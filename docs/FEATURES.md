# Chronicle – feature list

Chronicle is an Android app (Capacitor + vanilla JS) for **chat, roleplay and AI agents**. It is built around an OpenCode Go subscription and also works with any OpenAI-compatible endpoint. Everything runs on the phone; data is stored on the device (IndexedDB, with keys in the Android Keystore).

This file is a snapshot of what exists (November 2026). It is meant as input for researching what to add next. The last section lists known limits and things that are not built.

---

## 1. Models & providers
- OpenCode Go model list, refreshed live. Each model shows its context size, price, vision and reasoning badges, FREE/NEW badges and filters.
- If a model disappears, the app switches to the closest replacement and tells you.
- Custom OpenAI-compatible endpoints, with a Chub (Soji) preset. Requests go through the WebView so Cloudflare lets them through.
- Claude with your own Anthropic API key (platform.claude.com; not a claude.ai sign-in): an "Anthropic (Claude)" provider on the official SDK, with the live model list (context window and effort levels per model), adaptive thinking shown summarized, effort mapped onto Claude's levels, tools/agent mode, images, prompt caching (cached tokens in the usage view), thinking blocks kept with replies and sent back, and a clear message when Claude declines.
- OpenCode Zen free models.
- Go usage meters (5-hour, weekly and monthly allowance with reset times), plus a spend view (busiest chats, list-price value) and an optional daily token budget.
- A fallback model when a model stays overloaded. Automatic retries on 5xx, TLS read errors and "overloaded" answers.
- A reasoning-effort toggle per model. Thinking can be shown, collapsed or hidden.
- Per-model vision override, when the list wrongly says a model can't see images.
- An on-device offline model (experimental, ~400 MB).
- OpenCode on your PC: open OpenCode's own web UI (`opencode serve` / `opencode pair`) in the app.
- Prompt test: one message to up to four model/prompt variants, compared side by side.

- Custom providers: each model's own abilities (pictures, tools, reasoning, context) are read from the provider's model list; the provider's switches apply only when it says nothing.
- A reply refused because the chat is too long for the model is rebuilt to fit and sent again; the model's real limit is remembered and kept to from then on.

