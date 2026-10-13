import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.ts";
import { transfer } from "../src/ledger/transfer.ts";

// 50 calls are issued at once, but pg's default pool max is 10, so the real
// concurrency is 10 transactions in flight with 40 queued on pool.connect().
// That is exactly what the api does under load - raising the pool to make the
// number bigger would test a configuration nobody runs.
const PARALLEL = 50;

// Every one of the 50 contends for the same two row locks, so they serialise.
// Generous on purpose: a cold CI runner is slow, and a flaky timeout here reads
// as a broken invariant.
const TIMEOUT_MS = 120_000;

after(() => pool.end());

/** Mirrors requestHash in src/api/routes/transfers.ts, which does not export it. */
function hashOf(from: string, to: string, amount: string): string {
  return createHash("sha256").update(JSON.stringify([from, to, amount])).digest("hex");
}

async function newAccount(type: "user" | "system", currency = "NGN"): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (type, currency) VALUES ($1, $2) RETURNING id`,
    [type, currency],
  );
  return rows[0].id; // pg hands BIGINT back as a string
}

/** A system account may go negative, so it funds a user account from zero. */
async function fund(accountId: string, amount: bigint): Promise<void> {
  const source = await newAccount("system");
  const result = await transfer({
    key: randomUUID(),
    requestHash: hashOf(source, accountId, amount.toString()),
    fromId: source,
    toId: accountId,
    amount,
  });
  assert.equal(result.kind, "created");
}

async function balanceOf(accountId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT balance::text FROM accounts WHERE id = $1`, [accountId]);
  return rows[0].balance;
}

async function txnCount(accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT transaction_id)::int AS n FROM entries WHERE account_id = $1`,
    [accountId],
  );
  return rows[0].n;
}

/** The North Star: every committed transaction balances, so the table sums to zero. */
async function assertLedgerBalanced(): Promise<void> {
  const { rows } = await pool.query(`SELECT COALESCE(SUM(amount), 0)::text AS total FROM entries`);
  assert.equal(rows[0].total, "0", "entries no longer sum to zero");
}

/**
 * allSettled, not all: a deadlock victim is aborted with SQLSTATE 40P01, and the
 * point is to name it rather than let one rejection mask the other 49 outcomes.
 */
async function settle(calls: Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(calls);
  const failures = settled
    .filter((s): s is PromiseRejectedResult => s.status === "rejected")
    .map((s) => `${(s.reason as { code?: string }).code ?? "?"}: ${(s.reason as Error).message}`);
  assert.deepEqual(failures, [], "no call may fail - 40P01 means the lock ordering broke");
}

test("50 parallel transfers between two accounts", { timeout: TIMEOUT_MS }, async () => {
  const from = await newAccount("user");
  const to = await newAccount("user");
  const opening = 100_000n;
  const amount = 100n;
  await fund(from, opening);

  const calls = Array.from({ length: PARALLEL }, () =>
    transfer({
      key: randomUUID(),
      requestHash: hashOf(from, to, amount.toString()),
      fromId: from,
      toId: to,
      amount,
    }),
  );
  await settle(calls);

  const results = await Promise.all(calls);
  assert.equal(
    results.filter((r) => r.kind === "created").length,
    PARALLEL,
    "distinct keys, funded account: every call should have moved money",
  );

  const moved = amount * BigInt(PARALLEL);
  assert.equal(await balanceOf(to), moved.toString());
  assert.equal(await balanceOf(from), (opening - moved).toString());
  assert.equal(await txnCount(to), PARALLEL);
  await assertLedgerBalanced();
});

test("concurrent A->B and B->A on the same pair", { timeout: TIMEOUT_MS }, async () => {
  const a = await newAccount("user");
  const b = await newAccount("user");
  const opening = 50_000n;
  await fund(a, opening);
  await fund(b, opening);

  // The classic deadlock: without a deterministic lock order one transaction
  // holds a and waits for b while its opposite holds b and waits for a. The
  // amounts differ per direction so a lost update cannot cancel out and hide.
  const each = PARALLEL / 2;
  const aToB = 100n;
  const bToA = 40n;

  const calls = Array.from({ length: each }, () => [
    transfer({
      key: randomUUID(),
      requestHash: hashOf(a, b, aToB.toString()),
      fromId: a,
      toId: b,
      amount: aToB,
    }),
    transfer({
      key: randomUUID(),
      requestHash: hashOf(b, a, bToA.toString()),
      fromId: b,
      toId: a,
      amount: bToA,
    }),
  ]).flat();
  await settle(calls);

  const net = (aToB - bToA) * BigInt(each);
  assert.equal(await balanceOf(a), (opening - net).toString());
  assert.equal(await balanceOf(b), (opening + net).toString());
  assert.equal(await txnCount(a), each * 2 + 1); // both directions, plus the funding
  await assertLedgerBalanced();
});
