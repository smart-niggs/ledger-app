# 009 — Phase 7: ECS by hand

**Date:** 2026-10-14 → 2026-10-15 · **Time spent:** _h · **Credits:** $138.45 estimated
remaining of a $140.00 credit at phase start ($1.55 used across phases 0–6)

## Goal

`https://` on a domain I own, serving the ledger from Fargate against RDS, with a real
transfer returning 201 — then everything deleted. Not "ECS exists": a certificate a browser
accepts, in front of a money-moving endpoint.

## What was built

Thirteen objects, in dependency order, every one through the console.

| # | Object | Notes |
|---|---|---|
| 1 | ECR repo `ledger` | private, **tag immutability on**, AES-256 |
| 2 | Image `ledger:986530a` | built on an arm64 Mac, pushed to ECR |
| 3 | VPC `ledger-vpc` `10.0.0.0/16` | DNS hostnames enabled |
| 4 | 4 subnets | `public-1a/1b` (`10.0.0/1.0`), `private-1a/1b` (`10.0.10/11.0`) |
| 5 | IGW + 2 route tables | public → `0.0.0.0/0 → igw`; private → `local` only |
| 6 | `ledger-task-sg`, `ledger-rds-sg` | rds-sg's source is **task-sg**, not a CIDR |
| 7 | RDS `ledger-db` | PostgreSQL **18.3-R2**, `db.t4g.micro`, 20 GiB gp3, single-AZ, not public |
| 8 | SSM param `/ledger/prod/DATABASE_URL` | SecureString, Standard tier, `alias/aws/ssm` |
| 9 | Log group `/ecs/ledger` | retention **1 week**, not the "Never expire" default |
| 10 | `ledger-ecs-execution-role` | managed exec policy + inline `ssm:GetParameters` on `/ledger/prod/*` |
| 11 | Task definition `ledger:1` | FARGATE, **ARM64**, secrets→SSM, awslogs. No task role. |
| 12 | `ledger-tg` + `ledger-alb` + `ledger-alb-sg` | target type **IP**, health `/health/live`, HTTP:80 + HTTPS:443 |
| 13 | ACM cert + Route 53 **alias** | `trinaaxel.com` and `*.trinaaxel.com`, DNS-validated |

Built in the order the learner asked for rather than the plan's order: **smallest thing that
works first, then add each object when its absence hurts.** The API ran as a bare task on a
public IP with no load balancer at all before the ALB existed. That one step is why the
target group never felt arbitrary.

## Issues

**1. `ECONNREFUSED 127.0.0.1:5432` — a secret that arrived and still pointed at localhost.**
First migration run. Easy to misread as "the secret didn't inject", but
`node_modules/node-pg-migrate/bin/node-pg-migrate.js:349-350` prints an explicit
*"The DATABASE_URL environment variable is not set"* when it's missing — that message never
appeared, so the variable was present. `pg` parses the connection string as a URL; if the
**host section comes out empty it silently falls back to libpq defaults**, which are
`localhost:5432`. A `#` or `?` in the password truncates the URL before the host (fragment
and query delimiters), and `/` ends the authority section early. The diagnosis isn't "wrong
value", it's "unparseable value, failing open".

**2. `no pg_hba.conf entry … no encryption`, `code: '28000'`, `routine: 'ClientAuthentication'`.**
RDS PostgreSQL sets `rds.force_ssl = 1` by default. `pg` does not use TLS unless told to.
`pg_hba.conf` matches on *(type, database, user, address, **SSL state**)*; a plaintext
connection matched no row. Note it is **not** `28P01` — that would be a wrong password. The
local `postgres:18-alpine` accepts unencrypted connections happily, so this cannot surface
before the first real deploy. Textbook dev/prod divergence.

**3. `SELF_SIGNED_CERT_IN_CHAIN` — `?sslmode=require` does not mean what libpq means.**
`node_modules/pg-connection-string/index.js:137-158`: `prefer`, `require` and `verify-ca`
are all **aliases for `verify-full`** unless `uselibpqcompat=true`. So `require` left
`ssl = {}`, Node defaulted `rejectUnauthorized` to true, and full verification ran against
Node's bundled CA list — which **does not contain Amazon's RDS CA**. The empirical finding:
RDS certificates do not chain to a publicly trusted root. Anything verified needs
`sslrootcert` pointing at Amazon's bundle on disk.

**4. A failed migration task ran for 21 minutes.** The connection error was logged, the
process never exited. `pg` left an open socket handle and Node won't exit while one is open
— the same reason `pool.end()` in an `after()` hook is mandatory in the test suite
(journal 007). On a laptop that's a hung terminal. On Fargate it bills per second with no
natural end. **A one-off task that can fail needs a timeout, not just an error path.**

