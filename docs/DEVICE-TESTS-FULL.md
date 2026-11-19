# On-phone checks – full reference

The per-feature reference behind the short checklist in `docs/DEVICE-TESTS.md` (37 steps – start there). Each section
here belongs to a feature or a decision in `docs/DECISIONS.md`; use it to test one feature in depth, or when a step
of the short list fails and you want the details. Nobody needs to go through all of it.

**Before you start:** install the newest APK from the "latest" release. If Android refuses to update,
back up (Settings › Data › Export backup), uninstall, install, then restore.

---

## 1. Keys are stored in the Android Keystore 🔒
1. Open Settings › Account.
   - ✅ Under the API key it says *"encrypted with the Android Keystore 🔒"*.
2. Force-close the app (swipe it away), then open it again.
   - ✅ Models still load and you can chat, so the key survived.
3. Settings › Account & models › Custom endpoints › your Chub endpoint.
   - ✅ Its key is still filled in and a roleplay reply works.

## 2. Replies keep going in the background, and you get a notification
1. Settings › Chats: check **"Notify me when a reply finishes in the background"** is on.
2. Send a message that gets a long reply (e.g. "write a 600-word story"), then go straight to the home screen.
   - ✅ A silent **"… is writing…"** notification shows while it works.
   - ✅ When it's done, a **notification with the start of the reply** appears.
   - The first time, Android may ask to allow notifications. Allow it.
3. Tap the notification.
   - ✅ The app opens on that chat and the full reply is there.
4. Do it again, but stay in the app.
   - ✅ No "reply finished" notification (you were watching).

## 3. Read aloud and voice input 🔊🎤
1. On any reply tap **⋯ › 🔊 Read aloud**.
   - ✅ The phone reads it; a **"🔊 Reading… ⏹ Stop"** pill shows; tapping it stops reading.
   - ✅ Code blocks, links and `*`/`**` symbols are not read out.
2. In a roleplay: Settings › Voice › "In roleplay, read only the dialogue" on.
   - ✅ Only the "quoted" lines are read.
3. Tap **🎤** in the message box.
   - ✅ Google's "Speak now" screen opens; what you say lands in the message box.
   - If there's no 🎤, or it says there is no speech recognizer, install or enable the **Google** app / **Speech Services by Google**.

4. Per-character voices: 🎭 Personas › a character › **🔊 Voice**.
   - ✅ The Engine list shows your phone's TTS apps (Google, and CloneTTS if installed); the Voice list fills in.
   - ✅ **▶ Test this voice** speaks in that voice. After saving, **Read aloud** on that character's replies uses it.
   - With **CloneTTS**: make a cloned voice in its app, then pick CloneTTS as the engine. If its voices don't appear in the list, note that. It may only expose one voice to other apps.

## 4. Import from a Chub link 🔗
1. Personas › 🎭 Roleplay tab › paste a chub.ai character link › **Import**.
   - ✅ The character appears with its picture, lorebook (if it has one) and full-size art.
   - ❌ If it fails, send me the link and the error message.

## 4b. Browse Chub inside the app 🌐
1. Personas › 🎭 Roleplay tab › **🌐 Browse Chub**.
   - ✅ A full-screen browser opens on chub.ai (if it shows a Cloudflare check, wait a few seconds or tap the box).
   - ✅ You can search, open a character page, and the top bar shows **⤵ Import this page** on character pages.
2. On a character page tap **Download › PNG**.
   - ✅ The screen closes by itself and the character is imported (a "Got … – importing…" message appears first).
   - ❌ If nothing is imported after tapping Download, tap **⤵ Import this page** instead and tell me. It means Chub's download button works differently than I expected.
3. Tap **🌐 Browse Chub** again.
   - ✅ It reopens on the page you were on, so you can pick the next character.
4. Try a **lorebook**: Lorebooks tab on Chub › Download › JSON.
   - ✅ It is added under 📚 Lorebooks.
4b. Open a character from the search results (not by typing its address), with a long page title.
   - ✅ **⤵ Import this page** shows at the right of the top bar, and the title is shortened with “…”.
4c. On that page: Download › **PNG**.
   - ✅ The screen closes by itself and the character is imported with its picture.
