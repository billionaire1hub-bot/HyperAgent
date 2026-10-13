import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  DiscoverA2aAgentBody,
  DiscoverA2aAgentResponse,
  CreateA2aQuoteBody,
  CreateA2aQuoteResponse,
  ExecuteA2aTaskBody,
  ExecuteA2aTaskResponse,
  GetA2aDashboardResponse,
  GetA2aRegistryAgentsResponse,
  GetA2aSettingsResponse,
  ListA2aActivityResponse,
  ListA2aServicesResponse,
  PingA2aAgentBody,
  PingA2aAgentResponse,
  ReceiveA2aAgentWebhookBody,
  ReceiveA2aAgentWebhookParams,
  UpdateA2aSettingsBody,
  UpdateA2aSettingsResponse,
} from "@workspace/api-zod";
import {
  a2aActivityTable,
  a2aLedgerTable,
  a2aQuotesTable,
  a2aSettingsTable,
  a2aWhopPaymentStateTable,
  db,
} from "@workspace/db";
import {
  executePaidTask,
  getConfiguredExecutionMode,
} from "../lib/a2a-execution";
import { requireOwnerSession } from "../lib/a2a-auth";
import { getHunterHeartbeat } from "../lib/hunter";
import { formatUsd, negotiate, priceTask } from "../lib/pricing";
import {
  getA2aRegistryFeedSnapshot,
  isVerifiedOutreachOptInUrl,
} from "../lib/a2a-registry";
import {
  acceptAgentWebhook,
  discoverExternalAgent,
  pollA2aTask,
  sendA2aMessage,
} from "../lib/a2a-agent-client";
import a2aAuthRouter from "./a2a-auth";

const router: IRouter = Router();
const rateWindowMs = 60_000;
const maxWritesPerWindow = 40;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
router.use("/auth", a2aAuthRouter);

router.post(
  "/webhooks/agent-response/:deliveryId",
  async (req, res): Promise<void> => {
    const params = ReceiveA2aAgentWebhookParams.safeParse(req.params);
    const parsed = ReceiveA2aAgentWebhookBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "The agent callback is invalid." });
      return;
    }
    const accepted = acceptAgentWebhook(
      params.data.deliveryId,
      parsed.data.token,
      parsed.data.result,
    );
    if (!accepted) {
      res.status(401).json({ error: "The callback token is invalid or expired." });
      return;
    }
    await db.insert(a2aActivityTable).values({
      type: "outbound-response",
      title: "External agent callback received",
      detail: `External agent response received:\n\n${parsed.data.result}`,
    });
    res.status(202).end();
  },
);

router.use(requireOwnerSession);

router.use((req, res, next) => {
  if (req.method !== "POST" && req.method !== "PATCH") {
    next();
    return;
  }

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const current = requestCounts.get(key);
  if (!current || current.resetAt <= now) {
    requestCounts.set(key, { count: 1, resetAt: now + rateWindowMs });
    next();
    return;
  }
  if (current.count >= maxWritesPerWindow) {
    res.status(429).json({ error: "Too many requests. Try again shortly." });
    return;
  }
  current.count += 1;
  next();
});

const services = [
  {
    id: "micro-summary",
    name: "Micro summary",
    category: "Writing",
    description: "Condense a text into an agreed, bounded summary.",
    startingAmount: 0.5,
    unit: "per task",
    active: true,
  },
  {
    id: "translation",
    name: "Translation",
    category: "Language",
    description: "Translate a short text into a requested language.",
    startingAmount: 0.5,
    unit: "per task",
    active: true,
  },
  {
    id: "structured-data",
    name: "Structured data",
    category: "Data",
    description: "Extract or reformat a small dataset into a defined structure.",
    startingAmount: 0.5,
    unit: "per task",
    active: true,
  },
  {
    id: "research-brief",
    name: "Research brief",
    category: "Research",
    description: "Produce a scoped research outline from supplied source material.",
    startingAmount: 5,
    unit: "per task",
    active: true,
  },
];

function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

async function ensureSettings() {
  await db
    .insert(a2aSettingsTable)
    .values({ id: 1, outreachEnabled: false, payoutsEnabled: false })
    .onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(a2aSettingsTable)
    .where(eq(a2aSettingsTable.id, 1))
    .limit(1);
  if (!settings) throw new Error("Unable to initialize A2A safety settings");
  if (settings.payoutsEnabled) {
    const [safeSettings] = await db
      .update(a2aSettingsTable)
      .set({ payoutsEnabled: false })
      .where(eq(a2aSettingsTable.id, 1))
      .returning();
    if (!safeSettings) {
      throw new Error("Unable to keep payouts disabled");
    }
    return safeSettings;
  }
  return settings;
}

