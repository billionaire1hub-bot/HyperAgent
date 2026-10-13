import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { a2aActivityTable, a2aQuotesTable, db } from "@workspace/db";
import { createPaidQuote, IntakeError, maxTaskChars } from "../lib/intake";
import { formatUsd } from "../lib/pricing";
import { getPublicBaseUrl } from "../lib/public-url";
import { fulfillPaidQuotes } from "../lib/fulfillment";
import { verifyWhopWebhook } from "../lib/whop-checkout";
import { reconcilePaymentById, syncWhopNow } from "../lib/whop-ledger";
import { logger } from "../lib/logger";

/**
 * Public, payment-gated surface. Anyone may *ask* for a quote; nothing runs
 * until Whop confirms an upfront payment (see lib/fulfillment.ts).
 */
const router: IRouter = Router();

const rateWindowMs = 60_000;
const maxIntakePerWindow = 20;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(req: Request): boolean {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + rateWindowMs });
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > maxIntakePerWindow;
}

/** Optional shared-secret gate: set A2A_INBOUND_REQUIRE_TOKEN=true to enforce A2A_INBOUND_TOKEN. */
function inboundAuthorized(req: Request): boolean {
  if (process.env.A2A_INBOUND_REQUIRE_TOKEN !== "true") return true;
  const expected = process.env.A2A_INBOUND_TOKEN;
  if (!expected) return false;
  const match = /^Bearer (.+)$/i.exec(req.get("authorization")?.trim() ?? "");
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function agentCard() {
  const base = getPublicBaseUrl();
  return {
    protocolVersion: "0.3.0",
    name: "HyperAgent",
    description:
      "Autonomous AI task agent. Every task is priced dynamically from its complexity and paid upfront through Whop checkout before any work starts.",
    url: base ? `${base}/a2a/rpc` : "/a2a/rpc",
    preferredTransport: "JSONRPC",
    version: "2.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "writing-summaries",
        name: "Writing & summaries",
        description: "Summaries, rewrites, drafting, proofreading.",
        tags: ["writing", "summary"],
      },
      {
        id: "translation",
        name: "Translation",
        description: "Translate text between languages.",
        tags: ["translation", "language"],
      },
      {
        id: "structured-data",
        name: "Structured data",
        description: "Extract and reformat data into a defined structure.",
        tags: ["data", "extraction"],
      },
      {
        id: "research-analysis",
        name: "Research & analysis",
        description: "Scoped research briefs and analysis from supplied material.",
        tags: ["research", "analysis"],
      },
      {
        id: "code-assist",
        name: "Code assistance",
        description: "Write, review and explain code (no execution).",
        tags: ["code"],
      },
    ],
    pricing: {
      model: "dynamic",
      currency: "usd",
      payment: "upfront-whop-checkout",
      negotiation:
        "Send metadata.offeredAmountUsd with message/send to make an offer; counteroffers are returned in the reply.",
    },
  };
}

router.get(
  ["/.well-known/agent-card.json", "/.well-known/agent.json"],
  (_req, res): void => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(agentCard());
  },
);

// ---------------------------------------------------------------- A2A JSON-RPC

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function agentMessage(text: string) {
  return {
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    parts: [{ kind: "text", text }],
  };
}

function textFromMessage(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.parts)) return "";
  return message.parts
    .map((part) =>
      isObject(part) && part.kind === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function offerFromMetadata(message: unknown, params: Json): number | null {
  const sources = [
    isObject(message) && isObject(message.metadata) ? message.metadata : null,
    isObject(params.metadata) ? params.metadata : null,
  ];
  for (const source of sources) {
    const raw = source?.offeredAmountUsd ?? source?.offeredAmount;
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.min(Math.round(value * 100), 10_000_000);
    }
  }
  return null;
}

type QuoteRow = typeof a2aQuotesTable.$inferSelect;

function taskView(quote: QuoteRow) {
  const base = { kind: "task", id: quote.id, contextId: quote.id };
  const price = formatUsd(quote.proposedCents);
  switch (quote.executionStatus) {
    case "completed":
      return {
        ...base,
        status: { state: "completed", message: agentMessage("Task completed.") },
        artifacts: [
          {
            artifactId: `${quote.id}-result`,
            name: "result",
            parts: [{ kind: "text", text: quote.result ?? "" }],
          },
        ],
      };
    case "executing":
      return { ...base, status: { state: "working", message: agentMessage("Payment verified. Working on your task.") } };
    case "checkout-failed":
      return { ...base, status: { state: "failed", message: agentMessage("No payment checkout could be created. No work was done.") } };
    default:
      return {
        ...base,
        status: {
          state: "input-required",
          message: agentMessage(
            `Payment required: ${price}. Pay here, then poll tasks/get with this task id: ${quote.checkoutUrl ?? "(checkout pending)"}`,
          ),
        },
        metadata: {
          payment: {
            amountUsd: quote.proposedCents / 100,
            currency: "usd",
            checkoutUrl: quote.checkoutUrl,
          },
        },
      };
  }
}