5. Tap a link that leaves Chub (e.g. a creator's Twitter).
   - ✅ It opens in your normal browser, not inside this screen.
6. Back button: goes back through the pages, then closes the screen.

## 4c. Browse BotBooru 🌐
1. Personas › 🎭 Roleplay tab › **🌐 Browse BotBooru**.
   - ✅ botbooru.com opens in the full-screen browser; you can search, sign in (it's on the site itself) and open a character.
2. On a character page use its download button (PNG or JSON).
   - ✅ The screen closes by itself and the character is imported. Downloads there are paced and may ask you to wait or sign in – that's BotBooru's own rule.
3. **⤵ Import this page** (character pages) is the fallback. Because BotBooru asks for sign-in or pacing sometimes, it may fail where the Download button works.
4. Reopening goes back to where you were on each site separately.

## 4d. Browse Character Archive 🌐
1. Personas › 🎭 Roleplay tab › **🌐 Character Archive**.
   - ✅ chararc.bernkastel.pictures opens in the full-screen browser; browse or search, open a card.
2. Use the card's own download button.
   - ✅ The screen closes by itself and the card is imported (lorebooks go under 📚 Lorebooks).
   - There is no "Import this page" shortcut here; if the download button does nothing, tell me what it shows.

## 4e. In-app update
1. When a new build is out, the banner shows **Update**. Tap it.
   - ✅ First time only: Android's "Install unknown apps" page opens for this app. Switch it on, come back, tap **Update** again.
   - ✅ The banner shows Downloading… %, then Android's install screen appears; tap Install. Your chats and settings stay.
2. If the download fails, the release page opens in the browser as a fallback.

## 4f. Phone folders 📱
1. In a chat with tools on, tap the **📁** chip › **📱 Link a phone folder** and pick a folder (e.g. one in Documents).
   - ✅ Its name shows at the top. Android only allows folders you pick; the app never sees outside it.
2. **📥 Bring files in** copies the folder's files into the chat; **📤 Save files to it** writes the chat's files back (asks first).
3. Ask the assistant: "go to my phone folder and list what's in it" (with none linked).
   - ✅ Android's folder picker opens; after you choose, it lists the files.
4. "Look at the photos in the `pics` folder and tell me what's in them." – it imports then views them.
5. "Make a file `report.md` in my phone folder." – ✅ it appears in your Files app (in Review mode, after you accept it).

## 4j. Review changes and agent modes 🛡⚡👁
With a phone folder linked, a chip by the composer shows the mode: **🛡 Review**, **⚡ Auto** or **👁 Read-only**. Tap it to change it for this chat (tick "make this the default" for all chats; also in Settings).
1. In **Review**, ask: "change `report.md` to say hello and add `notes/new.txt`".
   - ✅ Nothing is written yet. A **Review changes** sheet lists each file (NEW / REPLACE / DELETE) with a before/after diff or image preview.
   - Untick one file and tap **Apply** – ✅ only the ticked file appears in your Files app.
   - Tap **Reject all** (or close the sheet) – ✅ nothing is written and the assistant is told you declined.
2. Tick **Auto-accept from now on in this chat** and apply – ✅ the chip switches to ⚡ Auto.
3. In **Auto**, repeat the request – ✅ no sheet; files are written straight away.
   - Tap **↩ Undo N file changes** under the reply – ✅ new files are removed and replaced files get their old contents back.
4. In **Read-only**, ask it to write or delete – ✅ it refuses and says it can only read.

## 4g. Pasting pictures
1. Copy a picture (long-press a photo in Gallery/Photos › Copy, or copy an image in your browser, or Gboard's clipboard).
2. Open the app and tap the message box.
   - ✅ A **📋 Paste the picture you copied** button shows above it; tap it and the picture is attached (needs a model that can see pictures).
3. Gboard › clipboard icon › tap a copied **picture** while the message box is focused.
   - ✅ The picture is attached (it used to say "not supported"). Stickers and GIFs from the keyboard attach the same way.
4. Long-press in the message box › Paste (when your keyboard offers the picture there).
   - ✅ The picture is attached instead of nothing happening.

## 4h. Share to Chronicle
1. In your browser tap Share › **Chronicle** on a web page.
   - ✅ A sheet offers *Read it and summarize*, *See how it looks (phone + desktop)* or *Just open it in a chat*; the choice starts a new chat (tools on) and sends it.
2. Share a picture or a PDF from Gallery / Files.
   - ✅ It's attached to a new chat with quick actions (describe / read the text / summarize).
3. Share text from any app (select text › Share).
   - ✅ Summarize / Translate / Explain, with your text included.

## 4i. Mods
1. Settings › Tools & agent › **🧩 Mods** › under *Examples* tap **Dice roller**.
   - ✅ An install screen lists what it asks for ("Give the assistant new tools") and shows the code; **Install** starts it ("✓ running · 1 tool").
2. With 🛠 Tools on, ask: "roll 2d6+3 for me".
   - ✅ A 🧩 tool card shows the roll.
3. Install **Reply counter**, send a message.
   - ✅ A chip beside the message box counts replies (📋 chip row).
4. Tap **✨ Make one with the Mod Builder**, ask for a `/shout` command that uppercases text.
   - ✅ You get the install screen before anything is installed; afterwards `/shout hello` works.
5. Mods screen › **📖 Guide** opens the documentation.

## 4k. Helper agents 🤝
1. Settings › Tools & agent › **Helper agents**: leave on, helper model **Auto** (a fast, cheap model).
2. In a chat with tools on, attach a long text file and ask: "use a helper to summarise this file, then tell me the three key points".
   - ✅ A **🤝 Asked a helper** card appears showing which model answered; expand it to see the task and the helper's reply.
3. Turn the setting off – ✅ the assistant no longer has the tool.

## 4l. Browser control 🧭
1. Settings › Tools & agent › **Browser control**: tick it (it is off by default).
2. Ask: "open https://example.com and tell me what links are on it", then "click the first link".
   - ✅ A **🧭 Browser** card per step; expand it to see the numbered list of buttons/links the assistant saw.
3. Ask it to fill a form on a page you own (type into a field, press the button) – ✅ the next card shows the page after the action.
4. Ask for a screenshot of the page it has open – ✅ you get the picture (or a description if the model can't see images).
5. ✅ The page is closed when the reply ends. It never shows on screen.
Note: the agent's browser shares cookies with Browse Chub/BotBooru, so if you are logged in there, it could act on those sites.

## 4m. Context editor ✂
1. Tap the context chip (e.g. `~12k / 128k`). Rows for **Memories**, **Story memory**, **World info** (and **Example dialogues** for a character card) have a **Drop** button.
   - Tap Drop on Memories – ✅ the row is struck through, the total shrinks, and the next reply doesn't use your memories (nothing is deleted). **Include** brings it back.
2. Long-press / tap **⋯** on any message › **🙈 Hide from the AI** – ✅ it stays on screen, dimmed with "hidden from the AI", but is no longer sent. The context sheet lists "N messages hidden" with **Show all again**.

## 4n. Persona Maker and creating things 🎨
1. Open the persona list and pick **🎨 Persona Maker** (it is added automatically).
2. Say: "make me a gruff dwarven blacksmith character for roleplay, with a small lorebook about her forge town".
   - ✅ It may load your creation skills (character-sheet, lorebook…), then an approval sheet asks **Add the character “…”?** with a short summary.
   - Tap **Add it** – ✅ the character appears in your Roleplay list with its lorebook (📚 Lorebooks shows it). Tap **Not now** or type a change – ✅ nothing is added and it revises.
3. Ask for "a persona that reviews my commit messages" – ✅ approval, then it appears in the persona list. Ask for "a lorebook for X attached to Y" – ✅ it is attached.
3b. Send a picture first (with a vision model), then ask the Persona Maker to "make a character that looks like this" – ✅ the approval sheet says it will use the picture you sent; after adding, the character's avatar and card art are that picture.
4. Settings › Account: switch **Let the assistant create characters…** off – ✅ the tools disappear in every chat.

## 4o. Lore suggestions ✨
1. In a roleplay with a character, after a few exchanges, open the chat's settings (tap the character name) › **✨ Suggest lore entries from this chat**.
   - ✅ After a few seconds a sheet lists entries (name, keywords, text) for people, places and rules the story established – not things the lorebook already has.
2. Untick one, tap **Add selected** – ✅ a toast confirms; open 📚 Lorebooks and the entries are in the character's lorebook (a new "<name> – lore" book is made if it had none).
3. Tap **Suggest again** after more play – ✅ it doesn't repeat what you already added.

## 4p. Card AI edit, story map, prompt test, spend 🧪🗺
1. **Card AI edit:** edit a roleplay character › 🎭 Character card › **✨ Edit a field with AI**. Pick Description, type "more detail about her clothes" (or tap a chip), **✨ Rewrite** – ✅ the field changes; **↶ Undo** brings the old text back.
2. **Story map:** fork a chat (chat list › ⋯ › Fork), then tap the character/persona name › **🗺 Story map** – ✅ the original and its forks show as a tree (● = this chat); tap one to open it. Messages with swipes/edited versions are listed below; tap to jump.
3. **Prompt test:** chat ⋯ menu › **🧪 Prompt test** – ✅ pick two different models (or "No system prompt" for one), **▶ Run all** – answers stream side by side with time and size; the chat itself is untouched.
4. **Spend:** Settings › Data › 📊 Usage history – ✅ **Busiest chats** lists tokens and list-price value per chat (counting from this update); set a **Daily token budget** (e.g. 2) – ✅ one warning appears the first time today passes it.

## 4q. Quick actions, folder sync, offline model 📴
1. **Widget:** long-press the home screen › Widgets › *Chronicle quick chat*. Tap **✎ New chat** – ✅ a fresh chat opens with the keyboard up. Tap **🎤** – ✅ a fresh chat opens and starts listening (if voice input is available).
2. **Ask Chronicle:** select text in any app (a browser, a message) › ⋯ / the selection toolbar › **Ask Chronicle** – ✅ Chronicle opens with the "what to do with this" sheet (summarize, translate, explain…). If the item is missing, look under the toolbar's overflow menu.
3. **Folder sync:** Settings › Data › Automatic backup: choose a folder that is synced to your PC (Syncthing, Drive, OneDrive…). On the other device keep the same kind of folder. Tap **🔄 Merge newest backup from folder** – ✅ it asks, merges (newer chat/memory edit wins, nothing is deleted) and reloads.
4. **Offline model (experimental):** Settings › Account & models › tick **On-device model** – ✅ a ~400 MB download shows its progress. Save, pick *On-device Qwen2.5 0.5B (offline)* in the model list, turn on airplane mode and ask a short question – ✅ it answers (slowly, a few words per second). It has no tools and a short memory of the chat by design.

## 4r. UI cleanup
1. **Header:** the + in the top right is gone (use **+ New chat** in the side menu).
2. **Message actions** are small black/white icons: copy, pencil (edit), → (continue, last reply), ⟳ (retry), speaker (read aloud), ↶ (undo file changes, with a count). **Retry is on every reply**, not hidden under ⋯, and retries *that* reply.
3. **Dropdowns** (e.g. Settings › Appearance › Theme) open our own bottom sheet, with a search box when the list is long – not Android's default list.
4. **Roleplay start screen** with many characters: **New / Import card / Group** stay pinned at the top while you scroll the cards.
5. **Persona editor:** a chat assistant has no Greeting field; tick 🎭 Roleplay character and it appears.
6. **Settings › Prompts** has tabs: Chats · Roleplay · Group chats.

## 4s. Memory hygiene, HTML cards, backgrounds
1. **Skills don't leak into memory:** use a skill that has fixed details in it (e.g. a folder path), ask for something unrelated, then open Memory – ✅ nothing from the skill was saved "as something you said".
2. **Past-chat notes are picked by relevance:** a persona with several chats of multi-bullet notes only sends the bullets that fit what you're talking about (about 8 at most), not whole notes.
3. **HTML-styled text:** open a character whose description or greeting is designed HTML (divs, tables, a `<style>` block) – ✅ it shows styled (also in the full-screen character preview), contained inside its own box.
4. **Backgrounds:** Settings › Appearance has separate backgrounds for assistants and for roleplay (both can use the persona/character picture). If you had one background before, it became the roleplay one.

## 4t. Chats in the background, drag order, code box, search sources
1. **Several chats at once:** ask a long question in chat A, then open the side menu and start/open chat B and ask something there – ✅ B answers normally and A keeps writing. In the side menu A shows a **spinner** while it writes; when it finishes while you are elsewhere it gets a **blue dot** (gone once you open it). The "writing…" notification counts the chats ("2 chats are writing…").
2. **Reorder:** on the New chat / New roleplay screen, long-press a character (about half a second until it lifts), drag it to another place and release – ✅ the order stays (also after restarting the app). A normal tap still picks the character, and scrolling doesn't start a drag.
3. **Code box:** in the message box type ```` ```md ```` and press Enter – ✅ a closing ``` appears with a free line below it, the caret sits inside, and a formatted preview of the code box shows above the message box.
4. **Search sources (mods):** install a mod that calls `mod.searchSource` (see docs/MODS.md), ask the assistant to search the web – ✅ its results show under their own heading next to the normal results.

## 4u. Audit fixes
1. **Closed mid-reply:** start a long reply, force-stop the app, reopen – ✅ that chat doesn't show a reply "writing" forever; it says the app was closed and offers Retry.
2. **Private addresses:** ask the assistant to read `http://192.168.x.x/` (your router) or a short link that redirects there – ✅ it refuses ("private network"). Public pages still work.
3. **Google backup is off** for the app's data (use Settings › Data › Backup).

## 4v. Compact menus (Chub-style)
1. Tap the **⋮** in the header (or a chat's ⋮ in the side menu) – ✅ a small popover next to the button with short labels: Chat settings · Character settings · Chat memory · Search · Fork · Pin · Rename · **More ▾** (name with AI, folder, write my next message, compact, make a persona, prompt test, inspect, export, archive, delete).
2. Tap the 📎 by the message box – ✅ a small menu: Attach a file or image · Change persona · Write my next message · Prompt test · Inspect the prompt.
3. **Chat settings** is shorter: persona, a row of small buttons (Group chat · Personas · Story map), who you are, context limit and the memory switch first; the long editors stay folded below.

## 4w. Chub: no import until you ask
1. Browse Chub, tap a character in the list to open its page – ✅ nothing is imported or downloaded just by opening it (the ⤓ Import button waits for you).
2. Tap **Import this page**, or Download › PNG – ✅ then it imports.

## 4x. Character page
1. Roleplay › New roleplay: tap a character card – ✅ its page opens: big picture, name, **Chat with …**, Edit / Group chat, a blurb (Show more/less), tags, "Created by @author · chub.ai", and folded sections for Definitions, Greetings and the Lorebook entries. Assistants (chat tab) still start straight away.
2. Tap **Chat with …** – ✅ the roleplay starts with its greeting.

## 4y. Questions, lorebook list, MCP, open mods
1. **Questions:** in the Persona Maker (or any chat) make the assistant ask something, then switch to another chat – ✅ the question does NOT appear there; in the side menu the asking chat shows ❓. Open it again, tap the **❓ Question waiting** chip. Tapping outside the sheet no longer answers; the ⌄ arrow only hides it. If it asks several things at once ("ASKMULTI"-style) you get pages with ‹ › arrows and **Send answers** on the last one.
2. **World info list:** chat settings › 📚 World info is a folded section "(2 on of 12)", with a search box and a scrolling list (the ones that are on come first).
3. **Connection errors:** a TLS/“SSLProtocolException” hiccup in the middle of an agent turn is retried automatically (up to twice) instead of stopping the reply.
4. **MCP servers:** Settings › Connections › MCP servers: add a server with extra headers (`X-Api-Key: …`); Test it – ✅ the tool list appears with checkboxes to switch single tools off (the count shows "3/5 tools on"). Works with https servers, LAN servers (`http://192.168.x.x:port/mcp`) and Termux (`http://127.0.0.1:port/mcp`).
5. **Open mods:** Settings › Tools & agent › 🧩 Mods › examples: install **Tool guard** (ask the assistant to read a page on its list – ✅ "Blocked by a mod"), **Notes panel** (`/note hello`, then ⋮ › More › Mod panels), **Wikipedia search** (ask a web question – ✅ a "Wikipedia · …" heading in the results).

## 4z. The assistant looks at the pages it writes
1. Tools on, a model that can see pictures. Ask: "make me a one-page website for a bakery, then look at it on a phone and improve the design".
   - ✅ After writing the files it calls **🖼 Previewed the page** (screenshot shown, saved in `output/screenshots/`), you see what it sees, and it fixes things and previews again – usually 2–3 rounds.
2. A page with a JavaScript mistake – ✅ the result lists the errors ("JavaScript errors: …") so it can fix the script.
3. Settings › Account: **Let the assistant look at web pages it writes** switches it off. The page is drawn in the hidden WebView; requests to your LAN/this phone from the page are refused.

## 4aa. Backup no longer crashes
1. Settings › Data › Automatic backup › **Back up now** (with a lot of chats and files) – ✅ the app stays up, "Last backup…" appears and the `chronicle-backup-….zip` is in the folder. Export backup works the same way (share sheet opens at the end).
2. While it runs the status line shows progress ("Saving files… 3 of 12 chats"), and the app should stay responsive (taps and scrolling work); a short stutter is normal on very large data.
3. If it fails it says why and no half-written zip is left in the folder.
Restoring a very large backup still reads the whole file into memory – if that ever fails, say so.

## 4ab. Queue, steer and browser handoff
1. **Queue:** while the assistant is writing, type a message – ✅ the send button now queues it (a chip "⏳ …" shows above the box, ✕ removes it) and it goes out by itself when the reply finishes. If you tap **Stop**, the queue waits (nothing is sent) until you send again. It only auto-sends while you are in that chat.
2. **Steer (↪ button next to send):** during an agent turn (tools on), type a correction and tap ↪ – ✅ a note "↪ You added: …" appears after the current step and the assistant follows it. In a plain chat reply, ↪ stops the reply and answers your new message at once.
3. **Browser handoff:** enable Settings › Tools & agent › Browser control. Ask: "open <a site that needs a login> and tell me what's in my account". ✅ When it hits the sign-in it asks to hand over: the page opens full-screen with a bar "Please sign in…" and **Cancel / Done**. Sign in yourself (the assistant never sees what you type), tap **Done** – it carries on from the page you left. The browser keeps your sign-in for later runs and is shared with Browse Chub/BotBooru.

## 4ac. Side-menu chat actions
In the side menu, a chat's ⋮ now shows only: Pin, Rename, Move to folder, Fork, Archive, Delete. Everything else (chat/character settings, memory, search, export, compact, prompt test…) is in the ⋮ at the top of the chat itself.

## 4ad. Smoother drag-to-reorder
On the New chat / New roleplay screen, long-press a character until it lifts, then drag. ✅ The page and the row do not scroll under your finger while you hold it; the others slide aside smoothly (no flicker back and forth); hold near an edge and the list scrolls by itself; drop to keep the order.

## 5. Files: export, share, save
1. On a chat: **⋯ › Export chat… › Markdown**.
   - ✅ Android's share sheet opens with a `.md` file (save it to Files or Drive).
2. Settings › Data › **Import SillyTavern chats** › pick a `.jsonl` from SillyTavern.
   - ✅ The chat opens with the right character and swipes.
3. Settings › Data › **Export backup**.
   - ✅ A `.zip` is offered to save or share.

## 6. Update check
1. Settings › Data › App updates: add your read-only GitHub token (the repo is private) › **Check now**.
   - ✅ It shows "You're up to date (build #N)", or a banner with **Download** that opens the release page.

## 7. Small things
- **Back button:** closes sheets and the menu first; on the chat screen it minimises the app (doesn't close it).
- **Quick settings tile and long-pressing the app icon:** "New chat" and per-persona shortcuts open the right chat.
- **Character art:** tap a character's picture in a chat › full screen; tap the picture to zoom to 100%.
- **Startup:** no flash of an unstyled page when opening the app.

---

### If something fails
Tell me the **step number**, **what you saw** (a screenshot helps), and if relevant the **model / endpoint** you were using.

## 4ae. Browser: sign-in, then keep going (Notion-style)
1. Ask the assistant to open a page that needs sign-in (e.g. Notion). Use the handoff, sign in, tap Done.
2. In the *next* message say "now list the page contents". Expect it to reopen the page itself (a "reopened" note), signed in, not "No page is open".
3. On a long page, ask it to read it all: it should read in parts (offset) rather than stop at ~4,000 characters.
4. On a page with an inner scroll area, ask it to scroll: the scroll position should change (not `0/0`). Ask it to press PageDown.
5. Break something on purpose (e.g. ask it to click a number that doesn't exist): it should tell you what failed instead of stopping.
6. After a reply that ended in a red error card, type "what went wrong?": it should know the error.

## 4af. Browser: watch the agent (monitor button)
1. In a chat with browser control on, ask the assistant to open a website. A monitor icon appears left of the ⋮ in the chat header while a page is open; it disappears when the reply ends (the browser closes).
2. Tap it: the page fills the screen with a "Close" bar. The assistant keeps working underneath; Close returns to the chat.
3. While watching, ask for a handoff: the bar should switch to Done/Cancel.
4. Note: while on screen the page is full-screen sized, so the page may re-layout briefly for the assistant too.

## 4ag. Code box in the message field
1. Type ```js and press Enter. The field turns into a dark monospace box; a bar above shows "code · js", Wrap on/off and Done. Type code inside it.
2. Wrap off: long lines scroll sideways. Done: the caret moves below the box and the field returns to normal.
3. Tap back into the box: it turns into a code box again.

## 4ah. Browser: long documents (Notion)
1. The browser stays open between replies: ask for something, wait, ask for a follow-up; the page is still there (no "reopened" note). After 10 idle minutes it closes and the next action reopens the same page at the same scroll position.
2. On a long Notion page: "read the whole page" → the agent uses read full:true and gets the entire document in parts, not just what is on screen.
3. Ask it to scroll to a given position; it should use scroll y.
4. A typed edit into a Notion text block is refused unless you asked it to edit.

## 4ai. Browser: eval
1. Ask the assistant to open a wiki page and list the infobox fields / all section headings. It should use action eval and answer from the returned data.
2. Ask it to run a script that throws: it should report the error, not stop.

## 4aj. Browser: Playwright-style actions
1. Ask: "open <a wiki page>, then list every infobox row" → it should use query_all / get with selectors.
2. Ask it to fill a search box by label, click a button by its text, tick a checkbox, pick a dropdown option, hover a menu.
3. Ask it to wait for some text to appear, read the console errors, and list the network requests.
4. A page that opens a link in a new tab should open it in the same view. Note what does NOT work (decision 28): several tabs. (Downloads the server sends as an attachment work since decision 113.) Uploading a workspace file with `upload` works (4be step 10), and so does `pdf`.

## 4ak. MCP: no reconnect on every message
1. With one MCP server enabled, send a message to an agent: the "connecting to MCP servers…" card may show the very first time only.
2. Send another message, and again after closing/reopening the app: no connecting card, tools available straight away.
3. Turn the server off its network (or break the URL): the first message shows an MCP warning once, later messages are not delayed for ~2 minutes.

## 4al. Browser: one per chat
1. Start a reply in chat A that opens a site; while it runs, start chat B and have it open a different site.
2. Each chat should keep reading and clicking its own page; neither should jump to the other's address.
3. The monitor button appears only in a chat that has a page open and shows that chat's page.
4. Sign in to a site in chat A: chat B opening the same site is signed in too (shared cookies).

## 4am. Notion again: full read, steps, eval
1. read full twice on the same long Notion doc: same character count both times, a header saying "Whole document read: N screens, M blocks".
2. Text under repeated headings ("Items & Armor", "Blocks") is present for every section, and genuinely repeated lines appear as often as in the source.
3. If a screen could not be linked, the header says PARTIAL and names the scroll positions (it must never claim a complete read then).
4. A `steps` call (scroll, read, scroll, read) returns in one go; an eval crawl up to 45 s works; read max_chars 200 returns 200.

## 4an. Built-in Linux (proot) — first on-device test, expect to debug
1. Install the new build. Settings → 💻 Linux terminal → Install Linux: it downloads (~4 MB), unpacks, then the command bar appears. If it says it cannot run here, note the message.
2. Run `uname -a`, `cat /etc/os-release`, `apk add python3` then `python3 -c "print(1+1)"`, `cd /tmp && pwd` then `pwd` (state persists).
3. `ping`-less network check: `wget -qO- https://example.com | head -3`.
4. Stop: run `sleep 100`, tap Stop, run `echo ok` (a fresh shell starts).
5. Settings → turn on "run commands in the built-in Linux", ask the assistant: "install nodejs and run a script that prints the first 10 squares". It should call shell, handle the apk install (timeout_s), and report real output.
6. If step 1/2 fails, send me the exact message shown (it is the proot or tar error).

## 4an-bis. The self-test (do this first — it covers 4ao and 4ap in one command)
1. With the phone on adb: `adb shell touch /sdcard/Android/data/dev.chronicle.app/files/selftest.key` (once), then `adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1`, then `adb logcat -s ChronicleSelfTest`.
   - ✅ Two suites, one launch. Native: `VERDICT ok=8 fail=0 ALL-GOOD` (abi, proot libraries, rootfs, shell, toolkit, app -> /workspace, shell -> app, **same inode**).
   - ✅ Bridge (lines prefixed `js`): `mount`, `app -> shell`, `shell -> app`, `app delete -> shell` (must say *No such file*), `shell delete -> app`, ending `bridge done  ok=6 fail=0`.
   - If the `js` lines are missing, the web layer did not get the flag — check that the build has `selftest.js`.
2. If a line fails, send me that line (it carries the reason) before working through the sections below.

## 4ao. /workspace is a mount, and deletes cross both ways (decisions 33–34)
1. Settings → turn on the Linux shell tool. Ask: "write a note in the shell to /workspace/out/note.txt, then read it back with read_file".
   - ✅ `read_file out/note.txt` returns the text. This is the direction that used to be missing entirely.
   - ✅ The result says *n file(s) back from /workspace*.
2. **The delete test — the one that matters.** Write a file with `write_file` or `run_python`, delete it there, then run any shell command and `cat /workspace/<it>`.
   - ✅ `No such file`. The shell must not keep a copy of a file the app removed (that is how AES keys and cookie jars used to stay behind).
3. Now the other way: `rm /workspace/out/note.txt` in the shell, then `list_files`.
   - ✅ It is gone from the app too, and the result says how many were deleted.
4. Two chats: make a file in chat A, then run `ls /workspace` in chat B.
   - ✅ Chat B does not see chat A's file (each chat has its own directory).
5. A big file: ask for `dd if=/dev/zero of=/workspace/big.bin bs=1M count=80` (80 MB), then a shell command again.
   - ✅ `ls -l /workspace/big.bin` works in the shell (80 MB is fine in a mount); the app reports it as too big to carry (over 32 MB) and **stops mentioning it** on later calls instead of re-reading it every time.
6. A file at the edge: `run_python` writes 33 MB, then any shell command.
   - ✅ It is refused, nothing appears in the shell, and the workspace copy is **still 33 MB** (this is the case that used to leave a zero-byte file and then overwrite the original).
7. Mode: `echo hi > /workspace/x.sh; chmod +x /workspace/x.sh`, then `list_files`, then `read_file`.
   - ✅ The script works in the shell, and still does after the assistant rewrites it from the app side: the permission bits cross both ways (a `644` stays `644`, a `600` stays `600`). `toolkit-pull` reports `NOT-EXECUTABLE` rather than `ok` for a hash-correct file nobody can run.
6. Link a phone folder and ask the assistant to write into /phone from the shell.
   - ✅ In auto mode the folder really has it; in review mode it is staged like a phone_write; read-only refuses.
7. Unlink the folder and run a shell command.
   - ✅ It still works; /phone is simply not mounted.

## 4ap. A slow command gets a handle instead of dying
1. Ask: "in the shell, sleep 45 then echo done, and tell me when it is done".
   - ✅ The shell call answers within ~30 s with "still running … job job_…"; the reply does not stop.
2. It should then call shell_job (poll or wait) and finally report exit code 0 and the word done.
   - ✅ No "timed out, the shell was restarted"; `echo still-here` afterwards works in the same shell (cd and variables kept).
3. Run `job run 'sleep 20; echo ok'` in the terminal, then `job out <id>` straight away: it prints RUNNING, then DONE exit=0 with ok.
4. Kill one: shell_job action kill, or Ctrl-free: run `job list` and `job kill <id>`.
5. Ask for a command the assistant sets timeout_s on (e.g. 5 s) with `sleep 30`: it must report TIMED OUT and restart the shell, as documented.

## 4aq. One toolkit, one home
1. In the terminal: `ls -l /usr/local/bin` → job, doctor, toolkit-pull and .toolkit are there.
2. `toolkit-pull` → every script says `ok` with its hash. Edit a copy by hand (`echo '# junk' >> /usr/local/bin/job`), run `toolkit-pull` → it says DRIFT.
3. Ask the assistant anything that runs a shell command: the repaired copy is restored from the app (the result mentions "toolkit installed" once).
4. `doctor` on a fresh install must say what is missing (ffmpeg/python3 MISSING) instead of the app finding out later.

## 4ar. Every result says which surface answered
1. Ask a question that uses run_python, then fetch_url, then the shell.
   - ✅ Each tool card's text ends with `[surface=… ok=… bytes=… ms=… proof=…]`.
2. Save something to the phone folder and open the card: the proof says `read-back` (the file was read back and matched), not just "ok".
3. Break a fetch (a URL that 404s): the card shows `ok=0` and the HTTP status, never a bare success.

## 4as. Enable an MCP server without a new chat
1. In Settings › Connections › MCP servers, add a server and switch it on (or switch an existing one on).
   - ✅ The row says "✓ N tools ready" straight away.
2. In the open chat, ask the assistant to use one of those tools (or call reload_tools).
   - ✅ The tool is available in the same chat, without starting a new one.

## 4at. Hooks (needs the built-in Linux)
1. Settings › Tools & agent › 🪝 Hooks › + Add: event "Before a tool runs", tools `shell`, command `echo "$TOOL_ARGS" | grep -q "rm -rf" && { echo "no rm -rf"; exit 2; } || true`. Ask the agent to run `rm -rf /tmp/x`: the card says "Blocked by your hook".
2. Add "After a tool ran", tools `write_file|edit_file|apply_patch`, command `echo "checked $TOOL_NAME"`: after a file write the card's result ends with `[hook "…"] checked write_file`.
3. Add "When the reply would end", command `test -f /workspace/DONE || { echo "create DONE first"; exit 2; }`: ask for something small. The agent comes back once, creates DONE, then finishes.
4. Add "When you send a message", command `date`: the next message's request carries "[Context from the user's hooks]" with the date (see the prompt inspector).

## 4au. apply_patch, repo_map, parallel reads
1. With tools on, ask: "create a small Python project with 3 files, then rename a function in all of them using one patch". Expect a 🩹 Patched files card with the diff.
2. Ask: "map this project". Expect 🗺 Mapped the code with the functions and line numbers.
3. Ask for three files to be read: they should appear as one folded step box, and it should be no slower than reading one file.

## 4av. Roleplay: timed lorebook entries, variables, regex, scene tracker
1. In a lorebook entry › advanced › Timing: sticky 3. Mention its keyword once. The entry stays in the prompt (inspector › World info) for the next 3 messages, without the keyword.
2. Set cooldown 5: after it fires, mentioning the keyword again within 5 messages does not bring it back. With delay 10, it is not used before the chat has 10 messages.
3. Put `{{setvar::mood::grumpy}}Mood: {{getvar::mood}}` in a prompt note: the prompt says "Mood: grumpy".
4. Settings › Roleplay prompts & preset › 🔁 Regex scripts: find `/\*/g`, replace with nothing, "Saved". The next reply has no asterisks. Change it to "Only shown": the asterisks are back in the inspector but not on screen.
5. Settings › Roleplay › Scene tracker on, then start a new roleplay. After the first reply, chat sheet › 📊 Scene tracker shows Time/Location/… Edit a line and send: the next request carries your edit.

## 4aw. Tool permissions
1. Settings › Tools & agent › 🔐 Permissions: Linux shell → Ask me. Ask the agent to run `ls`: a question sheet asks first. "Allow for this chat" → later shell calls in that chat do not ask; a new chat asks again.
2. Type "use Python instead" in the answer box: the agent is told that and does not retry the shell.
3. Web search → Never: the agent says it cannot search, and its card shows "not allowed".

## 4ax. /guide
1. In a roleplay, type `/guide she finally admits the truth` and send: no message of yours appears, and the next reply does it.
2. Type `/guide` alone: a hint explains how to use it.

## 4ay. Back button in the site browsers
1. Open Chub (and BotBooru, Character Archive) from the roleplay import, tap into a character, then a second page. Phone Back goes back one page each time; on the first page Back leaves the browser.
2. Works with gesture navigation (swipe from the edge) and with the 3-button bar.

## 4az. Deferred tools
1. With more than 12 saved/MCP tools, ask for something one of them does: the chat shows "🧰 Loaded tools" first, then the tool call.

## 4ba. Claude Code features
1. Settings › Chats › "Compact when the context reaches": pick 64K tokens. For the current model pick 32K. In a long chat, compaction starts after crossing 32K (a "Summarizing earlier messages" note).
2. `/compact keep every decision about the database`: the summary keeps them.
3. With tools on and files in the workspace, type `@` – files are listed – pick one, send: the inspector shows the file's text under your message.
4. Ask the agent to write `.chronicle/commands/test.md` containing `Run the tests for $ARGUMENTS`. Then type `/te`: "/test" is offered (📁). `/test the parser` sends "Run the tests for the parser".
5. Ask it to write `.chronicle/agents/reviewer.md` (front matter `name: reviewer`, `description: reviews diffs`, `tools: read`). Then ask "have the reviewer check app.py": its card shows "reviewer is working…".
6. `# always use tabs`: nothing is sent, a toast says it went into AGENTS.md, and the next request carries it.
7. Tap the mode chip (⚡ Auto): choose 🛡 Ask first. The next file write asks first. Choose 📋 Plan: plan mode turns on.
8. Chat sheet › Reply style › Learning: the agent leaves TODO(human) parts.
9. On an earlier message of yours: ⋯ › ⏪ Rewind › Files only / Conversation only / both. Files go back, or later messages go, and your message is back in the box.

## 4bb. Persona toolset
1. Edit a roleplay character › 🛠 Tools › Roleplay (web only), Save. In its chat with tools on, the context sheet's "Tool instructions & definitions" drops from ~18K to a few K.
2. "Tools off" on a persona: its new chats start with 🛠 Off.
3. Coding preset on Coder: shell, Python and previews are there; creator and phone folder are not.

## 4bc. Editing what exists
1. Ask the Persona Maker: "make Lia 3 years older and add a greeting where she is reading". The approval says "Change the character “Lia”: description (1 edit), +1 greeting", and the rest of her card is unchanged (compare in the editor).
2. "Add an entry about the old library to Lia's lorebook and remove the one about the river": the approval lists both, and the other entries stay.
3. "Turn tools off for Lia": approval says "tools off".
4. With tools on: "rename notes.txt to docs/notes.md, then delete the tmp folder": 📁 Moved and 🗑 Deleted cards, and the files page shows it.

## 4bd. Managing saved things
1. "What do you remember about me?" → 🧠 Memory list. "Forget that I live in X" removes it; "Remember I prefer metric units" adds it (Settings › Memory shows both).
2. "List my saved tools", "turn off tool X", "delete tool Y".
3. "Turn off the Hello mod", then "remove it": the second one asks first.
4. "Show me the World lorebook" → its entries; "delete the old lorebook" asks with a Delete it button.
5. "Delete the character Old" asks; asking to delete the Persona Maker is refused (built in).

## 4be. Quick wins
1. Ask something long, switch to another app. When "reply ready" comes, type in its reply box: the message appears in the chat and a new reply starts.
2. With Ask first on, ask the agent to write a file and leave the app: a ❓ notification has Allow once / Allow for this chat / Deny. Tap Allow: the reply continues.
3. When a Go limit is hit: under the error "Tries again at 3:40 PM… Cancel". Keep the app open past that time: the reply is tried again.
4. On a reply ⋯ › ✏️ Correct it with an instruction › "make it shorter": a diff (green/red), Keep replaces the reply.
5. `/polish i sa teh cat` → "I saw the cat" in the box; `/unpolish` puts it back. Type half a message, swipe the app away, open it: the text is still in the box.
6. Roleplay: a "Continue" button above the box. Settings › Roleplay › Offer choices: replies end with 2–4 buttons; tapping one sends it.
7. Settings › Voice › Skip *actions*: Read aloud skips the asterisk parts.
8. Settings › Data › 📊 Usage history › History: "Where it went" lists Replies, Tool: web_search, MCP: …, Chat titles.
9. Memory list: a memory older than six months shows "⏳ Old – is this still true?".
10. With browser control on: "upload /workspace/cv.pdf on <a page with a file field>" – the page receives the file. During a handoff, tapping the page's file button opens the phone's picker.
11. "Set a 10 minute timer for pasta" → asks "Start a 10 min timer (“Pasta”)?" → the Clock app opens with it. Also try "text Mom I'm late" (Messages opens with the text, not sent), "add dentist Friday 3pm to my calendar", "open wifi settings".

## 4bf. Background wake-ups and proactive messages
1. Ask the agent to "remind me in 3 minutes to stretch", lock the phone. After ~3 min (later without exact alarms) the reminder reply arrives and notifies.
2. Swipe the app away from recents and repeat: a "⏰ … Scheduled" notification appears; tapping it opens the chat and the task runs.
3. Settings › Notifications & background › Characters can message me first; set quiet hours. In a roleplay: chat sheet › Can write first › After 2 hours. Leave it: a "💬 Wrote first" message arrives with a notification, only once until you answer, never in quiet hours.
4. On Android 14, "Allow exact timing" opens Alarms & reminders; after allowing, the hint goes away.
5. Restart the phone with a task scheduled: it still fires.

## 4bg. Voice mode
1. Hold the mic button: the microphone permission is asked once, then a full-screen circle. Say something: the words appear as you talk, then it is sent.
2. The reply starts being read before it has finished writing. Tap the circle mid-sentence: it stops and listens.
3. Stay silent twice: "Paused – tap to talk". Say "stop": voice mode ends.
4. Deny the permission: each turn uses Android's listening screen instead.
5. In a roleplay with a character voice and "read only the dialogue": only the quoted parts, in that voice.

## 4bh. MCP sign-in
1. Add an MCP server that uses OAuth (e.g. a hosted one like Linear's or Notion's MCP URL). Test: "needs you to sign in". Sign in: the sign-in page opens in a Chrome tab; after approving, you are back in the app and its tools are listed.
2. Use one of its tools in a chat. After an hour (token expiry) it still works (refreshed).
3. Sign out: Test asks to sign in again.

## 4bi. stdio MCP servers
1. With the Linux terminal installed: MCP servers › add `npx -y @modelcontextprotocol/server-everything`. The first test installs Node (a minute or two), then lists its tools.
2. `uvx mcp-server-time`: uv is installed, the time tools are listed; ask "what time is it in Tokyo?".
3. Swipe the app away, open it, use a tool of that server: the bridge starts again by itself.
4. A wrong command (`npx -y @nope/does-not-exist`): Test shows "did not start" with the last lines of its log.

## 4bj. Search by meaning and recall
1. Turn on 🧠 Smart memory and wait for the model. Leave the app open a few minutes, then search the drawer for a word you never typed but a chat is about (e.g. "holiday" for a trip chat): it shows under "≈ About this, in other words".
2. With tools on: "find the chat where we talked about my vacation" – 🗂 Searched your chats lists it, marked "(about it, in other words)" if the word itself never appears.
3. A long roleplay (past the context window, or after /compact): mention something from early on. The inspector's system prompt shows "[Recalled from earlier in this story …]" with that moment, on the reply after.

## 4bk. Recipes
1. Settings › Shortcuts & recipes › 🧪 Recipes › + New recipe: keep the template, change the name, Save. Type `/` – it is listed with 🧪.
2. `/my-recipe topic="phones"`: two messages are sent, the second after the first reply, each tagged 🧪.
3. Without the required parameter: a toast says what is missing and nothing is sent.
4. Uncomment the schedule line, Save, Schedule: the chat's ⏰ list shows it; at that time it runs (also with the app in the background).
5. Import a recipe from a GitHub link: the editor shows it first; one with an invisible character shows the warning and ⟦U+200B⟧.

## 4bl. Git history
1. New chat, 📁 Chat files › 🌿 Git history › Clone `https://github.com/octocat/Hello-World` – the README appears, history shows its commits.
2. Ask the agent to change the README: a new commit named after your message appears.
3. Restore the commit before: the README is back, and a "Restore …" commit is on top.
4. With a token that can write to a repo of yours: set it as the address, Push – the commits appear on GitHub. Change a file on GitHub, Pull – it comes in.

## 4bm. Packs and the MCP registry
1. Settings › Shortcuts & recipes › 📦 Packs › Make a pack: a .chronicle-pack.json is shared. On a second phone (or after removing your recipes), "From a file…" shows everything in it, then Install adds it; Remove takes it all away.
2. MCP servers › 🔎 Find a server › "time": results show the publisher and 🌐 remote / 🐧 npm. Add a remote one: the confirmation shows its address, then it is tested. Add an npm one (with Linux): the command is shown first.

## 4bn. Automation (Tasker)
1. Settings › Connections › 🤖 Automation › + Give an app access › Tasker. Copy link.
2. Tasker task: Send Intent – Action android.intent.action.VIEW, Data `chronicle://run?token=<token>&prompt=Give%20me%20a%20haiku&id=t1`, Target Activity. A profile with Event › Intent Received › Action `dev.chronicle.app.RESULT` gets `%text`.
3. With a wrong token: a toast, nothing runs, no broadcast.

## 4bo. Full terminal *[superseded by 4br/4bt: Connections › Linux terminal opens the full terminal; `script` comes from util-linux (decision 116)]*
1. Settings › Linux terminal › 🖥 Full terminal: a prompt appears. `vi /tmp/x` opens vi full screen; type `i`, text, Esc (from the row), `:wq`.
2. `apk add htop && htop`: it draws and updates; rotate the phone – it redraws at the new size. Ctrl (row) then c quits.
3. If nothing appears, or the size is wrong: note it – busybox `script` under proot is unverified (decision 89).

## 4bp. PC agents (ACP)
1. On a PC on the same Wi-Fi: `python3 acp-bridge.py -- npx -y @agentclientprotocol/claude-agent-acp` (Claude Code's adapter, command `claude-agent-acp`; the old `@zed-industries/claude-code-acp` still runs) (or `gemini --experimental-acp`). Add the printed address and secret in Settings › Connections › 🖥 PC agents › + Add, then New chat.
2. "List the files here": the answer streams in; tool calls show as 🔧 lines.
3. Ask it to edit a file: the approval sheet asks first (and a notification when the app is in the background); Reject → it does not edit.
4. Stop during a long answer: the PC agent stops.

## 4bq. This round
1. Import the Mary card (two `chara` chunks): the greeting is the pool scene, with 7 greetings to swipe. For the one already imported: character page › Update / Re-import anyway.
2. Roleplay a while: no reply ends with a lone `*` or `"`.
3. When "📜 story updated" or "🧠 remembered" appears under a reply, the chat stays where it was.
4. Delete one of your own messages mid-chat: "This and the N after it" / "Only this message".
5. Retry a reply, then chat sheet › 🗺 Story map: "the reply was retried · 2 versions"; tapping the other one switches to it.
6. Settings › Voice › Better voices: pick an engine (e.g. a cloning app) and voice, Test.
7. With tools on: "research the best budget phones this year" → 🔬 Researched, a report with [n] sources, saved under research/.
8. Ask the agent "which models can you give a helper?" – it lists them.
9. Usage: in a long roleplay at the context limit, the Console's cached-token share should go up compared with before.

## 4br. Terminal, !commands, drafts, job chips
1. Settings › Connections › Linux terminal: a full-screen terminal with two rows of keys like Termux. Type `ls`, use ↑ for history, CTRL then c, PGUP. If it says it could not start: ☰ Command box, and tell me.
2. In a chat: `!uname -a` – the output appears as a reply at once, no model involved; then ask "what did that print?" – the assistant knows.
3. Type half a message in chat A, open chat B, type something else, go back to A: each has its own text. Scroll up in a long chat, leave, come back: same place.
4. Ask the agent to run `sleep 300` in the shell: after 30 s a chip "sleep 300 · 0m 31s ✕" sits above the box; ✕ stops it.
5. After a few replies that changed files: 📁 Chat files › 📝 What this chat changed.
6. Watch the agent's browser while it works (open pages, screenshots): the page stays visible; Close and Back both close it without stopping the agent.

## 4bs. Download with the browser's sign-in
1. Ask the assistant to open github.com and hand over; sign in. Then ask: "show me the changelog of my private repo <owner>/<repo>".
2. Expected: one `browser download` call (the file's /raw/ address or the branch zip), the file appears in Chat files › downloads, and the reply quotes it. No curl/git attempts, no in-page scripts.
3. Ask for the whole repo: expect one zip download and an `unzip` in the shell.
4. A wrong branch name: the result says HTTP 404 and that the sign-in was sent.
5. Click a link that the server sends as an attachment: the note says it was saved.

## 4bt. Crop, dates, terminal set-up
1. preview_page on a page with a header and a full-screen `position:fixed` stage: the picture is the whole screen, no "shorter than the screen" note. A genuinely short page still gets cut.
2. `browser` open a short page, screenshot: cut where the content ends, with the note; `full_page:true` on a long page is not cut.
3. Shell: `touch -d '2026-01-05T09:30:00Z' /workspace/tfiles/old.txt`, then `browser upload` it into a page that prints `lastModified`: it starts 2026-01-05.
4. Settings › Connections › Linux terminal, online: "Setting up the terminal…" once, then a prompt; typing, arrows, CTRL+C, `vi` work. Second open: no set-up line. Offline first open: says the install failed and why.

## 4bu. Crop and scroll follow-ups
1. `browser` → short page → `screenshot full_page:true`: cut to the content, with the note.
2. preview_page on a short page with a 60 px fixed cookie bar: cut (near 700 px at 3× density); a page with a full-screen fixed stage: not cut.
3. Shell `touch -d '2025-03-01' /workspace/tfiles/old.txt` (a date it has not had before), then upload: lastModified is 2025-03-01. In Python, `os.path.getmtime('tfiles/old.txt')` gives the same date.
4. Ask an agent something with several tool steps and a long answer. While it writes, scroll up into the answer and keep flicking slowly. When it finishes the text you are reading stays where it is, and the fling is not stopped.

## 4bv. Line icons
1. Drawer, settings, chips under the box, a tool card, the message menu: line icons, no colour emoji. Light and dark theme both readable.
2. Message menu: "Fork from here" shows a fork icon; Chat files › Git history shows a branch icon.
3. A persona with an emoji avatar keeps its emoji; an emoji in a message keeps its emoji.
4. Scroll a long chat while a reply streams: no stutter compared to before.
5. Appearance › Icons › Colourful, Material, Duotone (pick an accent colour first: the second tone takes it): drawer, settings and chips switch at once; restart the app – still colourful. Emoji: the phone's own emoji. Back to Line.
6. A forked chat in the drawer: fork icon (Line) / crossing arrows (Colourful), not a leaf.

## 4bw. Watching, vh pages, broken writes
1. Ask for a few browser steps (open a site, scroll, click), tap the browser button and watch: the page stays visible while the assistant works, and Close works every time. Back closes it too.
2. preview_page full_page on a page with a 100vh hero and content below: the picture ends with the content below; if the note says the window was stretched, it also says how many vh elements were held (normally it says the page was drawn as one whole document).
3. write_file with `def broken(:` in a .py: the step shows as failed, "Wrote, but it does not parse", the file is there.
4. preview_page desktop: the saved screenshot is 2560 px wide, not 4160.

## 4bx. GitHub in the shell
1. Settings › Connections › GitHub › OAuth app: paste the client ID. Sign in with GitHub: a code appears (and is copied), GitHub's device page opens in the assistant's browser already signed in; enter the code, approve, Done. The section says "Connected as @you", name and email are filled.
2. 🧪 Test: "GitHub knows the token" and "git in the shell reached <your latest repo>".
3. In a chat: "clone <a private repo>, change the README, commit and push". It works without asking for a password; the commit has your name; nothing in the output shows the token (try `cat ~/.config/chronicle/gh-token` – it prints [GitHub token]).
4. Sign out: the next shell command in any chat reports "GitHub: signed out"; git push asks for credentials again.
5. Paste a fine-grained token instead: same results, limited to the repos it was given.

## 4by. Full-page pictures by scrolling *[superseded by 4bz: scroll-and-join was removed (decision 133); only step 4 still applies]*
1. preview_page full_page on the tester's jshero.html (hero sized from innerHeight in a resize handler, red footer): the picture ends with the red footer; the result says it was joined from N screens.
2. A page with a sticky header: the header is at the top of the picture only.
3. A short page full_page: one screen, cut to the content.
4. Tap the screenshot chip under a preview: the picture opens.

## 4bz. Full-page pictures (round 3 of the device review)
1. ruler.html full_page: the bands/ticks read down the page once, in order. The note says "drawn as one whole document" or "taken with the window stretched … held" – never "joined".
2. jshero.html and vh2.html full_page: end with the footer / the #111 block.
3. hashscroll.html (scrolls itself to 1500), browser screenshot: shows tick 1500 at the top, or the result says it could only draw from the top.
4. short.html full_page: cut to about 216 px, not 800.

## 4ca. Wide pages, saving files
1. m900.html full_page on mobile: the picture ends with the dark block (1400 CSS tall); the note says the page is 900 wide and only the left 390 is shown.
2. short.html (no viewport meta) full_page: cut to its content.
3. Open a file from Chat files: ⬇ Download → toast "Saved to Download/Chronicle/<name>", the Files app shows it there. Again → "<name> (1)". 💾 Save as… → Android's save screen; pick a folder; the file is there.
4. Workspace manager: select 3 files → ⬇ Download saves one zip.
5. sb1.html (1400 wide, black) full_page on desktop: no grey line at CSS 796–800. heights2/s200.html: 600 CSS tall, not 616.

## 4cb. Odysseus batch
1. A custom endpoint with a small model (e.g. 8K): a long chat → the reply says "too long … sending it again without the oldest messages" and answers; the next message answers straight away.
2. A chat with 4 photos sent over 4 messages: the prompt inspector shows the first two as "[Image … not sent again]".
3. OpenRouter as a provider: a vision model shows the picture badge, a text model does not, with the provider's Vision switch either way.
4. deep_research on a product question: the sources list shows (official)/(community)…; with only forum sources the report says so near the top.
5. "Check the price of <page> every hour and tell me only if it drops": the task shows "quiet" in ⏰ Scheduled; runs with no change leave nothing in the chat and no notification; Run now works.

## 4cc. Review round
1. Settings › Tools & agent › Permissions: shell = Never. Ask for a run_script that calls shell: the script's result says "You may not use shell".
2. Long chat, Stop during "Summarizing earlier messages…": no summary is kept, no reply appears in another chat.
3. Two chats running Python at once: the second shows "waiting for Python (busy in another chat)…" and both finish.
4. Backup without keys: the zip's settings have no githubToken, no provider apiKey, no MCP token.
5. With GitHub signed in, in the shell: `touch x; ls -l x` shows -rw-r--r-- (not -rw-------).
6. Browser handoff to a slow sign-in for 12 minutes: the page stays open.
7. Share a file from another app: it arrives; Android's "share" of an app-internal file path is refused.

## 4cd. Open items and phone data (decision 140)
1. Self-test: without the key, `adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1` logs "no key" and runs nothing. `adb shell touch /sdcard/Android/data/dev.chronicle.app/files/selftest.key`, run it again: it runs.
2. Ask the assistant to download a big file (over 4 MB, e.g. a release zip) with `browser` download: it arrives whole in the workspace; no out-of-memory.
3. Open five different pages in five chats with the browser: the first one's next action reopens its page (it was closed to stay at four).
4. Start a reply, switch to another app, and in it ask (by a scheduled task) for android_intent open_url: a notification "Tap to open it" appears instead of nothing; the tool result says so.
5. Schedule a task 2 minutes ahead, swipe the app away: the notification arrives at the time. With the app open: the task runs and no notification is posted.
6. Fresh install on Android 13+: switch "Notify me when a reply finishes" off and on: Android's prompt appears. Refuse twice, switch it on again: the app's notification settings open.
7. Chub browser: download a card PNG and a JSON: both import as before.
8. Settings › Notifications & background: "Run without battery limits" opens Android's question; after Allow the hint is gone.
9. A reply that runs over 6 hours on Android 15 (or: `adb shell dumpsys activity services dev.chronicle.app` shows `types=0x40000000` specialUse on Android 14+).
10. Linux terminal sheet: "Let it see all phone storage" → switch it on, come back: `ls /sdcard/Download` in the shell lists the phone's Download folder.
11. "What's on my calendar tomorrow?": the chat asks "Let the assistant read your calendar", then Android asks; the answer lists tomorrow's events with times. "Add dentist Friday 3pm": a confirmation with the time, then the event is in the calendar app with the reminder if asked.
12. "Phone number of <a contact>": asks once, answers. "Weather here?": asks to share the approximate location; the coordinates in the tool card are rounded (2 decimals).
13. android_intent list_apps with all: keyboards and services appear too.

## 4ce. Big workspaces, screenshot names, body crop (decision 141)
1. In a chat's shell: `cd /workspace && git clone <a repo with a package.json> om && cd om && npm ci`. Then write_file `output/probe.txt` and run `ls /workspace/output` in the shell: the probe is listed, list_files shows it, and no result says "deleted on both sides". The result says node_modules/.git are not mirrored.
2. Same chat: `rm -rf /workspace/om`: nothing "comes back" in list_files that was not already there.
3. Two browser screenshots, then delete the first file, then a third screenshot: three different names (-1, -2, -3), never -1 twice.
4. A page with `body{height:3000px}` and one `<p>`: browser screenshot full_page is the whole 3000 px, not 97 px.
5. A page with text straight in `<body>` (no wrapping element) after a short div: the picture includes all the text.

## 4cf. Roleplay presets (decision 142)
1. Settings › Roleplay presets: ＋ New preset… › Starter: Vivid prose, name it. Pick a model and (if it has one) an effort; tick Default. Back in a roleplay chat, the model button reads "<model> · Vivid prose"; the prompt inspector shows the Vivid post-history line and temperature 1.
2. Switch the page back to Standard: its own prompts are unchanged.
3. In the chat's menu › Chat settings › Roleplay preset: Standard. The model button shows the selected model again; the next reply uses it.
4. In a preset chat, pick another model from the model button: a toast says it is for this chat; other chats with the preset keep its model.
5. Export a preset, delete it, import the file: it comes back the same. Import a SillyTavern preset .json: its main prompt, jailbreak and samplers fill in.

## 4cg. Watching the assistant's browser (decision 143)
1. Ask the assistant to open a site with a cookie banner and keep taking screenshots. Watch it (the browser card's 👁): scroll the page, tap the banner's Accept – it answers at once. Close works at once.
2. After you used the page while watching, the assistant's next browser result starts with "The user had this page on screen and used it".
3. While you hold a finger on the page, the assistant's click waits (its tool card shows it still running) and goes through when you let go.
4. After closing the watch screen, a full-page screenshot still comes out whole (the page went back to its capture drawing).


## 4ch. Places, the map, phone status and controls (decision 144)
1. "Nearest pharmacy that is open?" in a new chat: the chat asks "Find places near you?" (mentions about 100 m and OpenStreetMap), then Android asks for location. The answer has a map with numbered pins, a blue dot where you are, "© OpenStreetMap contributors" bottom right, and a list with distances; the tool card says how many and the first names.
2. Drag the map with one finger (the chat does not scroll while you do), tap + − ◎; tap a pin: its row is highlighted; tap a row's number: the map centres on it.
3. Directions opens Google Maps navigation (without Google Maps: the map app at that point); Map opens any map app; Call opens the dialer with the number, not calling; Website opens the browser.
4. Close the app, open the chat again: the map is there. Airplane mode, open it again: the same tiles show, "Offline – showing saved map tiles" only where tiles are missing; pan somewhere new: a plain grid, pins still right.
5. Same question after allowing only "Approximate" in Android's location dialog: the result says distances are rough. "Cafes near Alexanderplatz, Berlin": no location question at all.
6. Ask for the same thing twice within ten minutes: the second answer comes at once (no new request). Settings › Tools › Maps & places: a wrong tiles address (no {z}) is not taken; "Clear saved map tiles" works.
7. Light and dark theme: the grid and the list follow; with another icon pack the pin numbers and list stay as they are.
8. "How is my phone doing?": phone_status without any question – battery %, charging, temperature, storage, network type, volumes, next alarm match the phone. Check on Android 10 (no heat line is fine) and 14+.
9. "Which Wi-Fi am I on?": the chat asks about Wi-Fi names, then Android asks for precise location (if only approximate was given, Android offers the upgrade). Name, signal, band, IP are right. With Location switched off: it says Location is off. With precise refused twice: it says where to allow it.
10. "Which networks are around?" five times within two minutes: the fifth says Android limited scanning and how old the list is. No BSSIDs anywhere.
11. "Flashlight on" / "off"; with the camera app open in split screen: it says the camera is in use. "Media volume to 30 %": the volume panel shows; "ring volume to 0" with Do Not Disturb on: a plain refusal, no crash. With music playing: "pause", "next" work and the result says whether something is playing.
12. "Copy 'hello' to my clipboard", paste elsewhere. "What is on my clipboard?": asked every time; Android 12+ shows its own "pasted from" toast. From a scheduled task with the app in the background: refused with "only while Chronicle is open".
13. "What plant is this?" → take_photo: "Take a photo for the assistant?", the camera app opens, take it: the picture shows in the card, is in the chat's files under photos/, and the model describes it. Back out of the camera: "closed the camera without taking a photo". Try a second camera app (Samsung/OEM and one from a store). With a non-vision model: a description by the vision model.
14. take_photo, then while the camera is open force the app out of memory (developer option "Don't keep activities"): no crash on return; the reply can be retried.
15. Write a PDF or CSV in a chat, "share that file": the share sheet opens with the file, send it to a mail app and a messenger – it arrives whole. "Open it in another app": a viewer opens. A 30 MB file works. With the app in the background: a notification to tap.
16. Plan mode: "turn on the flashlight" is held back until the plan is approved; phone_status still answers.

## 4ci. Round 6 fixes (decision 145)
1. Linked phone folder in Review mode: `echo x > /phone/t.txt` in the shell does not appear on the phone until accepted; in Auto it appears at once.
2. Calendar add with a second calendar's id lands in that calendar. Restore an auto-backup over 25 MB.
3. Ask for calendar and contacts in one message on a fresh install: two prompts in turn, both tools answer.
4. Schedule a task 2 minutes ahead, press Home: the run starts or a notification appears within about 10 s of the time.
5. Desktop-view page, Watch, ask for a screenshot: the picture is the page as shown, no black area; scrolling stays smooth while the assistant screenshots; Close answers on the first tap.
6. A news site with a cookie wall: the browser result starts with "On top of the page: …" and the Accept button is in the list.
7. A page that calls alert() while loading: the browser tool answers instead of hanging.
8. In the shell: `mkdir /workspace/workspace && echo x > /workspace/workspace/README.md` with a README.md at the top: the top-level file is untouched.
9. Delete another chat, then send in the open chat, switch away and back: the new messages are there.
10. Switch Web search off, ask something that needs it: the tool card says "switched off".


## 4ck. Compaction styles, stubs, the to-do list (decision 147)
1. Settings › Chats › Compaction style: "Structured (no model call)". In an agent chat with a few file writes and a shell command, type `/compact`: it is instant, the divider says "folded into a structured record", and the usage sheet shows no compaction request. Tap the divider: your messages are there word for word, with the files and commands.
2. Same with flight mode on: `/compact` still works.
3. After that, ask "what exactly did I write in my second message?" – the assistant answers from the record, or calls read_chat "this" and quotes it.
4. "Structured + short summary": `/compact` shows the short summary on top of the record; with flight mode on it stores the record alone and says so.
5. A long agent task with a to-do list (over 12 tool rounds): the inspector (Next request) shows "[Reminder – where the work stands …]" after round 12; after an auto-compact the list is in the system prompt.
6. A roleplay with the Structured style: it keeps sliding and never shows a structured record; `/compact` there still writes a model summary.
7. A long agent chat that reads the same file several times: in the inspector the older reads show "[Result left out: …]", and the start of the request stays the same over two replies in a row (the cache counter in the stats stays high).
## 4cn. Sensitive phone access (decision 150)
1. Settings › Tools › 🔒 Sensitive phone access: all three switches are off on a fresh install; each says what is read and that it goes to the AI provider. With all off, no `notifications` / `messages` tool reaches the model and schedule_task has no `when`.
2. Notifications on → "Turn on notification access…" opens Android's page with Chronicle. Android 13, 14, 15, 16 with the app installed from a file: the switch is greyed out ("Restricted setting"); App info › ⋮ › Allow restricted settings, then it can be switched on. Android 10–12: no restricted step. Back in the app the sheet says "on".
3. After a few notifications arrive, Refresh: the apps are listed, none ticked; WhatsApp/Telegram/Signal marked "messages"; a bank, Google Authenticator, Bitwarden are greyed out "blocked".
4. Tick one app. "What did I miss?": asked once per chat with the app names; only that app's notifications come back; a "Your code is 123456" SMS-style notification shows `[code hidden]`. Switch "Show one-time codes" on: the digits show. Android 15+: an OTP notification may already arrive redacted by Android – also fine.
5. "Dismiss the promo one": asked every time, it disappears from the shade; an ongoing (music) one says it cannot be dismissed. "Open it": asked, the other app opens on its screen (Android 13, 14, 16 – check 14+ especially, where opening another app's notification needs the background-start option). From a scheduled task: refused, no question.
6. Switch Notifications off in the app with Android access still on: nothing is listed or triggered; the sheet still offers Android's page to revoke access.
7. Texts on. "Did the courier text me?": the question shows "from “DHL”" (or the words), Android asks for SMS permission once (on screen only); the second search asks again in the chat. A verification SMS shows `[code hidden]`. Android 15 sideloaded: the SMS permission may need "Allow restricted settings" first – note what the phone did. "Who called this morning?": asked, list with names from contacts. A quiet scheduled task that tries it: refused, no question, the Scheduled history says so.
8. Notification trigger: "When DHL sends a notification about my parcel, tell me where to pick it up" → the confirmation sheet; ⏰ Scheduled shows "🔔 notification · DHL containing …". Send a matching notification (another phone / a test app): with Chronicle open the quiet run starts within seconds; with it in the background the run starts or "⚡ DHL – open Chronicle to run its task" appears (no notification text on the lock screen); after a force-stop: nothing until the app is opened (Android stops listeners of force-stopped apps – note it). Seven matching notifications in an hour: the seventh is skipped ("already ran 6 times").
9. Place trigger: "When I get home, remind me to water the plants" (the model gets lat/lon from places or location). Settings shows "Location in the background: not allowed" and the button: Android 10 – a dialog with "Allow all the time"; Android 11–16 – the app's location settings page, choose the option named on the button. Back in the app: "allowed".
10. Leave the place (> radius), come back: the quiet task runs (or the notification appears), possibly a few minutes late; standing at home when the trigger is set does NOT fire it. "leave" triggers likewise. Reboot the phone, open nothing: leaving/arriving still fires (re-armed at boot); update the app: still fires.
11. Battery: with one place trigger set for a day, Settings › Battery › Chronicle – note the usage; Android 10+ shows its own "used your location in the background" reminder once – expected.
12. Plan mode: notifications dismiss/open held back until approved; list, texts and calls still ask and answer. A helper agent ("delegate: check my notifications") has neither tool.
## 4cm. Round 6 leftovers (decision 149)
1. Browser download of a file over 4 MB (e.g. a large PDF or zip with action download): it lands in /workspace/downloads; then `run-as dev.chronicle.app ls cache/bridge` (or Settings › Apps › Storage › cache size) shows no file left behind for it. Same after reading a phone-folder file over 4 MB.
2. Hide a calendar in the phone's calendar app (e.g. a holidays or a shared one), ask "what is on my calendar this week?": its events are not listed; show it again: they are.
3. Open the Chub browser (Characters › Browse Chub), and while it is open let a running reply call android_intent (e.g. a scheduled "open the alarm app"): the other app opens at once instead of a "Tap to open it" notification. With the app in the background: still the notification.
4. Restore a backup that holds a chat with a shell script (chmod +x before the backup): after the restore `ls -l /workspace` shows it executable with its old date; files deleted before the backup do not come back after the first command.
## 4cj. Done check, shell guard, /btw, advisor (decision 146)
1. Agent chat with Linux on: "write hello.py that prints hi" and nothing else. If the model ends without running it, the reply shows "🔎 Files were changed but nothing was run…" once and then either runs `python3 hello.py` or says it is unchecked. Ask again "and run it": no 🔎 line (it ran).
2. Settings › Tools & agent › Check work before finishing off: the same request ends without the 🔎 line. In a roleplay chat with tools: never.
3. With a stop hook set (Settings › Tools › Hooks): no 🔎 line after a turn that wrote files (the hook was the check).
4. ⚡ Auto mode, linked phone folder: "delete everything in /phone/test with rm -rf": the question "Run this shell command? It deletes files on your phone…" appears with Run it / Not now. Not now: nothing deleted, the assistant does not try another way. Run it: deleted. "rm -rf node_modules" in /workspace: no question.
5. `git push --force` in a cloned repo: asked. A scheduled task (app in the background) that runs `rm -rf ~/x`: refused with a reason, no question; the chat's result says so.
6. Settings › Tools & agent › Ask before a dangerous shell command off: rm -rf /phone/test runs at once (still asks in 🛡 Ask first as before).
7. While a long reply runs, type `/btw what are you doing?` and send: a bubble above the message box answers within a few seconds, the reply carries on, nothing is queued. × closes the bubble. The next reply does not mention the question. Usage sheet: "Side questions (/btw)".
8. Settings › Tools & agent › Advisor model: pick a stronger model. Give the agent a task where a command keeps failing: it calls advisor (🎓 card) and the answer names the model. In 📋 plan mode it may still call it. Set back to None: the tool is gone from the next request.
## 4cl. UI round (decision 148)
1. Settings › Appearance › Text size XL on the smallest phone at hand: Settings, the drawer, the chat sheet, the persona editor, the preset page and the composer all grow; nothing runs off the right edge; the drawer's Personas / Memory / Settings wrap rather than overflow; S makes everything smaller. Android's own font size (Settings › Display) still applies on top.
2. Message actions, ‹ › on a reply with two versions, and the chips under the message box: each is easy to hit with a thumb, the row of icons looks as before.
3. Settings search: "battery", "calendar", "wifi", "github", "backup", "key", "text size" each list the right rows; tap one: the page opens at that row and it flashes. Back returns to the results. With "Remove animations" on (Accessibility), the row gets an outline instead of the flash, and sheets open without sliding.
4. A roleplay chat: the 🎛 chip by the message box names its preset; pick another – the model chip and the next reply follow; Edit presets… opens the page. A normal chat shows no 🎛 chip.
5. Roleplay presets: New / Duplicate / Rename ask in the app's sheet (keyboard opens, Enter saves, Back cancels); Delete asks with a red Delete. Packs › Make a pack, Automation › Add, a recipe with parameters, Git › Commit: the same sheet, no grey system box.
6. Light theme: greyed hints and stats are readable in daylight; roleplay *actions* and "dialogue" are dark grey and brown, not pale. Pick your own dialogue colour, switch themes: your colour stays. Reset: the theme's colours again.
7. The 🛠 chip shows "N tools" or "Tools off"; a tap opens the menu (switch, list, Tool settings…) and changes nothing by itself.
8. TalkBack: the selects and text boxes in Settings, the chat sheet and the persona editor read their label.

## 4co. GitHub App sign-in (decision 151)
1. Create a GitHub App as Settings › Connections › GitHub › "Use a GitHub App" says, install it on the organisation with only the org repo selected, paste its Client ID, Sign in with GitHub. The card says "GitHub App sign-in", "renews itself" and lists the org repo.
2. In a chat with the shell: `git clone https://github.com/<org>/<repo>` works; a repo NOT in the installation is refused, and the result says the app is not installed there.
3. Leave the app 8+ hours (or set the phone clock forward), run a git command: it still works (renewed); the card shows a new renewal time.
4. Ask the assistant to "set up an SSH key for GitHub": it refuses to make one and points to Settings; running `ssh-keygen` in a shell command asks you first.
5. Backup without keys: the zip's settings have no githubToken and no githubRefresh.

## 4cp. Field report leftovers (decision 152)
1. In the shell: `cd /root && git clone https://github.com/<a small repo>`; the result says it is shell-only and gives the shallow-clone hint; list_files afterwards names /root/<repo>.
2. Ask the assistant to look at a 16×16 PNG in that repo by its /root path: it sees it enlarged with hard pixel edges on a checkerboard, in one step.
3. `true` in the shell (or a job that prints nothing): the result says it succeeded.

## 4cq. SSH key (decision 153)
1. Settings › Connections › GitHub › SSH key › Make a key: the card shows a SHA256 fingerprint; Add it on GitHub copies the public key and opens the new-key page.
2. List `acme-studio/demogame`, switch on for 1 hour. In a chat: `git clone git@github.com:acme-studio/demogame.git` works; `git clone git@github.com:your-user/<another repo>.git` asks for a password / fails (the key is not used for it).
3. `git push` asks first. `cat ~/.config/chronicle/ssh/id_ed25519` asks first.
4. Wait for the hour (or switch Off): the next shell command takes the key out (`ls ~/.config/chronicle/ssh` – gone).
5. Delete key: gone from the card, taken out of the shell, GitHub's keys page opens to delete it there.

## 4cr. Memory picked by the question (decision 154)
1. Settings › Memory: "Learn about me" shows "Every 3 messages"; "Recall my past messages from other chats" is off.
2. New assistant chat, three ordinary messages about yourself: the "remembered" note appears only under the third reply. Close the app after two, reopen, send the third: it still learns (from all three).
3. "Remember that I keep bees": the note appears under that reply at once. Its Undo forgets it; the next reply does not learn it again.
4. Smart memory on, cross-chat recall on: in an older chat with the same assistant say something specific ("my tomato leaves get brown spots"). In a new chat ask about tomato leaves, then ask a follow-up: the Prompt inspector shows, after the history, a system message quoting your earlier words with that chat's title and date. Mark the older chat incognito: it is no longer quoted.
5. A long roleplay with a lorebook (or a scene sheet) once older messages have left the window: mention a lorebook name that came up early; the next request's "[Recalled from earlier in this story …]" quotes that early moment (also with Smart memory off).
6. A roleplay whose story memory is longer than 2,500 characters: the Prompt inspector shows its first and last points in the system prompt and "[Story memory – more of what happened, picked for this moment]" after the history, with points that fit the last messages. The story memory editor still shows (and saves) the whole text.

## 4cs. Files: file manager and Linux files (decision 156)
1. Menu › Workspace files: places at the top (Chats' workspaces, Linux files, and the chat's phone folder when linked); chats as folders in a grid with file count and size; the storage line (chats · files · size) under the path bar. Toggle list view, close and reopen the app: still list. Long-press a file: selecting starts with it; Download / Share / Delete work as before.
2. With a repo cloned into /root (e.g. demogame, 5,000+ files): Linux files › demogame opens in about a second; .git shows a size and asks before opening; a folder with more than 500 entries says how many more. Start a long command in a chat (`sleep 120`) and browse at the same time: it still answers.
3. Open README.md (text), a PNG (picture) and a binary (size/type only). Download it (Download/Chronicle) and Save as…; 📥 Copy into this chat → the file is in the chat's files; copying again asks before replacing.
4. Select a folder › Copy into this chat: the count and size are shown, .git / node_modules are left out, and the files arrive in the workspace.
5. /root/.config shows no `chronicle`; ✎ /root/.config/chronicle and ~/x/../.config/chronicle/gh-token are refused; `ln -s ~/.config/chronicle ~/sneaky` in the shell, then open sneaky: refused. With the SSH key on, ~/.config/gh/hosts.yml (if gh is signed in) and any copy of the key (`cp ~/.config/chronicle/ssh/id_ed25519 /tmp/k`) open as "not shown".
6. A file named `my "odd" 'name' é.txt` in /root opens, copies and saves.
7. Chat files: the phone folder is one row "📱 <name> · linked" with ⋯ (Change folder, Bring files in, Save files to it, Unlink, the hint). 360-wide phone, light and dark, the largest text size: nothing overlaps or runs off the screen.
8. Linux files › a folder with photos (e.g. `cp /sdcard/DCIM/Camera/*.jpg ~/pics/` in the shell): the grid shows thumbnails as you scroll, without the screen stalling; a picture over 3 MB shows its icon.
9. Open a .js, .py or .sh file (in the workspace, in Linux files, in the phone folder): the code is coloured; with Settings › highlighting off it is plain.
10. Files › 📱 the phone folder › Select a folder › Copy into this chat: count and size are asked first, .git / node_modules are left out and said, and the files arrive under the folder you type.

## 4ct. Character sites stay open; ⓘ buttons (decision 157)
1. 🌐 Browse Chub › download two characters one after the other: the site stays open, a light bar at the bottom says "Importing …" and then "Imported <name> ✓" for each; no dark Android toast. Close the site: one app message "Imported 2: …", both are in the Roleplay list.
2. "⤵ Import this page" on a character page: the same, the site stays open.
3. A download that is not a card (a random image): "Couldn't import that: …" in the bar, the site stays open.
4. Settings › Roleplay › Story memory: "using a fast model (DeepSeek V4.1 Flash)" (or the Flash model you have); tap ⓘ: the bubble names it and says how it is picked; tap outside: it closes. Scene tracker's ⓘ: tapping it does not tick the checkbox.
5. Settings › Memory, Tools, Roleplay, GitHub; the persona editor; the chat sheet: long explanations are a first sentence + ⓘ; each ⓘ opens its text (links in it work), a tap outside closes it, the Back button closes it before leaving the page. Settings search for a word only in a bubble (e.g. "WebAssembly") still finds the setting.
6. Roleplay start screen (a new roleplay, with more than 3 characters): type part of a name or a tag: only matching cards show, the keyboard stays up. Sort by Recently chatted / Name / Newest added / Most chats; close and reopen the app: the sort is kept. In "Your order", long-press drag still rearranges; in any other sort it does not.

## 4cu. Background processes of a chat (decision 158)
1. Ask the assistant to start something in the background: "run `nohup sh -c 'while true; do date >> /tmp/t.log; sleep 2; done' >/dev/null 2>&1 &`". Within ~10 s a dashed "⚙ … · 0m 8s ✕" chip appears above the message box; its clock runs.
2. Switch to another chat: the chip is not there; back: it is.
3. Tap it: the whole command and "Stop it"; stop it: "Stopped …", the chip goes, and `pgrep -f t.log` in the terminal finds nothing.
4. A recording (`nohup ffmpeg … &`): one chip for it; stop it: the file it wrote so far is still there.

## 4cv. Big files from Linux (decision 159)
1. In the shell: `dd if=/dev/urandom of=/root/big.bin bs=1M count=600`. Files › 🐧 Linux › /root › select big.bin › Download › Download/Chronicle: a progress toast, then "Saved big.bin (600 MB)"; the phone's Files app shows it in Download/Chronicle with the same size; the app's memory does not jump (no crash).
2. The same into the linked phone folder.
3. Tap big.bin: "Too big to open in the app" with "Save it to the phone".
4. Ask the assistant (review mode) to save /root/big.bin to the phone folder: it asks once ("Save big.bin (600 MB) from Linux…"), then saves; in read-only mode it refuses.
5. `ln -s ~/.config/chronicle/gh-token ~/t` then try to save ~/t: refused.
6. Review mode, phone folder linked: ask the assistant to `dd if=/dev/urandom of=/phone/big.bin bs=1M count=100`: after the command it asks "The shell made big.bin (100 MB) in /phone. Save it…?"; Save it: the file is in the folder with the full size.
7. `dd … of=/workspace/w.bin bs=1M count=100`, then ask it to save /workspace/w.bin to the phone: it uses phone_write from_shell and the file arrives.

## 4cx. ⚡ Bypass permissions (decision 161)
1. A tools chat › mode chip › ⚡ Bypass permissions: a sheet lists "No longer asked" and "Still asked, or still refused"; Cancel: the chip still reads ⚡ Auto. Again › Turn on Bypass: the chip reads "⚡ Bypass" in amber, in light and dark theme.
2. Linux on: ask the assistant to `mkdir -p /root/t && rm -rf /root/t` and then `git reset --hard` in a repo (both asked in ⚡ Auto): no question, it says what it ran. `rm -rf ~/.config/chronicle` and `ssh-keygen` still ask. With the SSH key on and "ask before every push": `git push` still asks.
3. Settings › Tools › Permissions › Delete files: Never. In the Bypass chat ask it to delete a file: refused ("You may not use delete_file").
4. Ask "where am I?": the location question still comes; Not now: it says it could not. The same for "what is on my calendar", "read my notifications", "my last texts".
5. Ask it to text someone: the Messages app opens with a draft after a question; nothing is sent by itself.
6. Link a phone folder in 🛡 Review, then Bypass: ask it to edit a file there: saved at once, ↩ Undo under the reply works, no review sheet. Switch the folder to 👁 Read-only: the chip reads "⚡ Bypass · 👁 Read-only" and a write is refused.
7. Review folder + Bypass: `dd if=/dev/urandom of=/phone/big.bin bs=1M count=100`: saved without the "Save it into …?" question.
8. Tap the ⚡ Bypass chip › Turn Bypass off: back to ⚡ Auto; `rm -rf /phone/x` asks again.
9. Settings › Tools & agent › "⚡ Bypass permissions in new chats": the warning comes first; Cancel leaves it unticked. Tick and confirm: a new chat shows ⚡ Bypass; a chat forked from it does not; a Tasker/automation run does not.
10. Schedule a task in a Bypass chat that runs `git reset --hard` in a repo while the app is in the background: it runs; the same in an ⚡ Auto chat: refused with "nobody is here to say yes".

## 4cy. Claude plugins (decision 162)
1. Settings › Packs (or Skills › 🧩 Claude plugin…), paste `https://github.com/anthropics/knowledge-work-plugins/tree/main/design`, Get: the review says "🧩 Design 1.2.0 – … by Anthropic – licence: Apache-2.0 (if it has one)", lists 7 skills and the remote MCP servers (Slack, Figma, Linear, Asana, Atlassian, Notion, Intercom), and "⛔ MCP server google calendar / gmail – it has no address yet". Open a skill under the list: its whole text shows.
2. Install. Skills: one group "Design – 7 skills" with the 7 skills inside. Untick the group: all 7 are off (a new chat with tools does not list them); tick it again. "Remove Design": the skills, snippets and MCP servers it added are gone; your own skills stay.
3. Paste `https://github.com/anthropics/knowledge-work-plugins` (a marketplace): a list of its plugins with Open buttons; open one: its review.
4. Paste `https://github.com/anthropics/skills`: the marketplace list; open document-skills: only its 4 skills (xlsx, docx, pptx, pdf), with "N files … not text, or too big" for the binary/large ones; install; ask for a PDF task: the assistant calls use_skill pdf and the skill's scripts are in /workspace/skills/pdf/.
5. Skills › ⤵ Import a plugin .zip (download a plugin folder as zip): it opens the same review, not one skill per SKILL.md.
6. Not signed in to GitHub: a private repo link says "GitHub has no … (or it is private: sign in to GitHub in Settings)"; signed in: it imports.
7. With the Linux terminal installed, a plugin whose .mcp.json has `npx …` (stdio): it is listed as a 🐧 server that runs that command, added switched off; without Linux: "⛔ … needs the built-in Linux".

## 4cw. Chat history by time; chat export/import (decision 160)
1. Drawer with chats from today, yesterday, this week, this month and older: headers Today / Yesterday / 7 Days / 30 Days / "Oct 2026" / "2025"; each row has a small time ("14:05", "Mon", "12 Oct"). Pinned and folders stay on top. Same on 🎭 Roleplay.
2. Scroll the list: the header of the group you are in stays at the top, flush (no row peeking above it), and the next header pushes it away. Light and dark.
3. 360-wide phone, the largest text size in Settings: long names end in "…", the time and ⋮ stay inside the row.
4. Leave the app open past midnight, open the drawer: yesterday's chats are under Yesterday.
5. A roleplay (with alternate greetings, a swipe, scene tracker and author's note) › ⋮ › More › Export chat… › 📦 Chronicle chat (.json): the share sheet offers `<name>.chronicle.json`. The sheet says workspace files and keys are not included.
6. On a second phone (or after deleting the character): drawer › ⤵ › pick that file: the chat opens on 🎭 Roleplay with the character (picture, greetings) made from the file; swipes, scene tracker and author's note are there. Import it again: a second chat, still one character.
7. Same phone, character unchanged: importing makes no second character. Settings › Data › Import chats takes the .json and a SillyTavern .jsonl.
8. Open the exported .json in a text editor: no API key, no GitHub token.

## 4da. Claude with your own Anthropic API key (decision 164)
1. Settings › Account & models › Custom endpoints › + Anthropic (Claude): name and base URL filled in, the key hint names platform.claude.com, no "Send the key as" / "Connect via" / context / tools fields. Test without a key: "Enter your Anthropic API key". A wrong key: "Anthropic did not accept the API key…". Your real key: "Model list: ✓ N – claude-opus-5-5, …" and "Chat test … ✓ replied". Save.
2. The model picker lists the Claude models with the provider's name; Claude Opus 5.5 shows "1M ctx". Pick it: the 🧠 effort chip cycles default / low / medium / high / xhigh / max.
3. A plain chat: the reply streams word by word; the thinking (summarized) shows in the thinking view; the meta line shows tokens in/out. Send a second message within 5 minutes: "N% cached" appears; Settings › Data › Usage › the Claude model's row shows "(… cached)".
4. Effort high on a hard question: noticeably longer thinking than low. The chat’s sampler settings show the "Claude models … not sent" note.
5. Agent mode (🛠 on): "create notes.txt with three lines, then read it back": write_file and read_file run, the reply quotes the file. Ask "and now add a fourth line": works on the next turn (thinking blocks from the first turn go back; no 400 about signatures).
6. Lock the phone / switch apps during a long agent reply: it keeps going (KeepAlive notification) and finishes; same as with OpenCode Go.
7. Attach a photo: Claude describes it. Roleplay with a character whose preset has a prefill: the reply comes without an error (the prefill is not sent).
8. A long chat that gets compacted, a helper (delegate), memory learning: each runs on Claude when Claude is the chat's / helper model.
9. Airplane mode, send: "Network error – could not reach Anthropic …", retried, then the error. Stop during a reply: it stops at once.
10. Settings › Data › Export backup, open backup.json: the Anthropic provider is there with an empty apiKey. Restore on the same phone: the key is still set.

## 4cz. Claude Code in Linux (decision 163)
1. Without Linux: Settings › Account & models › Claude Code (your subscription) › Claude Code in Linux says "Install Linux first"; Start is greyed. Install Linux.
2. Install: the output streams in the dark box (apk add, npm install -g …), close and reopen Settings mid-way: it is still "Installing…" and the output continues. When done: "✓ Claude Code 2.x installed (Node v22…) · not signed in yet". Note the time it took and the free space before/after (Settings › Data or `df -h /` in the terminal).
3. On an Alpine with Node < 22 (if one can be had): the install stops with "Node … is too old".
4. Open 🐧 terminal: the full terminal opens with `claude` typed but not run. Press Enter: Claude Code starts (first-run screens), `/login` (or its own prompt) shows a link – open it in the browser, sign in with your claude.ai account, paste the code back. Nothing in Chronicle asked for the account. Back in Settings › Check again: "✓ signed in (in Claude Code)".
5. Start with folder `/root` (and once with a folder that does not exist: "the folder … does not exist in Linux"). The line says "● running on 127.0.0.1:<port> in /root". In the terminal: `cat /proc/net/tcp | awk '$4=="0A"'` shows the port only on 0100007F; `tr '\0' ' ' < /proc/$(cat ~/.cache/chronicle-claude/bridge.pid)/cmdline` has no secret; `cat ~/.cache/chronicle-claude/bridge.log` has no secret.
6. New chat › "list the files here and create hello.txt": the reply streams, tool calls show, the write asks "Claude Code (in Linux) wants to: …"; Allow: `ls /root` in the terminal shows hello.txt. Note how long the first reply takes and the phone's memory (Settings › Phone status, or `free -m`).
7. Kill the app (swipe away), open it, send another message in that chat: it starts Claude Code again by itself and answers (says "a new session" if the adapter could not load the old one).
8. In the terminal `claude auth logout` (or /logout in claude), send a message: the chat says Claude Code is not signed in and to sign in in the 🐧 terminal – no sign-in button.
9. Files › 🐧 Linux › /root: no `.claude.json`; open `.claude`: no `.credentials.json`, no `backups`; `ln -s ~/.claude/.credentials.json ~/c` then tap `c`: "private".
10. In an ⚡ Auto tools chat (and once in ⚡ Bypass), ask the assistant to `cat ~/.claude/.credentials.json`, `cp -r ~/.claude /workspace/` and `echo $CLAUDE_CODE_OAUTH_TOKEN`: each asks first; Not now: nothing ran.
11. Settings › Data › Export backup (with and without keys): unzip, search for `sk-ant-` and the bridge secret: none. Stop: the line no longer says running; `ps` in the terminal shows no claude-agent-acp.

## 4db. Claude Code in the model picker and its usage (decision 165)
1. Settings › Account & models: the "Claude Code (your subscription)" section with the Claude Code in Linux card (Install / sign-in / Start / usage); Settings › Connections has PC agents but no Claude Code card. Nothing in either shows a robot or a Claude logo. Search Settings for "Claude Code": it finds the card on Account & models.
2. With Claude Code installed and signed in (4cz) but not started, and after an app restart: + New chat › model button: the sheet has "Claude Code (your subscription)" on top with "Claude Code – default model". Pick it; the header says so.
3. Send "what folder are you in?": Claude Code starts by itself (no card), the reply comes; note how long. Open the model button again: Claude Code's own models are listed (write down their names), and after a few seconds the header shows "5 h: …% · week: …%". Compare with claude.ai › Settings › Usage: same numbers (±1 %).
4. Pick another Claude Code model in the same chat and send: the reply comes from it (ask "which model are you?"). Tap 🧠 to a level and send; in the 🐧 terminal `ps` shows still one claude-agent-acp.
5. Tap the usage numbers: a sheet with a bar per window, reset times in the phone's local time; Refresh works. ☰: under the Go usage card "Claude: 5 h …% · week …%". The chat list has no chat for /usage.
6. + New chat: the header shows the last Claude Code model; send: it is a Claude Code chat. Pick a normal model (e.g. GLM) in it and send: an ordinary reply; then pick Claude Code again and ask "what did I ask before?": it knows (the chat so far went along).
7. A "Claude Code (phone)" chat from the card's New chat still works as in 4cz.
8. Sign Claude Code out (`claude auth logout`), Check again on the card: the picker's section says "Not signed in yet"; sending says to sign in inside Claude Code; the usage shows nothing new and no error toast.
9. Roleplay tab: the model sheet has no Claude Code section.

## 4dc. Claude Code gets Chronicle's skills, phone tools and MCP servers (decision 166)
1. With Claude Code set up (4cz/4db), pick a Claude Code model in a new chat and ask "which skills do you have?": it lists Chronicle's enabled skills (chronicle-playbook, chronicle-harness, a pack or imported plugin's skills). In the 🐧 terminal: `ls ~/.claude/skills` shows them, each with SKILL.md starting `---\nname: …\ndescription: "…"`, and a `.chronicle-skill` file; `cat ~/.cache/chronicle-claude/skills.manifest` lists the same names.
2. In the terminal make your own skill: `mkdir -p ~/.claude/skills/my-own && printf -- '---\nname: my-own\ndescription: mine\n---\nhi\n' > ~/.claude/skills/my-own/SKILL.md`. In Chronicle switch one skill off and edit another, then send a message: the switched-off one is gone from ~/.claude/skills, the edited one has the new text, `my-own` is untouched. Ask "which skills do you have?" in the same session: the change is there without a new chat (Claude Code's watcher).
3. Ask "where am I?": Claude Code calls mcp__chronicle__location; Chronicle's sheet asks "Share your approximate location…" (no second question from Claude Code); Share: the answer has the place. Ask again: no question (once per chat).
4. Ask "what is on my calendar tomorrow?" and "add a dentist appointment Friday 3 pm": the calendar is read after the once-per-chat OK; the add asks "Add to your calendar?" every time.
5. Settings › Tools & agent › Permissions: set memory to "Ask me", ask Claude Code to remember something: "Allow memory (Claude Code)…?" appears; Deny: Claude Code says it was not allowed. Set contacts to Never: asking to look someone up is refused without a question. Turn the chat's 🛡 Ask first on and ask for a photo (take_photo) or a phone-folder write: it asks first; ⚡ Bypass: it does not (personal data still asks).
6. Switch the chat's tools off (🛠): the next message starts a new session and Claude Code has no chronicle tools. Switch them on again.
7. Ask Claude Code to open a web page with the browser tool and take a screenshot: the browser works, the screenshot comes back as an image Claude Code describes. Ask it to make `index.html` and look at it with preview_page: the preview shows the page it just wrote.
8. Ask Claude Code to write `notes.txt` "here": after the reply the chat's 📁 shows notes.txt; open it, it has the text. Attach a file to the chat and ask Claude Code to read it: it finds it in its working directory (`pwd` = /chats/<chat>).
9. Settings › MCP servers: an HTTP server with a token and a stdio server (e.g. `npx -y @modelcontextprotocol/server-everything`). In a new Claude Code chat ask it to use them: they work, Claude Code asks its own permission for them; a tool switched off in the server's list is not offered.
10. In the terminal: `cat /proc/net/tcp | awk '$4=="0A"'` – still only 127.0.0.1 for the bridge; `curl -s -X POST http://127.0.0.1:<port>/mcp/x -d '{}'` → 401; with the bridge secret instead of the MCP token → 401.
11. Ask for something slow (the browser on a heavy page) and press Stop in the chat: the tool stops and Claude Code's turn ends. Kill the app during a tool call: Claude Code gets "Chronicle did not answer" at the latest after 30 minutes (note what it shows).

## 4dd. Claude Code and Chronicle's models call each other (decision 167)
1. With Claude Code installed and signed in (4cz/4db), Settings › Tools & agent: "💻 Let models hand tasks to Claude Code" is off. In a normal chat (GLM) with tools on, ask "use claude_code to write a tiny Python CLI in this folder": the model says it does not have it (or does it itself). Turn the switch on.
2. Same chat, same request: a "💻 Claude Code" tool card appears; its line goes "Starting Claude Code…", then "Claude Code · step N: …" as it works (note how long the start takes). When Claude Code wants to edit or run something, the ask sheet says "Claude Code (in Linux, working for the assistant) wants to: …"; Allow. When done, the card opens to the task, "✓ edit · …" steps and Claude Code's answer; the model's reply uses it. The chat's 📁 has the files Claude Code wrote.
3. In the 🐧 terminal during step 2: `ps` shows one claude-agent-acp; after the card finishes, ask Claude Code nothing for a minute: no extra claude process stays (the session was closed). The chat list has no new chat.
4. Ask for something long (e.g. "with claude_code, run a 2 minute sleep then say done") and press Stop: the card shows stopped, the reply ends, `ps` shows the sleep gone within a few seconds; the next claude_code call works.
5. Settings › Permissions › 💻 Claude Code tasks: Ask me → the next call asks "Allow claude_code: …?" first; Never → refused without a question.
6. A persona with the "coding" toolset preset gets it; one without the 💻 group does not. A roleplay chat and a group chat never offer it (ask the model to list its tools).
7. Sign Claude Code out (`claude auth logout`), Check again on the card: the tool is no longer offered in a new message.
8. In a Claude Code chat (picked in the model picker), ask "list Chronicle's models with list_models, then ask the cheapest one to summarise this paragraph: …": Claude Code calls mcp__chronicle__list_models (the list has your models with prices, no Claude Code entries) and mcp__chronicle__ask_model; the answer names the model that did it. Settings › Permissions › 🤝 Helper agents to Never: ask_model is refused. 🤝 Helper agents off in Settings › Tools & agent: Claude Code does not have ask_model.
9. No loops: in a normal chat, ask the model to use claude_code with the task "call mcp__chronicle__ask_model to ask GLM something": Claude Code reports ask_model is not available (started by one of Chronicle's models).
10. Note the plan usage (5 h / week) before and after step 2: it went up – the tool really uses the Claude plan.

## 4de. Model per side, Bypass in roleplay, joined usage card (decision 168)
1. In Roleplay pick Soji; switch to Chats: the model button shows the chats model, not Soji. Pick DeepSeek; back to Roleplay: Soji. Close and reopen the app: still Soji in Roleplay, DeepSeek in Chats.
2. Open an older chat that last used another model: that model is selected (the chat's own wins); switch tabs and back: each side's pick returns.
3. Settings › Tools & agent › Bypass for new chats on. A new chat shows ⚡ Bypass; Roleplay › New roleplay: no mode chip at all.
4. With OpenCode Go and Claude Code usage both on, open the side menu: one card – OpenCode Go rows, a dashed line, then "Claude Code usage" with 5-hour and Weekly rows in the same style. Details opens the full sheet. Turn Claude usage off in Settings › Data: the Go card is whole again, with its bottom corners round.
5. With a context cap set (Settings or the persona, e.g. 60K), open a Claude Code chat on Opus 5.5 and send something: the 🪟 chip shows Claude Code's own numbers (e.g. "30K / 1M" or "/ 200K", whatever Claude Code reports), not 60K. Tap it: a short note, not the breakdown sheet. A long session: the number drops after Claude Code compacts.

## 4df. Background jobs on Claude Code (decision 169)
1. With Claude Code set up and its models known (open the model picker once), Settings › Tools & agent › Helper model: a group "Claude Code (your subscription)" with the plan's models; the same in the advisor list and in Memory's learning model; not in the fallback list.
2. Helper model → Claude Code · Sonnet. Type "/polish i has went to the shop" and send: after a few seconds the box holds the corrected text. In the 🐧 terminal meanwhile, `ps` shows one claude process for the job, gone afterwards.
3. Learning model → Claude Code. Chat a few messages with learning on: Memory gets new notes; the plan usage (5 h) goes up a little. Stop Claude Code (Account & models › Claude Code › Stop): learning still works on the automatic model.
4. Advisor → Claude Code: ask the assistant to consult its advisor; the answer names "Claude Code · …".

## 4dg. Stress-test fixes (decision 170)
1. In a Claude Code chat: "call mcp__chronicle__read_chat with chat_id set to one of my chats" – the result starts with ("chat_id" was read as "id".) and shows the chat.
2. "web_search for __nonexistent_query_zzz_qwerty_12345": the output says none of the results contains the searched words. A search that opens a game8 page: no "free member" lines in its page text; a long page ends with "[… cut here: N more characters …]".
3. location (approximate) right after opening Maps: answers in about a second. With location off for an hour and indoors: may still wait, with "Asking Android for the location…" on the card.
4. memory list in a chat with persona A: no memories of persona B, and a line saying how many were left out; "scope all" shows them. Adding a memory that repeats an existing one is refused with its id.
5. A Claude Code chat without a phone folder: ask "is a phone folder linked?" – it knows without calling a tool. Link one: the confirmation says it stays linked in this chat.

## 4dh. Background running said honestly (decision 172)
1. Ask the assistant for `doctor`: a "background" row – idle, last stop finished (or not used yet); notes when notifications are off or battery optimisation is on.
2. Battery saver / "restrict background" on for Chronicle (Settings › Apps › Chronicle › Battery › Restricted), send a long request and switch away at once: back in the app, a message says background protection is not running, once.
3. A reply that runs into Android's limit (hard to force; leave a long agent task running for hours on Android 13 or older): a "Reply paused by Android – tap to continue" notification; opening the app says it once.
4. Kill the app (swipe it away) mid-reply, open it again: the half reply says it was cut off when the app closed, with ↻ Continue; Continue finishes it.
