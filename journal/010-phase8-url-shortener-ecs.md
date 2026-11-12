# 010 — Phase 8: a second app on Fargate

**Date:** 2026-11-09 → 2026-11-12 · **Time spent:** _h · **Credits:** $_ remaining

## Goal

Take a NestJS + MongoDB app I wrote in 2021, get it onto Fargate behind an ALB, and see
which parts of 009 survive contact with a different runtime and a different database.

**Caveat on this entry:** the application code was largely not mine this phase. The
modernisation, the health controller, the index job, the compose file and the `autoIndex`
change were written by the assistant. I wrote the Dockerfile, ran every AWS action through
the console, and did the diagnosis with guidance. That matters for reading the rest of this.

## What was built

Thirteen objects, though not the same thirteen as 009.

| # | Object | Notes |
|---|---|---|
| 1 | ECR repo `url-shortener` | private, tag immutability on, AES-256 |
| 2 | Image `url-shortener:d881ce1` | arm64 Mac → ECR, 89.6 MB on the wire |
| 3 | SSM parameter `/url-shortener/mongo-url` | Standard tier, SecureString |
| 4 | IAM role `ecsTaskExecutionRole` | managed policy + inline `ssm:GetParameters` |
| 5 | Log group `/ecs/url-shortener` | 1 day retention, created before ECS could |
| 6 | ECS cluster `url-shortener` | Fargate |
| 7 | Task definition `url-shortener:1` | **ARM64**, .25 vCPU / .5 GB |
| 8 | SG `url-shortener-alb-sg` | 80, 443 from `0.0.0.0/0` |
| 9 | SG `url-shortener-task-sg` | 3000 from the ALB's SG, not a CIDR |
| 10 | Target group `url-shortener-tg` | **IP** target type, `/health/live`, 30s dereg delay |
| 11 | ALB `url-shortener-alb` | internet-facing, HTTP:80 only |
| 12 | ECS service `url-shortener` | 1 task, public IP on, circuit breaker + rollback |
| 13 | MongoDB Atlas M0 | not an AWS object, and that is the story of this phase |

## Issues

**1. The 2021 toolchain could not build at all.** `@nestjs/cli@7.6.0` declares
`webpack@5.28.0` as a dependency and does not install it; adding webpack explicitly then
produced a wall of `TS1005` parse errors, because TypeScript 3.7 cannot read the `.d.ts`
syntax that 2026's `@types` packages ship. There was no version of "just build the old app" —
modernising was forced rather than chosen. A side effect worth knowing about: `npm install`
rewrote `package-lock.json` from **lockfileVersion 1 to 3**, and the committed diff is
**4,030 insertions against 13,032 deletions** — the entire tree re-resolved against today's
registry, silently, as a side effect of a command that looks read-mostly.

**2. DocumentDB is not available on the AWS Free Plan.** *"The specified cluster engine type
is not available with free plan accounts. Available engine types: [aurora-postgresql]."*
This is a **service gate, not a spend limit** — having credits is irrelevant to it.
Upgrading to the Paid Plan carries credits over, with one trap: upgrading *by joining an AWS
Organization or a Control Tower landing zone* expires them immediately. I went to Atlas
instead. That unblocked me in ten minutes and cost me the VPC, subnet-group and
security-group work DocumentDB would have forced — a trade made for velocity, not an
equivalent substitution.

**3. `ecr:GetAuthorizationToken` — `AccessDeniedException`.** I created
`ecsTaskExecutionRole` with the inline Parameter Store policy and never attached
`AmazonECSTaskExecutionRolePolicy`. The wording matters: *"because no identity-based policy
allows the ecr:GetAuthorizationToken action"* means nothing granted it, as opposed to
something denying it. The structural lesson is ordering — the **execution role is used before
my container exists**, to fetch the image and the secret. Nothing in the app, the Dockerfile
or the networking had run yet, so none of it was worth looking at.

**4. "Rollback failed" was not a second failure.** The deployment circuit breaker fired
correctly, then had nowhere to roll back to, because this was the first deployment the
service had ever attempted. Reads like a compounding error; is the feature working.