**5. `curl` hung instead of refusing — and the hang *is* the diagnosis.** `ledger-task-sg`
had zero inbound rules, created that way deliberately. **Security groups drop packets; they
never reject them**, so a scanner learns nothing from a closed port. Which makes the failure
mode diagnostic:

```
Connection refused  →  the packet arrived; the problem is the app or the port
Timeout / hang      →  nothing replied; the problem is a security group, route table or NACL
```

`ping` is worthless here for the same reason — ICMP isn't permitted by default either, so a
perfectly healthy service never answers.

**6. `Listener port unreachable — The security groups for your load balancer don't allow
traffic on this listener port.`** The HTTP:80 listener existed and had a valid redirect
action; `ledger-alb-sg` had no `:80` inbound rule. **A listener and a security group rule are
two independent things** and either one alone is silently useless. Found and fixed from the
console's own warning, which is the first time the vocabulary paid for itself.

**7. The Postgres 18 image moved its mount point.**
`Error: in 18+, these Docker images are configured to store database data in a format which
is compatible with "pg_ctlcluster"` — 18+ wants a single mount at `/var/lib/postgresql` and
places data in a major-version subdirectory, so `pg_upgrade --link` can span versions inside
one mount. The old `pgdata:/var/lib/postgresql/data` was the 17 convention, and the volume
still held PG17 data besides. Fixed by mounting one level up and renaming the volume to
`pgdata18`. **CI was unaffected — no volume, fresh container every run. RDS was unaffected —
provisioned empty. Only the thing with persistent state broke.** That generalises past
Postgres: a major version bump of a stateful service is never only a tag change.

## Decisions

| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Egress for tasks | **public subnets + public IP** ($0.005/h) | NAT gateway ($0.05/h); 4 VPC interface endpoints ($0.04/h) | `grep` found **zero outbound HTTP** in `src/` and the four runtime deps make none. The private-subnet-plus-NAT pattern exists because real apps call Stripe/SES/webhooks; copying it here would have been convention without its reason. Cost it would have added for no benefit: $32/mo if ever forgotten |
| Build host | laptop → ECR → pull | build on the runtime host (Phase 5) | Phase 5 built a 2 GB image on a 910 MiB box with hand-made swap. With Fargate there is **no host to build on** — the registry is the only way code enters |
| Image tag | git short SHA, immutability **on** | `latest` | A task definition naming `latest` doesn't describe a deployment, it describes "whatever was pushed last". Phase 12 (CD) rollback is "redeploy the previous tag", which requires the tag to still mean the same bytes |
| Secrets | Parameter Store Standard, SecureString | Secrets Manager ($0.40/secret/mo); `environment` | Task definition revisions are **immutable**, so a password in `environment` is readable forever, even after "fixing" it in the next revision. Rotation is the only thing Secrets Manager adds, and nothing rotates yet |
| Param naming | `/ledger/prod/DATABASE_URL` | flat `DATABASE_URL` | The path is what makes `Resource: …parameter/ledger/prod/*` possible. A flat name forces either enumerating every parameter in the policy or granting `parameter/*`, and everyone picks the second |
| Task definitions | one + **container override** | separate `ledger-migrate` | Settled decision: one image, multiple commands. Honest cost: the migrate command then lives in a deploy script rather than a versioned definition. **Revisit at Phase 12 (CD)** |
| Database | RDS `db.t4g.micro` | Aurora; Postgres in a container | Aurora has no `micro` class (smallest ≈ 4–5×), is excluded from the Free Tier, and bills per-I/O. Its wins — 30 s failover, 15 shared-storage replicas — are worth nothing to one task |
| Postgres version | **18.3-R2** | 17.11-R1 | Local Compose was already on 18.3. Production matching the thing CI tests against is the rule; CI was the outlier and moved to 18 |
| Target type | **IP** | Instance | `awsvpc` gives each task its own ENI. There is no instance ID to register |
| Health check path | `/health/live` | `/health/ready` | `ready` is `SELECT 1` (`src/api/server.ts:36`). A database blip would fail every target, the ALB would kill all of them, and a recoverable hiccup becomes a total outage with no capacity to recover into |
| TLS to RDS | `?sslmode=no-verify` **(temporary)** | `verify-full` + CA bundle | Chosen to stop debugging two things at once. **This encrypts but does not authenticate the server.** Deliberate debt, logged below |
| Load balancer | ALB | NLB; CloudFront; TLS in the container | ACM private keys are **not exportable** — a cert can only attach to ALB/NLB/CloudFront/API Gateway. NLB is layer 4 and can't health-check HTTP meaningfully. The ALB is also what makes tasks replaceable: DNS points at it, not at an IP that changes every deploy |
| Certificate names | `trinaaxel.com` **and** `*.trinaaxel.com` | one subdomain | A wildcard matches **exactly one label**, so `*.trinaaxel.com` does not cover the apex. Both on one cert, free, and ready for the frontend |
| DNS record | **A, Alias** | CNAME | Alias resolves the ALB's current IPs at query time, is free to query, and works at the apex. An ALB has **no static IP** — only a stable name |
| Deregistration delay | 30 s | 300 s default | 300 makes every deploy take five minutes to drain. 30 comfortably covers the app's 10 s drain |

