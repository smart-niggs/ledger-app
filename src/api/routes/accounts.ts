import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.ts";

const createAccountBody = z.object({
  type: z.enum(["user", "system"]),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be 3 uppercase letters"),
});

const accountIdParams = z.object({
  id: z.string().regex(/^\d+$/, "id must be a positive integer"),
});

export async function accountRoutes(app: FastifyInstance) {
  app.post("/accounts", async (request, reply) => {
    const body = createAccountBody.parse(request.body);

    const { rows } = await pool.query(
      `INSERT INTO accounts (type, currency) VALUES ($1, $2)
       RETURNING id, type, currency, balance`,
      [body.type, body.currency],
    );

    return reply.code(201).send(rows[0]);
  });

  app.get("/accounts/:id/balance", async (request, reply) => {
    const { id } = accountIdParams.parse(request.params);

    const { rows } = await pool.query(
      `SELECT id, currency, balance FROM accounts WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: "account not found" });
    }
    return reply.send(rows[0]);
  });
}
