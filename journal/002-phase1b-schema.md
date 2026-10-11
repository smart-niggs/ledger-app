# 002 — Phase 1b: Schema
**Date:** 2026-10-11 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

## Goal
A ledger schema that makes bad money impossible: every transaction's entries sum to
zero in a single currency, user accounts cannot go negative, entries cannot be edited,
and the whole migration can be rolled back and reapplied cleanly.

## Issues

### 1. `npm run migrate` printed help and exited 1
- **Symptom:**
  ```
  Usage: node-pg-migrate.js [up|down|create|redo] [migrationName] [options]
  ```
  (full option list, exit code 1)
- **Root cause:** two things at once — node-pg-migrate's CLI calls `showHelp()` and
  `process.exit(1)` when given no subcommand, and `npm run <script>` swallows trailing
  arguments unless they follow `--`.
- **Fix:** `npm run migrate -- up`
- **Lesson:** a non-zero exit with a help screen is a usage error, not a broken install.
  Every invocation of an npm script that forwards flags needs `--`.

### 2. `--envPath` is a silent no-op in this repo
- **Symptom:** none visible — that is the problem. The flag is advertised in `--help`
  and does nothing, so the failure surfaces later as a missing connection string.
- **Root cause:** `node_modules/node-pg-migrate/bin/node-pg-migrate.js:219` loads dotenv
  optionally — `const dotenv = await tryImport("dotenv"); if (dotenv) { ... }`. `dotenv`
  is not among node-pg-migrate's dependencies (`glob`, `jiti`, `yargs`) and is not
  installed here, so the import returns nothing and `.env` is never read.
- **Fix:** `node --env-file-if-exists=.env node_modules/node-pg-migrate/bin/node-pg-migrate.js`
  in the `migrate` script. `NODE_OPTIONS` refuses the flag
  (`--env-file-if-exists= is not allowed in NODE_OPTIONS`) and the `.bin` shim's
  `#!/usr/bin/env node` shebang cannot forward node flags, so the bin's real path is required.
- **Lesson:** an advertised flag that depends on an optional peer fails silently. Check
  whether the dependency is actually installed before trusting a CLI option.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Sum-to-zero | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` | `CHECK` constraint | A CHECK sees one row and cannot aggregate; a non-deferred check rejects the first entry of every balanced pair |
| Same-currency rule | Same deferred trigger counts `DISTINCT currency` via join to `accounts` | `currency` column on `entries`; application-only check | No denormalized copy to keep truthful; summing across currencies is meaningless, so it is the same invariant |
| Append-only | `BEFORE UPDATE OR DELETE` row trigger + `BEFORE TRUNCATE` statement trigger | `REVOKE UPDATE, DELETE` | A trigger binds everyone including psql; the GRANT version arrives with a separate app role. Row triggers do not see TRUNCATE — hence the second trigger |
| Account id | `BIGINT GENERATED ALWAYS AS IDENTITY` | `serial`, UUID | SQL-standard form, no separately-owned sequence; cheap ordering for `ORDER BY id FOR UPDATE` lock ordering in 1c |
| Account type / currency | `TEXT` + `CHECK` | Postgres `ENUM`, `CHAR(3)` | Enums need `ALTER TYPE` inside migrations; `CHAR` blank-pads |
| Timestamps | `TIMESTAMPTZ` | `TIMESTAMP` | Plain TIMESTAMP silently discards the offset |
| Migration env | `node --env-file-if-exists=.env` | install `dotenv` for `--envPath` | Platform feature beats a dependency, and the same script works in ECS where no `.env` exists |

## Numbers
3 tables, 3 triggers, 2 plpgsql functions, 2 indexes, 1 migration file.
`up → down → up` cycle clean; `pgmigrations` dropped to 1 row between them.
**6 of 6 break tests rejected correctly**, exact strings:

```
ERROR:  transaction 2 is unbalanced: entries sum to -100000
CONTEXT:  PL/pgSQL function assert_transaction_balanced() line 18 at RAISE
ERROR:  transaction 3 mixes currencies
CONTEXT:  PL/pgSQL function assert_transaction_balanced() line 13 at RAISE
ERROR:  new row for relation "accounts" violates check constraint "no_overdraft"
DETAIL:  Failing row contains (2, user, NGN, -1, 2026-10-11 18:13:01.577863+00).
ERROR:  entries are append-only: UPDATE is not allowed
ERROR:  entries are append-only: DELETE is not allowed
ERROR:  entries are append-only: TRUNCATE is not allowed
```

`SELECT SUM(amount) FROM entries` = 0; zero transactions with a non-zero sum.

## Post hook
The unbalanced transfer failed on `COMMIT`, not on `INSERT` — and that ordering is the
whole lesson. A `CHECK` constraint cannot count across rows, so a ledger that must sum
to zero needs a deferred constraint trigger. Without `DEFERRABLE INITIALLY DEFERRED`,
the first half of every legitimate transfer is illegal.

## Open at close
- Phase 1b's bar is met. Not yet proven: the §1 criterion that `SUM(entries.amount) = 0`
  holds under **50 concurrent transfers** — that is Phase 3's job.
- Postgres' `ON CONFLICT DO NOTHING` behaviour against a conflicting *uncommitted* row
  is unverified; 1c's claim path is written to be safe either way.
