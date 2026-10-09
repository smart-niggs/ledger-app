import Fastify from "fastify";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";

const app = Fastify({ logger: true });

app.get("/health/live", async () => ({ ok: true }));

app.get("/health/ready", async (_req, reply) => {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });