import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const minimumSessionSecretLength = 32;
const maxRevokedAccessTokens = 4096;

interface OwnerAuthConfig {
  username: string;
  password: string;
  sessionSecret: string;
}

interface OwnerSessionPayload {
  username: string;
  expiresAt: number;
  credentialVersion: string;
}

export interface OwnerSession {
  username: string;
  expiresAt: string;
}

export interface IssuedOwnerSession extends OwnerSession {
  accessToken: string;
}

const revokedAccessTokens = new Map<string, number>();

function getOwnerAuthConfig(): OwnerAuthConfig | null {
  const username = process.env.A2A_OWNER_USERNAME?.trim() || "owner";
  const password = process.env.A2A_OWNER_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;

  if (
    !password ||
    !sessionSecret ||
    sessionSecret.length < minimumSessionSecretLength
  ) {
    return null;
  }

  return { username, password, sessionSecret };
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function textMatchesConstantTime(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function credentialVersion(config: OwnerAuthConfig): string {
  return createHmac("sha256", config.sessionSecret)
    .update(config.password, "utf8")
    .digest("base64url");
}

function signingKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret)
    .update("hyperagent-a2a-owner-access-token-v1", "utf8")
    .digest();
}

function signPayload(encodedPayload: string, sessionSecret: string): Buffer {
  return createHmac("sha256", signingKey(sessionSecret))
    .update(encodedPayload, "utf8")
    .digest();
}

function signaturesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBearerToken(req: Request): string | null {
  const authorization = req.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function accessTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function pruneRevokedAccessTokens(now: number): void {
  for (const [fingerprint, expiresAt] of revokedAccessTokens) {
    if (expiresAt <= now) revokedAccessTokens.delete(fingerprint);
  }
  while (revokedAccessTokens.size > maxRevokedAccessTokens) {
    const oldestFingerprint = revokedAccessTokens.keys().next().value;
    if (!oldestFingerprint) break;
    revokedAccessTokens.delete(oldestFingerprint);
  }
}

export function ownerAuthIsConfigured(): boolean {
  return getOwnerAuthConfig() !== null;
}

export function configuredOwnerUsername(): string | null {
  return getOwnerAuthConfig()?.username ?? null;
}

export function verifyOwnerCredentials(
  username: string,
  password: string,
): string | null {
  const config = getOwnerAuthConfig();
  if (!config) return null;

  const usernameMatches =
    normalizeUsername(username) === normalizeUsername(config.username);
  const passwordMatches = textMatchesConstantTime(password, config.password);

  return usernameMatches && passwordMatches ? config.username : null;
}

export function issueOwnerSession(): IssuedOwnerSession | null {
  const config = getOwnerAuthConfig();
  if (!config) return null;

  const expiresAtMs = Date.now() + sessionLifetimeMs;
  const payload: OwnerSessionPayload = {
    username: config.username,
    expiresAt: expiresAtMs,
    credentialVersion: credentialVersion(config),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = signPayload(encodedPayload, config.sessionSecret).toString(
    "base64url",
  );

  return {
    username: config.username,
    expiresAt: new Date(expiresAtMs).toISOString(),
    accessToken: `${encodedPayload}.${signature}`,
  };
}

export function readOwnerSession(req: Request): OwnerSession | null {
  const config = getOwnerAuthConfig();
  const token = readBearerToken(req);
  if (!config || !token || token.length > 2048) return null;

  const now = Date.now();
  pruneRevokedAccessTokens(now);
  if (revokedAccessTokens.has(accessTokenFingerprint(token))) return null;

  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;

  let actualSignature: Buffer;
  let payload: OwnerSessionPayload;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = signPayload(
      encodedPayload,
      config.sessionSecret,
    );
    if (!signaturesMatch(actualSignature, expectedSignature)) return null;

    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as OwnerSessionPayload;
  } catch {
    return null;
  }

  if (
    payload.username !== config.username ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= now ||
    typeof payload.credentialVersion !== "string" ||
    !textMatchesConstantTime(
      payload.credentialVersion,
      credentialVersion(config),
    )
  ) {
    return null;
  }

  return {
    username: payload.username,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export function revokeOwnerSession(req: Request): void {
  const token = readBearerToken(req);
  if (!token || !readOwnerSession(req)) return;

  const now = Date.now();
  pruneRevokedAccessTokens(now);
  revokedAccessTokens.set(
    accessTokenFingerprint(token),
    now + sessionLifetimeMs,
  );
  pruneRevokedAccessTokens(now);
}

export const requireOwnerSession: RequestHandler = (req, res, next) => {
  if (!ownerAuthIsConfigured()) {
    res.status(503).json({ error: "Owner sign-in is not configured." });
    return;
  }
  if (!readOwnerSession(req)) {
    res.status(401).json({ error: "Owner access token is required." });
    return;
  }
  next();
};
