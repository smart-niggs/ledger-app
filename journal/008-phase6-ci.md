# 008 — Phase 6: CI
**Date:** 2026-10-13 · **Time spent:** _h · **Credits:** $0 used (GitHub Actions is free for public repos)

## Goal
A pull request that cannot be merged while a test fails. Not "a workflow exists" —
GitHub actively refusing the merge.

## What was built
`.github/workflows/ci.yml`, one job named `test` on `ubuntu-latest`, triggered by
`pull_request` targeting `main`. A `postgres:17-alpine` service container, then
`npm ci` → `npm run migrate -- up` → `npm run check` → `npm test`. Plus a branch ruleset on
`main` requiring that check, with an empty bypass list.

Built in two stages deliberately: Stage 1 was plumbing only (checkout, Node, `npm ci`,
`npm run check` — no database), pushed and proven green before Stage 2 added the service
container, migrations and `npm test`. A Stage 2 failure then had exactly one possible cause.

## Issues
**1. A required status check cannot be selected until it has reported at least once.**
GitHub's ruleset picker searches checks it has actually seen. Configure branch protection
before the first run and the list is simply empty, with nothing explaining why.

**2. `DATABASE_URL` is `localhost` in CI but `db` in Compose.** Not an inconsistency.
Compose runs the app *inside* the Docker network, where the service name resolves. Actions
runs steps on the runner VM *outside* it, so the container's port is published to the VM's
localhost by `ports: ["5432:5432"]`. The same file would say `db` again if the job used
`container:`.

**3. Enforcement status defaults to Disabled.** A ruleset created and left at the default
looks configured and gates nothing.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Provider | GitHub Actions | Jenkins, CircleCI | Repo is already on GitHub, public repos get free runners, and §6 specifies Actions. Jenkins in the plan is conditional on the §1 payoff question, still unanswered |
| Trigger | `pull_request` to `main` | `push` on every branch | The bar is about blocking a *merge*. Running on every push burns minutes proving nothing |
| Token scope | `permissions: contents: read` | the default token | The default `GITHUB_TOKEN` carries write scopes this job has no use for. One line, least privilege |
| Postgres | `services:` container, `postgres:17-alpine` | Testcontainers; a hosted test DB | Identical image tag to `docker-compose.yml`, so CI and local cannot drift on a version |
| Readiness | `--health-cmd pg_isready` + retries | a `sleep` | Compose gets this from `depends_on: service_healthy`; without the equivalent here, `migrate` races a Postgres still booting |
| Node version | `node-version-file: .nvmrc` | hardcoded `24` in the workflow | One source of truth. Bumping `.nvmrc` moves CI with it instead of silently diverging |
| Check composition | `npm run check` | spelling out `tsc --noEmit && tsc` | CI should not know what "checking" means. Adding a linter later becomes a `package.json` edit with no workflow change |
| Bypass list | empty | add repo admins | Sole admin on the repo — adding myself would make the gate decoration |
| Action pinning | `@v4` | `@main`, full SHA | Moving major tag: bugfixes inside v4 arrive automatically, a breaking v5 never does |

## Numbers
Stage 1 (no database): **succeeded in 13 s**. Annotations reported 1 warning and 1 notice —
not yet read.

Merged PRs #1 and #2. The bar itself is two commits:
```
d7a0013 simulate breaking tests - to test github CI
bc09e1e UNDO simulate breaking tests - to test github CI
```
The first produced a failing `test` check and a merge GitHub refused. The second restored
green.

## Post hook
The deliberate break is the only part that counts. A workflow that runs tests and a ruleset
that names a check are both just configuration — they can be wrong in ways nothing reveals
until the day they were supposed to stop something. Watching the merge button actually
refuse is the difference between believing the gate works and knowing it.

The staged build paid for itself too: Stage 1 green meant that when the database arrived,
any failure was unambiguously about the database.

## Open at close
- **Annotations: 1 warning and 1 notice, unread.** Usually an action deprecation; worth
  expanding before it becomes a broken pipeline.
- **No linter.** §6 lists lint as a CI step and §11 still has "CI linter, given the TS 6
  tooling gaps" open. There is no `lint` script, so nothing was wired. The CI change when it
  lands is one line, because `check` is the indirection.
- **`npm run check` does not typecheck `test/`** (journal 007, Issues 2). A type error in a
  test file passes CI today.
- **Nothing is deployed by CI.** §6 also calls for building an ARM image and pushing to ECR
  via an OIDC role trusted only for this repo and branch. ECR does not exist until Phase 7.
  The plan's "native ARM runner if free for public repos" is still unverified.
- **The `lab` profile is still a long-lived IAM access key.** It must not become a GitHub
  Actions secret; the OIDC role replaces it. Noted at Phase 5 pre-flight and still true.
- Branch `test/prove-ci-blocks` is still checked out locally and pushed; it has served its
  purpose.
