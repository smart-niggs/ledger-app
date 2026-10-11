import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { accountRoutes } from "./routes/accounts.ts";
import { transferRoutes } from "./routes/transfers.ts";
import { internalRoutes } from "./routes/internal.ts";

const app = Fastify({
  logger: {
    // pino writes JSON to stdout, which is what CloudWatch ingests from a
    // container. Nothing here may carry a secret.
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
  // Behind an ALB, reuse the inbound id so one request is traceable across the
  // load balancer, the api task and (from Phase 2) the worker.
  genReqId: (req) => {
    const header = req.headers["x-request-id"];
    return typeof header === "string" && header.length > 0 ? header : randomUUID();
  },
});

app.setErrorHandler((err, request, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request", details: err.issues });
  }
  request.log.error(err);
  return reply.code(500).send({ error: "internal error" });
});

app.get("/health/live", async () => ({ ok: true }));

app.get("/health/ready", async (_req, reply) => {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

await app.register(accountRoutes);
await app.register(transferRoutes);
await app.register(internalRoutes);

/**
 * ECS sends SIGTERM, waits `stopTimeout`, then SIGKILLs. Draining inside that
 * window is what makes a deploy invisible to callers: stop accepting new work,
 * let in-flight requests finish, close the pool, exit 0.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutdown: draining in-flight requests");

  // Exit on our own terms rather than being killed mid-request.
  const force = setTimeout(() => {
    app.log.error("shutdown: drain timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    await app.close(); // stops accepting connections, waits for in-flight handlers
    await pool.end(); // closes pooled database connections
    app.log.info("shutdown: clean");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "shutdown: failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
