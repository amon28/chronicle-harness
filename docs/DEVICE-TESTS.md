# On-phone checklist (short)

The automated tests (about 1,600, run on every change) cover the app's logic and screens with stand-ins for Android
and Claude Code. This list is only what a real phone can show. **40 steps in 6 sittings, about 10 minutes each** –
do them in any order, one sitting at a time. For anything that fails, send the step number (e.g. "C4") and what you
saw, with a screenshot or the log if there is one.

The full reference list, per feature and decision, is in `docs/DEVICE-TESTS-FULL.md` (section numbers like 4dg in
the decisions point there). You do not need to go through it.

---

## A. The basics (once after each new APK)
1. The update installs over the old app; your chats, characters and settings are all there.
2. Send a message, switch to another app for 30 s, come back: the reply finished (or finishes) and you got a
   notification if it ended while you were away.
3. Settings › Data › Export backup, then Import it: no crash, nothing lost.
4. A long chat scrolls smoothly; opening the side menu, the model picker and Settings is instant.
5. Roleplay tab: pick a model; Chats tab: pick another; back to Roleplay – its own model is still selected.
6. A new roleplay shows no ⚡ Bypass chip, even with "Bypass for new chats" on.
7. Swipe the app away in the middle of a long reply, open it again: the half reply says it was cut off, and
   ↻ Continue finishes it. Ask the assistant to run
   `doctor`: its "background" row says how the last protection ended.

## B. Claude Code
1. Settings › Account & models › Claude Code › Update: the log ends with the versions (no "@@FAIL"); under
   "checking claude" it says nothing or "making claude a real file". Then type `claude --version` in the terminal.
2. Press Update a second time: still fine (this is the update that broke it before).
3. Pick a Claude Code model in the picker and chat: a reply comes; the 🪟 chip shows Claude Code's own numbers
   (e.g. "30K / 1M"), not your context cap.
4. Ask it something that needs a phone tool (e.g. "where am I?" or "list my phone folder"): it uses the chronicle
   tool, asking you first where your permissions say so.
5. Press Stop while it works: it stops within a few seconds. Tap the 🪟 chip: the Context sheet with Claude Code's
   numbers; type "/": Claude Code's commands are there, tagged.
6. Side menu: one usage card – OpenCode Go rows, a dashed line, then Claude Code's 5-hour and Weekly rows.
7. Settings › Tools & agent › Helper model → Claude Code · Sonnet; type `/polish i has went to shop` and send: the
   box gets the corrected text after a few seconds.

## C. Phone tools (in a normal chat with tools on)
1. "Where am I?" (approximate): answers in about a second if a map app got a location recently.
2. Vibrate the phone, then set the volume to 50 %: the first asks once for phone controls, then both are quick.
3. Set the volume to 150 %: refused, "between 0 and 100", nothing changed.
4. Link a phone folder; write a file into a new subfolder; delete the file, then the empty folder: both go (after
   your review in Ask-first mode). Deleting a folder that still has a file in it is refused.
5. Import a phone file with `to` set to a folder name: it lands as folder/name, not a file named like the folder.
6. Take a photo holding the phone upright: it shows upright in the chat.
7. Copy some text that ends with a new line; ask the assistant to read the clipboard and put it back: the same text,
   same length.

## D. Browser (ask the assistant to use the browser)
1. Open example.com, click "Learn more", read the heading: it reports the new page (iana.org), not example.com.
2. A login page: it hands over to you (handoff), you sign in, it continues on the signed-in page.
3. Preview a page the assistant wrote, then ask it to download a file that page links to: it saves the file.
4. Watch the assistant's browser from the monitor button while it works.

## E. Linux and files
1. Settings › Linux terminal opens a full terminal; `ls /workspace` shows the chat's files.
1a. Debian (decision 190): on a phone with the old Alpine, Settings › Linux terminal says "Ready (Alpine)" – press
   **Switch to Debian**. It downloads (~30 MB), unpacks and fetches its first tools; then `cat /etc/os-release` says
   Debian 13, `ls /root` still shows your files, and `apt-get install -y jq && jq --version` works. Then Settings ›
   Claude Code › Install: the log shows apt-get and "Node from nodejs.org", and ends with the versions (sign in again
   only if it asks).
2. A command that runs long (e.g. `sleep 120`) gets a chip with a timer that keeps counting after you leave the app
   and come back.
3. Files: open a file from Linux, share it to another app, save one to Download.
4. Share an image from the gallery to Chronicle: it arrives in a chat.
5. Files on my PC (decision 223): on a computer on the same Wi-Fi run `python3 pc-files.py ~/Documents` (Windows:
   `py pc-files.py %USERPROFILE%\Documents`; allow it in the firewall when asked). Settings › Connections › Files on
   my PC: enter the address and secret it printed, + Connect → "✓ … shares Documents – read-only". In a chat with
   tools on: "what is in my Documents on the PC?" lists it; "copy report.pdf from my PC" puts it in the workspace.
   Restart the script with `--write`, Test again, then "save a note to my PC" asks first (Review mode) and the file
   is there on the computer.
6. A big video in the phone folder (decision 224): link a folder with a video over 32 MB (e.g. DCIM/Camera), ask
   "check the video with ffmpeg". It should take a few steps: phone_import says "In the shell now … /phone/<name>",
   then ffmpeg/ffprobe runs on it. Do it in Auto (or Bypass) and in Review: both work, no searching under /storage.

7. 📎 › Take a photo (decision 229): the camera app opens; the photo appears as an attachment. 📎 › Record a video:
   record a few seconds; a video-….mp4 chip appears; send "what is in this video?" – the assistant runs ffprobe/ffmpeg
   on /workspace/videos/…; 📁 shows it under videos/.

8. PC QR, auto start, full control (decision 230): `py pc-files.py %USERPROFILE%\Documents --autostart` prints a QR;
   Settings › Connections › Files on my PC › 📷 Scan the QR → "✓ … shares Documents". Log out and in on the PC: the
   phone still connects (Test). `py pc-files.py --full --autostart`, scan again → ⚠ FULL CONTROL; in a Review chat
   "what is in C:/Users?" works, "run ipconfig on my PC" asks first and shows the output. `--no-autostart` undoes it.

9. Claude Code roleplay (decision 238): open a one-on-one roleplay with a card that has a lorebook, model picker ›
   Claude chip › a Claude Code model. Write something that names a lorebook keyword: the reply stays in character and
   uses that entry; set an author's note in the chat sheet and it is followed. A group roleplay does not offer Claude Code.

## F. Voice, sites, updates
1. Read aloud a reply; voice input types what you say; voice mode answers aloud and listens again.
2. Browse Chub inside the app and import a character; it shows up with its picture.
3. A character's ⓘ / import buttons open and close without leaving two sheets open.
4. Settings › About › Check for updates: it says you are up to date (or offers the newer APK).
5. Turn the phone sideways and back in a chat and in Settings: nothing is cut off.
6. The largest text size (Settings › Look): menus and sheets still fit at your phone's width.
7. Leave the app for an hour with a scheduled task due: it runs, and you get its notification.
8. Restart the phone, open Chronicle: everything is there; the Claude Code card says "not running" until a chat
   starts it.
9. After any of the above went wrong: Settings › Data › 🧾 Error log lists it (Export it and send it along).