function settingsResponse(settings: {
  outreachEnabled: boolean;
  payoutsEnabled: boolean;
}) {
  return GetA2aSettingsResponse.parse({
    outreachEnabled: settings.outreachEnabled,
    payoutsEnabled: false,
    safeMode: true,
    payoutNote:
      "Withdrawals are disabled. Verified Whop receipts remain in the internal ledger; no bank, card, wallet, or payout details are collected. Withdrawal setup is deferred until the verified balance reaches the owner's $50–$100 target.",
  });
}

router.get("/services", (_req, res): void => {
  res.json(ListA2aServicesResponse.parse(services));
});

router.get("/registry/agents", (_req, res): void => {
  res.json(
    GetA2aRegistryAgentsResponse.parse(getA2aRegistryFeedSnapshot()),
  );
});

router.get("/dashboard", async (_req, res): Promise<void> => {
  const settings = await ensureSettings();
  const quotes = await db
    .select({ id: a2aQuotesTable.id, executionStatus: a2aQuotesTable.executionStatus })
    .from(a2aQuotesTable);
  const ledger = await db
    .select({
      type: a2aLedgerTable.type,
      amountCents: a2aLedgerTable.amountCents,
      source: a2aLedgerTable.source,
    })
    .from(a2aLedgerTable);
  const totalEarnedCents = ledger
    .filter(
      (entry) =>
        entry.source === "whop" && entry.type === "verified-earning",
    )
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const availableBalanceCents = ledger
    .filter((entry) => entry.source === "whop")
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const activeQuotes = quotes.filter(
    (quote) =>
      quote.executionStatus === "quoted" ||
      quote.executionStatus === "awaiting-payment",
  ).length;
  const executing = quotes.some(
    (quote) => quote.executionStatus === "executing",
  );
  const completedCount = quotes.filter(
    (quote) => quote.executionStatus === "completed",
  ).length;
  const status = executing
    ? "EXECUTING"
    : activeQuotes > 0
      ? "NEGOTIATING"
      : "SANDBOX ACTIVE";
  const aiProvider = getConfiguredExecutionMode();

  res.json(
    GetA2aDashboardResponse.parse({
      mode: "sandbox",
      status,
      totalEarned: fromCents(totalEarnedCents),
      availableBalance: fromCents(availableBalanceCents),
      completedCount,
      activeQuotes,
      aiProvider,
      lastHeartbeat: getHunterHeartbeat(),
    }),
  );
});

router.get("/activity", async (_req, res): Promise<void> => {
  const activity = await db
    .select()
    .from(a2aActivityTable)
    .orderBy(desc(a2aActivityTable.createdAt), desc(a2aActivityTable.id))
    .limit(40);
  res.json(
    ListA2aActivityResponse.parse(
      activity.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        detail: item.detail,
        amount:
          item.amountCents == null ? null : fromCents(item.amountCents),
        createdAt: item.createdAt.toISOString(),
      })),
    ),
  );
});

router.get("/settings", async (_req, res): Promise<void> => {
  res.json(settingsResponse(await ensureSettings()));
});

router.patch("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateA2aSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db
    .insert(a2aSettingsTable)
    .values({
      id: 1,
      outreachEnabled: parsed.data.outreachEnabled,
      payoutsEnabled: false,
    })
    .onConflictDoUpdate({
      target: a2aSettingsTable.id,
      set: {
        outreachEnabled: parsed.data.outreachEnabled,
        payoutsEnabled: false,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (parsed.data.outreachEnabled) {
    await db.insert(a2aActivityTable).values({
      type: "safety",
      title: "Sandbox control changed",
      detail:
        "Owner enabled outbound agent communication. New discovery, ping, and task requests can now contact explicitly selected public HTTPS agents.",
    });
  }
  res.json(UpdateA2aSettingsResponse.parse(settingsResponse(settings)));
});

router.post("/agents/discover", async (req, res): Promise<void> => {
  const parsed = DiscoverA2aAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid HTTPS agent URL." });
    return;
  }
  const settings = await ensureSettings();
  if (!settings.outreachEnabled) {
    res.status(409).json({ error: "Enable outbound agent outreach in Controls first." });
    return;
  }
  if (!isHttpsUrl(parsed.data.url)) {
    res.status(400).json({ error: "Agent discovery requires a public HTTPS URL." });
    return;
  }
  if (!isVerifiedOutreachOptInUrl(parsed.data.url)) {
    res.status(403).json({
      error:
        "Only registry-verified agents with an explicit outreach opt-in can be contacted.",
    });
    return;
  }
  try {
    const card = await discoverExternalAgent(parsed.data.url);
    await db.insert(a2aActivityTable).values({
      type: "outbound-discovery",
      title: "External agent discovered",
      detail: `Discovered ${card.name} at ${new URL(card.url).origin}; ${card.skills.length} capabilities returned.`,
    });
    res.json(DiscoverA2aAgentResponse.parse(card));
  } catch (error) {
    req.log.warn({ err: error }, "A2A agent discovery failed");
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not discover the external agent.",
    });
  }
});

