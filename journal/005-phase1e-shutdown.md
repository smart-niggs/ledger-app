# 005 — Phase 1e: Graceful shutdown + logs
**Date:** 2026-10-11 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

## Goal
On SIGTERM: stop accepting new connections, let in-flight requests finish, close the
pool, exit 0 — inside the window ECS allows before it sends SIGKILL. JSON logs to
stdout carrying a request id, with no secrets.

## Issues
None. Passed first run.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Drain | `app.close()` then `pool.end()`, `process.exit(0)` | exit immediately on SIGTERM | `app.close()` stops the listener and waits for in-flight handlers; exiting first would reset live connections mid-deploy |
| Timeout guard | 10s `setTimeout` → `exit(1)`, `.unref()`d | wait indefinitely | ECS SIGKILLs after `stopTimeout`; exiting on our own terms keeps the log honest. `.unref()` so the timer never holds the process open |
| Re-entrancy | `shuttingDown` flag | none | Two SIGTERMs (or SIGTERM then SIGINT) would otherwise run the drain twice |
| Request id | reuse inbound `x-request-id`, else `randomUUID()` | always generate | Behind an ALB, one id must span the load balancer, the api task and the worker |
| Log redaction | `req.headers.authorization`, `req.headers.cookie` | log everything | Neither exists yet; the list has to predate the header that leaks |
| Test harness | compiled `dist/` on port 3100 | `tsx watch` on 3000 | One process, no wrapper to swallow signals — and it is exactly what production runs |

## Numbers
In-flight request held on a row lock for **5258 ms**, of which **2.2 s were after SIGTERM**,
and it still returned **201**. New connections after SIGTERM: refused (`HTTP 000`).
Drain completed 1 ms after the in-flight request finished.

## Numbers — the shutdown log, verbatim
```
{"level":30,"time":1791745502617,"reqId":"ed673bf5-a29d-4124-bc76-c73d88f0f943","req":{"method":"POST","url":"/transfers",...},"msg":"incoming request"}
{"level":30,"time":1791745505636,"signal":"SIGTERM","msg":"shutdown: draining in-flight requests"}
{"level":30,"time":1791745507876,"reqId":"ed673bf5-a29d-4124-bc76-c73d88f0f943","res":{"statusCode":201},"responseTime":5258.506625,"msg":"request completed"}
{"level":30,"time":1791745507877,"msg":"shutdown: clean"}
```

## Post hook
SIGTERM arrived while a transfer was blocked on a row lock. The request finished 2.2
seconds later with a 201, and the next connection was refused. That gap is the whole
difference between a deploy nobody notices and a deploy that drops requests.

## Open at close
- The app binds `0.0.0.0`, so `Server listening at http://192.168.0.144:3100` — reachable
  from the LAN during local development. Required inside a container; in AWS the
  security-group chain is what closes it.
- 10s drain vs ECS `stopTimeout` is unverified against a real task definition (Phase 7).
