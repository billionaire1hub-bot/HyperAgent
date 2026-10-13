# Deploy checklist (Railway)
1. Set the variables in .env.example in Railway (never commit a real .env).
2. Whop dashboard: webhook for `payment.succeeded` -> https://<domain>/api/webhooks/whop ; API key needs checkout_configuration:create + payment read scopes.
3. Build: pnpm build. Start command: node --enable-source-maps artifacts/api-server/dist/index.mjs. Healthcheck path: /api/healthz. Tables are created automatically on boot (schema-bootstrap.ts).
4. Check logs for "Database schema verified", "Hunter started", "Hunter cycle started".
5. Smoke test: POST /api/public/tasks {"taskText":"..."} -> pay the checkout_url yourself -> poll GET /api/public/tasks/:id.
Not yet run against live Whop/Postgres: test with one small real payment first.
