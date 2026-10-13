import { createHmac, timingSafeEqual } from "node:crypto";
import { getWhopCompanyId, whopPost } from "./whop-ledger";

export interface CheckoutLink {
  checkoutId: string;
  url: string;
}

/**
 * Create a one-time Whop checkout for exactly `priceCents` and tag it with the
 * quote id (Whop copies `metadata` onto the resulting payment, which is how a
 * payment is matched back to a task).
 */
export async function createCheckout(
  quoteId: string,
  priceCents: number,
  title: string,
): Promise<CheckoutLink> {
  const accountId = getWhopCompanyId();
  if (!accountId) throw new Error("WHOP_COMPANY_ID is not configured.");
  const productId = process.env.WHOP_PRODUCT_ID?.trim();
  const response = await whopPost(
    "/checkout_configurations",
    {
      account_id: accountId,
      mode: "payment",
      metadata: { quoteId, app: "hyperagent" },
      plan: {
        plan_type: "one_time",
        initial_price: Number((priceCents / 100).toFixed(2)),
        currency: "usd",
        title: title.slice(0, 80),
        ...(productId ? { product_id: productId } : {}),
      },
    },
    `hyperagent-quote-${quoteId}`,
  );
  if (
    typeof response !== "object" ||
    response === null ||
    !("id" in response) ||
    typeof response.id !== "string" ||
    !("purchase_url" in response) ||
    typeof response.purchase_url !== "string"
  ) {
    throw new Error("Whop did not return a checkout purchase_url.");
  }
  return { checkoutId: response.id, url: response.purchase_url };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Standard Webhooks verification as documented by Whop:
 *   signed content = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   signature      = base64(HMAC-SHA256(key, signed content)), header "v1,<sig> [v1,<sig>…]"
 * Whop's docs say to pass the `ws_…` secret exactly as issued. Because the exact
 * key derivation is done inside their SDK helper, we accept the two derivations
 * in use (raw UTF-8 secret, or base64-decoded body of the secret); both are
 * derived from the secret, so this does not weaken the check.
 */
export function verifyWhopWebhook(
  rawBody: Buffer,
  headers: {
    id?: string;
    timestamp?: string;
    signature?: string;
  },
  secret: string | undefined,
  nowMs: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "WHOP_WEBHOOK_SECRET is not configured" };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing webhook-* headers" };
  }
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(nowMs / 1000 - tsSeconds) > 300) {
    return { ok: false, reason: "timestamp outside the 5 minute tolerance" };
  }

  const keys: Buffer[] = [Buffer.from(secret, "utf8")];
  const stripped = secret.replace(/^(whsec_|ws_)/, "");
  try {
    const decoded = Buffer.from(stripped, "base64");
    if (decoded.length > 0) keys.push(decoded);
  } catch {
    /* not base64 — ignore */
  }

  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    rawBody,
  ]);
  const provided = signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => Buffer.from(part.slice(3), "base64"));

  for (const key of keys) {
    const expected = createHmac("sha256", key).update(signedContent).digest();
    if (provided.some((candidate) => safeEqual(candidate, expected))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}
