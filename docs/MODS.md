# Chronicle mods

Mods are small JavaScript add-ons that extend Chronicle (the harness around your model). A mod can:

- give the assistant **new tools** it can call (`mod.tool`)
- add **slash commands** to the message box (`mod.command`)
- **change the prompt** just before it is sent (`beforeRequest`), **react to replies** (`afterReply`) or **reword what you send** (`userMessage`)
- show a **status chip** next to the message box (`mod.status`)
- keep a little **saved data** (`mod.storage`)
- reach **specific websites** if you allow it (`mod.fetch`)

Manage mods in **Settings › Tools & agent › 🧩 Mods**. There you can install a mod from a file or a link, switch mods on and off, see what each one is allowed to do, read its source, and remove it. The **🧩 Mod Builder** persona writes mods for you.

> Mods run **inside Chronicle on your phone**. They cannot change the app's screens, and they only get the permissions you approve.

---

## 1. A mod file

A mod is one `.js` file that starts with a header comment, or a `.zip` containing `mod.json` and `main.js`.

```js
/*! @mod {
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "description": "/count <text> tells you how long a text is",
  "author": "you",
  "permissions": ["commands"]
} */

mod.command({
  name: 'count',
  description: 'Count the words in some text',
  run: async (text) => ({ toast: `${text.trim().split(/\s+/).filter(Boolean).length} words` }),
});
```

The header is JSON. Fields:

| field | meaning |
|---|---|
| `id` | lowercase words with hyphens; the mod's identity (installing the same id again updates it) |
| `name`, `version`, `description`, `author` | shown in the Mods screen |
| `permissions` | what the mod may use (see below). Anything not listed is refused |

The code after the header is plain JavaScript. A global `mod` object is available; top-level `await` works.

---

## 2. Permissions

You see this list when you install a mod, and can read it again any time in the Mods screen.

| permission | what it allows |
|---|---|
| `tools` | `mod.tool(...)` – new tools for the assistant |
| `commands` | `mod.command(...)` – slash commands |
| `chat` | the `afterReply` and `userMessage` hooks: the mod sees what you write and what the assistant replies |
| `request` | the `beforeRequest` hook: the mod sees the whole prompt (system prompt, memories, history) and may add to it |
| `storage` | `mod.storage` – up to 256 KB of the mod's own data |
| `search` | `mod.searchSource` – add your own source to the assistant's `web_search` |
| `panel` | `mod.panel` – a page of text in the chat menu (⋮ › More › Mod panels) |
| `toolhook` | `mod.on('beforeTool' / 'afterTool')` – see, change or block every tool call the assistant makes (sensitive) |
| `net:example.com` | `mod.fetch` to that one host (https only). Use one entry per host |
| `net:*` | `mod.fetch` to **any** website. A mod with this can send anything it can see anywhere – install only mods you trust |

`chat`, `request` and `net:*` are marked as sensitive in the install screen.

---

## 3. The `mod` API

### `mod.tool({ name, description, parameters, run })`
Adds a tool the assistant can call (only in chats with 🛠 Tools on). `name` is `lowercase_with_underscores`; `parameters` is a JSON Schema object; `run(args, ctx)` returns a string or any JSON value. The tool is shown to the model as `mod_<modid>__<name>`.

```js
mod.tool({
  name: 'roll',
  description: 'Roll dice, e.g. 2d6',
  parameters: { type: 'object', properties: { dice: { type: 'string' } }, required: ['dice'] },
  run: async ({ dice }) => {
    const [n, s] = dice.split('d').map(Number);
    const rolls = Array.from({ length: n || 1 }, () => 1 + Math.floor(Math.random() * (s || 6)));
    return `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`;
  },
});
```

### `mod.command({ name, description, run })`
Adds `/name` to the message box (it also shows in the `/` menu). `run(args, ctx)` gets the text after the command and returns:

- a **string** → put into the message box
- `{ insert: "text" }` → put that text into the message box
- `{ insert: "text", send: true }` → put it in the box and send it
- `{ toast: "message" }` → show a short message
- nothing → the command is just done

### `mod.on(event, handler)`
Each event can have one handler per mod. A handler that takes longer than 2.5 seconds is skipped.

| event | needs | handler receives | may return |
|---|---|---|---|
| `userMessage` | `chat` | the text you are about to send | a new string to send instead |
| `beforeRequest` | `request` | `{ model, persona: {id, name}, system, messages: [{role, content}] }` – a text view of the prompt (pictures and tool results are summarized) | `{ system?, prepend?, append? }` – a new system prompt, messages to insert right after it, and messages to add at the end. Each message is `{ role: 'system'\|'user'\|'assistant', content }` |
| `afterReply` | `chat` | `{ content, model, persona, conversation: {id, title} }` | nothing (runs in the background) |

```js
mod.on('beforeRequest', (req) => ({ append: [{ role: 'system', content: `Today is ${new Date().toDateString()}.` }] }));
```

