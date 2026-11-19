# Chronicle – handoff

Chronicle is an installable Android app: Capacitor 8 + Vite, vanilla JS. Package `dev.chronicle.app`, repo `amon28/chronicle-harness`. Chat, roleplay (SillyTavern-style), personas and memory, an agent with tools, OpenCode Go plus custom OpenAI-compatible endpoints.

## Where things are
- `src/` – app code. `src/app/*.js` is the UI/engine split: `core.js` (state, prefs), `engine.js` (replies, tools loop, per-chat runs), `render.js` (messages), `chatlist.js` (drawer, chat menu), `personas-ui.js`, `settings.js`, `extras.js`, plus feature modules (`review-ui`, `mods-ui`, `charview`, `select-ui`, `sortable`, `fence`, …).
- `src/tools.js` + `phonetools.js`, `plantools.js`, `skills.js`, `modtools.js`, `creatortools.js`, `delegate.js` + `subagent.js` (helper agents and their tool loop), `browsercontrol.js` – the agent's tools.
- `src/bridge.js` (the shell's `/workspace` and `/phone`), `src/mirror.js` (the reconciler: changed / deleted / new, with tombstones), `src/shellfs.js` (the app's side of the bound directories), `src/jobs.js` (job handles), `src/toolkit.js` + `src/toolkit/` (the helper scripts and their hashes), `src/doctor.js` (per-surface probe), `src/surface.js` (the evidence line on every result) – see README › Surfaces, and decisions 33–35.
- `src/hooks.js` (user hooks; wired into the tool loop in `engine.js`), `src/patch.js` (apply_patch), `src/repomap.js` (repo_map), `src/regexscripts.js` (regex scripts), `src/tracker.js` (scene tracker), `src/app/rules-ui.js` (the editor for hooks and regex scripts). Lorebook timed effects are in `src/lore.js`; chat variables in `expandMacros` (`src/rp.js`).
- `src/compactat.js` (auto-compact threshold), `src/atfiles.js` (@file), `src/projectfiles.js` (.chronicle/ commands, agents, styles), `src/outputstyles.js`, `src/remember.js` (# to remember), `src/deferred.js` (load_tools), `src/permissions.js`. Rewind is `rewindTo` in `engine.js`; the mode chip is in `review-ui.js`.
- `src/mods.js` – sandboxed mods. See `docs/MODS.md`.
- `android/app/src/main/java/dev/chronicle/app/` – native plugins (GoStream, Folder, Browser, ChubBrowser, Shell, Intents, Scheduler + WakeReceiver, Automation, KeepAlive + GenerationService, Speech, SecureStore, Updater, Clip, ShareTarget, Shortcuts, QuickWidget, FileMode, SelfTest).
- Storage: IndexedDB `chronicle` (`conversations`, `workspaces`, `kv`). Secrets (API keys) are in the Android Keystore, not in settings.
- Tests: `tests/unit` (Vitest, no DOM) and `tests/e2e` (Playwright against a mock server, `tests/e2e/mock-server.js`).

## Working on it
- Work branch: `ccr-3600dcaa-tmuwka`. PR #1 to `main` exists. Push only to the work branch.
- Gate before every push: lint (`src` and `tests`), unit tests, all e2e. The author's script runs these and then commits and pushes; a change is not "done" until all three pass.
- CI builds the APK on main, and on another branch only when the commit message has `[apk]` (Actions minutes are limited); otherwise build locally with the release key (`scripts/build-local.sh`). The signing keystore is never committed (secrets `OCM_KEYSTORE_BASE64`, `OCM_KEYSTORE_PASSWORD`).
- Android code can be compile-checked offline (`./gradlew --offline compileDebugJavaWithJavac`) but only runs on a phone. `docs/DEV.md` sets that up on Windows (JDK 21 pinned for Gradle, command-line SDK, `scripts/proot-from-apk.ps1`) and the app can check its own native half on a device: `adb shell touch /sdcard/Android/data/dev.chronicle.app/files/selftest.key` once (the key: other apps cannot start the self-test), then `adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1`, then `adb logcat -s ChronicleSelfTest`.

## Status
All approved features are shipped and pass the automated tests. Nothing marked below has been verified on a phone by the developer. `docs/DEVICE-TESTS.md` is the short on-phone checklist (37 steps, what only a phone can show) and the real acceptance test; `docs/DEVICE-TESTS-FULL.md` is the full per-feature reference (the section numbers in DECISIONS.md point there).

Not built: roleplay image generation (parked on purpose) and the system assistant gesture.

## Known gaps
- Hidden-browser WebView, widget, "Ask Chronicle" selection entry, on-device model download, folder sync and the Chub download hook have only been compiled/tested with stand-ins.
- The surfaces bridge (decisions 33–34): the copy path is unit-tested and the job handle is covered end-to-end in the web build, but the native half — `-b` bind mounts for the phone folder (`FolderPlugin.localPath`), the shell surviving a timeout instead of being killed, and the `/phone` bind itself — is compile-checked only until it runs on a phone. If a bind is refused, the app falls back to the hash-checked copy, so the feature degrades but does not disappear.
- Retry-after-"carry on" bug report could not be reproduced; retry now binds to the exact message.
- Cleartext http is allowed on purpose (own PC via `opencode serve`). The Chub/BotBooru in-app browser shares cookies with the assistant's browser and exposes a download bridge to the sites it shows.
- Chub's like/download counts, dates, discussion and version history are not stored, so the character page omits them.

## Conventions the owner asked for
- Don't impersonate OpenCode for Zen free models. No PR unless asked. No model IDs in commits, PR text or code comments. Report honestly what was and wasn't verified on a phone.
