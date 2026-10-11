import type { PoolClient } from "pg";
import { pool } from "./pool.ts";

/**
 * Runs `fn` inside a single database transaction.
 *
 * pool.query() checks out a different connection per call, so BEGIN on one
 * connection and INSERT on another would not be in the same transaction.
 * Everything here uses one checked-out client, released in finally.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
