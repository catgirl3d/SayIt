# SayIt Fork Porting Guide

This runbook defines how this fork takes changes from upstream
`crosswk/SayIt`: by porting selected behavior, commit by commit. It replaces
the retired rebase workflow; see the last section.

## Model

This fork is a hard fork.

- `main` carries the fork's own history and is never rebased onto
  `upstream/main`, and `upstream/main` is never merged into it.
- Upstream is a source of reviewed changes, not a base to replay onto. Every
  upstream commit is reviewed individually and then re-implemented against the
  fork architecture, confirmed as already present, or consciously rejected.
- Fork history is never rewritten, so the decision journal's evidence commits
  stay reachable.
- Rebase and merge are rejected deliberately: a rebase would rewrite published
  fork history, and a merge would pull in unreviewed upstream architecture;
  both bypass the per-commit decision record.
- The fork owns its versioning, release metadata, and documentation formats.
  Upstream release chores, changelogs, and upstream-only docs are never
  ported.

## Sources of truth

| Artifact | Role |
| --- | --- |
| `dev-scripts/upstream-decisions/` | Authoritative journal of decisions for upstream commits, with its tooling (local, git-ignored). Tool usage: `dev-scripts/upstream-decisions/upstream-decisions.md`. |
| `dev-scripts/upstream-slices/` | Read-only review evidence for large upstream commits (local, git-ignored). Packet format and reviewer contract: `dev-scripts/upstream-slices/README.md`. |
| `UPSTREAM-TRACKER.md` | Committed mirror of porting progress, one row per feature. Update it when a port lands or a decision changes. |
| `CHANGELOG-FORK.md` | Release-facing summary of user-visible fork changes. Release-note discipline: `AGENTS.md` section 4. |
| `AGENTS.md` | Repository-wide engineering rules. |

`UPSTREAM-TRACKER.md` mirrors progress for humans; the decision journal remains
the authoritative record. If they disagree, fix the mirror.

## Workflow

1. `git fetch upstream`. The journal tool never fetches; it reads the locally
   cached `upstream/main`.
2. `node dev-scripts/upstream-decisions/upstream-decisions.mjs status` lists
   upstream commits newer than `main` with their recorded decisions.
   `PENDING` means "not yet reviewed": it is the absence of a record, not a
   stored state.
3. Review each pending commit against the fork: `git show <sha>`, plus the
   current fork behavior with file:line evidence. For a large upstream commit,
   cut it into per-topic slice packets first and give one reviewer one topic.
4. Decide per upstream commit: accept (method `adapted`, `already-present`, or
   `cherry-picked`), partial, or reject, with a written rationale. Partial
   decisions must state what is covered and what remains.
5. Implement accepted behavior as ordinary fork commits following fork
   conventions. One upstream commit may map to several fork commits, or to
   none.
6. Record the decision with `mark`, linking evidence commits that are already
   reachable from `main`. Commit the fork work first, then mark.
7. Update `UPSTREAM-TRACKER.md`, and `CHANGELOG-FORK.md` when the port is a
   user-facing feature.
8. Re-run `status`; processed commits must stop being `PENDING`.

Run the journal tool from the main checkout so every worktree shares the same
journal: its `data/` folder resolves relative to the script file.

## Roles

- The coordinator investigates, compares intent, traces call chains and state
  ownership, and selects clear non-overlapping resolutions.
- Reviewers are read-only. They never decide product, architectural,
  compatibility, privacy, or persistence questions.
- The executor implements only ports the coordinator approved and stops before
  substantive decisions.
- The user is involved when there is a genuine choice between user-facing
  contracts or architecture.

## Decision quality

- A slice patch is review evidence, not an applicable patch. Never
  `git apply` it, and do not reconstruct upstream trees to apply them. Port
  selected behavior by hand.
- When upstream independently implements the same or an overlapping feature,
  compare user-facing behavior, maintenance cost, test coverage, and
  compatibility before choosing. Do not assume the fork implementation wins.
- Do not expand a port to cover hypothetical edge cases found during review.
  Record unrelated pre-existing issues as follow-up work.
- Preserve the rationale: the journal note and the fork commit message carry
  the "why"; keep both specific.

## Dependencies, locks, and release contracts

- Resolve a manifest before its generated lockfile. Regenerate lockfiles with
  the proper tool and inspect the resulting diff; never hand-merge a lockfile.
  For `client/package-lock.json`, settle `client/package.json` first, then
  `npm --prefix client install --package-lock-only`. For
  `client/src-tauri/Cargo.lock`, settle `Cargo.toml` first, then let cargo
  bring the lockfile into agreement.
- `server/backend/requirements.gigaam-win.lock.txt` is a tested Windows GigaAM
  environment snapshot created with `pip freeze`. Do not regenerate or merge
  it from an arbitrary Python environment; validate changes in the intended
  Windows GigaAM environment.
- The release workflow requires matching versions in `client/package.json` and
  `client/src-tauri/tauri.conf.json`, installs with `npm ci`, and refuses to
  publish without a non-empty `CHANGELOG-FORK.md` section for the released
  version. Preserve those contracts when a port touches release-related files.
- Treat manifests, version fields, workflows, and server configuration as
  substantive even when they look like metadata.

## Validation

Validate what the port actually touches; do not run unrelated suites merely
because a port landed.

- Frontend: `npm --prefix client run lint`, `npm --prefix client run build`,
  and focused `npm --prefix client test -- <affected paths>`. Run
  `npm --prefix client ci` when dependencies changed. Run
  `npm --prefix client run i18n:check` when locale files, translation keys, or
  locale selection behavior changed.
- Rust: `cargo fmt --manifest-path client/src-tauri/Cargo.toml --check`,
  `cargo check --manifest-path client/src-tauri/Cargo.toml`, and focused
  `cargo test --manifest-path client/src-tauri/Cargo.toml <filter>` where
  tests exist.
- Server: focused `python -m pytest backend/tests/<file>.py -v`; the full
  `python -m pytest backend/tests/ -v` when a substantive server behavior,
  dependency, or cross-layer API contract is in scope.
- On this workstation, respect the Cargo build constraints in `AGENTS.md`
  sections 5 and 6 (external target directory, no chained heavy builds,
  bounded parallelism).

A test that cannot run locally is a verification gap: state the exact command
and reason instead of claiming full validation. For substantive ports, a
read-only review comparing the upstream intent with the ported behavior is
expected; classify findings as port defect, accepted divergence, or
pre-existing follow-up.

## Finish criteria

- The working tree is clean and `git diff --check` passes.
- The journal shows no `PENDING` for reviewed commits; evidence commits are
  reachable from `main` (no `[STALE]` flags left unresolved).
- Every landed port has a journal record, an `UPSTREAM-TRACKER.md` row, and a
  `CHANGELOG-FORK.md` entry when it is user-visible.
- Relevant validation has passed; verification gaps are explicitly stated.
- Fork commits follow repository message style and explain the "why" in the
  body when it is not obvious.

## Retired workflow

The previous runbook rebased `main` onto `upstream/main` regularly. That path
is retired: the fork diverged too far for a routine rebase to be safe, and
porting every commit through the decision journal replaced it. The old text
remains in git history; do not follow it. This repository does not use
fork-change markers or an automated fork-audit script; do not introduce them.
