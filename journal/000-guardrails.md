# 000 — Phase 0: Guardrails
**Date:** 2026-10-08 · **Time spent:** _h · **Credits:** $0 used (balance $118.97)

> Written retroactively on 2026-10-11. Nothing was recorded at the time, so the
> Issues section below is empty by fact, not because the phase was frictionless.

## Goal
Put the rules in place before any code: what the project is, what it refuses to be,
and where the tutor's context lives — so that `/clear` costs nothing.

## Issues
Not recorded at the time. Any errors from this phase are lost.

## Decisions
| Choice | Picked | Rejected | Why |
|---|---|---|---|
| Tutor context | `CLAUDE.md` + `.claude/PROJECT-PLAN.md` + `.claude/PROJECT-CONTINUITY.md` | claude.ai chats, a Claude Doc, a separate `STATE.md` | Local, versioned, survives `/clear`; one volatile doc, not two |
| Plan split | Stable spec vs live progress in separate files | One combined doc | The spec must not churn every session |
| App code | Learner types all of `src/` | AI writes it | Phase 1 anti-goal: the point is to understand it |

## Numbers
3 context documents. 25 locked decisions recorded in plan §5. 12 phases defined in §7.

## Post hook
The first commit on an infrastructure project should be the rules, not the code.

## Open at close
- `CLAUDE.md` is currently **deleted in the working tree** (`D CLAUDE.md`). Either restore it
  or record where it moved — Phase 0's main artifact is missing from disk.
- `.claude/PROJECT-CONTINUITY.md` is 0 bytes: the handoff machinery was never written.
