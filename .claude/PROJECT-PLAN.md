# Project plan — ledger-platform
Stable context — goals, decisions, architecture, phases. Changes rarely. Live progress and next steps live in `.claude/PROJECT-CONTINUITY.md`. Changelog at the bottom.

## 1. North star
Build and operate a production-shaped, two-service money system on AWS — laptop → Docker → ECS → CI/CD —
understanding every layer well enough to rebuild it from zero and defend each choice. Document the journey
with real numbers and real failures for an X/LinkedIn post.

### Success criteria (all measurable)
- Explain any component without notes: why it exists, what breaks without it, what it costs.
- Terraform takes the stack from zero to HTTPS in one `apply`; `destroy` leaves nothing billable.
- A PR with a failing test is blocked; a merge deploys; a bad deploy rolls back automatically.
- Ledger invariant `SUM(entries.amount) = 0` holds under 50 concurrent transfers.
- Total AWS spend ≤ $25 of credits; AWS phases finished by ~2027-01-15 (plan closes ~2027-02-04).
- Journal records every error with exact text; post published with ≥ 4 real numbers.

### Anti-goals
- Not a real product. No feature creep in the ledger beyond what the infra lessons need.
- No tool enters the plan without a stated reason it beats the simpler option.
- AI never writes the app code. The learner types it.
- No re-litigating locked decisions (we churned 4 times on the TS dev runner — that churn cost more than any tool).

### Payoff (unconfirmed — ask early)
Learner's broader aim is skills that make money. Unknown which: role change to DevOps/platform, higher rates as a
backend engineer, freelance infra work, or audience growth. The answer sets depth (e.g. whether Jenkins survives).

## 2. Learner
- Chukwuemeka: backend engineer, Node.js/TypeScript, multiple services and API integrations, payment/remittance APIs.
- Machine: personal Apple Silicon Mac, macOS. Repo `~/DevOps/ledger-platform`, public on GitHub.
- Strong: backend code, HTTP APIs, payments domain.
- New or shaky (observed): YAML structure, Docker volumes/networking, ESM + tsc module resolution, npm bins/PATH/npx,
  AWS, IaC, CI/CD.
- Style: wants the why before the how, analogies, concise bullets, one section at a time. Pushes back hard on
  unverified or imprecise claims. Asks to simplify when overwhelmed — then cut scope, don't add options.

### Concepts already taught (don't re-teach; quiz occasionally)
- Named volume vs bind mount; top-level `volumes:` declares, service-level `name:/path` attaches; `down` vs `down -v`.
- YAML indentation is structure; `docker compose config` validates.
- `127.0.0.1` (loopback, this machine) vs `0.0.0.0` (all interfaces); inside a container 127.0.0.1 = the container.
- zod: runtime validation at trust boundaries ("parse, don't validate"); TS types vanish at runtime.
- ESM needs full file extensions; `.ts` imports + `rewriteRelativeImportExtensions`.
- `tsc` = TypeScript compiler; binaries come from packages via `node_modules/.bin`; `npm run` adds it to PATH;
  `npx` can fetch unknown registry packages (security risk) → prefer `npm run` / `npm exec --no`.
- Liveness vs readiness health checks and why the LB must use liveness.
- Money as BIGINT minor units; double-entry; deferred constraint triggers; append-only ledger; cached balance drift.

