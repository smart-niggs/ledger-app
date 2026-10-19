# 007 — Phase 3: Tests
**Date:** 2026-10-13 · **Time spent:** _h · **Credits:** $0 used

## Goal
Enough test coverage that a deliberate bug cannot reach `main`. Two invariants matter:
`SUM(entries.amount) = 0` under concurrency, and the idempotency contract. Done when a
deliberate bug is caught.

## Issues
**1. The lock-ordering bug I expected to write is not a bug.**
Reversing `ORDER BY id` to `ORDER BY id DESC` left the suite **7/7 green** — correctly.
Deadlock avoidance requires a *deterministic* order, not an ascending one; direction is
irrelevant as long as every transaction agrees. The real defect is *non-determinism*.

**2. `npm run check` does not typecheck `test/`.**
`tsconfig.json` has `include: ["src"]` and `rootDir: "src"`, so adding `test` to `include`
makes `tsc` fail with "not under rootDir". The test files were verified type-clean
separately under the same strict flags, but CI will not catch a future type error in
`test/`. Unresolved — fixing it means touching the build output layout.

**3. `npm run migrate -- up` reported "No migrations to run!"** on the local stack, because
the compose `pgdata` volume still held all three from Phase 1. A clean-slate run was
therefore never actually observed locally; verification used a separate throwaway database
instead. CI gets a genuinely empty database every run, which is the real clean-slate proof.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Runner | `node:test` | vitest | Node 24 runs `.ts` natively via type-stripping — verified, zero config, zero dependencies. vitest buys watch mode and nicer assertions at the cost of a dep in a project whose subject is not JS tooling. Answers §11 |
| Database | real Postgres via `DATABASE_URL` | Testcontainers | CI already needs a `services: postgres` block for Phase 6; Testcontainers would duplicate that and additionally need a mounted Docker socket. Supersedes §7's "Testcontainers Postgres" |
| Mocking | none | mock `pool.query()` | Every invariant worth testing lives in Postgres — deferred constraint trigger, `no_overdraft` CHECK, `FOR UPDATE` ordering, BIGINT-as-string. A mock asserts your beliefs about the driver, and would have passed both deliberate bugs |
| Unit-test file | dropped | `test/money.test.ts` | There is no money-math module. `requestHash` is three lines; the BigInt rule is a convention, not a function. A test file written to satisfy a plan bullet is work with no subject |
| Isolation | each test creates its own accounts | `TRUNCATE` between tests; per-test rollback | `ledger-core.sql` has a `BEFORE TRUNCATE` trigger that rejects truncation, and `transfer()` owns its own transaction via `withTransaction`, so there is no outer transaction to roll back |
| Global assertion | `SUM(entries.amount) = 0` across the whole table | scoped per-test sums | Safe at READ COMMITTED precisely because only committed — therefore balanced — transactions are visible. It gets *stronger* as rows accumulate |
| Env loading | `node --env-file-if-exists=.env --test` | `--env-file` | Same reasoning as the `migrate` script: no `.env` exists in CI, and the flag must no-op rather than fail |

## Numbers
**7 tests, 7 pass, 0 fail, 608 ms.** Run twice back to back with identical results, then
once more against a freshly created and migrated throwaway database — 7/7 there too, so
nothing depends on pre-existing rows.

Concurrency, stated honestly: **50 calls issued, ~10 transactions actually in flight.**
`pg`'s default pool max is 10, so 40 queue at `pool.connect()`. The pool is not even the
binding constraint — all 50 contend for the same two row locks and serialise behind
`FOR UPDATE` regardless. 50 transfers complete in **~265 ms**.

## Numbers — the deliberate bugs, verbatim
**Bug 1 — lock ordering.** Replaced the single ordered
`WHERE id = ANY(...) ORDER BY id FOR UPDATE` with two separate single-row `FOR UPDATE`
queries in *caller* order (`fromId` then `toId`), making the order non-deterministic.
Caught by `concurrency.test.ts` → "concurrent A->B and B->A on the same pair":

```
40P01: deadlock detected
```

**46 of 50 calls rejected.** 6 pass / 1 fail. The broken run took **23.0 s** against
**0.19 s** healthy — Postgres waits out `deadlock_timeout` (1 s) per victim. That gap is
why the file carries a 120 s timeout: a genuinely broken build needs headroom to report the
real error instead of dying as a timeout.

**Bug 2 — funds check.** Deleted the
`from.type !== "system" && BigInt(from.balance) < input.amount` block. Caught by
`transfer.test.ts` → "overdraft from a user account":

```
new row for relation "accounts" violates check constraint "no_overdraft"
```

6 pass / 1 fail. Note *how* it failed: not a wrong return code, but the migration's `CHECK`
rejecting what the application stopped rejecting. Defence in depth is not theoretical here.

Both reverted with `git checkout -- src/ledger/transfer.ts`; `git diff src/ migrations/`
confirmed 0 bytes afterwards.

## Post hook
The phase's lesson is not "write tests". It is that **the database caught both bugs** —
once through a CHECK constraint, once through lock contention under real concurrency. Every
mock-based version of this suite passes both broken builds. That is the whole argument for
an integration test reaching a real Postgres, and it took two deliberate regressions to see
it rather than argue it.

The second lesson is cheaper: the bug I *predicted* would be caught was not a bug at all.
`ORDER BY id DESC` is as deadlock-safe as `ASC`. Writing the test suite corrected my
understanding of my own schema.

## Open at close
- `test/` is not typechecked by `npm run check` — see Issues 2. Real gap, deliberately left.
- ~40 lines of helpers are duplicated across the two files. A `test/helpers.ts` would fix it
  but would not be matched by the `test/*.test.ts` glob, so the script would need widening.
- `account_not_found` and the `in_progress` (409) race are untested. The latter needs two
  clients interleaved mid-transaction — a larger harness than this phase needed.
- `.claude/PROJECT-PLAN.md` is now stale in two places: §7's Phase 3 line still says
  "Testcontainers Postgres", and §11 still lists "Test runner: `node:test` vs vitest" as an
  open decision. Both are answered above.
