import { lookup } from "node:dns/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  DiscoverA2aAgentResponse,
  type A2aAgentCard,
} from "@workspace/api-zod";

const maxResponseBytes = 1_000_000;
const requestTimeoutMs = 12_000;
const maxTaskWaitMs = 45_000;
const taskPollIntervalMs = 1_500;
const webhookLifetimeMs = 10 * 60_000;
const maxPendingWebhooks = 500;

type JsonObject = Record<string, unknown>;
type A2aTaskState =
  | "completed"
  | "failed"
  | "working"
  | "submitted"
  | "input-required"
  | "auth-required"
  | "canceled"
  | "rejected"
  | "unknown";

export interface A2aMessageResult {
  taskId: string | null;
  state: A2aTaskState;
  response: string;
}

interface PendingWebhook {
  tokenDigest: Buffer;
  expiresAt: number;
  resolve: (response: string) => void;
  timer: NodeJS.Timeout;
}

const pendingWebhooks = new Map<string, PendingWebhook>();

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  const firstGroup = Number.parseInt(normalized.split(":")[0] || "0", 16);
  // Only global unicast IPv6 addresses are accepted. This excludes loopback,
  // link-local, ULA, IPv4-mapped, multicast, and transition ranges.
  return (
    firstGroup >= 0x2000 &&
    firstGroup <= 0x3fff &&
    !normalized.startsWith("2001:db8:") &&
    !normalized.startsWith("2001:0:") &&
    !normalized.startsWith("2001:10:")
  );
}

async function resolvePublicAddress(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("Only public HTTPS agent endpoints are supported.");
  }

  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await lookup(host, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((item) => !isPublicAddress(item.address))
  ) {
    throw new Error("The agent host must resolve only to public IP addresses.");
  }
  return addresses[0]!;
}

function httpsJsonRequest(
  urlText: string,
  method: "GET" | "POST",
  body?: JsonObject,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      reject(new Error("The agent URL is invalid."));
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      reject(new Error("Agent endpoints must use HTTPS without URL credentials."));
      return;
    }

    void resolvePublicAddress(url.hostname).then(
      (addressInfo) => {
        const lookupPinned: LookupFunction = (_hostname, options, callback) => {
          if (options && typeof options === "object" && "all" in options && options.all) {
            callback(null, [
              {
                address: addressInfo.address,
                family: addressInfo.family,
              },
            ]);
            return;
          }
          callback(null, addressInfo.address, addressInfo.family);
        };
        const payload = body ? JSON.stringify(body) : undefined;
        const request = httpsRequest(
          url,
          {
            method,
            agent: false,
            lookup: lookupPinned,
            timeout: requestTimeoutMs,
            headers: {
              accept: "application/json",
              ...(payload
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                  }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let responseBytes = 0;
            response.on("data", (chunk: Buffer | string) => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              responseBytes += buffer.length;
              if (responseBytes > maxResponseBytes) {
                request.destroy(new Error("Agent response exceeded the size limit."));
                return;
              }
              chunks.push(buffer);
            });
            response.on("end", () => {
              const statusCode = response.statusCode ?? 0;
              if (statusCode < 200 || statusCode >= 300) {
                reject(new Error(`Agent returned HTTP ${statusCode}.`));
                return;
              }
              const text = Buffer.concat(chunks).toString("utf8");
              try {
                resolve(JSON.parse(text) as unknown);
              } catch {
                reject(new Error("Agent returned invalid JSON."));
              }
            });
          },
        );
        request.on("timeout", () =>
          request.destroy(new Error("External agent request timed out.")),
        );
        request.on("error", reject);
        if (payload) request.write(payload);
        request.end();
      },
      () => reject(new Error("The agent host could not be safely resolved.")),
    );
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 4_000) : fallback;
}