## 3. Architecture
### Local (now → Phase 4)
```
Mac: api (tsx watch :3000) ──127.0.0.1:5432──▶ Docker: postgres:17 + volume pgdata
Phase 4: api, worker, db all in compose; app reaches DB at db:5432 (Compose DNS)
```
### AWS target (Phases 7–10), us-east-1, 2 AZs, no NAT
```
Internet ─443─▶ ALB (public subnets, ACM cert, api.<domain> via Route 53 alias)
                  │ :3000, health /health/live
                  ▼
           ECS Fargate ARM64 — service "api"  (public subnet, public IP, SG: from ALB only)
                  ▲ Service Connect (http://api:3000/internal/...)
           ECS Fargate ARM64 — service "worker" (public subnet, public IP, no inbound)
                  │ :5432
                  ▼
           RDS Postgres t4g.micro single-AZ (private subnets, no public access)
Images: ECR · Secrets: SSM Parameter Store · Logs: CloudWatch (7-day retention) · CI/CD: GitHub Actions via OIDC
```
Security-group chain: internet → alb-sg:443 → api-sg:3000 (from alb-sg, worker-sg) → rds-sg:5432 (from api-sg, worker-sg).
Tasks sit in public subnets only to pull images/reach AWS APIs without NAT; SGs are the protection. Known trade-off.

## 4. Domain model
- Tables: `accounts` (type user|system, currency, cached balance, CHECK no_overdraft for users), `transactions`,
  `entries` (signed BIGINT kobo, non-zero, append-only trigger, deferred trigger: each transaction sums to 0).
- System account represents the outside world (deposits); may go negative.
- Planned: `idempotency_keys` (1c), `outbox` (1d) — each its own migration.
- Worker: polls outbox with `FOR UPDATE SKIP LOCKED`, calls ledger `/internal/accounts/:id` for details (this is the
  container-to-container call), logs the "notification" (real email via SES deferred: sandbox limits), marks processed.
  Delivery is at-least-once → consumer dedupes by event id.

## 5. Locked decisions
| Area | Picked | Rejected | Why |
|---|---|---|---|
| App | Ledger API + notification worker | Todo, URL shortener | Money correctness, idempotency, async side effects |
| Repo | One package, two entrypoints (api, worker) | Monorepo workspaces | One image, two commands; simpler Docker |
| Framework | Fastify | Express | Built-in validation + pino logs |
| DB access | Raw `pg` + node-pg-migrate SQL files | Prisma/ORMs | Explicit transactions, row locks |
| Runtime | Node 24 LTS, ESM | — | Current LTS |
| TypeScript | v6 pinned | v7 | v7 lacks stable API; linters/editors lag |
| Dev runner | `tsx watch` | ts-node, Node type stripping | ts-node unmaintained, incompatible with TS 7 |
| Imports | `.ts` + `rewriteRelativeImportExtensions` | `.js` in source | Learner preference |
| Prod run | tsc → dist → `node dist/api/server.js` | TS in prod | Plain JS only |
| Gate | `npm run check` (typecheck + build) | — | Same command locally and in CI |
| Config | zod, fail fast at boot | Raw process.env | Crash at boot, not at 2am |
| Health | /health/live + /health/ready | Single check | DB blip must not kill all tasks |
| Local DB | Postgres 17, 127.0.0.1:5432, volume pgdata | Native, bind mount | RDS parity; no LAN exposure; macOS perms |
| Money | BIGINT kobo, signed, double-entry | Floats, debit/credit cols | No drift; balance = SUM |
| Compute | ECS Fargate ARM64, 0.25 vCPU / 0.5 GB | x86, EKS | Cheaper; matches Mac builds; EKS ~$73/mo control plane |
| Network | No NAT, public subnets + SG chain | NAT, VPC endpoints | NAT ~$32/mo; endpoints cost more |
| Secrets | SSM Parameter Store; RDS-managed master password | Secrets Manager for app secrets | Free; keeps password out of Terraform state |
| Access | IAM user + MFA + `aws login` | Identity Center, access keys | Identity Center blocked on Free plan; no long-lived keys |
| EC2 access | SSM Session Manager | SSH | No open port 22 |
| Images | Tag = git SHA; ECR lifecycle keeps last N | `latest` | Traceable, rollbackable |
| Migrations | One-off step/task before deploy | On app boot | Concurrent tasks would race |
| Jenkins | Local Docker only, if kept | On AWS | Duplicates Actions; burns credits |
| Tutor | Claude Code + CLAUDE.md + PROJECT-PLAN + PROJECT-CONTINUITY | claude.ai chats, Claude Doc, a separate STATE.md | Local, versioned, /clear-friendly; one volatile doc, not two |

