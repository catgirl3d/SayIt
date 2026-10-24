# Guidelines for AI Agents

## 1. Language and Code Comments Policy
- **STRICT PROHIBITION**: NEVER write code comments, docstrings, log messages, or documentation in Chinese or other non-Latin/non-Cyrillic unknown languages.
- **Allowed Languages**: All code comments, docstrings, and technical documentation must be written strictly in **English** (or Russian when specifically requested by the user).
- **Existing Comments**: When modifying files with legacy Chinese comments, translate the comments in the code you change, plus any comment your change makes stale or misleading, into clear, high-fidelity English that fully preserves the architectural reasoning; remove only truly obsolete notes. Do not bulk-translate the rest of the file inside a functional change: it buries the real diff and makes review and upstream ports harder. Translating a whole file is its own dedicated change (a separate commit or PR).

## 2. Code Quality & Precision
- Always follow surgical precision and exact match editing rules.
- Do not make assumptions, never suppress errors with blind `try/except` or `true` fallback.
- Write clean, self-documenting code with concise English comments when necessary.

## 3. Preserving Architectural Context & Rationale
- **Preserve the "Why"**: Legacy comments in this codebase often contain in-depth technical essays explaining subtle OS edge cases, race conditions, hardware quirks, and why specific design decisions were made.
- **High-Fidelity Translation**: When translating legacy comments from Chinese to English, you MUST fully preserve the technical depth, nuances, and underlying rationale. Never blindly truncate, over-summarize, or strip away vital architectural context.

## 4. Changelog Discipline
- **Always update `CHANGELOG.md`** when adding or materially changing an important user-facing feature or improvement in the fork.
- **`CHANGELOG.uk.md` is the Ukrainian translation** of the fork changelog, mirrored at release freeze: when a version's section is frozen in `CHANGELOG.md`, its translation is frozen in `CHANGELOG.uk.md` under the same `## vX.Y.Z` heading. Do not translate unreleased drafts — they change until the freeze. The release workflow ships the translation inside the update manifest (`notesLocalized`) and the app falls back to English when a section is missing, so a pending translation never blocks a release.
- Add concise release-note entries for all important fork-specific features, including meaningful behavior changes that users need to know about. New entries go into the newest `(unreleased)` version section at the top of the file: sections are per version, newest first, and the release workflow embeds the released version's section into the GitHub release notes and into the update manifest, so the app shows the same notes.
- Entries are release notes, i.e. the user-visible delta of the upcoming release. While a feature is still unreleased (its code is not in `main`), do not add entries for its internal iterations or pre-release fixes; adjust the feature's own bullet to its final behavior instead. Once a feature has shipped in a release, later fixes to it get their own entries.
- Before finishing the work, compare the final changes with `CHANGELOG.md` and ensure no important feature is missing. Do not add internal refactors, formatting-only changes, or test-only changes as user-facing features.
- The release runbook is `docs/RELEASE_GUIDE.md` (also available as the `/release` command): version bumps, changelog freeze, workflow dispatch, and post-release verification.

## 5. Local Rust Build Directory
- This Windows workstation has insufficient free space on the repository volume for Rust/Tauri build artifacts. Keep the Cargo target directory outside the repository.
- Pass the directory inline in the same command as the build, for example: `CARGO_TARGET_DIR='C:/cargo-target/sayit' cargo test --offline`. A separate `export` does not survive tool invocations; without the inline variable cargo silently builds into `client/src-tauri/target` on the almost-full repository volume (observed: a full cold rebuild including the transcribe C++/Vulkan stack).
- On this workstation a local, git-ignored `.cargo/config.toml` at the repository root pins the target directory; cargo discovers it from any directory under the checkout, including the nested Agent Manager worktrees under `.kilo/worktrees`. Worktrees created outside this path must pass `CARGO_TARGET_DIR` inline as above.
- In Git Bash, inspect the inherited variable with `printf '%s\n' "$CARGO_TARGET_DIR"`; in PowerShell use `$env:CARGO_TARGET_DIR`. When the environment is uncertain, verify the effective directory with `cargo metadata --no-deps --format-version 1 --offline` before an expensive build.
- Do not commit this machine-specific path to Cargo configuration, package scripts, CI workflows, or Agent Manager scripts. Other machines and CI must choose their own target directory.

## 6. Cargo Load Discipline (this workstation freezes under full builds)
- **NEVER chain two heavy Cargo invocations in one shell command** (e.g. `cargo test && cargo check`). The check profile is a separate build graph: a cold `cargo check` rebuilds 500+ crates plus the transcribe C++/Vulkan build scripts and froze this workstation for ~15 minutes (observed 2026-09-19). Run exactly one heavy cargo command per tool invocation.
- Bound Cargo's parallelism on this machine: pass `CARGO_BUILD_JOBS=2` inline with cargo commands (same rationale as the release workflow's `CARGO_BUILD_JOBS: 2`).
- `cargo test` and `cargo check` share no artifacts across profiles. Prefer `cargo test --no-run` / the targeted test filter to warm the test profile, and run `cargo check` as its own, separate invocation — never as an `&&` tail after a test run.
- Frontend commands (`npm test`, `npx tsc --noEmit`) are cheap; batch them freely. The one-command-per-invocation rule applies to cargo/npm-install-scale builds only.

## 7. CI Checks (GitHub Actions)
- `ci-frontend.yml` runs lint, i18n check, release-script tests, vitest, and build for `client/**` changes (excluding `client/src-tauri/**`).
- `ci-rust.yml` runs `cargo fmt --all --check`, an advisory `cargo clippy`, and `cargo test --locked` for `client/src-tauri/**`, `rust-toolchain.toml`, and `rustfmt.toml` changes, on the toolchain pinned in `rust-toolchain.toml` (1.97.1) with `rustfmt.toml` pinning style edition 2024.
- The Rust gate is formatting-enforced: run `cargo fmt --all` in `client/src-tauri` before committing Rust changes. After applying upstream port patches, format the touched files before committing — ported upstream code arrives unformatted.
- `cargo clippy` runs with `continue-on-error` as a baseline measurement; do not treat its result as a merge gate until a baseline decision is made.

## 8. Never Commit Plans or Working Notes
- NEVER commit plan documents, drafts, internal reviews, or working notes (e.g. `docs/*PLAN*.md`, follow-ups, design notes) to this repository — not in normal commits, PRs, or history rewrites.
- Such files stay local and untracked. Only the maintainer's explicit per-file request can change that, and the file must be named explicitly each time.

## 9. Storybook Coverage for User-Visible UI
- Every new or materially changed user-visible component, page, or dialog must include added or updated Storybook coverage in the same change. Keep `*.stories.tsx` files co-located with the implementation under `client/src/**`, following the existing naming and title conventions; a component that is independently interactive needs focused stories — incidental appearance inside a parent story is not sufficient coverage.
- Cover the meaningful supported states and behaviors, as applicable: default/selected, empty, loading, error, disabled, and edge data. Add `storybook/test` play functions for important interaction flows, including controlled value updates where relevant.
- Use deterministic fixtures and the existing Storybook mocks instead of real backend or native calls; use `parameters.tauri.settings` where applicable for settings-backed UI. Stories and play functions must stay compatible with the portable-stories smoke suite under Vitest/jsdom.
- Before completing UI work, run the Storybook smoke suite (`client/src/storybook/__tests__/storiesSmoke.test.tsx`) and, from `client/`, `npm run storybook:typecheck`; both must pass. Preview the affected stories with `npm run storybook` to check visual states jsdom cannot validate.
