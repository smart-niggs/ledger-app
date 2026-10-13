# 006 — Phase 5: Raw EC2
**Date:** 2026-10-12 · **Time spent:** _h · **Credits:** $_ used (balance was $118.97)

## Goal
Deploy the compose stack by hand onto one `t4g.micro`, reachable only through SSM —
no key pair, no inbound rule. Reboot it, read its logs, terminate it. Write down the
pains that an orchestrator removes.

## Setup
Account `755573862900`, IAM user `trina-admin`, `us-east-1`. Instance `ledger-lab`
(`i-0c0b5ab800ca4fa02`), `t4g.micro`, Amazon Linux 2023 arm64, instance profile `ledger-ec2-ssm`
(`AmazonSSMManagedInstanceCore` only). Zero inbound security-group rules — the default
SSH-to-`0.0.0.0/0` rule was removed in the launch wizard. Deploy was
`git clone -b feat/module-2/db-setup` of the public repo over HTTPS, then
`docker compose up -d --build` on the box.

## Issues
**1. `session-manager-plugin` was not installed.**
```
zsh: command not found: session-manager-plugin
```
`aws ssm start-session` cannot work without it; the AWS CLI alone only negotiates the
session. Homebrew cask offered `1.2.835.0`, above AWS's `1.2.764.0` floor. _Never
confirmed installed — the console's `Connect → Session Manager` was used instead, which
needs no local plugin._

**2. The IAM instance profile is not the IAM user.**
`trina-admin` is a *user*; users cannot be attached to an instance. An instance gets
credentials only through an instance profile wrapping a *role* that trusts
`ec2.amazonaws.com`. The IAM console's "EC2 use case" creates that instance profile
silently — `aws iam list-instance-profiles-for-role` is what reveals it. The CLI needs
`create-instance-profile` + `add-role-to-instance-profile` as two extra explicit steps.

**3. `git clone` appeared to need `sudo`.** Not a permissions problem on AWS — the SSM
session starts outside `$HOME`, in a directory `ssm-user` cannot write. `cd ~` fixed it.
`ssm-user` already has passwordless sudo, so there was no privilege to grant. Two
unrelated layers (IAM-to-AWS vs Linux-user-on-box) looked like one problem.

**4. Compose plugin was too new for the distro's Docker.**
```
unknown flag: --progress
compose build requires buildx 0.17.0 or later
```
AL2023 ships `docker 25.0.16`; the compose plugin was taken from GitHub `latest`. Two
independently-versioned components against an old daemon. Self-inflicted — the fix was
installing buildx `v0.38.0` manually from the release asset `buildx-v0.38.0.linux-arm64`.
`--progress` is unsupported on that compose version; `BUILDKIT_PROGRESS=plain` is the
version-independent way to get readable build output.

**5. `docker compose up` without `--build` is not a way to avoid building.** With both
`build:` and `image:` set, Compose follows `pull_policy`, default `missing`: it attempts
the pull *first*, then builds from source if the image isn't found. `image: ledger:dev`
has no registry prefix, so that pull resolves to Docker Hub `library/ledger` and can never
succeed. `--build` means "rebuild even if present", not "build at all".

**6. Reboot left the box healthy and the application gone.**
Not recorded as an error anywhere — see Numbers.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Instance arch | `t4g.micro` ARM | `t3.micro` x86 | Cheaper ($0.0084/h; T4g is "up to 40% better price-performance" per AWS) and the whole pipeline stays one architecture. The binding constraint is image↔host, not laptop↔host |
| Access | SSM Session Manager, no key pair | SSH + key pair + port 22 | Zero inbound rules; the agent dials out on 443. Nothing to lose, rotate or leak |
| Instance profile scope | `AmazonSSMManagedInstanceCore` only | reuse an admin role | Instance-profile credentials are readable from any process on the box via `169.254.169.254`. Admin there means a container escape owns the account |
| Build location | on the box, this once | ship an image | Deliberate: generating the pain is the phase. The box has no ECR or S3 permission anyway |
| Memory | 2 GiB swapfile before building | size up the instance | Only the *build* needs the memory. Paying for a bigger box for a once-per-deploy step is the pain, not the fix |
| `restart:` policy | left absent | `restart: unless-stopped` | The single-host fix would have hidden pain #4. Phase 7's desired-count replaces it |
| Compose file edits | none on the box | edit in place | A change made on the instance exists nowhere else; the next clone loses it. The box is scratch, not an authoring environment |

## Numbers
`docker 25.0.16 · aarch64 · 954372096 bytes RAM` — **910 MiB**, with 202 MiB already used
and 635 MiB available before any build. Swapfile: 2147483648 bytes written at 147 MB/s in
14.575 s, giving `Swap: 2.0Gi`. `ledger:dev` measured **397MB** locally (86.7MB content).