## 6. Budget model
- Rule: cost is hours × services. Build, learn, destroy every session.
- Estimated hourly (us-east-1, verify): ALB $0.0225 · RDS t4g.micro $0.016 · 2 Fargate ARM tasks ~$0.02 · 4 public IPv4 $0.02
  → full stack ≈ $0.08/h (~$58/month if left on).
- Fixed: Route 53 hosted zone $0.50/month; ECR/snapshots/logs cents.
- Planned AWS hours ≈ 45 (P5 4, P7 6, P8 10, P9 8, P10 8, P11 6) → ≈ $4 + fixed ≈ $8 total. Ceiling $25. Buffer for mistakes.
- Budget alert $17/month; check Billing → Credits weekly (alerts lag hours).

## 7. Phase plan (goal · key steps · done when)

| # | Phase | Done when |
|---|---|---|
| 0 | Guardrails | — |
| 1a | Scaffold | config + pool + Fastify with two health routes |
| 1b | Schema | ledger-core migration; up/down/up; psql break tests fail; SUM = 0 |
| 1c | Transfer + idempotency | same key twice → one transaction; same key, different body → 422; overdraft rejected |
| 1d | Outbox | rollback → no event; crash after commit → event survives |
| 1e | Shutdown + logs | in-flight request completes during shutdown |
| 2 | Worker | two workers never double-process; kill mid-batch → nothing lost |
| 3 | Tests | a deliberate bug is caught |
| 4 | Docker | `docker compose up` from a clean clone |
| 5 | Raw EC2 | 3 pains that orchestration fixes, written down |
| 6 | CI | failing test blocks PR |
| 7 | ECS by hand | HTTPS works, then everything deleted |

**Rows above are history — 0 through 7 are complete except 2, which was deferred and is
re-planned below as 14.** Their numbers are frozen because four journals are named after them
(`006-phase5`, `007-phase3`, `008-phase6`, `009-phase7`). Remaining work is renumbered
sequentially in execution order:

| # | Phase | Done when |
|---|---|---|
| 8 | `snip` — console rep 2 | learner-led rebuild, different choices, same bars |
| 9 | PHP app | a **multi-container** task definition serving traffic |
| 10 | Terraform | zero → HTTPS in one apply; destroy < 15 min |
| 11 | **Restore drill** | a snapshot restored to a new instance returns the original rows |
| 12 | CD | broken image auto-rolls back |
| 13 | Alarms | a forced error emails you **and** a runaway rate emails you |
| 14 | Worker (was 2) | two workers never double-process; kill mid-batch → nothing lost |
| 15 | Service-to-service (was 10) | worker reaches api by name; nothing else can |
| 16 | Cron | a scheduled job runs nightly **and its failure reaches the alarm** |
| 17 | Observability (was 11) | one Insights query answers "what broke" across all streams |
| 18 | Write-up (was 12) | post from journal: errors, decisions, numbers |
| 19 | Frontend | static site on CloudFront calling the API cross-origin |

**Old → new, for reading older journals:** 2 → 14 · 8 → 10 · 9 → 12 · 10 → 15 · 11 → 13+17 ·
12 → 18. Anything a journal calls Phase 0–7 is unchanged.

**No target dates.** The previous column was derived from §10's schedule, then invented wholesale
once the project ran ~6 weeks ahead of it. Order is the row order; live status lives in
`.claude/PROJECT-CONTINUITY.md`, not here.

Four deliberate changes from the original order:
- **Worker moves last-ish (14).** It is a hard prerequisite for 15 and its source was deleted;
  calling it "optional, deferred" hid that dependency.
- **Alarms (13) move before the worker, and the bar widened.** The original justification — that
  a log alarm would have caught the deleted worker's hot loop — **is wrong**: that loop logged
  946 *successes*, and an error filter sees nothing. What catches it is an **invocation-rate**
  alarm, so the bar now requires both. The move is only defensible with the rate half in it.
