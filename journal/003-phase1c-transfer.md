# 003 — Phase 1c: Transfer + idempotency
**Date:** 2026-10-11 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

## Goal
`POST /transfers` that moves money exactly once no matter how many times the client
retries, with both accounts locked in a deadlock-safe order inside one transaction.

## Issues

### 1. `POST /accounts` returned 404 while the file on disk was correct
- **Symptom:**
  ```
  {"message":"Route POST:/accounts not found","error":"Not Found","statusCode":404}
  ```
- **Root cause:** the process listening on :3000 predated the new `server.ts`; a stale
  server (old `dist/` build or a leftover container) was still serving. `/health/ready`
  returned 200 throughout, which made it look healthy — that route exists in both versions.
- **Fix:** `lsof -i :3000`, stop the stale process, restart `npm run dev`.
- **Lesson:** verify with an endpoint that only exists in the new code. A health check
  passing proves the old process is fine, not that the new one is running.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Validation | plain `schema.parse()` per handler + `ZodError` → 400 error handler | `fastify-type-provider-zod`, JSON Schema | One fewer dependency, no zod-4 compat risk; same "parse at the trust boundary" idea as `config.ts` (answers plan §11) |
| BIGINT over the wire | string from `pg`, `BigInt` for arithmetic, string in JSON | `Number`, JSON number | `Number` silently breaks past 2^53; `JSON.stringify` throws on BigInt (answers plan §11) |
| Lock order | `WHERE id = ANY(...) ORDER BY id FOR UPDATE` | lock the source account first | Concurrent A→B and B→A both take the lower id first, so one waits instead of deadlocking |
| Failure responses | stored in `idempotency_keys` and committed | roll back so a retry can succeed | One key, one outcome. Cost: an insufficient-funds retry replays 422 even after funds arrive |
| Transaction helper | `withTransaction(fn)` checking out one client | `pool.query()` per statement | `pool.query()` takes a different connection each call, so BEGIN and INSERT would land in different transactions |
| HTTP codes | carried on the result object from `transfer()` | mapped in the route only | Idempotency inherently stores the response, so the ledger has to know the code anyway |

## Numbers
5 new files, 1 migration. `npm run typecheck` clean.
10 of 10 verification requests returned the expected status.
**2 identical POSTs → 1 transaction** (`transactionId: "1"` on both), `SUM(entries.amount) = 0`.
4 idempotency keys stored from 5 keys sent — the malformed request never claimed one.

## Post hook
Two identical POSTs, one transaction. The primary key on the idempotency table *is* the
concurrency control: the second insert blocks on it until the first commits or rolls back,
so you get exactly-once without writing a single line of locking code.

## Open at close
- Replay is semantically identical but not byte-identical: `response_body` is JSONB, which
  does not preserve key order.
- Postgres' `ON CONFLICT DO NOTHING` behaviour against a conflicting *uncommitted* row is
  still unverified. The `FOR UPDATE` fallback is safe either way but may answer 409 where a
  replay would be friendlier.
- Concurrency is untested. §1's "SUM = 0 under 50 concurrent transfers" waits for Phase 3.