router.post("/agents/ping", async (req, res): Promise<void> => {
  const parsed = PingA2aAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid HTTPS agent URL." });
    return;
  }
  const settings = await ensureSettings();
  if (!settings.outreachEnabled) {
    res.status(409).json({ error: "Enable outbound agent outreach in Controls first." });
    return;
  }
  if (!isHttpsUrl(parsed.data.agentUrl)) {
    res.status(400).json({ error: "Agent pings require a public HTTPS URL." });
    return;
  }
  if (!isVerifiedOutreachOptInUrl(parsed.data.agentUrl)) {
    res.status(403).json({
      error:
        "Only registry-verified agents with an explicit outreach opt-in can be contacted.",
    });
    return;
  }
  try {
    const card = await discoverExternalAgent(parsed.data.agentUrl);
    const initial = await sendA2aMessage(
      card,
      "HyperAgent connectivity ping. Please confirm that your A2A endpoint is reachable and return a brief status.",
    );
    const result = await pollA2aTask(card, initial);
    const response =
      result.response ||
      `The agent accepted the message with status “${result.state}”.`;
    await db.insert(a2aActivityTable).values({
      type: "outbound-ping",
      title: "External agent ping sent",
      detail: `${card.name} responded to a connectivity check.`,
    });
    res.json(
      PingA2aAgentResponse.parse({
        agentName: card.name,
        status: "responded",
        response,
        completedAt: new Date(),
      }),
    );
  } catch (error) {
    req.log.warn({ err: error }, "A2A agent ping failed");
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "The external agent did not respond.",
    });
  }
});

router.post("/tasks/delegate", (_req, res): void => {
  res.status(409).json({
    error:
      "External task delegation is paused until each task is linked to a verified upfront Whop payment and an agreed settlement flow.",
  });
});

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

router.post("/quote", async (req, res): Promise<void> => {
  const parsed = CreateA2aQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const taskText = parsed.data.taskText.trim();
  if (!taskText) {
    res.status(400).json({ error: "Task text cannot be empty." });
    return;
  }
  const offeredCents = toCents(parsed.data.offeredAmount);
  // Dynamic pricing: complexity-scored ask, negotiated against the offer. No fixed
  // rate, no $50 cap, never free, always full scope.
  const pricing = await priceTask(taskText);
  const deal = negotiate(pricing, offeredCents === 0 ? null : offeredCents);
  const minimumCents = pricing.floorCents;
  const proposedCents = deal.priceCents;
  const scopePercent = 100;
  const quoteStatus =
    offeredCents === 0
      ? "zero-offer"
      : deal.outcome === "counteroffer"
        ? "counteroffer"
        : "standard";
  const message =
    quoteStatus === "zero-offer"
      ? `Zero-value work is never executed. Price for this task: ${formatUsd(proposedCents)} (${pricing.rationale}).`
      : deal.message;
  const [quote] = await db
    .insert(a2aQuotesTable)
    .values({
      taskText,
      offeredCents,
      minimumCents,
      proposedCents,
      scopePercent,
      quoteStatus,
      complexity: pricing.complexity,
      askCents: pricing.askCents,
      pricingRationale: pricing.rationale,
    })
    .returning();
  await db.insert(a2aActivityTable).values({
    type: quoteStatus,
    title:
      quoteStatus === "standard"
        ? "Task quote created"
        : "Counteroffer issued",
    detail: `Full scope quoted at ${formatUsd(proposedCents)} (${pricing.rationale}).`,
    amountCents: proposedCents,
  });

  res.status(201).json(
    CreateA2aQuoteResponse.parse({
      id: quote.id,
      minimumAmount: fromCents(minimumCents),
      offeredAmount: fromCents(offeredCents),
      proposedAmount: fromCents(proposedCents),
      scopePercent,
      status: quoteStatus,
      message,
      createdAt: quote.createdAt.toISOString(),
    }),
  );
});