- **Cron promoted out of "Later" (16)**, with a bar that requires its failure to be *visible* —
  a silent cron is the worst of both worlds.
- **Restore drill added (11)**, placed right after Terraform: `apply` makes the restore target
  cheap to create and destroy, and you should know you can recover *before* automating deploys
  that can break things. Untested backups are the standard way to discover you have none.

Live status per phase lives in `.claude/PROJECT-CONTINUITY.md`, not here. Detail follows.
- **0 Guardrails** — done.
- **1a Scaffold** — done.
- **1b Schema** — ledger-core migration; up/down/up; psql break tests (unbalanced, overdraft, edit) fail; SUM = 0.
- **1c Transfer + idempotency** — migration `idempotency_keys` (key PK, request_hash, response_code, response_body);
  POST /accounts, POST /transfers, GET /accounts/:id/balance. One DB transaction: claim idempotency key → lock both
  accounts `SELECT … FOR UPDATE` ordered by id (deadlock avoidance) → check currency + funds → insert transaction +
  2 entries → update cached balances → store response. Done: same key twice → one transaction; same key, different
  body → 422; overdraft rejected.
- **1d Outbox** — migration `outbox`; event written in the same transaction as the transfer (solves dual-write).
  Done: rollback → no event; crash after commit → event survives.
- **1e Shutdown + logs** — SIGTERM: stop accepting, finish in-flight, close pool (ECS sends SIGKILL after stopTimeout).
  JSON logs to stdout with request ids; no secrets or PII. Done: in-flight request completes during shutdown.
- **14 Worker (was 2)** — `src/worker/index.ts` poll loop with `SKIP LOCKED`, calls ledger internal endpoint, idempotent
  consumer, backoff, graceful stop. **Rebuild from scratch — the original was deleted.** Three known
  fixes from the post-mortem: count rows *delivered* not *fetched*, add `WHERE attempts < MAX`, give
  `fetch` an `AbortSignal.timeout`. Done: two workers never double-process; kill mid-batch → nothing lost.
- **3 Tests** — unit (money math), integration with Testcontainers Postgres, concurrency invariant (50 parallel
  transfers). Runner choice open. Done: deliberate bug is caught.
- **4 Docker** — multi-stage, non-root, `.dockerignore`, one image / two commands; compose api+worker+db,
  `DATABASE_URL` host `db`, `depends_on: service_healthy`, migrations as one-off service; record image size before/after.
  Done: `docker compose up` from a clean clone.
- **5 Raw EC2** — t4g.micro ARM, SSM (instance profile AmazonSSMManagedInstanceCore), docker + compose, manual deploy,
  reboot, logs; terminate. Done: 3 pains that orchestration fixes, written down.
- **6 CI** — Actions on PR: `npm ci`, check, lint, tests (Postgres service). On main: build ARM image (native ARM
  runner if free for public repos — verify), push to ECR via OIDC role trusted only for this repo + branch.
  Done: failing test blocks PR.
- **7 ECS by hand (once)** — VPC + subnets, SGs, RDS, Parameter Store, task/execution roles, task defs (awslogs),
  ALB + target group (type ip, /health/live), ACM DNS validation, Route 53 alias, migration RunTask; teardown checklist.
  Done: HTTPS works, then everything deleted.
- **8 `snip` — second console rep** — a separate practice repo (URL shortener, Node + Postgres,
  one table). Same twelve objects as Phase 7, **learner-led**: assistant gives the bar per object,
  not the click path, and does not pre-warn traps. Different choices on purpose — private subnets
  + VPC endpoints (never exercised), `sslmode=verify-full` with Amazon's CA bundle, two task
  definitions instead of a command override, two tasks across two AZs, and `docker buildx build
  --platform linux/arm64` declared explicitly rather than inherited from the laptop.
  Done: `POST` returns 201 over HTTPS on a real domain, then everything deleted.
