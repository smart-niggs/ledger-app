import type { PoolClient } from "pg";
import { withTransaction } from "../db/tx.ts";

export type TransferInput = {
  key: string;
  requestHash: string;
  fromId: string;
  toId: string;
  amount: bigint;
};

export type TransferKind =
  | "created"
  | "replayed"
  | "in_progress"
  | "hash_mismatch"
  | "account_not_found"
  | "currency_mismatch"
  | "insufficient_funds"
  | "same_account";

export type TransferResult = {
  kind: TransferKind;
  code: number;
  body: unknown;
};

const FAILURES = {
  account_not_found: { code: 404, body: { error: "account not found" } },
  currency_mismatch: { code: 422, body: { error: "currency mismatch" } },
  insufficient_funds: { code: 422, body: { error: "insufficient funds" } },
  same_account: { code: 422, body: { error: "from and to must differ" } },
} as const;

type FailureKind = keyof typeof FAILURES;

/** Store the failure as this key's answer, so a retry replays it instead of re-trying. */
async function recordFailure(
  client: PoolClient,
  key: string,
  kind: FailureKind,
): Promise<TransferResult> {
  const { code, body } = FAILURES[kind];
  await client.query(
    `UPDATE idempotency_keys SET response_code = $1, response_body = $2 WHERE key = $3`,
    [code, JSON.stringify(body), key],
  );
  return { kind, code, body };
}

export function transfer(input: TransferInput): Promise<TransferResult> {
  return withTransaction(async (client) => {
    // 1. Claim the key. The PRIMARY KEY is the concurrency control: zero rows
    //    back means someone else already owns it.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING key`,
      [input.key, input.requestHash],
    );

    if (claim.rowCount === 0) {
      // FOR UPDATE blocks until the holder commits or rolls back.
      const { rows } = await client.query(
        `SELECT request_hash, response_code, response_body
           FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
        [input.key],
      );
      const prior = rows[0];

      if (!prior) {
        // Holder rolled back after we lost the claim. Safe answer: retry.
        return { kind: "in_progress", code: 409, body: { error: "request in progress, retry" } };
      }
      if (prior.request_hash !== input.requestHash) {
        return {
          kind: "hash_mismatch",
          code: 422,
          body: { error: "idempotency key reused with a different request" },
        };
      }
      if (prior.response_code === null) {
        return { kind: "in_progress", code: 409, body: { error: "request in progress, retry" } };
      }
      return { kind: "replayed", code: prior.response_code, body: prior.response_body };
    }

    if (input.fromId === input.toId) {
      return recordFailure(client, input.key, "same_account");
    }

    // 2. Lock both accounts, lowest id first. The ORDER BY is the deadlock
    //    avoidance: concurrent A->B and B->A both take the lower id first.
    const locked = await client.query(
      `SELECT id, type, currency, balance FROM accounts
        WHERE id = ANY($1::bigint[])
        ORDER BY id
          FOR UPDATE`,
      [[input.fromId, input.toId]],
    );

    if (locked.rowCount !== 2) {
      return recordFailure(client, input.key, "account_not_found");
    }

    const from = locked.rows.find((r) => r.id === input.fromId);
    const to = locked.rows.find((r) => r.id === input.toId);

    if (from.currency !== to.currency) {
      return recordFailure(client, input.key, "currency_mismatch");
    }
    // System accounts represent the outside world and may go negative.
    if (from.type !== "system" && BigInt(from.balance) < input.amount) {
      return recordFailure(client, input.key, "insufficient_funds");
    }

    // 3. The money. The deferred trigger re-checks sum-to-zero at COMMIT.
    const txn = await client.query(`INSERT INTO transactions DEFAULT VALUES RETURNING id`);
    const transactionId: string = txn.rows[0].id;
    const amount = input.amount.toString();

    await client.query(
      `INSERT INTO entries (transaction_id, account_id, amount)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [transactionId, input.fromId, (-input.amount).toString(), input.toId, amount],
    );

    await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [
      amount,
      input.fromId,
    ]);
    await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [
      amount,
      input.toId,
    ]);

    const body = {
      transactionId,
      from: input.fromId,
      to: input.toId,
      amount,
      currency: from.currency,
    };

    // 4. The event, in the SAME transaction as the money. This is the whole
    //    point of an outbox: if the COMMIT fails, the event never existed, and
    //    there is no window where money moved but no notification was recorded.
    //    Phase 2's worker polls this table with FOR UPDATE SKIP LOCKED.
    await client.query(
      `INSERT INTO outbox (event_type, payload, transaction_id) VALUES ($1, $2, $3)`,
      ["transfer.completed", JSON.stringify(body), transactionId],
    );

    await client.query(
      `UPDATE idempotency_keys
          SET transaction_id = $1, response_code = $2, response_body = $3
        WHERE key = $4`,
      [transactionId, 201, JSON.stringify(body), input.key],
    );

    return { kind: "created", code: 201, body };
  });
}
