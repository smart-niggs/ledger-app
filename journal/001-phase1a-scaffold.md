# 001 — Phase 1a: Scaffold
**Date:** 2026-10-09 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

> Written retroactively on 2026-10-11 from verified repo state. Errors from the day
> were not captured and are lost.

## Goal
A server that boots, fails loudly on bad config, and can tell a load balancer the
difference between "alive" and "able to serve" — with Postgres running in Docker.

## Issues
Not recorded at the time.

Known unresolved from this period (plan §11): `npx tsc` once resolved to an unrelated
registry package instead of the local TypeScript binary. Root cause never confirmed.
Mitigation in force: use `npm run`, or `npm exec --no` for a genuine one-off.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Config | zod `schema.parse(process.env)` at module scope | reading `process.env` inline | Malformed `DATABASE_URL` throws during import, before Fastify binds a port |
| Health | `/health/live` static + `/health/ready` running `SELECT 1` | one combined check | The LB targets liveness, so a DB blip degrades requests instead of killing every task |
| Bind address | app on `0.0.0.0`, Postgres published on `127.0.0.1:5432` | symmetric | The app must accept traffic inside a container; the DB must never reach the LAN |
| Imports | `.ts` extensions + `rewriteRelativeImportExtensions` | `.js` in source | Learner preference; compiler emits `.js` |
| Dev runner | `tsx watch` | ts-node, Node type stripping | ts-node unmaintained; churned 4 times before locking this |

## Numbers
3 source files (`config.ts`, `db/pool.ts`, `api/server.ts`). 2 health routes.
Node 24.18.0. Postgres 17-alpine in Compose with a `pg_isready` healthcheck.
Both health endpoints verified returning 200 on 2026-10-11.

## Post hook
Two health endpoints is not redundancy. One answers "is the process alive",
the other "can it serve" — point your load balancer at the wrong one and a
30-second database blip kills every task you have.