- **9 PHP app** — a GitHub sample PHP server (nginx + php-fpm) on ECS. The new concept is a
  **multi-container task definition**: shared network namespace, `dependsOn` ordering, and which
  container the target group points at. Done: multi-container task serving traffic through an ALB.
- **10 Terraform** — codify a console-built stack; remote state in S3 (native lockfile — verify version); no secrets in state.
  Done: zero → HTTPS in one apply; destroy < 15 min.
- **11 Restore drill** — put known rows in, take a manual snapshot, restore it to a **new** instance,
  query the rows back, point the app at it, delete both. Also time it. Done: the restored instance
  returns the original rows, and the elapsed time is written down. A backup nobody has restored is
  a belief, not a backup — and this is the only phase that tests recovery rather than construction.
- **12 CD (was 9)** — on main: build → push (SHA tag) → migrate task → new task def → deploy, wait stable; deployment circuit
  breaker with rollback. **The build must declare `--platform linux/arm64`** — `ubuntu-latest` is
  x86-64, so an inherited-architecture build produces amd64 and the task definition rejects it with
  `exec format error`. Done: broken image auto-rolls back.
- **15 Service-to-service (was 10)** — worker as ECS service; Service Connect; SG rule worker→api; decide outbox polling vs SQS.
  Done: worker reaches api by name; nothing else can.
- **13 Alarms** — two alarms, not one. (a) metric filter on error logs → CloudWatch alarm → SNS
  email. (b) an **invocation-rate** alarm — ECS task count, or a metric filter counting a
  per-iteration log line, breaching on an implausible rate. Container Insights costs extra; stay
  off it. Done: a forced error emails you **and** a deliberate runaway loop emails you. (b) is the
  half that would actually have caught the 946-attempts-in-3-seconds bug; (a) would not have.
- **16 Cron** — EventBridge Scheduler → ECS RunTask, reusing the task definition with a command
  override. Job: nightly reconciliation of cached balance vs `SUM(entries)`. Done: it runs on
  schedule **and a deliberate failure reaches the Phase 13 alarm** — a silent cron is not done.
- **17 Observability (was 11)** — Logs Insights queries across streams; a saved query that answers
  "what broke". Done: one query spans every stream in the group.
- **18 Write-up (was 12)** — post from journal: errors, decisions, numbers.
- **19 Frontend** — S3 static hosting + CloudFront + cache invalidation on deploy + CORS against
  the API + a path-based ALB rule. Learner-requested breadth, overriding a recommendation to skip
  it; none of those five appear elsewhere in the plan, so it is a real phase, just not backend.
  Done: the static site calls the API cross-origin over HTTPS.
- **Later (challenge each first)** — Prometheus: local first, AMP later · ArgoCD: local kind/k3d,
  not EKS · Elasticsearch: local Docker.

## 8. Post strategy
- Angle: real numbers + real failures. "I deployed Node to ECS" is commodity.
- Numbers to collect: image size before/after, build time, deploy time, rollback time, total credits used,
  hours of infra run, count of errors by phase.
- Every error goes in `journal/` with exact error text (searchable, credible).

## 9. Unverified claims (verify before relying)
- Hourly cost estimates · GitHub free ARM runners for public repos · Terraform S3 native locking version ·
  Claude Code `Edit(...)` deny syntax and SessionStart hook behaviour · RDS offers Postgres 17 ·
  Node 24 type-stripping warning behaviour.

## 10. Account and schedule
- IAM user `emeka-admin` with MFA; CLI profile `lab` via `aws login`; region us-east-1. Root has MFA and no access keys.
- Budget alert at $17/month. Route 53 hosted zone exists and is authoritative; no MX. Domain name not recorded — ask.
- Credits $118.97 as of 2026-10-07, $1.03 of it used — probably the hosted zone, never confirmed.
- Between sessions, no billable resources should be running at all.
- Week-by-week target (week of): Oct 12 1b–1c · Oct 19 1d–1e · Oct 26 2 · Nov 2 3 · Nov 9 4 · Nov 16 5 · Nov 23 6 ·
  Nov 30 7 · Dec 7 8 · Dec 14 9 · Dec 21 buffer · Dec 28 10 · Jan 4 11 · Jan 11 12 + final teardown ·
  Jan 18–Feb 4 buffer. Free plan closes ~2027-02-04; AWS phases target ~2027-01-15.

