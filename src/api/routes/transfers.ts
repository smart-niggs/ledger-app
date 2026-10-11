import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transfer } from "../../ledger/transfer.ts";

const transferBody = z.object({
  from: z.string().regex(/^\d+$/, "from must be a positive integer string"),
  to: z.string().regex(/^\d+$/, "to must be a positive integer string"),
  amount: z.string().regex(/^[1-9]\d*$/, "amount must be a positive integer string of kobo"),
});

/**
 * Hash a canonical form, not the raw bytes: a client that reorders JSON keys
 * or changes whitespace must still hash to the same value, or honest retries
 * would be rejected as key reuse.
 */
function requestHash(body: z.infer<typeof transferBody>): string {
  const canonical = JSON.stringify([body.from, body.to, body.amount]);
  return createHash("sha256").update(canonical).digest("hex");
}

export async function transferRoutes(app: FastifyInstance) {
  app.post("/transfers", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.code(400).send({ error: "Idempotency-Key header is required" });
    }

    const body = transferBody.parse(request.body);

    const result = await transfer({
      key,
      requestHash: requestHash(body),
      fromId: body.from,
      toId: body.to,
      amount: BigInt(body.amount),
    });

    return reply.code(result.code).send(result.body);
  });
}