### `mod.searchSource({ name, description, run })` (needs `search`)
Adds a source to the assistant's **web search**. Whenever the assistant calls `web_search`, every search source of every running mod is asked too, and its results are listed under their own heading (`Mod name · source name`) next to the normal engines. Use it for a site-specific search (a wiki, your own notes API, a forum), or any search service the built-in engines don't cover.

```js
mod.searchSource({
  name: 'wiki',
  description: 'Search Wikipedia',
  run: async (query, { max }) => {
    const r = await mod.fetch('https://en.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent(query) + '&limit=' + max);
    return JSON.parse(r.text).pages.map((p) => ({ title: p.title, url: 'https://en.wikipedia.org/wiki/' + p.key, snippet: p.description || '' }));
  },
});
```
`run(query, { max })` returns an array of `{ title, url, snippet }` (30 s limit). A source that fails or times out never breaks the search – the assistant just sees "(failed: …)" under its heading. A source that calls a website needs the matching `net:host` permission too.

### `mod.panel({ name, icon, description, render })` (needs `panel`)
Adds a page to the chat menu (⋮ › More › **Mod panels**). `render()` returns Markdown text; it is drawn when the user opens the panel and again on **Refresh**. Use it for a dashboard, notes, a status page or a log. Panels are read-only text – interaction goes through slash commands (`mod.command`).

### `mod.on('beforeTool' | 'afterTool', handler)` (needs `toolhook`)
Sees every tool call the assistant makes – built-in tools, MCP tools and other mods' tools.
- `beforeTool({ name, args })` runs before the tool. Return `{ block: 'reason' }` to stop it (the assistant is told why), or `{ args: {...} }` to change what it is called with.
- `afterTool({ name, args, result })` runs after. Return `{ result: 'text' }` to replace what the assistant sees (to redact, shorten or reformat).

Hooks have 2.5 s; a hook that fails or times out is skipped (the tool still runs). Because it sees your tool arguments and results, `toolhook` is marked as sensitive in the install screen. Typical uses: a guard that blocks dangerous calls, an audit log, redaction of secrets, or defaults for arguments.

### `mod.status(text)`
Shows a short text (40 characters) in a chip beside the message box. Pass `''` to remove it.

### `mod.toast(text)` · `mod.log(...)`
`toast` shows a message at the bottom of the screen. `log` writes to the mod's log (Mods screen › Logs).

### `mod.storage` (needs `storage`)
`await mod.storage.get(key)` → value or `null` · `await mod.storage.set(key, value)` · `await mod.storage.remove(key)`. Values must be JSON. 256 KB per mod.

### `mod.fetch(url, { method, headers, body })` (needs `net:host`)
Returns `{ status, ok, body }` where `body` is text. `https://` only; addresses on your phone or home network are refused; no cookies are sent; responses over 2 MB are cut.

```js
const r = await mod.fetch('https://api.github.com/repos/torvalds/linux');
return JSON.parse(r.body).stargazers_count;
```

### `mod.id`, `mod.name`, `mod.version`
The values from the header.

---

## 4. What a mod cannot do

Each mod runs in its own sandboxed frame: no access to the app's pages, your chats, memories or API keys except through the hooks above; no storage of its own except `mod.storage`; and the browser blocks every network request – `fetch`, `XMLHttpRequest`, `WebSocket` and the like do not exist inside a mod. The only way to reach a website is `mod.fetch`, which only allows hosts the mod listed and you approved.

This is a strong barrier, not a guarantee against a determined attacker. **Only install mods from people you trust, and read the permissions.** A mod with `chat` or `request` can see your conversations; one that also has `net:…` can send what it sees to that site.

---

## 5. Installing and updating

- **From a file:** Mods › **+ Install from file** and pick a `.js` or `.zip`.
- **From a link:** Mods › **+ Install from link** and paste an `https://` link to a `.js` file (for example a raw GitHub link).
- **Examples:** the Mods screen lists a few ready-made mods you can install with one tap.
- **Update:** installing a mod with the same `id` replaces it. If the new version asks for more permissions, the install screen highlights them.
- **Turn off / remove:** the switch in the list disables a mod without deleting it; **Remove** deletes it and its saved data.

If a mod fails to start, the Mods screen shows the error and the mod stays off until you fix or reinstall it.

---

## 6. Writing one with the Mod Builder

Start a chat with the **🧩 Mod Builder** persona (Mods › **✨ Make one with the Mod Builder**). Describe what you want. It reads this guide, writes the mod, and installs it with `save_mod` – you always get the install screen first, with the permissions listed. It then tells you whether the mod started and what it registered, and can fix problems.

Any assistant can use the built-in **chronicle-mods** skill (Settings › Tools & agent › 📚 Skills) to write mods too.

---

## 7. Tips

- Keep handlers fast; do slow work with `mod.fetch` inside a tool instead of a hook.
- A `beforeRequest` hook that adds text on every message costs tokens every time – keep the additions short.
- Use `mod.storage` for counters, last-seen values, small caches. Not for secrets.
- To debug, call `mod.log(...)` and open Mods › **Logs**; errors thrown by a tool are returned to the assistant as the tool's result.