router.post("/execute", async (req, res): Promise<void> => {
  const parsed = ExecuteA2aTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const acceptedCents = toCents(parsed.data.acceptedAmount);
  if (acceptedCents <= 0) {
    res.status(400).json({ error: "Zero-value work cannot be executed." });
    return;
  }

  const claim = await db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(a2aQuotesTable)
      .where(eq(a2aQuotesTable.id, parsed.data.quoteId))
      .for("update")
      .limit(1);
    if (!quote) return { error: "Quote not found.", status: 404 as const };
    if (quote.executionStatus !== "quoted") {
      return { error: "This quote has already been used.", status: 409 as const };
    }
    if (acceptedCents !== quote.proposedCents) {
      return {
        error: `Accept the quoted amount of $${fromCents(quote.proposedCents).toFixed(2)} exactly.`,
        status: 400 as const,
      };
    }
    const [payment] = await tx
      .select()
      .from(a2aWhopPaymentStateTable)
      .where(
        eq(
          a2aWhopPaymentStateTable.paymentId,
          parsed.data.whopPaymentId.trim(),
        ),
      )
      .for("update")
      .limit(1);
    if (!payment) {
      return {
        error:
          "That Whop payment is not in the verified ledger yet. The background sync runs every five minutes; retry after it appears.",
        status: 409 as const,
      };
    }
    if (
      payment.providerStatus !== "paid/succeeded" &&
      payment.providerStatus !== "paid"
    ) {
      return {
        error: "The Whop payment is not marked paid and succeeded.",
        status: 409 as const,
      };
    }
    if (
      payment.currency !== "usd" ||
      !payment.paidAt ||
      payment.creditedCents <= 0 ||
      // Compare the price the buyer paid (gross), not the post-fee net amount.
      payment.grossCents - payment.refundedCents < acceptedCents
    ) {
      return {
        error:
          "The verified USD payment must cover the accepted amount after fees and refunds.",
        status: 409 as const,
      };
    }
    const reservation = `quote:${quote.id}`;
    if (
      payment.reservedForTask &&
      payment.reservedForTask !== reservation
    ) {
      return {
        error: "This Whop payment is already reserved for another task.",
        status: 409 as const,
      };
    }
    await tx
      .update(a2aWhopPaymentStateTable)
      .set({ reservedForTask: reservation })
      .where(eq(a2aWhopPaymentStateTable.id, payment.id));
    await tx
      .update(a2aQuotesTable)
      .set({ executionStatus: "executing", acceptedCents })
      .where(eq(a2aQuotesTable.id, quote.id));
    return { quote };
  });
  if ("error" in claim) {
    res.status(claim.status ?? 409).json({ error: claim.error });
    return;
  }

  try {
    const result = await executePaidTask(
      claim.quote.taskText,
      claim.quote.scopePercent,
    );
    const createdAt = new Date();
    const updated = await db.transaction(async (tx) => {
      const [completedQuote] = await tx
        .update(a2aQuotesTable)
        .set({
          executionStatus: "completed",
          acceptedCents,
          result: result.result,
          executionMode: result.mode,
          executedAt: createdAt,
        })
        .where(
          and(
            eq(a2aQuotesTable.id, claim.quote.id),
            eq(a2aQuotesTable.executionStatus, "executing"),
          ),
        )
        .returning();
      if (!completedQuote) return null;
      await tx.insert(a2aActivityTable).values({
        type: "completed",
        title: "Paid task completed in sandbox",
        detail: `${result.mode} execution completed after a verified Whop payment was reserved. Real net payment is recorded separately in the Whop ledger.`,
      });
      return completedQuote;
    });
    if (!updated) {
      res.status(409).json({ error: "Quote execution state changed." });
      return;
    }
    res.status(201).json(
      ExecuteA2aTaskResponse.parse({
        id: updated.id,
        status: "completed",
        result: result.result,
        amount: fromCents(acceptedCents),
        executionMode: result.mode,
        createdAt: createdAt.toISOString(),
      }),
    );
  } catch {
    try {
      await db
        .update(a2aQuotesTable)
        .set({
          executionStatus: "quoted",
          acceptedCents: null,
          result: null,
          executionMode: null,
          executedAt: null,
        })
        .where(
          and(
            eq(a2aQuotesTable.id, claim.quote.id),
            eq(a2aQuotesTable.executionStatus, "executing"),
          ),
        );
    } catch {
      req.log.error("A2A execution failed and quote state could not be reset");
    }
    req.log.error("A2A task execution failed");
    res.status(503).json({
      error: "No task result was produced. Check provider availability and retry; the quote is available again.",
    });
  }
});

router.post("/claim", async (req, res): Promise<void> => {
  void req;
  res.status(409).json({
    error:
      "Withdrawals are deferred. This system does not collect payout details or simulate claims.",
  });
});

export default router;