function normalizeCard(raw: unknown, cardUrl: string): A2aAgentCard {
  if (
    !isObject(raw) ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    typeof raw.url !== "string" ||
    !raw.url.trim()
  ) {
    throw new Error("The endpoint did not return a valid A2A agent card.");
  }
  const skills = Array.isArray(raw.skills)
    ? raw.skills.slice(0, 100).flatMap((entry, index) => {
        if (!isObject(entry)) return [];
        const name = safeString(entry.name, safeString(entry.id, `Skill ${index + 1}`));
        return [
          {
            id: safeString(entry.id, `skill-${index + 1}`),
            name,
            description: safeString(entry.description),
            ...(Array.isArray(entry.tags)
              ? {
                  tags: entry.tags
                    .filter((tag): tag is string => typeof tag === "string")
                    .slice(0, 20),
                }
              : {}),
          },
        ];
      })
    : [];
  let endpoint: string;
  try {
    endpoint = new URL(raw.url, cardUrl).toString();
  } catch {
    throw new Error("The agent card contains an invalid endpoint URL.");
  }

  return DiscoverA2aAgentResponse.parse({
    name: raw.name.trim().slice(0, 256),
    url: endpoint,
    description: safeString(raw.description),
    ...(typeof raw.version === "string"
      ? { version: raw.version.slice(0, 100) }
      : {}),
    skills,
  });
}

function getCardUrl(agentUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(agentUrl);
  } catch {
    throw new Error("Enter a valid HTTPS URL for the agent.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Agent endpoints must use HTTPS without URL credentials.");
  }
  if (
    parsed.pathname.endsWith("/.well-known/agent-card.json") ||
    parsed.pathname.endsWith("/.well-known/agent.json")
  ) {
    return parsed.toString();
  }
  return new URL("/.well-known/agent-card.json", parsed.origin).toString();
}

export function fetchPublicA2aJson(urlText: string): Promise<unknown> {
  return httpsJsonRequest(urlText, "GET");
}

export async function discoverExternalAgent(
  agentUrl: string,
): Promise<A2aAgentCard> {
  const cardUrl = getCardUrl(agentUrl);
  let raw: unknown;
  try {
    raw = await httpsJsonRequest(cardUrl, "GET");
  } catch (error) {
    const isNotFound =
      error instanceof Error && error.message === "Agent returned HTTP 404.";
    const enteredLegacyCard =
      new URL(agentUrl).pathname.endsWith("/.well-known/agent.json");
    if (!isNotFound || enteredLegacyCard) {
      throw error instanceof Error &&
        error.message.startsWith("Agent returned HTTP ")
        ? error
        : new Error("Could not safely reach the external agent card.");
    }
    const legacyCardUrl = new URL("/.well-known/agent.json", new URL(agentUrl).origin);
    raw = await httpsJsonRequest(legacyCardUrl.toString(), "GET");
  }
  return normalizeCard(raw, cardUrl);
}

function extractText(value: unknown): string {
  if (!isObject(value)) return "";
  const pieces: string[] = [];
  const collectParts = (partList: unknown) => {
    if (!Array.isArray(partList)) return;
    for (const part of partList) {
      if (!isObject(part)) continue;
      if (
        (part.kind === "text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        pieces.push(part.text);
      }
    }
  };

  collectParts(value.parts);
  if (isObject(value.message)) collectParts(value.message.parts);
  if (isObject(value.status) && isObject(value.status.message)) {
    collectParts(value.status.message.parts);
  }
  if (Array.isArray(value.artifacts)) {
    for (const artifact of value.artifacts) {
      if (isObject(artifact)) collectParts(artifact.parts);
    }
  }
  return pieces.join("\n\n").trim().slice(0, 50_000);
}

function parseMessageResult(raw: unknown): A2aMessageResult {
  if (!isObject(raw)) throw new Error("The external agent returned an invalid A2A response.");
  if (isObject(raw.error)) {
    throw new Error("The external agent rejected the A2A request.");
  }
  const result = isObject(raw.result) ? raw.result : raw;
  const status = isObject(result.status) ? result.status : null;
  const stateValue = status?.state;
  const state: A2aTaskState =
    stateValue === "completed" ||
    stateValue === "failed" ||
    stateValue === "working" ||
    stateValue === "submitted" ||
    stateValue === "input-required" ||
    stateValue === "auth-required" ||
    stateValue === "canceled" ||
    stateValue === "rejected"
      ? stateValue
      : status
        ? "unknown"
        : "completed";
  const taskId =
    typeof result.id === "string"
      ? result.id
      : typeof result.taskId === "string"
        ? result.taskId
        : null;
  const response =
    extractText(result) ||
    (status && typeof status.message === "string" ? status.message : "");
  return { taskId, state, response };
}

async function callAgent(
  card: A2aAgentCard,
  method: string,
  params: JsonObject,
): Promise<unknown> {
  const reply = await httpsJsonRequest(card.url, "POST", {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params,
  });
  if (isObject(reply) && isObject(reply.error)) {
    throw new Error("The external agent rejected the A2A request.");
  }
  return reply;
}

export async function sendA2aMessage(
  card: A2aAgentCard,
  text: string,
  metadata?: JsonObject,
): Promise<A2aMessageResult> {
  const messageId = randomUUID();
  const result = await callAgent(card, "message/send", {
    message: {
      messageId,
      role: "user",
      parts: [{ kind: "text", text }],
      ...(metadata ? { metadata } : {}),
    },
    configuration: { acceptedOutputModes: ["text/plain"] },
  });
  return parseMessageResult(result);
}

export async function pollA2aTask(
  card: A2aAgentCard,
  initial: A2aMessageResult,
): Promise<A2aMessageResult> {
  if (!initial.taskId || !["working", "submitted", "unknown"].includes(initial.state)) {
    return initial;
  }
  const deadline = Date.now() + maxTaskWaitMs;
  let latest = initial;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, taskPollIntervalMs));
    const raw = await callAgent(card, "tasks/get", { id: initial.taskId });
    latest = parseMessageResult(raw);
    if (
      !["working", "submitted", "unknown", "input-required", "auth-required"].includes(
        latest.state,
      )
    ) {
      return latest;
    }
    if (latest.state === "input-required" || latest.state === "auth-required") {
      return latest;
    }
  }
  return { ...latest, state: "working" };
}

export function createWebhookDelivery(
  deliveryId: string,
  callbackBaseUrl: string | null,
): {
  metadata?: JsonObject;
  waitForResponse: Promise<string>;
  remove: () => void;
} {
  if (!callbackBaseUrl) {
    return { waitForResponse: new Promise(() => {}), remove: () => {} };
  }

  const token = randomBytes(32).toString("base64url");
  const tokenDigest = createHash("sha256").update(token).digest();
  let resolveResponse!: (response: string) => void;
  const waitForResponse = new Promise<string>((resolve) => {
    resolveResponse = resolve;
  });
  const timer = setTimeout(() => pendingWebhooks.delete(deliveryId), webhookLifetimeMs);
  timer.unref();
  if (pendingWebhooks.size >= maxPendingWebhooks) {
    const oldestId = pendingWebhooks.keys().next().value;
    if (oldestId) {
      const oldest = pendingWebhooks.get(oldestId);
      if (oldest) clearTimeout(oldest.timer);
      pendingWebhooks.delete(oldestId);
    }
  }
  pendingWebhooks.set(deliveryId, {
    tokenDigest,
    expiresAt: Date.now() + webhookLifetimeMs,
    resolve: resolveResponse,
    timer,
  });
  return {
    metadata: {
      hyperagentCallback: {
        url: `${callbackBaseUrl.replace(/\/+$/, "")}/api/a2a/webhooks/agent-response/${deliveryId}`,
        token,
        expiresInSeconds: webhookLifetimeMs / 1000,
      },
    },
    waitForResponse,
    remove: () => {
      const entry = pendingWebhooks.get(deliveryId);
      if (entry) clearTimeout(entry.timer);
      pendingWebhooks.delete(deliveryId);
    },
  };
}

export function acceptAgentWebhook(
  deliveryId: string,
  token: string,
  result: string,
): boolean {
  const pending = pendingWebhooks.get(deliveryId);
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) clearTimeout(pending.timer);
    pendingWebhooks.delete(deliveryId);
    return false;
  }
  const actualDigest = createHash("sha256").update(token).digest();
  if (!timingSafeEqual(actualDigest, pending.tokenDigest)) return false;
  clearTimeout(pending.timer);
  pendingWebhooks.delete(deliveryId);
  pending.resolve(result.slice(0, 50_000));
  return true;
}

export function newWebhookDeliveryId(): string {
  return randomUUID();
}

export function publicCallbackBaseUrl(
  configuredBaseUrl: string | undefined,
  requestProtocol: string,
  requestHost: string | undefined,
): string | null {
  const candidate = configuredBaseUrl?.trim()
    ? configuredBaseUrl.trim()
    : requestHost
      ? `${requestProtocol}://${requestHost}`
      : "";
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}
