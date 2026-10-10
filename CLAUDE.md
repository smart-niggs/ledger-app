# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A double-entry wallet ledger used as the vehicle for a 12-phase DevOps learning track: laptop → Docker → raw EC2 → ECS Fargate → Terraform → CI/CD on AWS. The ledger exists to make the infrastructure lessons concrete; it is not a product.

Two documents in `.claude/` carry context the code cannot:

- **`.claude/PROJECT-PLAN.md`** (tracked) — the stable spec: north star, success criteria, anti-goals, local and AWS architecture, domain model, ~25 locked decisions with their rejected alternatives, budget model, the phase plan with a "done when" per phase, account/schedule facts (§10) and open decisions (§11). Read it before proposing anything. Section numbers cited below refer to it.
- **`.claude/PROJECT-CONTINUITY.md`** (gitignored globally, never stage it) — live progress: where the work is, next steps, verified-vs-assumed. It is session-handoff machinery with its own protocol in its preamble; follow that, don't patch it ad hoc.

**Both documents can be confidently wrong, and neither can be type-checked.** A previous handoff asserted "no commits at all" about a repo committed 20 minutes earlier, and the retired `STATE.md` claimed written SQL, a `migrate` script and a `.env.example` that never existed. Verify any claim about repo state with a command in the same turn — `git status --short --branch`, `ls`, `cat` — before acting on it.

## Hard rules from the plan

- **Don't write the application code.** Plan §1 anti-goals: "AI never writes the app code. The learner types it." Explain, design, review, and hand over SQL or config when asked — `src/` is the learner's to type. If they ask directly for app code, name the rule in one line and let them decide; don't silently refuse and don't silently comply. Where the line falls for infra files (Terraform, CI workflows) is undefined; ask.
- **Don't re-litigate the locked decisions** in §5. Disagree in one sentence and ask; never act against one quietly. Four rounds of churn on the TypeScript dev runner cost more than any tool in the plan.
- **One phase at a time.** §7 defines when each is done. Meet that bar; don't scope past it.
- **Every error goes in `journal/NNN-*.md`** with its exact text, using the template's sections (Goal · Issues as Symptom/Root cause/Fix/Lesson · Decisions · Numbers · Post hook). The journal is the versioned record and the source material for a public write-up, so exact error strings matter more than prose.
- **No tool enters the plan without a stated reason it beats the simpler option.**

## Commands

```bash
npm run dev        # tsx watch, loads .env, serves src/api/server.ts
npm run typecheck  # tsc --noEmit
npm run build      # rm -rf dist && tsc
npm run start      # node dist/api/server.js
npm run check      # typecheck + build — the gate; same command locally and in CI

docker compose up -d db                   # Postgres 17 only; the app runs on the host until Phase 4
docker compose exec db psql -U ledger     # where the schema break-tests run
docker compose down                       # keeps pgdata; `down -v` destroys it
```

Node 24 (`.nvmrc`). TypeScript is `^6.0.3` — the major is held deliberately, because v7 lacks a stable API and the linters and editors lag.

**No migration script and no test runner exist.** `node-pg-migrate@9` is installed but unscripted, and the runner choice (`node:test` vs vitest) is open (§11, needed by Phase 3). Don't invent either; add them in the phase that calls for them.

Binaries resolve from `node_modules/.bin` via `npm run`. Avoid `npx` here — it once fetched an unrelated registry package instead of `tsc` (root cause still unconfirmed, §11); use `npm exec --no` for a genuine one-off.

## What exists versus what is only designed

This matters more than any other orientation detail: **none of the ledger domain is implemented.** `migrations/` is empty, so there are no tables. What runs today is the scaffold — config, a pg pool, a Fastify server with two health routes — plus Postgres in Compose. Both journal entries are unfilled templates. Everything in "The ledger design" below is specification from the plan, not code to read.

## Architecture of the scaffold

**One package, two entrypoints.** `src/api/server.ts` today, `src/worker/index.ts` from Phase 2. Monorepo workspaces were rejected: one Docker image, two commands.

**Config fails at boot, not at 2am.** `src/config.ts` calls `schema.parse(process.env)` at module scope, so a missing or malformed `DATABASE_URL` throws during import — before Fastify binds a port. Everything imports `config` from there; nothing reads `process.env` directly. `server.ts` is top-level-await ESM.

**Relative imports carry `.ts` extensions.** `tsconfig.json` sets `rewriteRelativeImportExtensions` alongside `verbatimModuleSyntax` and NodeNext, so source reads `import { pool } from "../db/pool.ts"` and the compiler emits `.js`. Writing `.js` or an extensionless path in source is wrong in this repo.

**The two health endpoints are not redundant.** `/health/live` is static; `/health/ready` runs `SELECT 1` and returns 503 on failure. The load balancer must target liveness, so a database blip degrades requests instead of killing every task.

**Bind addresses are deliberately asymmetric.** The app listens on `0.0.0.0` because it must accept traffic inside a container, while Compose publishes Postgres on `127.0.0.1:5432` only, so the database is never exposed to the LAN. `DATABASE_URL` points at `127.0.0.1:5432` now and at `db:5432` once the app moves into Compose at Phase 4.

## The ledger design (specification — §4 and §7, not yet written)

**Money and the invariant.** Signed `BIGINT` kobo, never floats. One `transactions` row plus two or more append-only `entries` rows whose amounts sum to zero, enforced by a deferred constraint trigger that fires at COMMIT — so an unbalanced transaction fails on commit, not on insert. `accounts` carries a *cached* balance that can drift from `SUM(entries.amount)`; keeping it in sync is Phase 1c's job and nightly reconciliation is parked. System accounts represent the outside world and may go negative; user accounts carry a no-overdraft CHECK. DB access is raw `pg` with SQL migration files — no ORM, so transactions and `FOR UPDATE` locks stay explicit. `SUM(entries.amount) = 0` must hold under 50 concurrent transfers.

**Transfers lock in id order.** Phase 1c, one transaction: claim the idempotency key → `SELECT … FOR UPDATE` both accounts ordered by id (deadlock avoidance) → check currency and funds → insert transaction and entries → update cached balances → store the response. Same key twice yields one transaction; same key with a different body returns 422.

**The outbox solves the dual-write.** Phase 1d writes the event in the same transaction as the transfer; the Phase 2 worker polls it with `FOR UPDATE SKIP LOCKED` and calls the ledger's internal endpoint. Delivery is at-least-once, so the consumer dedupes by event id.

## AWS

Target is ECS Fargate ARM64 behind an ALB with RDS Postgres across two AZs and **no NAT gateway** — tasks sit in public subnets protected by a security-group chain (`alb-sg:443 → api-sg:3000 → rds-sg:5432`), a known and accepted trade-off. Images are tagged with the git SHA, never `latest`. Migrations run as a one-off task before deploy, never on app boot, because concurrent tasks would race. Diagram in §3; account identity, budget alert and the week-by-week schedule in §10.

Cost is a binding constraint, not a footnote: a $25 credit ceiling against roughly $0.08/hour for the full stack. **Build, learn, destroy every session** — nothing is left running between sessions. §9 lists claims nobody has verified (hourly rates, free ARM runners for public repos, RDS Postgres 17 availability); check them before relying on them.
