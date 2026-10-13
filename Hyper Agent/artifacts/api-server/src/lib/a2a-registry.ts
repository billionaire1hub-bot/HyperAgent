import type { A2aRegistryAgent, A2aRegistryFeed } from "@workspace/api-zod";
import { discoverExternalAgent, fetchPublicA2aJson } from "./a2a-agent-client";
import { logger } from "./logger";

const registrySource = "A2A Registry · global public directory";
const registryUrl = "https://api.a2a-registry.org/public/agents";
const registryPageSize = 10;
const maxRegistryPagesPerSync = 50;
const syncIntervalMs = 15 * 60_000;
const maxCardFetchesPerSync = 5;
const maxCardFetchesPerHour = 10;
const successfulCardTtlMs = 24 * 60 * 60_000;
const failedCardRetryMs = 6 * 60 * 60_000;

type JsonRecord = Record<string, unknown>;

const initialSnapshot: A2aRegistryFeed = {
  source: registrySource,
  status: "unavailable",
  lastSyncedAt: null,
  totalListings: 0,
  skippedUnverified: 0,
  verifiedListings: 0,
  eligibleListings: 0,
  connectedListings: 0,
  agents: [],
  error: "The first registry refresh has not completed yet.",
};

let snapshot: A2aRegistryFeed = initialSnapshot;
let started = false;
let syncing = false;
const cardCache = new Map<
  string,
  { agent: A2aRegistryAgent; checkedAtMs: number; succeeded: boolean }
>();
const cardFetchTimes: number[] = [];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readNestedCard(record: JsonRecord): JsonRecord | undefined {
  const value =
    record.source_agent_card ??
    record.sourceAgentCard ??
    record.agentCard ??
    record.agent_card;
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isVerifiedListing(record: JsonRecord): boolean {
  if (record.isVerified === false || record.verified === false) return false;
  const level = readString(record, ["verification_level", "verificationLevel"])
    ?.toLowerCase();
  return record.isVerified === true || record.verified === true || level === "verified";
}

function hasExplicitOutreachOptIn(record: JsonRecord): boolean {
  const card = readNestedCard(record);
  const sources = [record, card].filter(
    (value): value is JsonRecord => value !== undefined,
  );
  const optInKeys = [
    "outreachOptIn",
    "outreach_opt_in",
    "acceptsOutreach",
    "accepts_outreach",
    "contactOptIn",
    "contact_opt_in",
    "acceptsRequests",
    "accepts_requests",
  ];
  return sources.some((source) => optInKeys.some((key) => source[key] === true));
}

function isPublicHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function getRegistryPage(payload: unknown): {
  entries: JsonRecord[];
  total?: number;
} {
  if (Array.isArray(payload)) {
    return { entries: payload.filter(isRecord) };
  }
  if (!isRecord(payload)) {
    throw new Error("The registry returned an unsupported response.");
  }
  const entries = payload.agents ?? payload.results ?? payload.data;
  if (!Array.isArray(entries)) {
    throw new Error("The registry response did not contain an agent list.");
  }
  const total =
    typeof payload.total === "number" &&
    Number.isSafeInteger(payload.total) &&
    payload.total >= 0
      ? payload.total
      : undefined;
  return { entries: entries.filter(isRecord), total };
}

async function getAllRegistryEntries(): Promise<{
  entries: JsonRecord[];
  totalListings: number;
  truncated: boolean;
}> {
  const firstPage = getRegistryPage(
    await fetchPublicA2aJson(
      `${registryUrl}?limit=${registryPageSize}&page=1`,
    ),
  );
  const totalListings = firstPage.total ?? firstPage.entries.length;
  const requestedPages = Math.max(
    1,
    Math.ceil(totalListings / registryPageSize),
  );
  const pagesToFetch = Math.min(requestedPages, maxRegistryPagesPerSync);
  const entries = [...firstPage.entries];

  for (let page = 2; page <= pagesToFetch; page += 1) {
    const result = getRegistryPage(
      await fetchPublicA2aJson(
        `${registryUrl}?limit=${registryPageSize}&page=${page}`,
      ),
    );
    entries.push(...result.entries);
  }

  const deduplicated = new Map<string, JsonRecord>();
  for (const entry of entries) {
    deduplicated.set(registryIdFor(entry), entry);
  }

  return {
    entries: [...deduplicated.values()],
    totalListings,
    truncated: requestedPages > maxRegistryPagesPerSync,
  };
}

function registryIdFor(record: JsonRecord, agentUrl?: string): string {
  return (
    readString(record, ["id", "registryId", "registry_id", "agentId", "slug"]) ??
    agentUrl ??
    readString(record, ["name", "displayName"]) ??
    "unknown-agent"
  ).slice(0, 512);
}

function candidateFrom(record: JsonRecord): A2aRegistryAgent | null {
  if (!isVerifiedListing(record)) return null;
  const agentUrl = readString(record, [
    "manifestUrl",
    "manifest_url",
    "agentUrl",
    "agent_url",
    "endpointUrl",
    "endpoint_url",
    "url",
  ]);
  const validUrl = isPublicHttpsUrl(agentUrl) ? agentUrl : null;
  const name =
    readString(record, ["displayName", "name", "agentName"]) ??
    (validUrl ? new URL(validUrl).hostname : "Verified agent");
  return {
    registryId: registryIdFor(record, validUrl ?? undefined),
    name: name.slice(0, 200),
    description: (readString(record, ["description", "summary"]) ?? "").slice(
      0,
      2_000,
    ),
    agentUrl: validUrl,
    verified: true,
    outreachOptIn: hasExplicitOutreachOptIn(record),
    connectionStatus: hasExplicitOutreachOptIn(record)
      ? validUrl
        ? "waiting"
        : "connection-failed"
      : "opt-in-required",
    skills: [],
    lastCheckedAt: null,
    connectionError:
      hasExplicitOutreachOptIn(record) && !validUrl
        ? "The verified listing has no valid public HTTPS agent URL."
        : null,
  };
}

function cleanFetchWindow(now: number): void {
  while (cardFetchTimes.length && cardFetchTimes[0]! <= now - 60 * 60_000) {
    cardFetchTimes.shift();
  }
}

async function connectEligibleCards(
  agents: A2aRegistryAgent[],
  now: number,
): Promise<A2aRegistryAgent[]> {
  let fetchedThisSync = 0;
  cleanFetchWindow(now);

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!;
    if (!agent.outreachOptIn) continue;
    const cached = cardCache.get(agent.registryId);
    if (
      cached &&
      now - cached.checkedAtMs <
        (cached.succeeded ? successfulCardTtlMs : failedCardRetryMs)
    ) {
      agents[index] = { ...cached.agent, registryId: agent.registryId };
      continue;
    }
    if (!agent.agentUrl) continue;
    if (
      fetchedThisSync >= maxCardFetchesPerSync ||
      cardFetchTimes.length >= maxCardFetchesPerHour
    ) {
      agents[index] = { ...agent, connectionStatus: "waiting" };
      continue;
    }

    fetchedThisSync += 1;
    cardFetchTimes.push(now);
    try {
      const card = await discoverExternalAgent(agent.agentUrl);
      const connected: A2aRegistryAgent = {
        ...agent,
        name: card.name.slice(0, 200),
        description: card.description.slice(0, 2_000),
        connectionStatus: "connected",
        skills: card.skills,
        lastCheckedAt: new Date(now),
        connectionError: null,
      };
      agents[index] = connected;
      cardCache.set(agent.registryId, {
        agent: connected,
        checkedAtMs: now,
        succeeded: true,
      });
    } catch (error) {
      const failed: A2aRegistryAgent = {
        ...agent,
        connectionStatus: "connection-failed",
        lastCheckedAt: new Date(now),
        connectionError:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Could not safely retrieve the agent card.",
      };
      agents[index] = failed;
      cardCache.set(agent.registryId, {
        agent: failed,
        checkedAtMs: now,
        succeeded: false,
      });
      logger.warn(
        { registryId: agent.registryId },
        "Verified opt-in agent card lookup failed",
      );
    }
  }
  return agents;
}