router.post("/a2a/rpc", async (req: Request, res: Response): Promise<void> => {
  if (!inboundAuthorized(req)) {
    res.status(401).json(rpcError(null, -32001, "Unauthorized"));
    return;
  }
  const body: unknown = req.body;
  if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
    return;
  }
  const params = isObject(body.params) ? body.params : {};

  try {
    if (body.method === "message/send") {
      if (rateLimited(req)) {
        res.status(429).json(rpcError(body.id, -32005, "Rate limit exceeded"));
        return;
      }
      const text = textFromMessage(params.message);
      if (!text.trim()) {
        res.json(rpcError(body.id, -32602, "message.parts must include text"));
        return;
      }
      const quote = await createPaidQuote({
        taskText: text,
        offeredCents: offerFromMetadata(params.message, params),
        requesterRef: `${req.ip ?? "unknown"}`,
        source: "a2a-rpc",
      });
      const [row] = await db
        .select()
        .from(a2aQuotesTable)
        .where(eq(a2aQuotesTable.id, quote.quoteId))
        .limit(1);
      const view = row ? taskView(row) : null;
      const task =
        view && view.status.state === "input-required"
          ? {
              ...view,
              status: {
                state: "input-required" as const,
                message: agentMessage(
                  `${quote.message}\nPay here: ${quote.checkoutUrl}\nThen poll tasks/get with id ${quote.quoteId}; the result is returned when payment clears.`,
                ),
              },
            }
          : view;
      res.json({ jsonrpc: "2.0", id: body.id ?? null, result: task });
      return;
    }

    if (body.method === "tasks/get") {
      const id = typeof params.id === "string" ? params.id : "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.json(rpcError(body.id, -32602, "Invalid task id"));
        return;
      }
      const [row] = await db
        .select()
        .from(a2aQuotesTable)
        .where(eq(a2aQuotesTable.id, id))
        .limit(1);
      if (!row || row.source === "owner") {
        res.json(rpcError(body.id, -32001, "Task not found"));
        return;
      }
      res.json({ jsonrpc: "2.0", id: body.id ?? null, result: taskView(row) });
      return;
    }

    res.json(rpcError(body.id, -32601, `Method not found: ${body.method}`));
  } catch (error) {
    if (error instanceof IntakeError) {
      res.status(error.status).json(rpcError(body.id, -32000, error.message));
      return;
    }
    logger.error({ err: error }, "A2A RPC request failed");
    res.status(500).json(rpcError(body.id, -32603, "Internal error"));
  }
});

// Plain REST convenience for non-A2A buyers.
router.post("/api/public/tasks", async (req, res): Promise<void> => {
  if (!inboundAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (rateLimited(req)) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  const body: unknown = req.body;
  const taskText = isObject(body) && typeof body.taskText === "string" ? body.taskText : "";
  const offered =
    isObject(body) && typeof body.offeredAmountUsd === "number" && body.offeredAmountUsd > 0
      ? Math.min(Math.round(body.offeredAmountUsd * 100), 10_000_000)
      : null;
  if (!taskText.trim() || taskText.length > maxTaskChars) {
    res.status(400).json({ error: `taskText is required (max ${maxTaskChars} chars).` });
    return;
  }
  try {
    const quote = await createPaidQuote({
      taskText,
      offeredCents: offered,
      requesterRef: req.ip ?? "unknown",
      source: "rest",
    });
    res.status(201).json({
      taskId: quote.quoteId,
      amountUsd: quote.priceCents / 100,
      complexity: quote.complexity,
      status: quote.outcome,
      message: quote.message,
      checkoutUrl: quote.checkoutUrl,
      resultUrl: `/api/public/tasks/${quote.quoteId}`,
    });
  } catch (error) {
    if (error instanceof IntakeError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "Public task intake failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/api/public/tasks/:id", async (req, res): Promise<void> => {
  const id = req.params.id ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }
  const [row] = await db
    .select()
    .from(a2aQuotesTable)
    .where(eq(a2aQuotesTable.id, id))
    .limit(1);
  if (!row || row.source === "owner") {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({
    taskId: row.id,
    status: row.executionStatus,
    amountUsd: row.proposedCents / 100,
    checkoutUrl: row.executionStatus === "awaiting-payment" ? row.checkoutUrl : null,
    result: row.executionStatus === "completed" ? row.result : null,
  });
});

// ----------------------------------------------------------------- Whop webhook

router.post("/api/webhooks/whop", async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: "Missing body" });
    return;
  }
  const verdict = verifyWhopWebhook(
    rawBody,
    {
      id: req.get("webhook-id"),
      timestamp: req.get("webhook-timestamp"),
      signature: req.get("webhook-signature"),
    },
    process.env.WHOP_WEBHOOK_SECRET,
  );
  if (!verdict.ok) {
    logger.warn({ reason: verdict.reason }, "Rejected Whop webhook");
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  // Acknowledge fast (Whop expects 2xx within 5s); work continues in the background.
  res.status(200).json({ received: true });

  const event: unknown = req.body;
  const type = isObject(event) && typeof event.type === "string" ? event.type : "";
  const data = isObject(event) && isObject(event.data) ? event.data : null;
  const paymentId = data && typeof data.id === "string" ? data.id : null;
  if (!type.startsWith("payment.") || !paymentId) return;

  void (async () => {
    try {
      // The payload is NOT trusted: the payment is re-fetched from Whop's API and
      // re-validated (paid/succeeded, USD, our company) before it is credited.
      await reconcilePaymentById(paymentId);
      await db.insert(a2aActivityTable).values({
        type: "whop-webhook",
        title: `Whop ${type}`,
        detail: `Payment ${paymentId} reconciled after a signed webhook.`,
      });
      await fulfillPaidQuotes();
    } catch (error) {
      logger.error({ err: error, paymentId }, "Webhook reconciliation failed; the 5-minute sync will retry");
      syncWhopNow();
    }
  })();
});

export default router;