## Numbers — the deploy, verbatim
```
{"ok":true} --> 200
{"id":"1","type":"system","currency":"NGN","balance":"0"} --> 201
{"id":"2","type":"user","currency":"NGN","balance":"0"} --> 201
{"transactionId":"1","from":"1","to":"2","amount":"50000","currency":"NGN"} --> 201
```
That last 201 is the proof: migrations ran, the deferred sum-to-zero constraint trigger
fired and passed, and `idempotency_keys` exists — on ARM, in EC2, from a clean clone.

## Numbers — after `sudo reboot`, verbatim
```
NAME                   IMAGE                COMMAND                  SERVICE   CREATED         STATUS
ledger-app-api-1       ledger:dev           "docker-entrypoint.s…"   api       6 minutes ago   Exited (0) 3 minutes ago
ledger-app-db-1        postgres:17-alpine   "docker-entrypoint.s…"   db        6 minutes ago   Exited (0) 3 minutes ago
ledger-app-migrate-1   ledger:dev           "docker-entrypoint.s…"   migrate   6 minutes ago   Exited (0) 6 minutes ago
```
`systemctl enable docker` brings the *daemon* back. It does not bring containers back —
there is no `restart:` key on any service. Every exit code is **0**: the API drained
cleanly on the daemon's SIGTERM (Phase 1e validated under a real host shutdown, which the
local test could not show), and Postgres shut down clean, so no recovery on next start.

## The pains that orchestration fixes
1. **Reboot ≠ recovery.** Instance running, docker running, three containers, every exit
   code 0, no error in any log — and nothing serving. A scheduler maintains a *desired
   count*: lose the task, the instance or the AZ and the missing thing is replaced without
   anyone reconnecting to anything. This is the strongest argument in the set precisely
   because nothing looked broken.
2. **A runtime host was made to carry a build toolchain.** docker group, compose plugin,
   buildx, jq, git, node, npm — four detours and two version mismatches before a line of
   application code ran. None of it is needed to *run* the image. Phase 7's host pulls a
   finished artifact and owns no builder.
3. **Build memory, not runtime memory, sized the instance.** ~2 GB to build, ~200 MB to
   run. Instance sizing and cost were set by a step that happens once per deploy. Build
   elsewhere, ship the artifact, size for the runtime.
4. **One shell, one box, one chance.** Every step was a command typed into an interactive
   session with no record except this file. Nothing is reproducible, nothing is reviewable,
   and the next instance starts from zero. That is Phase 8.
5. **Logs die with the box.** `docker compose logs` and `journalctl -u docker` are two
   separate universes on one host, with no aggregation, no retention and no survival past
   termination. That is Phase 11.

## Open at close
**Instance `i-0c0b5ab800ca4fa02` terminated from the EC2 console on 2026-10-12.** The IAM
role `ledger-ec2-ssm`, its instance profile and the launch-wizard security group were kept
deliberately — all free, and Phase 7 reuses the role pattern.

**Permanently lost — the box was terminated before these were captured:**
- `docker buildx version` after install. `buildx-v0.38.0.linux-arm64` is the asset that was
  fetched, not a confirmed running version.
- `docker compose up -d` after the reboot, and the `accounts/2/balance` check that would
  have shown `"50000"` and proved the `pgdata` volume survived. Volume survival across a
  *reboot* says nothing about survival across a *termination* — which is why Phase 7 moves
  the database to RDS.
- Build duration and peak memory; whether the 2 GiB swap was actually touched is unknown.
- `dnf list --available 'docker*'`, so whether AL2023 offers a distro-matched
  compose/buildx — which would have avoided issue 4 entirely — is still unknown.

**Still open:**
- `Credits:` in the header. AWS billing data lags up to 24 h, so this session's real figure
  is readable from `Billing and Cost Management -> Credits` on 2026-10-13, not today.
- `session-manager-plugin` was never confirmed installed; the phase ran entirely through the
  console's `Connect -> Session Manager`, so `aws ssm start-session` from the laptop is
  still unproven.

**Cost of the three states, since this question will recur** (verified 2026-10-12:
`$0.0084/h` t4g.micro, `$0.08/GB-month` gp3, `$0.005/h` per in-use public IPv4):

| | Compute | 8 GiB gp3 | Public IPv4 | Total/month |
|---|---|---|---|---|
| Running | $6.13 | $0.64 | $3.65 | **$10.42** |
| Stopped | $0 | $0.64 | $0 (released) | **$0.64** |
| Terminated | $0 | $0 | $0 | **$0** |

An `available` (unattached) volume bills identically to an attached one, and
`DeleteOnTermination` defaults to `false` on non-root volumes — so terminating an instance
with a data volume leaves it billing silently. Terminate is the only state that reaches $0,
which is what makes `terraform destroy` the real test in Phase 8. The public IPv4 cost more
than half of the instance itself and was never used, but it is still the cheap way to give
SSM its outbound path: three interface VPC endpoints would run roughly `$0.01/h` each.