export async function syncA2aRegistryFeed(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const { entries: listings, totalListings, truncated } =
      await getAllRegistryEntries();
    const verified = listings
      .map(candidateFrom)
      .filter((agent): agent is A2aRegistryAgent => agent !== null);
    const currentIds = new Set(verified.map((agent) => agent.registryId));
    for (const registryId of cardCache.keys()) {
      if (!currentIds.has(registryId)) cardCache.delete(registryId);
    }
    const now = Date.now();
    const agents = await connectEligibleCards(verified, now);
    const eligibleListings = agents.filter((agent) => agent.outreachOptIn).length;
    const connectedListings = agents.filter(
      (agent) => agent.connectionStatus === "connected",
    ).length;
    snapshot = {
      source: registrySource,
      status: agents.some(
        (agent) => agent.connectionStatus === "connection-failed",
      )
        || truncated
        ? "degraded"
        : "ready",
      lastSyncedAt: new Date(now),
      totalListings,
      skippedUnverified: Math.max(0, totalListings - verified.length),
      verifiedListings: verified.length,
      eligibleListings,
      connectedListings,
      agents,
      error: truncated
        ? `The public registry reports ${totalListings} listings. This refresh scanned the first ${maxRegistryPagesPerSync * registryPageSize}; remaining pages are deferred.`
        : null,
    };
    logger.info(
      {
        totalListings: snapshot.totalListings,
        scannedListings: listings.length,
        skippedUnverified: snapshot.skippedUnverified,
        verifiedListings: snapshot.verifiedListings,
        eligibleListings: snapshot.eligibleListings,
        connectedListings: snapshot.connectedListings,
      },
      "Global A2A registry feed refreshed",
    );
    if (truncated) {
      logger.warn(
        { maxRegistryPagesPerSync, totalListings },
        "Global registry scan reached its per-refresh page cap",
      );
    }
  } catch (error) {
    snapshot = {
      ...snapshot,
      status: "degraded",
      error: "The global registry could not be refreshed. The last verified snapshot is retained.",
    };
    logger.warn({ err: error }, "Global A2A registry refresh failed");
  } finally {
    syncing = false;
  }
}

export function getA2aRegistryFeedSnapshot(): A2aRegistryFeed {
  return snapshot;
}

export function isVerifiedOutreachOptInUrl(value: string): boolean {
  try {
    const candidate = new URL(value);
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      candidate.hash
    ) {
      return false;
    }
    const normalizedCandidate = candidate.toString().replace(/\/+$/, "");
    return snapshot.agents.some((agent) => {
      if (!agent.verified || !agent.outreachOptIn || !agent.agentUrl) {
        return false;
      }
      try {
        const registered = new URL(agent.agentUrl);
        return (
          registered.protocol === "https:" &&
          !registered.username &&
          !registered.password &&
          !registered.hash &&
          registered.toString().replace(/\/+$/, "") === normalizedCandidate
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function startA2aRegistryFeed(): void {
  if (started) return;
  started = true;
  void syncA2aRegistryFeed();
  const timer = setInterval(() => void syncA2aRegistryFeed(), syncIntervalMs);
  timer.unref();
  logger.info(
    { intervalMs: syncIntervalMs, source: registrySource },
    "Read-only global A2A registry feed started",
  );
}
