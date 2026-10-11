# 004 — Phase 1d: Outbox
**Date:** 2026-10-11 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

## Goal
Record the "transfer happened" event in the same database transaction as the money,
so there is no window where the ledger moved but the notification was lost — and no
window where a notification exists for money that never moved.

## Issues
None. The migration applied and the three checks passed first time.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Event delivery | outbox table written in the transfer's transaction | publish to a broker from the request handler | A broker publish cannot be rolled back; the dual-write would leave a message for a transfer that failed |
| Index | partial — `(id) WHERE processed_at IS NULL` | plain index on `id`, or on `processed_at` | The worker only ever queries unprocessed rows, so the index stays small as delivered events accumulate |
| Event placement | after balance updates, before the idempotency response is stored | before the money | Nothing between them can fail independently; ordering inside one transaction is for readability |
| Columns | `attempts`, `last_error`, `processed_at` | just `processed_at` | Phase 2 needs backoff and a reason when delivery keeps failing |

## Numbers
1 migration, 1 table, 1 partial index, 5 added lines in `transfer()`.
Successful transfer → **1 outbox row**, `processed_at` NULL, `attempts 0`.
Failed transfer (insufficient funds) → outbox count **unchanged at 1**.
Deliberately unbalanced transaction with an event → `before = 1`, `after = 1`, `ghosts = 0`.
Event survived `docker compose restart db`; the app's pool reconnected on its own and
`/health/ready` returned 200 without intervention.

## Numbers — the atomicity proof, verbatim
```
BEGIN
INSERT 0 1
INSERT 0 1
ERROR:  transaction 3 is unbalanced: entries sum to -100
CONTEXT:  PL/pgSQL function assert_transaction_balanced() line 18 at RAISE
 after
-------
     1
 ghosts
--------
      0
```

## Post hook
Both inserts reported success — `INSERT 0 1` twice — and then `COMMIT` took them both
back out. That is the entire argument for an outbox over publishing to a message broker
from your request handler: the database can un-send an event. Kafka cannot.

## Open at close
- Nothing reads the outbox yet. The row sits unprocessed until Phase 2's worker polls it
  with `FOR UPDATE SKIP LOCKED`.
- "Crash after commit" was verified by restarting Postgres rather than SIGKILLing the app;
  a committed row surviving a database restart is the stronger claim, but the app-crash
  path itself is untested.
