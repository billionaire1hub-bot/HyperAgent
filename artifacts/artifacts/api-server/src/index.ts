import app from "./app";
import { startHunterLoop } from "./lib/hunter";
import { startA2aRegistryFeed } from "./lib/a2a-registry";
import { getConfiguredExecutionMode } from "./lib/a2a-execution";
import { startWhopLedgerSync } from "./lib/whop-ledger";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/schema-bootstrap";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Background failures must be loud: never let a rejected promise vanish silently.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

try {
  await ensureSchema();
} catch (err) {
  logger.fatal({ err }, "Database schema bootstrap failed; check DATABASE_URL");
  process.exit(1);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info(
    {
      port,
      modelProvider: getConfiguredExecutionMode(),
      ownerAuthMode: "signed-bearer",
    },
    "Server listening",
  );
  startHunterLoop();
  startA2aRegistryFeed();
  startWhopLedgerSync();
});
