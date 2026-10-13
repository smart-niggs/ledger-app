import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.ts";
import { transfer } from "../src/ledger/transfer.ts";

// These run against a live database that already holds rows, and node:test runs
// files in parallel. So: no TRUNCATE (a trigger rejects it), no outer transaction
// to roll back (transfer owns its own), and no assertion on anything but ids this
// file created. The one global assertion is SUM(entries.amount) = 0, which is safe
// at READ COMMITTED because only balanced transactions are ever visible.

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
async function fund(accountId: string, amount: bigint, currency = "NGN"): Promise<void> {
  const source = await newAccount("system", currency);
  const result = await transfer({
    key: randomUUID(),
    requestHash: hashOf(source, accountId, amount.toString()),
    fromId: source,
    toId: accountId,
    amount,
  });
  // simulate test error to block CI
  assert.equal(result.kind, "not created");
}

async function balanceOf(accountId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT balance::text FROM accounts WHERE id = $1`, [accountId]);
  return rows[0].balance;
}

/** Transactions that touched this account - the only count that is ours to assert. */
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

test("same key and same body: one transaction, the second call replays it", async () => {
  const from = await newAccount("user");
  const to = await newAccount("user");
  await fund(from, 500n);

  const input = {
    key: randomUUID(),
    requestHash: hashOf(from, to, "200"),
    fromId: from,
    toId: to,
    amount: 200n,
  };

  const first = await transfer(input);
  const second = await transfer(input);

  assert.equal(first.kind, "created");
  assert.equal(first.code, 201);
  assert.equal(second.kind, "replayed");
  assert.equal(second.code, 201);

  const firstBody = first.body as { transactionId: string };
  const secondBody = second.body as { transactionId: string };
  assert.equal(secondBody.transactionId, firstBody.transactionId);

  // `to` was only ever the destination of this transfer, so one transaction is
  // the whole story: the replay wrote no money.
  assert.equal(await txnCount(to), 1);
  assert.equal(await balanceOf(to), "200");
  assert.equal(await balanceOf(from), "300");
  await assertLedgerBalanced();
});

test("same key and a different body: 422 hash mismatch", async () => {
  const from = await newAccount("user");
  const to = await newAccount("user");
  await fund(from, 500n);

  const key = randomUUID();
  const first = await transfer({
    key,
    requestHash: hashOf(from, to, "100"),
    fromId: from,
    toId: to,
    amount: 100n,
  });
  assert.equal(first.kind, "created");

  const second = await transfer({
    key,
    requestHash: hashOf(from, to, "400"),
    fromId: from,
    toId: to,
    amount: 400n,
  });

  assert.equal(second.kind, "hash_mismatch");
  assert.equal(second.code, 422);
  assert.deepEqual(second.body, { error: "idempotency key reused with a different request" });

  assert.equal(await txnCount(to), 1);
  assert.equal(await balanceOf(to), "100");
  await assertLedgerBalanced();
});

test("overdraft from a user account: 422 insufficient funds, and the retry replays it", async () => {
  const from = await newAccount("user");
  const to = await newAccount("user");
  await fund(from, 100n);

  const key = randomUUID();
  const input = {
    key,
    requestHash: hashOf(from, to, "101"),
    fromId: from,
    toId: to,
    amount: 101n,
  };

  const result = await transfer(input);
  assert.equal(result.kind, "insufficient_funds");
  assert.equal(result.code, 422);
  assert.deepEqual(result.body, { error: "insufficient funds" });

  // recordFailure stores the refusal under the key, so a retry must not re-try.
  const retry = await transfer(input);
  assert.equal(retry.kind, "replayed");
  assert.equal(retry.code, 422);
  assert.deepEqual(retry.body, { error: "insufficient funds" });

  assert.equal(await balanceOf(from), "100");
  assert.equal(await txnCount(to), 0);
  await assertLedgerBalanced();
});

test("currency mismatch between the two accounts: 422", async () => {
  const from = await newAccount("user", "NGN");
  const to = await newAccount("user", "USD");
  await fund(from, 500n, "NGN");

  const result = await transfer({
    key: randomUUID(),
    requestHash: hashOf(from, to, "100"),
    fromId: from,
    toId: to,
    amount: 100n,
  });

  assert.equal(result.kind, "currency_mismatch");
  assert.equal(result.code, 422);
  assert.deepEqual(result.body, { error: "currency mismatch" });

  assert.equal(await balanceOf(from), "500");
  assert.equal(await txnCount(to), 0);
  await assertLedgerBalanced();
});

test("same account as source and destination: 422", async () => {
  const account = await newAccount("user");
  await fund(account, 500n);

  const result = await transfer({
    key: randomUUID(),
    requestHash: hashOf(account, account, "100"),
    fromId: account,
    toId: account,
    amount: 100n,
  });

  assert.equal(result.kind, "same_account");
  assert.equal(result.code, 422);
  assert.deepEqual(result.body, { error: "from and to must differ" });

  assert.equal(await balanceOf(account), "500");
  assert.equal(await txnCount(account), 1); // the funding transfer, nothing else
  await assertLedgerBalanced();
});