## Numbers

**Running cost, all verified against AWS pricing pages the day of use:**

| Object | $/hour |
|---|---|
| ALB | 0.0225 (+ $0.008/LCU-h) |
| RDS `db.t4g.micro` single-AZ | 0.016 (≈ $11.68/mo) |
| Fargate task 0.25 vCPU / 2 GB ARM | ≈ 0.015 |
| Task public IPv4 | 0.005 |
| **Total** | **≈ $0.06/h — about $1.40/day** |

NAT gateways created: **0**. Elastic IPs: **0**. EBS volumes: **0**.

ECR: $0.10/GB-month, free tier 500 MB for 12 months. Image **397 MB** (86.7 MB content).
**Image pull on Fargate: 3 seconds.**

**Four migration task runs before green** — localhost, pg_hba, cert chain, then
`Migrations complete!`.

The two transfers that count:

```
HTTP/1.1 201   {"transactionId":"1", …}   direct to the task's public IP, no load balancer
HTTP/2   201   {"transactionId":"2", …}   https://ledger.trinaaxel.com through the ALB
```

Certificate: `subject: CN=trinaaxel.com`, `issuer: C=US; O=Amazon; CN=Amazon RSA 2048 M04`,
expires **Apr 30 2027**. `HTTP/2` rather than `1.1` because the ALB only negotiates h2 over
TLS — the plaintext 301 response is still `HTTP/1.1`.

## Post hook

**An error from the database is proof the network works.** The single most useful thing this
phase taught wasn't a service, it was a diagnostic habit: the *layer* an error comes from
tells you everything beneath it is fine. `no pg_hba.conf entry` arrived with
`routine: 'ClientAuthentication'` — Postgres only writes that after reading a startup packet
over an established TCP connection. So in one error message: the image pulled through the
IGW, the execution role decrypted the secret, DNS resolved the RDS endpoint, the `local`
route carried the packet to a private subnet, and `ledger-task-sg → ledger-rds-sg` let it
through. Four objects verified by a failure.

The corollary is the hang. A security group **drops** rather than refuses, so `Connection
refused` and `timeout` mean entirely different things — app versus network. That one
distinction cut the debugging time on every subsequent problem.

**And the thing that makes a VPC finally make sense:** routing and permissions are different
questions with different answers. A route table says *can this packet leave the VPC*. A
security group says *may these two things talk*. Subnets isolate nothing — "public" and
"private" are purely a property of which route table a subnet is associated with, one line
in a table. Everything inside a VPC can reach everything else unless a security group
refuses, and the three groups here name each other rather than any IP address:

```
0.0.0.0/0 → ledger-alb-sg :443 → ledger-task-sg :3000 → ledger-rds-sg :5432
```

Three links, zero IP addresses, correct through every deploy.

## Open at close

- **`sslmode=no-verify` is still in production.** Traffic to RDS is encrypted but the server
  is not authenticated — an active MITM would succeed. Fix is one `COPY certs ./certs` in the
  Dockerfile, Amazon's bundle from `truststore.pki.rds.amazonaws.com/us-east-1/`, and
  `?sslmode=verify-full&sslrootcert=/app/certs/rds-ca.pem`. Needs a rebuild, a new SHA tag
  and a new task definition revision.
- **Teardown not yet run.** §7's bar is *"HTTPS works, **then everything deleted**"* — half
  met. At time of writing the service is at desired `0`; ALB and RDS still bill ≈ $0.9/day.
- **Task is 256 CPU / 2048 MB.** Meant to be 512 MB. Valid but roughly 2× the memory cost.
  Fix on the next revision.
- **No task role**, so **no ECS Exec** — there is currently no way to get a shell inside a
  running task. That's the tool wanted the moment something is wrong and the logs don't say
  why.
- **Orphan ACM validation CNAME** `_a1b467cdb4dad…` in the `trinaaxel.com` zone, from a
  certificate requested and deleted earlier. Harmless; remove at teardown.
- **Option C was never exercised.** Tasks sit in public subnets with public IPs. Moving them
  to private subnets behind ECR/SSM/CloudWatch VPC endpoints is a one-session exercise that
  would make the egress argument concrete rather than theoretical.
- **The `environment` vs `secrets` distinction is still only half-used** — `PORT` relies on
  the zod default in `src/config.ts:4` rather than being declared.
- **Requested before Terraform (Phase 10):** a frontend and a queue, built in the console. Learner's
  explicit call, overriding a recommendation to codify in Terraform first — *"with terra, you
  jes gonna give me a bunch of code that confuses me... without grounding me"*.
