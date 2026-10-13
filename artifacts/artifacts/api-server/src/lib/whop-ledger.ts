import { eq, sql } from "drizzle-orm";
import {
  a2aActivityTable,
  a2aLedgerTable,
  a2aWhopPaymentStateTable,
  db,
} from "@workspace/db";
import { logger } from "./logger";
import { fulfillPaidQuotes } from "./fulfillment";

const syncIntervalMs = 5 * 60_000;
const paymentsPerPage = 100;
const maxPagesPerSync = 5;
const whopApiBaseUrl = "https://api.whop.com/api/v1";
const whopApiKey = process.env.WHOP_API_KEY;
const companyId = process.env.WHOP_COMPANY_ID;
let verifiedCompanyId: string | null = null;

export type WhopPayment = {
  id: string;
  status?: string;
  substatus?: string;
  currency?: string;
  total?: string | number;
  amount_after_fees?: string | number;
  refunded_amount?: string | number;
  paid_at?: string | null;
  updated_at?: string | null;
  company?: { id?: string } | null;
  company_id?: string;
  metadata?: Record<string, unknown> | null;
};

type WhopPaymentsPage = {
  data: WhopPayment[];
  page_info?: {
    has_next_page?: boolean;
    end_cursor?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dollarsToCents(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const dollars = Number(value);
  if (
    !Number.isFinite(dollars) ||
    dollars < 0 ||
    dollars > 21_474_836.47
  ) {
    return null;
  }
  const cents = Math.round((dollars + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents <= 2_147_483_647
    ? cents
    : null;
}

function asPaymentsPage(value: unknown): WhopPaymentsPage {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Whop returned an unsupported payments response.");
  }
  const pageInfo = isRecord(value.page_info)
    ? value.page_info
    : isRecord(value.pagination)
      ? value.pagination
      : undefined;
  const data = value.data.filter(
    (payment): payment is Record<string, unknown> => isRecord(payment),
  );
  return {
    data: data.filter(
      (payment): payment is WhopPayment => typeof payment.id === "string",
    ),
    page_info: pageInfo
      ? {
          has_next_page: pageInfo.has_next_page === true,
          end_cursor:
            typeof pageInfo.end_cursor === "string"
              ? pageInfo.end_cursor
              : null,
        }
      : undefined,
  };
}

export async function whopGet(path: string): Promise<unknown> {
  if (!whopApiKey) {
    throw new Error("WHOP_API_KEY is not configured.");
  }
  const response = await fetch(`${whopApiBaseUrl}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${whopApiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Whop API request failed (${response.status}) GET ${path.split("?")[0]}: ${body.slice(0, 300)}`,
    );
  }
  return response.json() as Promise<unknown>;
}

export function isWhopConfigured(): boolean {
  return Boolean(whopApiKey && companyId);
}

export function getWhopCompanyId(): string | null {
  return companyId ?? null;
}

export async function whopPost(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  if (!whopApiKey) {
    throw new Error("WHOP_API_KEY is not configured.");
  }
  const response = await fetch(`${whopApiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${whopApiKey}`,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Whop API request failed (${response.status}) POST ${path}: ${text.slice(0, 300)}`,
    );
  }
  return response.json() as Promise<unknown>;
}

async function verifyWhopCompany(): Promise<void> {
  if (!companyId) {
    throw new Error("WHOP_COMPANY_ID is not configured.");
  }
  if (verifiedCompanyId === companyId) return;

  const account = await whopGet("/accounts/me");
  if (!isRecord(account) || account.id !== companyId) {
    throw new Error(
      "The configured Whop API key does not belong to WHOP_COMPANY_ID.",
    );
  }
  verifiedCompanyId = companyId;
}

function creditedAmountCents(payment: WhopPayment): {
  currency: string;
  grossCents: number;
  netCents: number;
  refundedCents: number;
  creditedCents: number;
  paidAt: Date | null;
} {
  const currency = payment.currency?.toLowerCase() ?? "unknown";
  const grossCents = dollarsToCents(payment.total) ?? 0;
  const netCents = dollarsToCents(payment.amount_after_fees) ?? 0;
  const refundedCents = dollarsToCents(payment.refunded_amount) ?? 0;
  const parsedPaidAt =
    typeof payment.paid_at === "string" ? new Date(payment.paid_at) : null;
  const paidAt =
    parsedPaidAt && Number.isFinite(parsedPaidAt.getTime())
      ? parsedPaidAt
      : null;
  const isVerifiedUsdPayment =
    payment.status === "paid" &&
    (!payment.substatus || payment.substatus === "succeeded") &&
    currency === "usd" &&
    paidAt !== null &&
    grossCents > 0 &&
    netCents > 0;
  const refundRatio =
    grossCents > 0 ? Math.min(refundedCents / grossCents, 1) : 0;
  const creditedCents = isVerifiedUsdPayment
    ? Math.max(0, netCents - Math.round(netCents * refundRatio))
    : 0;

  return {
    currency,
    grossCents,
    netCents,
    refundedCents,
    creditedCents,
    paidAt,
  };
}

async function fetchPaymentsPage(after?: string): Promise<WhopPaymentsPage> {
  const query = new URLSearchParams({
    first: String(paymentsPerPage),
    order: "created_at",
    direction: "desc",
  });
  if (after) query.set("after", after);

  return asPaymentsPage(await whopGet(`/payments?${query.toString()}`));
}

export async function reconcilePayment(payment: WhopPayment): Promise<boolean> {
  if (
    !companyId ||
    (payment.company?.id && payment.company.id !== companyId) ||
    (payment.company_id && payment.company_id !== companyId)
  ) {
    return false;
  }

  const next = creditedAmountCents(payment);
  const providerStatus = payment.substatus
    ? `${payment.status ?? "unknown"}/${payment.substatus}`
    : (payment.status ?? "unknown");
  let changed = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('hyperagent-whop'), hashtext(${payment.id}))`,
    );
    const [current] = await tx
      .select()
      .from(a2aWhopPaymentStateTable)
      .where(eq(a2aWhopPaymentStateTable.paymentId, payment.id))
      .limit(1);
    const previousCents = current?.creditedCents ?? 0;
    const deltaCents = next.creditedCents - previousCents;

    if (deltaCents !== 0) {
      const isCredit = deltaCents > 0;
      const eventReference = [
        payment.id,
        current?.creditedCents ?? 0,
        next.creditedCents,
        payment.updated_at ?? payment.paid_at ?? "snapshot",
      ].join(":");
      await tx.insert(a2aLedgerTable).values({
        type: isCredit ? "verified-earning" : "refund",
        amountCents: deltaCents,
        note: isCredit
          ? "Verified Whop payment net of provider fees."
          : "Whop refund or payment reversal adjustment.",
        source: "whop",
        sourceReference: eventReference,
      });
      await tx.insert(a2aActivityTable).values({
        type: isCredit ? "whop-earning" : "whop-refund",
        title: isCredit ? "Whop payment verified" : "Whop refund recorded",
        detail: isCredit
          ? `Payment ${payment.id} is marked paid and succeeded. Net amount was added to the verified USD ledger.`
          : `Payment ${payment.id} was refunded or reversed. The verified ledger was reduced by the adjustment.`,
        amountCents: deltaCents,
      });
      changed = true;
    }

    const metadataQuoteId =
      payment.metadata && typeof payment.metadata.quoteId === "string"
        ? payment.metadata.quoteId.slice(0, 64)
        : null;
    const state = {
      ...(metadataQuoteId ? { quoteId: metadataQuoteId } : {}),
      currency: next.currency,
      providerStatus,
      grossCents: next.grossCents,
      netCents: next.netCents,
      refundedCents: next.refundedCents,
      creditedCents: next.creditedCents,
      paidAt: next.paidAt,
      updatedAt: new Date(),
    };
    if (current) {
      await tx
        .update(a2aWhopPaymentStateTable)
        .set(state)
        .where(eq(a2aWhopPaymentStateTable.id, current.id));
    } else {
      await tx.insert(a2aWhopPaymentStateTable).values({
        paymentId: payment.id,
        ...state,
      });
    }
  });

  return changed;
}

