import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  // Where the worker reaches the api. Localhost on the laptop, `api` in Compose,
  // and the Service Connect name in ECS - never a hardcoded address in code.
  LEDGER_API_URL: z.string().url().default("http://127.0.0.1:3000"),
  WORKER_POLL_MS: z.coerce.number().default(500),
});

export const config = schema.parse(process.env);