## 2. Chat basics
- Streaming Markdown with syntax-highlighted code boxes (copy, wrap, collapse), KaTeX math, Mermaid diagrams, and ▶ Preview for HTML/SVG in a sandbox.
- Swipes and versions: Retry keeps the alternatives, editing a message makes a new version, plus "retry with guidance" and "retry with another model".
- Branch or fork a chat from any message. A story map shows the fork tree and the messages with other versions.
- Continue, carry on (send with nothing typed), Stop, and queue or steer messages while a reply is running.
- Several chats can reply at the same time: a spinner shows which are busy and a blue dot which have unseen replies.
- Message menu: delete, delete everything after, hide from the AI, read aloud, ⏪ Rewind (conversation, files or both).
- Search inside a chat, global search, pins, folders, archive, drag-to-reorder.
- The chat list by time, like a chat app's drawer: Pinned, folders, then Today, Yesterday, 7 Days, 30 Days, months and years (sticky headers), with a quiet time on each row ("14:05", "Mon", "12 Oct"); on both 💬 Chats and 🎭 Roleplay.
- Attachments: images, files and zips (extracted into the chat's workspace). Paste an image from the clipboard. A code box opens in the composer with ```.
- 📦 Packs: one file with snippets, recipes, skills, MCP servers and personas – reviewed before install, removed as one; make your own.
- 🧩 Claude plugins: import one from a GitHub link (repo, folder or marketplace) or a .zip – its skills (as one group in Skills, with their files), commands as snippets, agents as personas and remote MCP servers, after a review that shows each skill's text and what is left out (hooks, desktop-only parts).
- Recipes: Markdown workflows with parameters, steps, sub-recipes and a schedule – `/name args`, import from a link with hidden characters revealed.
- Prompt snippets and slash commands (`/tldr`, `/fix`…), editable. `/compact`, `/guide`, `/goal`, `/plan`, `/impersonate`, `/init`.
- `@persona` mentions call a persona into the chat as a guest. `@path` attaches a workspace file.
- `# text` remembers it instead of sending it: into AGENTS.md with tools on, otherwise as a memory.
- Reply styles per chat: Default, Concise, Explanatory, Learning, plus the project's own.
- Read aloud (TTS, voice per persona; can read only dialogue or skip *actions*) and voice input.
- Voice mode (hold the mic, or `/voice`): a hands-free talk ↔ listen loop with live text, replies read as they are written, tap to interrupt.
- ✏️ Correct a reply with an instruction (word diff, keep or discard), `/polish` and `/unpolish` for your draft, and the draft survives the app closing.
- Each chat keeps its own draft and reading position.
- A quick-reply bar: snippets shown as buttons above the box (everywhere, chats or roleplay).
- Themes (light, dark, AMOLED), accent colours, text size, separate chat and roleplay backgrounds (including your own photo).
- Text size (S / M / L / XL) scales the whole app – messages, sheets, Settings, hints, chips, buttons and their tap areas – not only the messages; XL fits a 360 px phone.
- Settings search: a field above the Settings menu finds pages and single settings by their words and by the words people use for them (battery, calendar, location, storage, GitHub, schedule, Wi-Fi, key, backup…); a tap opens the page at the setting and lights it up for a moment.
- In a roleplay, the 🎛 chip by the message box shows the chat's preset and changes it in one tap (Default / Standard / your presets / Edit presets…).
- The 🛠 chip says how many tool groups are on ("8 tools" / "Tools off") and opens a small menu with this chat's switch and the list; it never flips the tools by itself.
- The app asks in its own sheets, not the system's boxes, for names (presets, packs, automation callers), a commit message and a recipe's parameters, and before deleting a preset.
- Readable greys (4.5:1 in both themes), roleplay colours with a default per theme (a colour you pick is kept), tap areas of at least 40×40 for message actions, swipe arrows and composer chips, names for screen readers on every labelled field, and no animations when the phone asks for reduced motion.

- Icon packs for the interface (Appearance › Icons): Line (Lucide, default), Colourful (Fluent Emoji Flat), Material (Android's own), Duotone (Phosphor, in your accent colour) or the phone's Emoji. Messages, avatars and anything you write keep their emoji.
- Older pictures in a chat are not re-sent with every reply (the newest two picture turns are; the rest are named).

## 3. Personas & memory
- Personas: a name, an avatar (emoji or photo), a system prompt, and optionally their own model, temperature, samplers, context limit and voice.
- Built-in personas: Assistant, Coder, Summarizer, Storyteller, Tutor, Persona Maker, Skill Creator, Mod Builder.
- A toolset per persona: tools on or off at start, and only the tool groups it needs (presets All, Coding, Research, Roleplay, None).
- The System prompt creator (✨ Generate) writes a prompt from a description.
- User personas: who *you* are in a chat (`{{user}}`, `{{persona}}`).
- Memory:
  - The app learns facts and preferences from your messages, shared by every persona or kept for one. Assistant chats learn in batches (Settings › Memory › Learn about me: after every reply, every 3 messages – the default – or every 6); "remember…", "forget…" and "my name is…" are learned at once, and a batch that was not due yet survives closing the app. Roleplays learn after every reply.
  - A relevance-ranked memory limit per chat, pins, and optional on-device embeddings ("smart memory").
  - With smart memory: search chats by meaning (drawer and `search_chats`), and recall of earlier moments in long roleplays (also by the names and things the last messages mention – lorebook keys, scene-sheet values, characters – which works without smart memory).
  - With smart memory, notes from past chats are picked by meaning as well as by words.
  - Optional, off by default: "Recall my past messages from other chats" – up to 3 of your own messages from your other chats with the same persona that fit what you are talking about, sent after the history, labelled with the chat and date (never incognito or roleplay chats).
  - Older memories are sent with their age ("noted 3 months ago"); ones unconfirmed for half a year ask "still true?".
  - Tidy up (merge or remove, with review and undo), and incognito per chat.
  - Episodic memory: each persona's own notes about past chats.
  - A long story memory (roleplay, over 2,500 characters) is sent in part: its first and last points always, and the middle points that fit the last messages; the stored memory and its editor are unchanged.
- Context editor: leave out memories, story memory, world info or example dialogues for one chat without deleting them.
- Context sheet: tokens per part (system prompt, memories, tools, messages), the exact count from the API, and Compact now.
- Prompt inspector: the exact request that will be sent.
- Every built-in instruction the app sends can be edited (Settings › Prompts).

## 4. Roleplay (SillyTavern-style)
- Character cards: PNG, JSON and .charx, V1–V3, import and export, with greetings, alternate greetings, example dialogues, system prompt, post-history instructions, depth prompt and an embedded lorebook.
- Import from Chub links, and in-app browsers for Chub, BotBooru and Character Archive (an opt-in download hook, Back goes back a page).
- A character page (like Chub's) before a chat starts. A scenario card type (a world, not a person). A Narrator.
- The SillyTavern prompt pipeline: main prompt (`{{original}}`), world info, your persona, description, personality, scenario, examples as real messages, injections at a depth (Character's Note, Author's Note, world info), post-history instructions.
- Roleplay presets (Settings › Roleplay presets): named sets of a model (and its reasoning effort), the main and post-history prompts, samplers, stop strings, prefill, prompt note at a depth, names and impersonation prompt. Standard is the page's own values; four starters (Vivid prose, Short & snappy, Slow burn, Story narrator); one is the default, and each chat can pick another in its menu. Export/import as JSON, and SillyTavern presets (chat- and text-completion) import. A model picked by hand in a chat beats its preset's for that chat only.
- Ban emojis, trim unfinished sentences.
- Macros:
  - `{{char}}`, `{{user}}`, `{{persona}}`, `{{time}}`, `{{date}}`, `{{weekday}}`, `{{random}}`, `{{pick}}`, `{{roll}}`, `{{lastMessage}}`, `{{idleDuration}}`, `{{trim}}`, comments, and `{{if …}}…{{else}}…{{/if}}` (a macro has a value, or `var::name == value`, `!=`, `<`, `>`; nests).
  - Chat variables: `{{setvar}}`, `{{getvar}}`, `{{addvar}}`, `{{incvar}}`, `{{decvar}}`, plus global variants.
- Lorebooks:
  - Matching: primary and secondary keys (AND/NOT), regex keys, whole-word and case options.
  - Placement and limits: constant entries, probability, position and depth, insertion order, scan depth, token budget, recursion.
  - Timing: sticky, cooldown and delay.
  - SillyTavern World Info import and export.
  - Lore suggestions: ✨ proposes entries from the chat.
- 🔁 Regex scripts: find and replace on saved messages, only on what you see, or only on what is sent – per author and per character, with a live test box.
- 📊 Scene tracker: a "Field: value" sheet (time, place, clothes, mood…) updated after each reply and sent with every message. Its fields are also variables.
- 📜 Story memory: important events recorded in the background, editable, undone when a turn is undone.
- Group chats: everyone replies in turn, or Auto picks 1–2. @mention members, a group scenario, a model per member, ▶ Next.
- Impersonate ("write my next message"), `/guide` (steer the next reply invisibly), retry with guidance chips.
- Forgotten `*asterisks*` and `"quotes"` in replies are closed automatically.
- Choice chips (opt-in): replies end with 2–4 options shown as buttons; tap one to send it.
- A sliding context window (e.g. 30K) instead of compaction for roleplays.
- Colours for `*actions*` and `"dialogue"`. HTML-styled cards render safely (no scripts).
- Card editor AI help: rewrite one field from an instruction, with undo.
- Chat export and import: a Chronicle chat file (.json) with the whole chat (versions, greetings, scene tracker, story memory, author's note, group, preset) and copies of its characters (with their pictures), your persona, lorebooks and the chat's memories, so it opens on a phone without that character (an identical character is reused, never duplicated; never keys or workspace files); also SillyTavern .jsonl, Markdown and text. Import with ⤵ next to the drawer's search (or Settings › Data); an imported chat is always a new chat, opened on its side.

- Characters imported from a link (Chub & co.) can be re-imported or updated from their source (also forced when nothing changed), and exported as PNG or JSON.

## 5. Agent & tools
**Workspace & code**
- Each chat has a workspace. `list_files`, `read_file` (numbered lines), `write_file` (refuses to overwrite a file someone else changed), `edit_file` (exact edits, all or nothing), `apply_patch` (Codex format or unified diff, several files), `move_file`, `delete_file`, `grep_files`, `glob_files`, `repo_map` (outline of functions and classes).
- Every write is syntax-checked (JSON, JS, Python). A changes card under each reply shows the diffs, with ↩ Undo.
- Python sandbox (Pyodide: numpy, pandas, matplotlib, micropip). `view_images` (with a vision model, or described by one).
- A built-in Linux: Alpine via proot.
  - The `shell` tool keeps a persistent shell per chat.
  - Long commands become jobs (`shell_job` poll, wait or kill).
  - `/workspace` is mounted into the shell, and `/phone` is the linked phone folder.
  - There's a terminal screen, and `apk add` installs packages.
- `doctor` reports what really works: the Linux tools, the network and the mounts.
- A phone folder (SAF) with Review, Auto and Read-only modes (diff sheet, undo). The phone tools are list, read, write, import and delete.
- 📁 Files (menu › Workspace files, or Chat files › Files of all chats…): a phone-style file manager. Places at the top – 💬 Chats' workspaces, 🐧 Linux files (when the shell is installed), and the phone folder linked to this chat. A path bar (tap a part, ‹ goes up), a slim storage line (chats · files · size), grid or list view (remembered), search, sort by Newest / Name / Size, long press (or Select) to pick several: Download, Share, To phone folder, Delete for workspace files.
  - 🐧 Linux files is read-only: what lives in the shell outside /workspace (a repo cloned into /root, /tmp). Quick places (/root, the folders this chat cloned into, /tmp), ✎ go to a path. One folder is read at a time (fast on 5,000-file trees), at most 500 rows with an "N more" note; .git and node_modules show their size and open only after you confirm. Text opens in the viewer (the first 2 MB), pictures in the image viewer, other files show size and type. Save to the phone, Share, or 📥 Copy into this chat (asks before replacing; a folder copies up to 300 files / 25 MB, without .git and node_modules, and says what was left out). ~/.config/chronicle (the GitHub sign-in and SSH key) is never listed or opened, also through a link or a typed path; a private key or a file holding the GitHub token is never shown, saved or copied. It uses its own shell, so a long command in a chat does not block it. No edit, delete or rename here.
  - Chat files: the linked phone folder is one compact row ("📱 Projects · linked"), its actions (Change folder, Bring files in, Save files to it, Unlink) in its ⋯ menu.
- The workspace as a website: `https://<chat>.workspace.localhost/` (SPA fallback, service workers), plus servers started in the shell at `127.0.0.1`.

**Web**
- `web_search`: Bing, Brave, Google and DuckDuckGo merged, with Exa as a fallback. Mods can add search sources.
- `fetch_url`.
- `screenshot_page`.
- `browser`: a hidden WebView driven like Playwright, one per chat.
  - Selectors (css, text=, role=, label=, xpath), real taps with user activation, hover, type, press, drag, wait_for, get, query_all, eval.
  - Console, network, dialogs, storage, cookies, downloads, PDF export, frames and shadow DOM.
  - A full read of virtualised pages, and steps (several actions in one call).
  - A handoff to you for sign-ins, and a monitor button to watch it work.
- `preview_page`: screenshots of a page the agent built, with steps, its JS errors and settle-before-capture.

**Planning & autonomy**
- `todo_write`, `ask_user` (a per-chat question sheet with pages), plan mode (`propose_plan`, with read-only tools until you approve).
- `/goal` with up to 200 steps, `ralph_loop` (fresh helpers over a progress file), `schedule_task` (once or repeating; add, list, cancel).
- `run_script`: a JS loop over its own tools, in a sandbox.
- `search_chats` and `read_chat` (earlier chats).
- `delegate`: helper agents with no tools, read-only tools (several in parallel) or full tools. They can fork this conversation as background, and the project can define named agents.
- A repeat guard, a tool time limit, Stop that works mid-tool, and a step limit per reply.
- A done check: a turn that changed files and ran nothing after them (no test, script, preview or served page) is sent back once to check them or to say they are unchecked, with a line in the chat saying so (Settings › Tools & agent › Check work before finishing).
- A guard for destructive shell commands: `rm -rf` outside the workspace or on the phone, `git reset --hard`, `git push --force`, `git clean -f`, `dd`, `mkfs`, overwriting phone files… wait for your OK even in ⚡ Auto, and are refused where nobody can be asked (helpers, scheduled runs). The command is parsed (`;` `&&` `|`, quotes, `sudo`/`env`, `sh -c`, heredocs) so `echo "rm -rf /"` is not flagged.
- `advisor`: a stronger model (Settings › Tools & agent › Advisor model) the agent may ask when stuck or before a risky step – no tools, at most 3 per message, allowed in plan mode.
- `/btw <question>`: a side question answered in a bubble above the message box, also while a reply runs; it is not added to the chat.

**Managing what the user keeps**
- `save_persona`, `save_character`, `save_lorebook`, `edit_persona` (field edits, greetings, tools, delete), `edit_lorebook` (add, update, remove, delete), `read_persona`, `list_personas`, `read_lorebook`. Each asks you first.
- `memory` (list, add, edit, forget), `saved_tools` (list, read, switch off, delete), `save_tool` (reusable Python tools as `tool_<name>`).
- Skills: `use_skill`, `save_skill`, `edit_skill`. Scripts from a skill are installed into the shell's PATH.
- Mods: `save_mod`, `list_mods`, `read_mod`, `manage_mod` (on, off, remove).

**Extending**
- MCP servers (Streamable HTTP, headers, tool switches, remembered tool lists, `reload_tools`).
- Mods: sandboxed iframes with permissions for tools, commands, chat, request, storage, net:<host>, search sources, panels and tool hooks.
- Deferred tools: with many saved, MCP or mod tools, only their names are sent, and `load_tools` loads the ones needed.

**Claude Code-style harness**
- Project instructions: AGENTS.md / CLAUDE.md, `/init`, `# rule`.
- The project folder `.chronicle/` or `.claude/`: `commands/*.md` (`/name` with `$ARGUMENTS`), `agents/*.md` (named helpers with their own prompt, tools and model), `styles/*.md`.
- 🪝 Hooks (shell commands): before a tool (exit 2 blocks it), after a tool (output added), on stop (exit 2 sends the agent back) and on prompt (adds context).
- 🔐 Permissions per tool (Allow, Ask me, Never), plus one switch per chat: ⚡ Auto, 🛡 Ask first, ⚡ Bypass or 📋 Plan.
- ⚡ Bypass permissions (per chat, or for new chats in Settings › Tools & agent; off by default, asks once): tools run without asking – no permission questions, shell guard or phone-folder review (Read-only stays). Still asks or refuses: tools set to Never, SSH pushes, credentials and the app's secrets, personal data (calendar, contacts, location, texts…), hand-offs to other apps. An amber ⚡ Bypass chip shows it; tap to turn it off.
- Auto-compact at a share of the context or a token count, set per model. `/compact <what to keep>`. Compaction style: a model summary, a structured record taken out of the messages (the user's words verbatim, files, commands with exit codes, errors, URLs, tool calls, to-dos – no model call, offline, free), or both; the folded messages stay readable with `read_chat` id "this". Stale old results (a call repeated later, a file read before it changed) are sent as one-line stubs, and the open to-do list is repeated after a compaction and every 12 tool rounds.
- Read-only tool calls in the same round run in parallel.
- Big results are spilled to `.out/`, old tool results are sent short, and an evidence line goes on every result (surface, ok, bytes, ms, proof).
- `!command` runs in the chat's shell without the model; running shell jobs show as chips with their own stop; "What this chat changed" shows one diff since the chat started.
- 🌿 Git history per chat (no Linux needed): a commit per reply that changes files, restore, clone / pull / push to GitHub.
- ⏪ Rewind and checkpoints, steer and queue, background running (a foreground service keeps work going while minimized).

- In the agent's browser, `upload` attaches workspace files to a page's file field; during handoff the page's file button opens the phone's picker.
- `browser` action `download` gets a file with the browser's sign-in (private repos, files behind a login) and saves it in /workspace/downloads/.
- GitHub sign-in for the shell (Settings › Connections › GitHub): git clone/pull/push and gh work in the Linux shell, commits use your GitHub name and email; or paste a fine-grained token.
- Usage by source: replies, each tool, each MCP server and the helper jobs, in the usage sheet.

## 6. Device & app
- Home-screen widget (New chat, 🎤), a quick-settings tile, shortcuts per persona, pin to the home screen, and "Ask Chronicle" in other apps' text-selection menu. Share into the app.
- Notifications when a reply finishes, with a reply box; questions and tool permissions asked in the background come as notifications with option buttons and an answer box.
- A reply that hit an OpenCode Go limit is tried again when the allowance resets (cancellable).
- Android wakes the app for scheduled tasks, retries and proactive messages (also in Doze, and after a restart). Quiet scheduled checks only speak when something is new; ⏰ Scheduled lists every chat's tasks with Run now and their last results.
- Files from a chat can be saved to the phone: ⬇ Download (Download/Chronicle) or 💾 Save as… (any folder, Drive), in the file viewer and the workspace manager.
- Better voices: pick the phone's text-to-speech engine and voice (including voice-cloning engines) in Settings › Voice.
- 🩺 Send timings (Settings › Data): a performance report from your own phone.
- Proactive messages (opt-in per chat): a character writes first after a quiet stretch – quiet hours, a daily cap, once per silence.
- 📷 Take a photo or record a video from the 📎 menu: the photo is attached; the video goes into the chat's folder (/workspace/videos/) for the shell's ffmpeg.
- 🖼 The assistant can show you pictures in the chat (`show_image`): from /workspace, the linked phone folder or the Linux shell, under its reply, tap to enlarge.
- 🗂 Files on my PC (Settings › Connections): `scripts/pc-files.py` on the computer shares the folders you name (read-only, or `--write` to allow saving; never deleting; hidden files and links out of the folders are left out). The assistant lists, searches and reads them, copies files into /workspace (`pc_import`) and saves results back (`pc_write`: asks first in Review mode, refused in Read-only). Several computers can be connected; the secret is kept in the Keystore. Pair by scanning the QR code the script prints; `--autostart` keeps it running from every log-in (same secret); `--full` gives full control – any file and `pc_shell` commands, asked first in Review mode.
- 🖥 PC agents over ACP (Claude Code, Gemini CLI, Goose…) through `scripts/acp-bridge.py`: their replies, tool calls and permission questions in a Chronicle chat.
- Claude Code in Linux (Settings › Account & models): installs the official Claude Code CLI and its ACP adapter (`claude-agent-acp`) in the app's Linux, you sign in inside Claude Code in the 🐧 terminal yourself (Chronicle has no sign-in for it and never reads, stores or backs up Claude Code's credentials), Start runs it on 127.0.0.1 behind acp-bridge with a secret kept in memory, and a chat drives it like a PC agent.
- Claude Code as models: when Claude Code in Linux is set up, the normal model picker has a "Claude Code (your subscription)" section with the models your own Claude Code offers; pick one in any chat (new chats follow the last pick) and the chat talks to it – the bridge starts by itself, 🧠 effort maps to Claude Code's effort, and the section header, a sheet and the drawer show your plan's 5-hour / weekly usage as Claude Code's `/usage` reports it.
- Claude Code with Chronicle's things: your enabled skills (packs and imported plugins too) become Claude Code skills in `~/.claude/skills` (only the ones Chronicle wrote are ever changed or removed), the phone and app tools (calendar, contacts, location, places, phone folder, photos, phone status/controls, notifications and texts if on, the browser, page previews, memory, web search, old chats) are an MCP server "chronicle" on the bridge – every call through your permissions and consent questions in the app –, your own MCP servers go along, and a Claude Code chat works in the chat's own files (they show in 📁).
- Claude Code and your other models work for each other (Settings › Tools & agent › "💻 Let models hand tasks to Claude Code", off by default): any model can hand a big coding job to your Claude Code with the `claude_code` tool – it runs hidden in the chat's own folder with the chat's skills and phone tools, its steps show live in the tool card, its permission questions come to the chat, Stop cancels it, and it uses your Claude plan – and Claude Code can ask your other models (`ask_model`, `list_models` in the chronicle MCP tools, the helper-agent machinery and permissions); one hop each way, no loops.
- `deep_research`: one call that plans searches, reads pages, takes notes and returns a cited report; each source is labelled (official, primary, community…) and it looks again when it has no official or primary one.
- The agent sees the model list and can pick a model for a helper; a built-in playbook skill says which tool fits which job.
- Automation: Tasker / MacroDroid run a prompt or recipe with `chronicle://run?token=…` and get the reply as a broadcast; a token per app.
- Phone data: `calendar` (what is on, and adding an event after you confirm), `contacts` (read only) and `location` (approximate unless precise is needed) – each asks in the chat first, and Android asks once.
- Places nearby: `places` finds the nearest pharmacy, ATM, cafe… (about 45 categories, or by name) around you or around an address, from OpenStreetMap – distance, address, opening hours with "open now" when they can be read, phone, website. The answer shows a small map in the chat (a ```map block): drag and zoom, numbered pins, a list with Directions / Map / Call / Website buttons that open your own apps. Asks once per chat before using where you are; the position sent to the search server is rounded to about 100 m. Map tiles are kept for a week and shown from the phone when offline; without them the pins and the list still show on a plain grid. The three service addresses can be changed (Settings › Tools › Maps & places).
- Phone status & controls (Settings › Tools, on by default): `phone_status` (battery, heat, storage, memory, device, network, sound mode, next alarm – no question; Wi-Fi name, signal and the networks in range after an OK per chat, with Android's precise location), `phone_control` (flashlight, volume, media play/pause/next/previous, vibration, copy to the clipboard after an OK per chat; reading the clipboard asks every time), `take_photo` (your camera app takes a picture for the assistant – asked every time, no camera permission; the photo is saved in the chat's files).
- 🔒 Sensitive phone access (Settings › Tools, each switch off until you turn it on, with what is read and where it goes): `notifications` (other apps' notifications – only from the apps you tick; banking, authenticator and password apps are never offered; read after an OK per chat, dismiss and open asked every time; needs Android's notification access, with the "Allow restricted settings" step for sideloaded apps explained), `messages` (text messages search and the call log, read only – asked every time with the search shown, never in scheduled checks, triggers, automation runs or helpers), and triggers for `schedule_task`: `when: { notification: { app, contains } }` or `when: { place: { lat, lon, radius_m, on: arrive|leave, label } }` runs a quiet task when it happens (you confirm each one; at most 6 runs an hour; up to 10 places, Android's own proximity alerts, location "Allow all the time"). One-time codes are hidden everywhere unless you switch them on; notification text is passed to the model as untrusted data.
- `android_intent`: the agent hands things to other apps – a page, the dialer, a text or email draft, the map, a calendar event, an alarm or timer, sharing, a settings page, an app (with `list_apps` to find the installed ones), or a file from the chat (`share_file` to the share sheet, `open_file` in an app that can show it). Asks first; you finish it there.
- Backup and restore to one .zip (streamed), automatic backups to a phone folder, folder sync with a PC, and a storage view and cleanup.
- An in-app update check against GitHub releases. Build numbers are minutes since 2026-01-01, so CI and local builds compare correctly.
- API keys in the Android Keystore, Android's own cloud backup switched off, a private-network block for the agent's browser.
- A device self-test (`adb … --es selftest 1`) for the native half, the agent scenarios and every tool.
- A web/PWA build (no native features).

---

## Known limits / not built yet
- **Not built:** AppFunctions (library not stable), the system assistant gesture, roleplay image generation (parked on purpose), stat-heavy RPG trackers (left out on purpose), multiple browser tabs, response mocking in the browser.
- **Linux:** arm64 only; slower than native because of proot. The full terminal (vim, htop) uses `script` from util-linux, installed on first open (needs a connection once).
- **MCP:** Streamable HTTP with OAuth sign-in, stdio servers through the built-in Linux, and a registry browser. No old SSE transport.
- **Scheduled tasks and proactive messages** need the app: Android wakes it (AlarmManager), but if Android has closed it, a notification asks you to open it. There is no server.
- **Testing:** many native parts (browser, shell, widget, folder sync) are only checked with stand-ins and a device self-test, not continuously on real phones.
