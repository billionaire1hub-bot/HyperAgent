import { and, asc, eq, gt } from "drizzle-orm";
import {
  a2aActivityTable,
  a2aQuotesTable,
  a2aWhopPaymentStateTable,
  db,
} from "@workspace/db";
import { executePaidTask } from "./a2a-execution";
import { logger } from "./logger";

const fulfillmentWindowMs = 7 * 24 * 60 * 60_000;
let running = false;

type ClaimResult =
  | { kind: "none" }
  | { kind: "claimed"; taskText: string; paymentId: string; priceCents: number };

/**
 * Runs the task for one quote *only if* a verified Whop payment linked to that
 * quote (via checkout metadata.quoteId) covers the price. The payment rows come
 * from `reconcilePayment`, which re-checks status = paid/succeeded, USD and the
 * company id against Whop's API — webhook payloads are never trusted directly.
 */
async function fulfillOne(quoteId: string): Promise<boolean> {
  const claim = await db.transaction(async (tx): Promise<ClaimResult> => {
    const [quote] = await tx
      .select()
      .from(a2aQuotesTable)
      .where(eq(a2aQuotesTable.id, quoteId))
      .for("update")
      .limit(1);
    if (!quote || quote.executionStatus !== "awaiting-payment") {
      return { kind: "none" };
    }
    const [payment] = await tx
      .select()
      .from(a2aWhopPaymentStateTable)
      .where(eq(a2aWhopPaymentStateTable.quoteId, quote.id))
      .orderBy(asc(a2aWhopPaymentStateTable.paidAt))
      .for("update")
      .limit(1);
    if (!payment) return { kind: "none" };

    const paidOk =
      (payment.providerStatus === "paid/succeeded" ||
        payment.providerStatus === "paid") &&
      payment.currency === "usd" &&
      payment.paidAt !== null &&
      // The buyer pays the sticker price; Whop's processing fee comes out of
      // our side. (The original gate compared the *net* amount to the price,
      // so every real payment fell short by the fee and was rejected.)
      payment.grossCents - payment.refundedCents >= quote.proposedCents &&
      payment.creditedCents > 0;
    if (!paidOk) return { kind: "none" };

    const reservation = `quote:${quote.id}`;
    if (payment.reservedForTask && payment.reservedForTask !== reservation) {
      return { kind: "none" };
    }
    await tx
      .update(a2aWhopPaymentStateTable)
      .set({ reservedForTask: reservation })
      .where(eq(a2aWhopPaymentStateTable.id, payment.id));
    await tx
      .update(a2aQuotesTable)
      .set({
        executionStatus: "executing",
        acceptedCents: quote.proposedCents,
        whopPaymentId: payment.paymentId,
      })
      .where(eq(a2aQuotesTable.id, quote.id));
    return {
      kind: "claimed",
      taskText: quote.taskText,
      paymentId: payment.paymentId,
      priceCents: quote.proposedCents,
    };
  });
  if (claim.kind === "none") return false;

  try {
    const result = await executePaidTask(claim.taskText, 100);
    await db.transaction(async (tx) => {
      await tx
        .update(a2aQuotesTable)
        .set({
          executionStatus: "completed",
          result: result.result,
          executionMode: result.mode,
          executedAt: new Date(),
          failureReason: null,
        })
        .where(
          and(
            eq(a2aQuotesTable.id, quoteId),
            eq(a2aQuotesTable.executionStatus, "executing"),
          ),
        );
      await tx.insert(a2aActivityTable).values({
        type: "completed",
        title: "Paid task completed",
        detail: `Task ${quoteId} completed after verified Whop payment ${claim.paymentId}.`,
        amountCents: claim.priceCents,
      });
    });
    logger.info({ quoteId, paymentId: claim.paymentId }, "Paid task completed");
    return true;
  } catch (error) {
    logger.error({ err: error, quoteId }, "Paid task execution failed; will retry");
    // Payment stays reserved for this quote, so the next sweep retries it.
    await db
      .update(a2aQuotesTable)
      .set({
        executionStatus: "awaiting-payment",
        failureReason:
          error instanceof Error ? error.message.slice(0, 300) : "execution failed",
      })
      .where(
        and(
          eq(a2aQuotesTable.id, quoteId),
          eq(a2aQuotesTable.executionStatus, "executing"),
        ),
      );
    return false;
  }
}

export async function fulfillPaidQuotes(): Promise<number> {
  if (running) return 0;
  running = true;
  let completed = 0;
  try {
    const pending = await db
      .select({ id: a2aQuotesTable.id })
      .from(a2aQuotesTable)
      .where(
        and(
          eq(a2aQuotesTable.executionStatus, "awaiting-payment"),
          gt(
            a2aQuotesTable.createdAt,
            new Date(Date.now() - fulfillmentWindowMs),
          ),
        ),
      )
      .orderBy(asc(a2aQuotesTable.createdAt))
      .limit(50);
    for (const { id } of pending) {
      if (await fulfillOne(id)) completed += 1;
    }
  } finally {
    running = false;
  }
  return completed;
}
