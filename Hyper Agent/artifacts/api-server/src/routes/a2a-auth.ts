import { Router, type IRouter, type RequestHandler } from "express";
import {
  GetA2aAuthSessionResponse,
  LoginA2aOwnerBody,
  LoginA2aOwnerResponse,
} from "@workspace/api-zod";
import {
  issueOwnerSession,
  ownerAuthIsConfigured,
  readOwnerSession,
  requireOwnerSession,
  revokeOwnerSession,
  verifyOwnerCredentials,
} from "../lib/a2a-auth";

const router: IRouter = Router();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 8;
const maxTrackedLoginClients = 2048;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

const limitLoginAttempts: RequestHandler = (req, res, next) => {
  if (!ownerAuthIsConfigured()) {
    next();
    return;
  }

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let record = loginAttempts.get(key);

  if (!record || record.resetAt <= now) {
    if (loginAttempts.size >= maxTrackedLoginClients) {
      for (const [clientKey, attempt] of loginAttempts) {
        if (attempt.resetAt <= now) loginAttempts.delete(clientKey);
      }
      if (loginAttempts.size >= maxTrackedLoginClients) {
        const oldestKey = loginAttempts.keys().next().value;
        if (oldestKey) loginAttempts.delete(oldestKey);
      }
    }
    record = { count: 0, resetAt: now + loginWindowMs };
    loginAttempts.set(key, record);
  }

  if (record.count >= maxLoginAttempts) {
    res.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil((record.resetAt - now) / 1000)).toString(),
    );
    res.status(429).json({
      error: "Too many sign-in attempts. Try again after the lockout expires.",
    });
    return;
  }

  record.count += 1;
  next();
};

router.get("/session", (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const session = readOwnerSession(req);
  res.json(
    GetA2aAuthSessionResponse.parse({
      authenticated: session !== null,
      configured: ownerAuthIsConfigured(),
      username: session?.username ?? null,
      expiresAt: session?.expiresAt ?? null,
    }),
  );
});

router.post("/login", limitLoginAttempts, (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = LoginA2aOwnerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid username and password." });
    return;
  }
  if (!ownerAuthIsConfigured()) {
    res.status(503).json({
      error:
        "Owner sign-in is not configured. Add a strong A2A_OWNER_PASSWORD in Replit Secrets.",
    });
    return;
  }

  const username = verifyOwnerCredentials(
    parsed.data.username,
    parsed.data.password,
  );
  if (!username) {
    res.status(401).json({ error: "The username or password is incorrect." });
    return;
  }

  const session = issueOwnerSession();
  if (!session) {
    res.status(503).json({ error: "Owner sign-in is not configured." });
    return;
  }

  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  loginAttempts.delete(clientKey);
  res.json(
    LoginA2aOwnerResponse.parse({
      authenticated: true,
      username,
      expiresAt: session.expiresAt,
      accessToken: session.accessToken,
    }),
  );
});

router.post("/logout", requireOwnerSession, (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  revokeOwnerSession(req);
  res.status(204).end();
});

export default router;
