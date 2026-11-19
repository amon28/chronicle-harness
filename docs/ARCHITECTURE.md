# Architecture

How the app is put together: the places the assistant's tools work in, and where things live in the code.

## Surfaces, and the edges between them

The assistant's tools are not one machine. Each one is a different place with a different filesystem, and
until they share edges every task pays a copy tax. This is what each surface is and where its files live:

| tool | surface | filesystem | persists? |
| --- | --- | --- | --- |
| `run_python` | Pyodide/WebAssembly worker (`surface=pyodide`) | `/workspace`, this chat's workspace | yes, in the workspace (IndexedDB) |
| `shell` | Alpine via proot (`surface=alpine-shell`) | `/workspace` (mirrored), `/phone` (bound or mirrored), `/root` | yes, inside the root filesystem |
| `phone_*` | the folder picked with Android's picker (`surface=phone-folder`) | that one folder, through SAF | yes, on the phone |
| `browser` | a real WebView (`surface=android-webview`) | — | cookies/sign-ins only |
| `fetch_url` | native HTTP (`surface=http`) | — | no |

Four rules hold it together:

1. **One home per artifact, and the app enforces it.** `/workspace` inside the shell is a *real
   directory*, bound in with `-b <files>/shell/work/<chat>:/workspace`: one directory per chat, so one
   chat's files are not another's. The app keeps the same files in memory (that is what `run_python`,
   the previews and the backup work on), and the two are reconciled by identity — every path remembers
   what both sides last agreed on, so **a file deleted on either side is deleted on the other**, and a
   file too big to carry is remembered as refused instead of being retried on every call
   (`src/mirror.js`, `src/bridge.js`). The linked phone folder is `/phone`: a proot bind when Android
   exposes a plain directory, otherwise a mirrored copy reconciled the same way. Writes into `/phone`
   follow the chat's review/auto/read-only rule.

   **The shell shares small files, not media.** 32 MiB per file, 128 MiB per command at ~4-6 MB/s: a
   3 GB video would be ~9 minutes of pure transfer in ~110 pieces. Keep large media on the shell side
   (or on a real machine) and deliver it another way; what this edge is for is scripts, thumbnails,
   logs and a remuxed clip.
   The crossings are bounded and they refuse to lose data: 32 MiB per file, 128 MiB per command (the
   workspace is a 256 MB wasm heap, so a bigger file stays in the shell), writes go to a temporary file
   and are renamed only after the byte count checks out, an empty copy never replaces content, and a
   disagreement the app cannot settle is reported instead of guessed. **Mode is not carried across a
   crossing**: a script keeps working inside the shell, but if the app rewrites it the file comes back
   `600` — `chmod +x` in the shell afterwards. The toolkit verifier checks the exec bit as well as the
   hash, so it cannot report a green tick for a file nobody can run.
2. **Job handles, not timeouts.** A command that outlives 30 s comes back as
   `[still running … job job_xxx]` instead of dying, and `shell_job` polls, waits or kills it. The
   shell is never restarted because a command was slow; inside the shell the same thing is spelled
   `job run` / `job out <id>` (`src/jobs.js`, `src/toolkit/job`).
3. **One toolkit, one home.** `src/toolkit/` holds `job`, `doctor` and `toolkit-pull`; they are written to
   `/usr/local/bin` on first use and every shell start verifies their hashes, replacing a copy that
   drifted (`src/toolkit.js`). `toolkit-pull` installs scripts from every source listed in
   `/workspace/.toolkit-url` (or `TOOLKIT_URL`), each checked against its own `.toolkit` manifest. The app
   adds a line there whenever a skill with a `scripts/` folder is used (`file:///workspace/skills/<name>/scripts`),
   so a skill's tools reach PATH with one `toolkit-pull`; scripts that fail their hash are refused. Nothing
   else in the shell is a tool of record — everything else is a cache.
4. **Every result says which surface answered, and proves what it claims.** Results end with
   `[surface=… ok=… bytes=… ms=… exit=… proof=sha256:…]` (`src/surface.js`); tools add their own
   evidence where they have it (the exit code, the hash of the file written, the HTTP status, a
   read-back after saving to the phone). A check that only reports "ok" without exercising the path is
   the bug this exists to prevent.

`doctor` is the one call that answers "what is this machine": each surface is exercised, not just
read from a flag, plus the shell's own `doctor` script (kernel, userland, cores, disk, tools, network,
writable folders). `reload_tools` re-reads the MCP registry without starting a new chat; switching a
server on in Settings also connects it right away.

```
src/bridge.js   the edges: /workspace and /phone
src/mirror.js   the reconciler: changed, deleted or new - and tombstones for deletes
src/shellfs.js  the app's side of the bound directories (real files, not a base64 pipe)
src/jobs.js     job handles for the shell
src/toolkit.js  installing, verifying and repairing the helper scripts
src/toolkit/    job, doctor, toolkit-pull (the source of truth)
src/doctor.js   the cross-surface probe
src/surface.js  surface=, bytes=, ms=, proof= on every result
```

## How it works

| Piece | File |
| --- | --- |
| UI (vanilla JS, Vite) | `index.html`, `src/style.css`, `src/main.js` (boot) |
| App modules | `src/app/core.js` (state, prefs, helpers), `chatlist.js`, `render.js`, `engine.js` (prompt building & streaming), `composer.js`, `settings.js`, `personas-ui.js`, `extras.js` |
| Roleplay | `src/rp.js` (macros), `src/lore.js` (lorebooks), `src/cards.js` (character cards) |
| Android Keystore for API keys | `android/.../SecureStorePlugin.java` |
| Background generation + notifications | `android/.../GenerationService.java`, `KeepAlivePlugin.java` |
| API client, SSE parsing | `src/api.js` |
| Native streaming HTTP (bypasses WebView CORS) | `android/app/src/main/java/dev/chronicle/app/GoStreamPlugin.java` |
| Chat storage (IndexedDB) | `src/store.js` |
| CORS proxy for the web build | `proxy/worker.js` |

All models are called through the OpenAI-compatible endpoint
`https://opencode.ai/inference/go/openai/v1/chat/completions` (OpenCode translates for models that natively use
another API format). Like the opencode CLI, each conversation sends a stable `x-opencode-session` id
(plus `x-opencode-session-id`, `x-session-affinity`, `x-opencode-client` and its own `User-Agent`), which Go uses
for routing and prompt caching. The allowance meters come from `GET https://opencode.ai/zen/go/v1/usage`.
