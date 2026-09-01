# SayIt Fork Rebase Guide

This runbook covers regularly rebasing this fork's `main` branch onto
`upstream/main` from `crosswk/SayIt`.

It does not cover feature development, release publishing, deployment, automatic
merge tooling, or pushing rewritten history.

## Responsibilities

- The coordinator is read-only. It investigates conflicts, compares intent,
  traces call chains and state ownership, selects clear non-overlapping
  resolutions, and coordinates review.
- The executor is a write-capable subagent. It runs `fetch`, `rebase`, and only
  the conflict resolution explicitly approved by the coordinator.
- The executor must stop before `git rebase --continue` for every substantive
  conflict and report the facts needed for a decision.
- The executor must not invent product, architectural, compatibility, privacy,
  or persistence decisions.
- The user is involved only when there is a genuine choice between user-facing
  contracts or architecture. Routine mechanical resolution does not require a
  user decision.

## Fork Sources of Truth

- `CHANGELOG-FORK.md` is the release-facing, high-level summary of fork
  features. Review every affected entry, but do not treat it as a substitute for
  commit history.
- `git log upstream/main..main` and the corresponding fork commits are the
  detailed implementation history. They are mandatory when the changelog is not
  specific enough or does not mention the conflicted path.
- `docs/decisions.md` records rationale for behavior that may look arbitrary.
  Preserve the decision or stop if an upstream change conflicts with it.
- `AGENTS.md` defines repository-wide engineering and documentation rules.

This repository does not use fork-change markers or an automated fork-audit
script. Do not copy OpenCode- or Kilo-specific marker commands into this
procedure; use the changelog, commit history, range-diff, and affected tests.

The upstream repository does not contain this fork's commits. A rebase replays
the fork commits over the newly fetched upstream history, but upstream can still
independently implement an overlapping feature.

## Before Rebasing

Start from a clean working tree. Do not stash, reset, clean, delete files, or
create backup branches as part of this procedure.

```bash
git status --short
git branch --show-current
git remote get-url upstream
git config merge.conflictStyle zdiff3
```

`git status --short` must have no output, the branch must be `main`, and the
upstream remote must point to `crosswk/SayIt`. Any tracked or untracked work is
a stop condition until its owner explicitly decides how to handle it.

Record the two immutable pre-fetch SHAs in the rebase report. They are required
for the final range comparison.

```bash
git rev-parse main
git rev-parse upstream/main
```

Fetch and rebase only after recording those values:

```bash
git fetch upstream main
git rebase upstream/main
```

Use `zdiff3` conflict style. It shows the common base, but it does not establish
which behavior is correct.

## Conflict Handling

A conflict is substantive when it affects executable code, dependencies,
configuration, migrations, tests, CI, release behavior, persisted settings, or
a user-facing contract. A coordinator may treat a conflict as mechanical only
after demonstrating that it is documentation-only or formatting-only.

During a rebase, Git's labels are easy to misread:

- `ours` is the newly fetched `upstream/main` base.
- `theirs` is the fork commit currently being replayed.

Never use a whole-file `git checkout --ours` or `git checkout --theirs` for a
substantive conflict in executable code, configuration, tests, or workflows.
It can silently discard valid behavior on the other side.

For each substantive conflict, the executor reports:

- The replayed fork commit, affected file, and conflicting hunk.
- The common-base behavior, upstream intent, and fork intent.
- Affected callers, state, ordering, persistence, side effects, failure paths,
  and tests.
- The relevant `CHANGELOG-FORK.md` entries and decision records.
- Whether the changes implement independent contracts, the same contract, or
  overlapping variants of the same user-facing feature.
- A recommended resolution: upstream, fork, or a minimal merge.

The coordinator resolves a clearly non-overlapping conflict while preserving
confirmed fork behavior. When upstream independently implements the same or an
overlapping feature, stop before choosing. Compare the resulting user-facing
behavior, maintenance cost, test coverage, and compatibility. Do not assume the
fork implementation wins.

Do not expand scope to cover hypothetical edge cases found while resolving a
conflict. Record unrelated pre-existing issues as follow-up work instead.

Useful inspection commands while a rebase is paused:

```bash
git status
git diff --cc -- <file>
git show REBASE_HEAD -- <file>
git show HEAD -- <file>
```

After a coordinator-approved resolution, stage only the resolved files and
continue:

```bash
git add <resolved-files>
git rebase --continue
```

If Git drops or skips a replayed commit, inspect its old behavior before treating
the skip as safe. A patch already present upstream may still differ in contract,
error handling, migration behavior, or user-visible details.

### Dependency And Release Conflicts

Resolve a manifest or version contract before resolving its generated lockfile.
Never hand-merge a generated lockfile.

For `client/package-lock.json`, after the coordinator has settled
`client/package.json`, use the upstream lockfile as a valid seed and regenerate
the lock from the final manifest:

```bash
git checkout --ours client/package-lock.json
npm --prefix client install --package-lock-only
git add client/package-lock.json
```

Inspect the generated lockfile diff. The command is allowed only for a lockfile
conflict; it is not a shortcut for resolving dependency or version choices.

For `client/src-tauri/Cargo.lock`, first resolve `Cargo.toml`. Use Cargo to bring
the lockfile into agreement with the resolved manifest and inspect the resulting
diff as part of the Rust validation. For a direct lockfile conflict, start from
the upstream lockfile as a valid seed:

```bash
git checkout --ours client/src-tauri/Cargo.lock
cargo check --manifest-path client/src-tauri/Cargo.toml
git add client/src-tauri/Cargo.lock
```

Do not edit checksum or dependency entries by hand.

`server/backend/requirements.gigaam-win.lock.txt` is a tested Windows GigaAM
environment snapshot created with `pip freeze`. Do not regenerate or merge it
from an arbitrary Python environment. A conflict in that file requires a
coordinator decision and validation in the intended Windows GigaAM environment.

Treat conflicts in these files as substantive even when they look like metadata:

- `client/package.json`, `client/package-lock.json`, and
  `client/src-tauri/Cargo.toml`
- `client/src-tauri/tauri.conf.json` and package version fields
- `.github/workflows/publish-windows-release.yml`
- `server/backend/requirements.txt`, Docker files, and server configuration
  templates

The release workflow requires matching versions in `client/package.json` and
`client/src-tauri/tauri.conf.json`, uses `npm ci`, and refuses to publish without
a non-empty `CHANGELOG-FORK.md`. Preserve those contracts when resolving
release-related conflicts.

## Validation

Validate the packages and contracts actually affected by rebased fork commits or
conflict resolutions. Do not run unrelated suites merely because a rebase was
performed.

Always review the replayed series using the SHAs recorded before fetching:

```bash
git range-diff <old-upstream>..<old-main> upstream/main..main
git diff --name-status upstream/main..main
```

For frontend changes, run the relevant commands from the repository root:

```bash
npm --prefix client run lint
npm --prefix client run build
npm --prefix client test -- <affected-test-paths>
```

When `client/package.json` or `client/package-lock.json` changed, first run
`npm --prefix client ci` to validate the exact dependency installation used by
the release workflow.

Run `npm --prefix client run i18n:check` when locale files, translation keys, or
locale selection behavior changes. Run the full client unit suite with
`npm --prefix client test` when a substantive client behavior conflict or broad
client-file overlap requires it.

For Rust changes, run focused tests where they exist and at least the relevant
check and formatting guard:

```bash
cargo fmt --manifest-path client/src-tauri/Cargo.toml --check
cargo check --manifest-path client/src-tauri/Cargo.toml
cargo test --manifest-path client/src-tauri/Cargo.toml <affected-test-filter>
```

For server changes, run focused tests from `server/` first:

```bash
python -m pytest backend/tests/<affected-test-file>.py -v
```

Run `python -m pytest backend/tests/ -v` when a substantive server behavior
conflict, server dependency change, or cross-layer API contract is in scope.
Use additional Docker or deployment validation only when the changed paths make
it relevant.

Do not dispatch a broad behavioral review for a conflict-free or
documentation-only rebase with no substantive executable intersection. Use deep
review for substantive conflict resolutions, overlapping behavior, lifecycle or
timing changes, persisted settings, privacy-sensitive paths, cross-layer
contracts, or broad executable-file overlap.

Deep review compares both baselines:

- The pre-rebase fork `main`.
- The newly fetched `upstream/main`.

Use read-only reviewers to compare each original fork commit with its replayed
commit and to adversarially inspect the final merged regions. Classify every
finding as one of the following:

- **Rebase regression:** caused by the resolution. Fix it before finishing and
  rerun affected validation.
- **Upstream behavior change:** verify that the fork feature still composes with
  the new upstream semantics.
- **Pre-existing:** inherited from earlier fork history. Record it as follow-up
  work; do not silently absorb it into the rebase.

A test that hangs, times out, or cannot run locally is a verification gap. State
the exact command and reason in the rebase report rather than claiming full
validation.

## Finish Criteria

Finish only when all of the following are true:

- The working tree is clean.
- The range-diff has been reviewed.
- Every affected fork feature identified through `CHANGELOG-FORK.md` and
  `git log upstream/main..main` has been checked against the final behavior.
- Relevant validation has passed, with any verification gaps explicitly stated.
- `git diff --check upstream/main..main` passes.
- This tracked-file conflict-marker scan produces no output and exits with code
  `1`:

```bash
git grep -nE '^(<{7}|\\|{7}|={7}|>{7})( |$)'
```

Do not push after the rebase unless the user explicitly requests it. The final
report must include the recorded pre-fetch SHAs, new `main` SHA, range-diff
summary, substantive resolutions, validation commands, and verification gaps.