**5. The Atlas IP access list broke startup in a way that looked like networking.**
`src/database/database.providers.ts:14` awaits `mongoose.connect()` during module init, so
when Atlas refused the connection the app **never bound a port at all**. The ALB got a
connection refused rather than an error response, the target never went healthy, and ECS
replaced the task on a loop. The fix is `0.0.0.0/0` on the access list, which M0 forces: no
PrivateLink or peering below M10, and Fargate task IPs are dynamic. The same constraint shows
up twice — once on the Atlas side, once as egress on the task SG.

**6. The deployment was green while the product was broken.** `BASE_URL` in the task
definition was still `http://localhost:3000`, so every short link the API returned was
unusable:

```
{"code":"C5N2ZN","short_url":"http://localhost:3000/C5N2ZN"}
```

The redirect itself worked, because it reads the code from the request path and never
consults `BASE_URL`. Health checks returned 200, target healthy, service stable, logs clean.
**No part of the infrastructure can catch this class of bug.** I found it by reading the
response body of a smoke test I nearly skipped.

## Decisions

| Decision | Chose | Over | Why |
|---|---|---|---|
| Image | single-stage | multi-stage | Measured rather than argued: 600 MB on disk, **89.6 MB on the wire**, against the ledger's 397 MB / 86.7 MB. Pull cost is compressed size, so the real gap was ~3 MB. Multi-stage deferred to the phase that adds image scanning, where attack surface gives it a reason |
| Database | Atlas M0 | DocumentDB | Free Plan gate, see issue 2 |
| Secret | Parameter Store | Secrets Manager | Nothing rotates an Atlas password, and rotation is most of what $0.40/secret/month buys |
| `autoIndex` | `NODE_ENV !== 'production'` | always off + index job | Dev gets unique indexes for free; production keeps the one-off job so concurrent tasks do not race to build the same two indexes |
| Compose | mongo service, no auth, no volume, no published port | parity with production | mongod reachable only on the compose network, so credentials would protect nothing. Dropping the `indexes` service followed from the autoIndex change |
| HTTPS + domain | skipped | ACM + Route 53 + 443 listener | Already done end to end in 009 |

## Numbers

| | this phase | 009 |
|---|---|---|
| Image, disk | 600 MB | 397 MB |
| Image, on the wire | 89.6 MB | 86.7 MB |
| Task size | .25 vCPU / .5 GB | .25 vCPU / **2 GB** (mistake) |
| Installed packages | 350 | — |
| Runtime dependencies | 9 | — |

Running cost not captured — the CLI session had expired at close. Atlas M0 is free; the ALB
and the Fargate task are not. **Capture the actual figure at the next teardown.**

## What I was walked through, and what that means

Honest accounting, because the point of this journal is to know what I can do unaided.

**Recalled from 009 without prompting:** very little that I can point to. I knew the overall
shape — registry, task definition, load balancer, service — and that the health endpoint
mattered.

**Told to me, and I would not have got right alone:** ARM64 on the task definition; **IP**
rather than Instance target type for `awsvpc`; the health check path, since the default `/`
404s against this app and loops forever; liveness rather than readiness for the ALB; public
IP required with no NAT; the execution-role-runs-first diagnosis; Parameter Store over
Secrets Manager.

That is the real result of this phase: **the transfer test has not been run yet.** Doing it
twice with guidance is not the same as doing it once alone. Phase 9 should be this same
deployment with the journal closed.

**Database knowledge did not transfer at all.** RDS, then DocumentDB, then Atlas were three
different answers to one question, and 009's TLS and CA-bundle work was simply inapplicable —
Atlas uses a public CA already in Node's trust store. The cert work I deferred in 009 remains
deferred. I have now not done it twice.

## Open at close

- **Zero tests.** `test/` went out with the old toolchain — it asserted `304` and exercised a
  `/urls` endpoint that no longer exists. Against my own rule, and the largest thing carried
  forward.
- **No lint.** The eslint config went in the same commit.
- **Atlas allowlist is `0.0.0.0/0`,** protected by credentials alone.
- **No task role, so still no ECS Exec** — the identical gap 009 closed with, still open.
- **HTTPS not done this phase.** The ACM certificate and the `trinaaxel.com` hosted zone are
  still in place, so it stays cheap whenever I want it.
- **The `describe-*` sweep 009 left open is still open.** Two phases now resting on the
  console rather than on captured output.
- **Teardown:** to be decided deliberately at close, not by forgetting.
