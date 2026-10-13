import { and, eq, gt, sql } from "drizzle-orm";
import { a2aActivityTable, a2aQuotesTable, db } from "@workspace/db";
import { negotiate, priceTask, formatUsd } from "./pricing";
import { createCheckout } from "./whop-checkout";
import { isWhopConfigured } from "./whop-ledger";
import { logger } from "./logger";

export const maxTaskChars = 12_000;
const maxOpenQuotesPerDay = 500;

export interface PaidQuote {
  quoteId: string;
  priceCents: number;
  askCents: number;
  complexity: number;
  outcome: string;
  message: string;
  checkoutUrl: string;
}

export class IntakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Turn a task request into a priced quote with a Whop checkout link.
 * Work is only ever executed by `fulfillPaidQuotes` after Whop confirms the
 * payment, so there is no path from here to free execution.
 */
export async function createPaidQuote(input: {
  taskText: string;
  offeredCents: number | null;
  requesterRef: string;
  source: "a2a-rpc" | "rest";
}): Promise<PaidQuote> {
  const taskText = input.taskText.trim();
  if (!taskText) throw new IntakeError("Task text cannot be empty.", 400);
  if (taskText.length > maxTaskChars) {
    throw new IntakeError(`Task text exceeds ${maxTaskChars} characters.`, 413);
  }
  if (!isWhopConfigured()) {
    throw new IntakeError(
      "Payments are not configured on this agent (WHOP_API_KEY / WHOP_COMPANY_ID).",
      503,
    );
  }

  const [{ open } = { open: 0 }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(a2aQuotesTable)
    .where(
      and(
        eq(a2aQuotesTable.executionStatus, "awaiting-payment"),
        gt(a2aQuotesTable.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
      ),
    );
  if (open >= maxOpenQuotesPerDay) {
    throw new IntakeError("Too many unpaid quotes are open. Try again later.", 429);
  }

  const pricing = await priceTask(taskText);
  const deal = negotiate(pricing, input.offeredCents);

  const [quote] = await db
    .insert(a2aQuotesTable)
    .values({
      taskText,
      offeredCents: input.offeredCents ?? 0,
      minimumCents: pricing.floorCents,
      proposedCents: deal.priceCents,
      scopePercent: 100,
      quoteStatus: deal.outcome,
      executionStatus: "awaiting-payment",
      complexity: pricing.complexity,
      askCents: pricing.askCents,
      pricingRationale: pricing.rationale,
      requesterRef: input.requesterRef.slice(0, 200),
      source: input.source,
    })
    .returning();
  if (!quote) throw new IntakeError("Could not record the quote.", 500);

  try {
    const checkout = await createCheckout(
      quote.id,
      deal.priceCents,
      `AI task (complexity ${pricing.complexity}/10)`,
    );
    await db
      .update(a2aQuotesTable)
      .set({ checkoutId: checkout.checkoutId, checkoutUrl: checkout.url })
      .where(eq(a2aQuotesTable.id, quote.id));
    await db.insert(a2aActivityTable).values({
      type: "quote",
      title: `Quote issued (${deal.outcome})`,
      detail: `${formatUsd(deal.priceCents)} for complexity ${pricing.complexity}/10 — ${pricing.rationale}. Awaiting upfront Whop payment.`,
      amountCents: deal.priceCents,
    });
    return {
      quoteId: quote.id,
      priceCents: deal.priceCents,
      askCents: pricing.askCents,
      complexity: pricing.complexity,
      outcome: deal.outcome,
      message: deal.message,
      checkoutUrl: checkout.url,
    };
  } catch (error) {
    // No checkout means no way to get paid, so the quote is closed, not executed.
    await db
      .update(a2aQuotesTable)
      .set({
        executionStatus: "checkout-failed",
        failureReason:
          error instanceof Error ? error.message.slice(0, 300) : "checkout failed",
      })
      .where(eq(a2aQuotesTable.id, quote.id));
    logger.error({ err: error, quoteId: quote.id }, "Whop checkout creation failed");
    throw new IntakeError(
      "Could not create a payment checkout. No work was started.",
      502,
    );
  }
}
