import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.ts";

const accountIdParams = z.object({
  id: z.string().regex(/^\d+$/, "id must be a positive integer"),
});

/**
 * Routes the worker calls, not the public internet. This is the
 * container-to-container hop that Phase 10 puts behind Service Connect and a
 * security-group rule allowing only worker-sg -> api-sg.
 */
export async function internalRoutes(app: FastifyInstance) {
  app.get("/internal/accounts/:id", async (request, reply) => {
    const { id } = accountIdParams.parse(request.params);

    const { rows } = await pool.query(
      `SELECT id, type, currency, balance FROM accounts WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: "account not found" });
    }
    return reply.send(rows[0]);
  });
}