async function syncWhopPayments(): Promise<void> {
  if (!companyId) {
    logger.warn(
      "Whop payment sync skipped because WHOP_COMPANY_ID is not configured",
    );
    return;
  }
  await verifyWhopCompany();

  let after: string | undefined;
  let paymentCount = 0;
  let changedCount = 0;
  let reachedPageLimit = true;

  for (let pageNumber = 0; pageNumber < maxPagesPerSync; pageNumber += 1) {
    const page = await fetchPaymentsPage(after);
    for (const payment of page.data) {
      paymentCount += 1;
      if (await reconcilePayment(payment)) changedCount += 1;
    }

    const nextCursor = page.page_info?.end_cursor;
    if (!page.page_info?.has_next_page || !nextCursor) {
      reachedPageLimit = false;
      break;
    }
    after = nextCursor;
  }

  if (reachedPageLimit) {
    logger.warn(
      { maxPagesPerSync },
      "Whop sync reached its page limit; remaining payments will be picked up on the next cycle",
    );
  }
  logger.info(
    { paymentCount, changedCount },
    "Whop verified payment ledger sync completed",
  );
}

let started = false;
let syncing = false;

/** Fetch a single payment from Whop and reconcile it into the ledger. */
export async function reconcilePaymentById(paymentId: string): Promise<boolean> {
  await verifyWhopCompany();
  const raw = await whopGet(`/payments/${encodeURIComponent(paymentId)}`);
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new Error("Whop returned an unsupported payment response.");
  }
  return reconcilePayment(raw as WhopPayment);
}

async function runCycle(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    await syncWhopPayments();
  } catch (error) {
    logger.error({ err: error }, "Whop payment ledger sync failed; will retry in 5 minutes");
  }
  try {
    await fulfillPaidQuotes();
  } catch (error) {
    logger.error({ err: error }, "Paid-quote fulfillment failed; will retry");
  } finally {
    syncing = false;
  }
}

export function startWhopLedgerSync(): void {
  if (started) return;
  started = true;
  if (!companyId) {
    logger.warn(
      "Whop payment ledger sync is disabled because WHOP_COMPANY_ID is missing",
    );
    return;
  }
  if (!whopApiKey) {
    logger.warn(
      "Whop payment ledger sync is disabled because WHOP_API_KEY is missing",
    );
    return;
  }
  logger.info(
    { intervalMs: syncIntervalMs, companyIdConfigured: true },
    "Whop verified payment ledger sync started",
  );
  void runCycle();
  // One fixed interval; webhook-triggered syncs reuse runCycle without adding timers.
  setInterval(() => void runCycle(), syncIntervalMs).unref();
}

/** Trigger an immediate sync (e.g. from a webhook) without waiting 5 minutes. */
export function syncWhopNow(): void {
  if (!companyId || !whopApiKey) return;
  void runCycle();
}
