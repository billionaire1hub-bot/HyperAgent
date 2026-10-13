import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotent schema bootstrap.
 *
 * The original project relied on `drizzle-kit push` (a dev-only step), so a
 * fresh Railway Postgres never received the tables and every ledger/quote query
 * failed with `relation "a2a_..." does not exist` — only logged at WARN level.
 * This creates everything that is missing and adds the new columns, so a plain
 * deploy is enough. Safe to run on every boot.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS a2a_quotes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_text text NOT NULL,
    offered_cents integer NOT NULL,
    minimum_cents integer NOT NULL,
    proposed_cents integer NOT NULL,
    scope_percent integer NOT NULL,
    quote_status text NOT NULL,
    execution_status text NOT NULL DEFAULT 'quoted',
    accepted_cents integer,
    result text,
    execution_mode text,
    created_at timestamptz NOT NULL DEFAULT now(),
    executed_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_activity (
    id serial PRIMARY KEY,
    type text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    amount_cents integer,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL,
    amount_cents integer NOT NULL,
    method text,
    note text NOT NULL,
    source text,
    source_reference text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_whop_payment_state (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id text NOT NULL,
    currency text NOT NULL,
    provider_status text NOT NULL,
    gross_cents integer NOT NULL DEFAULT 0,
    net_cents integer NOT NULL DEFAULT 0,
    refunded_cents integer NOT NULL DEFAULT 0,
    credited_cents integer NOT NULL DEFAULT 0,
    reserved_for_task text,
    paid_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS a2a_whop_payment_id_unique
     ON a2a_whop_payment_state (payment_id)`,
  `CREATE TABLE IF NOT EXISTS a2a_settings (
    id integer PRIMARY KEY DEFAULT 1,
    outreach_enabled boolean NOT NULL DEFAULT false,
    payouts_enabled boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_outreach (
    agent_key text PRIMARY KEY,
    agent_url text NOT NULL,
    agent_name text NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    last_contacted_at timestamptz,
    last_response text
  )`,
  // New columns (no-ops when the table was just created above with them absent)
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS complexity integer`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS ask_cents integer`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS pricing_rationale text`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS checkout_id text`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS checkout_url text`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS whop_payment_id text`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS requester_ref text`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'owner'`,
  `ALTER TABLE a2a_quotes ADD COLUMN IF NOT EXISTS failure_reason text`,
  `ALTER TABLE a2a_whop_payment_state ADD COLUMN IF NOT EXISTS quote_id text`,
  `CREATE INDEX IF NOT EXISTS a2a_quotes_status_idx
     ON a2a_quotes (execution_status, created_at)`,
  `CREATE INDEX IF NOT EXISTS a2a_whop_payment_quote_idx
     ON a2a_whop_payment_state (quote_id)`,
];

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    logger.info({ statements: statements.length }, "Database schema verified");
  } finally {
    client.release();
  }
}
