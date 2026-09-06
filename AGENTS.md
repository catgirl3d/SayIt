# Guidelines for AI Agents

## 1. Language and Code Comments Policy
- **STRICT PROHIBITION**: NEVER write code comments, docstrings, log messages, or documentation in Chinese or other non-Latin/non-Cyrillic unknown languages.
- **Allowed Languages**: All code comments, docstrings, and technical documentation must be written strictly in **English** (or Russian when specifically requested by the user).
- **Existing Comments**: When modifying files with legacy Chinese comments, translate them to clear, high-fidelity English, fully preserving the architectural reasoning, or remove only truly obsolete notes.

## 2. Code Quality & Precision
- Always follow surgical precision and exact match editing rules.
- Do not make assumptions, never suppress errors with blind `try/except` or `true` fallback.
- Write clean, self-documenting code with concise English comments when necessary.

## 3. Preserving Architectural Context & Rationale
- **Preserve the "Why"**: Legacy comments in this codebase often contain in-depth technical essays explaining subtle OS edge cases, race conditions, hardware quirks, and why specific design decisions were made.
- **High-Fidelity Translation**: When translating legacy comments from Chinese to English, you MUST fully preserve the technical depth, nuances, and underlying rationale. Never blindly truncate, over-summarize, or strip away vital architectural context.

## 4. Changelog Discipline
- **Always update `CHANGELOG-FORK.md`** when adding or materially changing an important user-facing feature or improvement in the fork.
- Add concise release-note entries for all important fork-specific features, including meaningful behavior changes that users need to know about.
- Before finishing the work, compare the final changes with `CHANGELOG-FORK.md` and ensure no important feature is missing. Do not add internal refactors, formatting-only changes, or test-only changes as user-facing features.

## 5. Local Rust Build Directory
- This Windows workstation has insufficient free space on the repository volume for Rust/Tauri build artifacts. Keep the Cargo target directory outside the repository.
- Before running any Cargo or Tauri command that can compile Rust, preserve the inherited `CARGO_TARGET_DIR`. If it is unset on this workstation, set it for the command or shell session to `C:/cargo-target/sayit`.
- In Git Bash, inspect it with `printf '%s\n' "$CARGO_TARGET_DIR"` and set it for the current shell with `export CARGO_TARGET_DIR='C:/cargo-target/sayit'`. In PowerShell, use `$env:CARGO_TARGET_DIR` instead.
- Verify the effective directory with `cargo metadata --no-deps --format-version 1 --offline` before an expensive build when the environment is uncertain.
- Do not commit this machine-specific path to Cargo configuration, package scripts, CI workflows, or Agent Manager scripts. Other machines and CI must choose their own target directory.
