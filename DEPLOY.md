# Deploy checklist (Railway)
1. Set the variables in .env.example in Railway (never commit a real .env).
2. Whop dashboard: webhook for `payment.succeeded` -> https://<domain>/api/webhooks/whop ; API key needs checkout_configuration:create + payment read scopes.
3. Start command: node --enable-source-maps artifacts/artifacts/api-server/dist/index.mjs (build: pnpm --filter @workspace/api-server run build).
4. Check logs for "Database schema verified", "Hunter started", "Hunter cycle started".
5. Smoke test: POST /api/public/tasks {"taskText":"..."} -> pay the checkout_url yourself -> poll GET /api/public/tasks/:id.
Not yet run against live Whop/Postgres: test with one small real payment first.
