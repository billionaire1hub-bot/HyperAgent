import { eq } from "drizzle-orm";
import {
  a2aActivityTable,
  a2aOutreachTable,
  a2aSettingsTable,
  db,
} from "@workspace/db";
import {
  discoverExternalAgent,
  pollA2aTask,
  sendA2aMessage,
} from "./a2a-agent-client";
import {
  getA2aRegistryFeedSnapshot,
  isVerifiedOutreachOptInUrl,
} from "./a2a-registry";
import { getPublicBaseUrl } from "./public-url";
import { logger } from "./logger";

/**
 * Autonomous hunter.
 *
 * Before: a timestamp heartbeat only ("outboundDiscovery: disabled") — it never
 * contacted anyone, so nobody ever knew the agent existed or how to pay it.
 *
 * Now, on boot and every HUNTER_INTERVAL_MS it:
 *   1. makes sure outbound outreach is enabled (AUTO_OUTREACH=false opts out),
 *   2. takes the registry feed, keeps only agents that are verified AND have an
 *      explicit outreach opt-in AND whose agent card was fetched successfully,
 *   3. sends each one a single offer (with our agent card + paid-intake URL),
 *      at most once per OUTREACH_COOLDOWN_DAYS and at most MAX_PER_CYCLE per run.
 * Buyers then come to /a2a/rpc, get a dynamic quote + Whop checkout, and the
 * task runs only after the payment is verified.
 */
const heartbeatIntervalMs = 30_000;
const huntIntervalMs = Number(process.env.HUNTER_INTERVAL_MS) || 30 * 60_000;
const cooldownMs =
  (Number(process.env.OUTREACH_COOLDOWN_DAYS) || 7) * 24 * 60 * 60_000;
const maxPerCycle = Number(process.env.OUTREACH_MAX_PER_CYCLE) || 3;

let lastHeartbeat = new Date().toISOString();
let started = false;
let hunting = false;

function offerText(base: string): string {
  return [
    "Hello from HyperAgent — an autonomous AI task agent that sells completed work for a per-task price.",
    `Agent card: ${base}/.well-known/agent-card.json`,
    `To request work, send an A2A message/send to ${base}/a2a/rpc with the task as text.`,
    "You get an instant quote priced from the task's complexity (add metadata.offeredAmountUsd to negotiate) and a Whop checkout link; the work starts after payment clears and the result is returned via tasks/get.",
    "If you have no task right now, no reply is needed.",
  ].join("\n");
}

async function ensureOutreachEnabled(): Promise<boolean> {
  if (process.env.AUTO_OUTREACH === "false") {
    const [settings] = await db
      .select()
      .from(a2aSettingsTable)
      .where(eq(a2aSettingsTable.id, 1))
      .limit(1);
    return settings?.outreachEnabled === true;
  }
  await db
    .insert(a2aSettingsTable)
    .values({ id: 1, outreachEnabled: true, payoutsEnabled: false })
    .onConflictDoUpdate({
      target: a2aSettingsTable.id,
      set: { outreachEnabled: true, updatedAt: new Date() },
    });
  return true;
}

export async function huntCycle(): Promise<void> {
  if (hunting) return;
  hunting = true;
  try {
    const base = getPublicBaseUrl();
    if (!base) {
      logger.warn(
        "Hunter idle: set PUBLIC_BASE_URL (or enable a Railway public domain) so peers can be told where to send paid tasks",
      );
      return;
    }
    if (!(await ensureOutreachEnabled())) {
      logger.info("Hunter idle: outbound outreach is disabled");
      return;
    }

    const snapshot = getA2aRegistryFeedSnapshot();
    const candidates = snapshot.agents.filter(
      (agent) =>
        agent.verified &&
        agent.outreachOptIn &&
        agent.connectionStatus === "connected" &&
        agent.agentUrl &&
        isVerifiedOutreachOptInUrl(agent.agentUrl),
    );
    logger.info(
      {
        registryStatus: snapshot.status,
        verified: snapshot.verifiedListings,
        optedIn: snapshot.eligibleListings,
        connected: snapshot.connectedListings,
        candidates: candidates.length,
      },
      "Hunter cycle started",
    );

    let contacted = 0;
    for (const agent of candidates) {
      if (contacted >= maxPerCycle) break;
      const agentUrl = agent.agentUrl!;
      const key = agent.registryId.slice(0, 512);
      const [previous] = await db
        .select()
        .from(a2aOutreachTable)
        .where(eq(a2aOutreachTable.agentKey, key))
        .limit(1);
      if (
        previous?.lastContactedAt &&
        Date.now() - previous.lastContactedAt.getTime() < cooldownMs
      ) {
        continue;
      }

      let status = "sent";
      let response = "";
      try {
        const card = await discoverExternalAgent(agentUrl);
        const initial = await sendA2aMessage(card, offerText(base));
        const final = await pollA2aTask(card, initial);
        response = (final.response || `state: ${final.state}`).slice(0, 500);
        status = final.state === "failed" || final.state === "rejected" ? "declined" : "delivered";
      } catch (error) {
        status = "failed";
        response = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
      }
      contacted += 1;

      await db
        .insert(a2aOutreachTable)
        .values({
          agentKey: key,
          agentUrl,
          agentName: agent.name,
          status,
          attempts: 1,
          lastContactedAt: new Date(),
          lastResponse: response,
        })
        .onConflictDoUpdate({
          target: a2aOutreachTable.agentKey,
          set: {
            status,
            attempts: (previous?.attempts ?? 0) + 1,
            lastContactedAt: new Date(),
            lastResponse: response,
          },
        });
      await db.insert(a2aActivityTable).values({
        type: "outbound-offer",
        title: `Offer ${status}: ${agent.name}`.slice(0, 200),
        detail: `Sent a paid-task offer to a registry-verified opt-in agent. Response: ${response || "none"}`,
      });
    }
    logger.info({ contacted }, "Hunter cycle finished");
  } catch (error) {
    logger.error({ err: error }, "Hunter cycle failed; will retry next interval");
  } finally {
    hunting = false;
  }
}

function scheduleHeartbeat(): void {
  const timer = setTimeout(() => {
    lastHeartbeat = new Date().toISOString();
    scheduleHeartbeat();
  }, heartbeatIntervalMs);
  timer.unref();
}

export function startHunterLoop(): void {
  if (started) return;
  started = true;
  lastHeartbeat = new Date().toISOString();
  scheduleHeartbeat();
  logger.info(
    { huntIntervalMs, maxPerCycle, cooldownMs },
    "Hunter started: autonomous outreach to verified opt-in agents enabled",
  );
  // The registry feed needs a minute to fetch agent cards, so first hunt is delayed.
  setTimeout(() => void huntCycle(), 90_000).unref();
  setInterval(() => void huntCycle(), huntIntervalMs).unref();
}

export function getHunterHeartbeat(): string {
  return lastHeartbeat;
}