## 11. Open decisions (phase that needs the answer in brackets)
- [~] ~~Payoff goal~~ — **withdrawn.** Asked four times across sessions, declined every time. Stop
      asking. Jenkins stays out by default.
- [x] Same-currency rule — **DB constraint.** The deferred sum-to-zero trigger joins `entries` to
      `accounts` and counts `DISTINCT currency`. (1b)
- [x] Fastify validation — **plain `schema.parse()` per handler + a `ZodError` → 400 handler.** (1c)
- [x] BIGINT — **string from the driver, `BigInt` only for arithmetic, string back out in JSON.**
      `JSON.stringify` throws on a `BigInt`. (1c)
- [x] Test runner — **`node:test`**, real Postgres via `DATABASE_URL`, no Testcontainers, zero new
      deps. 7/7 in 608 ms. (3)
- [x] Base image — **`node:24-slim`**, 397 MB / 86.7 MB content. Alpine never benchmarked; that
      comparison is parked, the decision is not. (4)
- [ ] Worker transport: outbox polling vs SQS. (15)
- [ ] **Build platform** — explicit `--platform linux/arm64`, a multi-arch image, or an ARM runner?
      `ubuntu-latest` is x86-64, so a CI-built image would be amd64 and the ARM64 task definition
      would reject it with `exec format error`. Whether ARM runners are free for public repos is
      still the unverified §6 item. (12)
- [ ] **RDS TLS** — `sslmode=no-verify` is live debt: encrypted, server **not** authenticated. Close
      it with `verify-full` + Amazon's CA bundle in the image. (8)
- [ ] **Does Terraform codify the ledger or `snip`?** Two console-built stacks will exist by then
      and the bar names HTTPS, not an app. (10)
- [ ] **What does the frontend actually display?** Phase 19 has no user and no requirement anywhere
      in §1–§4. Decide before building, or it gets built twice. (19)
- [ ] CI linter, given the TS 6 tooling gaps. (6)
- [ ] `npx tsc` resolved to an npm placeholder package — root cause unconfirmed; run `which -a node npm npx`. (soon)
- [ ] Editor set to use the workspace TypeScript. (soon)

## Changelog
- 2026-10-09: created from claude.ai sessions (Phase 0 → 1b).
- 2026-10-10: renamed from BRIEF.md to .claude/PROJECT-PLAN.md. STATE.md retired; live progress moved to
  .claude/PROJECT-CONTINUITY.md. Absorbed STATE's account, schedule and open-decision content as sections 10 and 11.
- 2026-10-11: added the 12-phase summary table to §7 (goal, done-when, target week).
- 2026-10-19: Phase 7 closed (journal 009). §7 split into a frozen history table (0–7, numbers
  locked because four journals are named after them) and a renumbered remainder, 8–19, in
  execution order. New: 8 `snip` console rep, 9 PHP multi-container, **11 Restore drill**,
  19 Frontend. Split old 11 into 13 Alarms and 17 Observability; 13 moved ahead of the worker
  **and its bar widened to require an invocation-rate alarm** — the original justification was
  wrong, a log-error filter would not have caught the hot loop that logged only successes.
  Promoted crons from "Later" to 16, with a bar requiring failures to be visible. Old Phase 2
  becomes 14 with its deletion and three known fixes recorded. **Target-week column removed** —
  it had been invented once the project ran ~6 weeks ahead of §10's schedule. Resolved five §11
  decisions, withdrew the payoff question after four refusals, added four new ones. Old → new
  map is in §7; journal 009's three forward references were updated in place.
