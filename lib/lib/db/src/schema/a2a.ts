import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const a2aQuotesTable = pgTable("a2a_quotes", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskText: text("task_text").notNull(),
  offeredCents: integer("offered_cents").notNull(),
  minimumCents: integer("minimum_cents").notNull(),
  proposedCents: integer("proposed_cents").notNull(),
  scopePercent: integer("scope_percent").notNull(),
  quoteStatus: text("quote_status").notNull(),
  executionStatus: text("execution_status").notNull().default("quoted"),
  acceptedCents: integer("accepted_cents"),
  result: text("result"),
  executionMode: text("execution_mode"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  // Dynamic-pricing / paid-intake fields (added by the autonomous-monetization refactor)
  complexity: integer("complexity"),
  askCents: integer("ask_cents"),
  pricingRationale: text("pricing_rationale"),
  checkoutId: text("checkout_id"),
  checkoutUrl: text("checkout_url"),
  whopPaymentId: text("whop_payment_id"),
  requesterRef: text("requester_ref"),
  source: text("source").notNull().default("owner"),
  failureReason: text("failure_reason"),
});

export const a2aActivityTable = pgTable("a2a_activity", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  amountCents: integer("amount_cents"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const a2aLedgerTable = pgTable("a2a_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  method: text("method"),
  note: text("note").notNull(),
  source: text("source"),
  sourceReference: text("source_reference"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const a2aWhopPaymentStateTable = pgTable(
  "a2a_whop_payment_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: text("payment_id").notNull(),
    currency: text("currency").notNull(),
    providerStatus: text("provider_status").notNull(),
    grossCents: integer("gross_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    refundedCents: integer("refunded_cents").notNull().default(0),
    creditedCents: integer("credited_cents").notNull().default(0),
    reservedForTask: text("reserved_for_task"),
    quoteId: text("quote_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    paymentIdUnique: uniqueIndex("a2a_whop_payment_id_unique").on(
      table.paymentId,
    ),
  }),
);

export const a2aSettingsTable = pgTable("a2a_settings", {
  id: integer("id").primaryKey().default(1),
  outreachEnabled: boolean("outreach_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const a2aOutreachTable = pgTable("a2a_outreach", {
  agentKey: text("agent_key").primaryKey(),
  agentUrl: text("agent_url").notNull(),
  agentName: text("agent_name").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  lastResponse: text("last_response"),
});

export const insertA2aQuoteSchema = createInsertSchema(a2aQuotesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertA2aQuote = z.infer<typeof insertA2aQuoteSchema>;
export type A2aQuote = typeof a2aQuotesTable.$inferSelect;
export type A2aActivity = typeof a2aActivityTable.$inferSelect;
export type A2aLedgerEntry = typeof a2aLedgerTable.$inferSelect;
export type A2aWhopPaymentState =
  typeof a2aWhopPaymentStateTable.$inferSelect;
export type A2aOutreach = typeof a2aOutreachTable.$inferSelect;
export type A2aSettings = typeof a2aSettingsTable.$inferSelect;
