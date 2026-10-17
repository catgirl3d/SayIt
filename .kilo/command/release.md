---
description: Cut a SayIt fork release following docs/RELEASE_GUIDE.md
---
Cut a Windows release of the SayIt fork. `docs/RELEASE_GUIDE.md` is the source of truth: follow it step by step, and if this prompt and the guide disagree, the guide wins.

If `$ARGUMENTS` names a version, that is the release version; otherwise ask which version we are releasing.

Working style:

- Read the guide first, then inspect the current state: `git status`, current branch, the version sources, and the newest section of `CHANGELOG.md`.
- Confirm with the user before every irreversible or outward-facing step: commit, push, and workflow dispatch.
- Do the checklist together with the user: version bump in all sources, changelog section freeze (replace `(unreleased)` with the release date, e.g. `## v0.2.2 — 2026-10-12`), local checks (`test:scripts`, `i18n:check`).
- Only after user confirmation: commit, push `main`, then dispatch `gh workflow run publish-windows-release.yml --ref main` and watch the run.
- After the run finishes, verify the published release: the notes section appears once with the full-changelog footer link, both assets (`SayIt_X.Y.Z_x64-setup.exe`, `latest-win32-x64.json`) are present, and the manifest carries the release notes.
- Never release new content under an already released version: every release gets a new version number.
- Report the result: version, tag, built commit, workflow run URL, asset names.
