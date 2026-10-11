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

| # | Phase | Done when | Target week |
|---|---|---|---|
| 0 | Guardrails | — | done |
| 1a | Scaffold | config + pool + Fastify with two health routes | done |
| 1b | Schema | ledger-core migration; up/down/up; psql break tests fail; SUM = 0 | Oct 12 |
| 1c | Transfer + idempotency | same key twice → one transaction; same key, different body → 422; overdraft rejected | Oct 12 |
| 1d | Outbox | rollback → no event; crash after commit → event survives | Oct 19 |
| 1e | Shutdown + logs | in-flight request completes during shutdown | Oct 19 |
| 2 | Worker | two workers never double-process; kill mid-batch → nothing lost | Oct 26 |
| 3 | Tests | a deliberate bug is caught | Nov 2 |
| 4 | Docker | `docker compose up` from a clean clone | Nov 9 |
| 5 | Raw EC2 | 3 pains that orchestration fixes, written down | Nov 16 |
| 6 | CI | failing test blocks PR | Nov 23 |
| 7 | ECS by hand | HTTPS works, then everything deleted | Nov 30 |
| 8 | Terraform | zero → HTTPS in one apply; destroy < 15 min | Dec 7 |
| 9 | CD | broken image auto-rolls back | Dec 14 |
| 10 | Service-to-service | worker reaches api by name; nothing else can | Dec 28 |
| 11 | Observability | a forced error emails you | Jan 4 |
| 12 | Write-up | post from journal: errors, decisions, numbers | Jan 11 |

Target weeks are the week-of dates from §10; Dec 21 is buffer. Live status per phase lives in
`.claude/PROJECT-CONTINUITY.md`, not here. Detail for each phase follows.
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
- **2 Worker** — `src/worker/index.ts` poll loop with `SKIP LOCKED`, calls ledger internal endpoint, idempotent
  consumer, backoff, graceful stop. Done: two workers never double-process; kill mid-batch → nothing lost.
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
- **8 Terraform** — codify Phase 7; remote state in S3 (native lockfile — verify version); no secrets in state.
  Done: zero → HTTPS in one apply; destroy < 15 min.
- **9 CD** — on main: build → push (SHA tag) → migrate task → new task def → deploy, wait stable; deployment circuit
  breaker with rollback. Done: broken image auto-rolls back.
- **10 Service-to-service** — worker as ECS service; Service Connect; SG rule worker→api; decide outbox polling vs SQS.
  Done: worker reaches api by name; nothing else can.
- **11 Observability** — Logs Insights queries; metric filter on error logs → alarm → SNS email. Container Insights costs extra.
  Done: forced error emails you.
- **12 Write-up** — post from journal: errors, decisions, numbers.
- **Later (challenge each first)** — crons: EventBridge Scheduler → ECS RunTask nightly reconciliation (cached balance
  vs SUM entries) · Prometheus: local first, AMP later · ArgoCD: local kind/k3d, not EKS · Elasticsearch: local Docker.

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
- [ ] Payoff goal — role change, higher rates, freelance, or audience? Sets depth; decides whether Jenkins survives. (now)
- [ ] Same-currency rule: DB constraint or application-only? (1b)
- [ ] Fastify validation: JSON Schema vs the zod type provider. (1c)
- [ ] BIGINT arrives from `pg` as a string — BigInt internally, string over JSON? (1c)
- [ ] Test runner: `node:test` vs vitest. (3)
- [ ] Base image: node:24-slim vs alpine vs distroless. (4)
- [ ] Worker transport: outbox polling vs SQS. (10)
- [ ] CI linter, given the TS 6 tooling gaps. (6)
- [ ] `npx tsc` resolved to an npm placeholder package — root cause unconfirmed; run `which -a node npm npx`. (soon)
- [ ] Editor set to use the workspace TypeScript. (soon)

## Changelog
- 2026-10-09: created from claude.ai sessions (Phase 0 → 1b).
- 2026-10-10: renamed from BRIEF.md to .claude/PROJECT-PLAN.md. STATE.md retired; live progress moved to
  .claude/PROJECT-CONTINUITY.md. Absorbed STATE's account, schedule and open-decision content as sections 10 and 11.
- 2026-10-11: added the 12-phase summary table to §7 (goal, done-when, target week).
