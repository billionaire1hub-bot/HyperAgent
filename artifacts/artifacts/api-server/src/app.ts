import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import a2aRouter from "./routes/a2a";
import a2aPublicRouter from "./routes/a2a-public";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(
  express.json({
    limit: "64kb",
    // Whop signs the exact raw bytes; keep them for webhook verification.
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Public, payment-gated endpoints (agent card, A2A RPC, Whop webhook) come first.
app.use(a2aPublicRouter);
app.use("/api", router);
app.use("/a2a", a2aRouter);

app.use((_req, res): void => {
  res.status(404).json({ error: "API endpoint not found." });
});

const handleApiError: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const candidateStatus =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 500;
  const status =
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus < 600
      ? candidateStatus
      : 500;

  logger.error(
    { err: error, method: req.method, path: req.path, status },
    "API request failed",
  );
  res.status(status).json({
    error:
      status >= 500
        ? "The server could not complete the request."
        : "The request could not be processed.",
  });
};

app.use(handleApiError);

export default app;
