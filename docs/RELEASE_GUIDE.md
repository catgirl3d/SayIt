# SayIt Fork Release Guide

Short runbook for cutting a Windows release of the fork. The release itself is a manual
GitHub Actions run: `.github/workflows/publish-windows-release.yml` (`workflow_dispatch`).

## Rules

- One release = one new version. Never ship new content under an already released
  version: the in-app updater compares version numbers only, so a same-version rebuild
  is invisible to users. Re-dispatching the same version is only for retrying a failed
  build, not for shipping changes.
- The workflow builds the dispatched commit, recreates the `v<version>` tag and GitHub
  Release, and publishes the NSIS installer plus the `latest-win32-x64.json` update
  manifest. The tag always points at the exact commit that was built.
- The GitHub release notes are the `CHANGELOG-FORK.md` section for the released version,
  extracted automatically. The workflow refuses to build when the version sources
  disagree or the section is missing or empty.
- The same section travels inside the update manifest, so the app shows those notes on
  the About page the moment it finds the update; there is nothing to write for the
  in-app notes per release.
- Never edit the release body on GitHub by hand: the next dispatch of the same version
  replaces it.

## Checklist

1. Finish the batch: all feature work committed on `main`, working tree clean, pushed.
2. Bump the version to the new `X.Y.Z` in every source:
   - `client/package.json`;
   - `client/package-lock.json` — after `package.json`, run
     `npm --prefix client install --package-lock-only`;
   - `client/src-tauri/tauri.conf.json`;
   - `client/src-tauri/Cargo.toml`; let cargo refresh the root entry in `Cargo.lock`
     (never hand-edit the lockfile).
   Verify with `npm --prefix client run check:release-versions`.
3. Freeze the changelog section in `CHANGELOG-FORK.md`: replace `(unreleased)` with the
   release date (`## vX.Y.Z — YYYY-MM-DD`). The section must be non-empty.
4. Run the release checks: `npm --prefix client run test:scripts` and
   `npm --prefix client run i18n:check`.
5. Commit (`chore(release): vX.Y.Z`) and push `main`.
6. Dispatch the workflow on `main`:
   `gh workflow run publish-windows-release.yml --ref main` (or via the Actions UI).
7. Verify the result:
   - the release page `vX.Y.Z` shows the section once, followed by
     `Full fork changelog: <link pinned to the build commit>`;
   - assets: `SayIt_X.Y.Z_x64-setup.exe` and `latest-win32-x64.json`;
   - an installed older build is offered `X.Y.Z` by "Check for updates", and the About
     page shows the same release notes from the manifest.
8. Next batch: add a new `## v<next> (unreleased)` section at the top of
   `CHANGELOG-FORK.md` when the first entry appears.

## FFmpeg sidecar

The bundled pair is part of every release:

- The pinned pair (`ffmpeg.exe` + `ffprobe.exe`) is fetched and verified by the release
  workflow itself, in a step placed before "Build NSIS installer": download the archive
  pinned in `client/ffmpeg.lock.json`, verify its SHA256 before unpacking, place the pair
  where the bundle picks it up. A mismatch must fail the build; never fall back to any
  other FFmpeg.
- The changelog records the delivery change: the `v0.2.3 (unreleased)` bullet claiming
  FFmpeg is user-installed ("File transcription uses FFmpeg and FFprobe that you install
  yourself ...") was replaced with the bundled wording inside the same section — that
  bullet describes the same feature's final behavior, not a new entry.
- Release verification additionally confirms: the installer contains the bundled pair (its
  payload is 7.8 MB — measure and record the actual installer growth in the release notes),
  and a fresh install on a machine with no FFmpeg in PATH transcribes a file with no setup.
- To update FFmpeg: rebuild in `catgirl3d/ffmpeg-build` (recipe pinned in its repo),
  publish a new `v<ffmpeg-version>-sayit.N` release with the tarball, `SHA256SUMS` and
  `BUILDINFO.txt`, re-run the smoke set from the plan doc, then update
  `client/ffmpeg.lock.json` in a normal commit.

## Notes

- Local Rust builds on this workstation follow the constraints in `AGENTS.md`
  sections 5-6; the release build itself runs in CI, so the only local cargo call in
  this checklist is the light `check:release-versions` metadata read.
- Release-note writing conventions live in `AGENTS.md` section 4.
- The `/release` Kilo command walks this checklist interactively.
