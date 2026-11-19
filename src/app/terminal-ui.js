// 💻 Linux terminal: install the built-in Linux, run commands, see the output. (The assistant uses the same Linux via its shell tool.)
import { logError } from '../errorlog.js';
import { canPty, canUseShell, installLinux, killShell, onShellOutput, plain, runShell, shellStatus, uninstallLinux } from '../shell.js';
import { openSheet } from './chatlist.js';
import { $, hooks, toast } from './core.js';

const ID = 'terminal';
let busy = false;
let unsub = null;
const MAX = 60000;

const out = () => $('#term-out');
function append(text, cls) {
  const o = out();
  const near = o.scrollHeight - o.scrollTop - o.clientHeight < 40;
  if (cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    o.append(s);
  } else o.append(document.createTextNode(plain(text)));
  while (o.textContent.length > MAX && o.firstChild) o.removeChild(o.firstChild);
  if (near) o.scrollTop = o.scrollHeight;
}

async function refresh() {
  const st = canUseShell() ? await shellStatus() : { available: false };
  const msg = $('#term-status');
  $('#term-install').hidden = true;
  $('#term-bar').hidden = true;
  $('#term-remove').hidden = !st.installed;
  $('#term-switch').hidden = !(st.installed && st.distro === 'alpine');
  if (!canUseShell()) msg.textContent = 'The Linux terminal only works in the Android app.';
  else if (!st.available) msg.textContent = 'This phone/app build cannot run the built-in Linux (it needs a 64-bit ARM phone and a build that includes it).';
  else if (st.installing) msg.textContent = 'Installing…';
  else if (!st.installed) {
    msg.textContent = 'Linux is not installed yet. Debian downloads once (about 30 MB; with its first tools about 60 MB) and stays inside the app.';
    $('#term-install').hidden = false;
  } else {
    msg.textContent =
      st.distro === 'alpine'
        ? 'Ready (Alpine). Chronicle now installs Debian, where much more software runs (decision 190): “Switch to Debian” replaces it – your /root folder stays, but programs installed in Linux (Claude Code too) have to be installed again.'
        : 'Ready. Each command runs in one persistent shell: cd and variables carry over.';
    $('#term-bar').hidden = false;
  }
  storageNote();
}

/** All files access: the phone's storage at /sdcard in the shell (a new shell picks it up). */
async function storageNote() {
  const s = await hooks.device?.status?.().catch(() => null);
  if (!s) return;
  $('#term-storage-note').textContent = s.allFiles ? "It sees the phone's whole storage at /sdcard (all files access is on – switch it off in Android's settings for Chronicle)." : "It sees only the chat's workspace and a linked phone folder.";
  $('#term-allfiles').hidden = !!s.allFiles || !s.allFilesPossible;
}

/** Linux terminal: straight into the full terminal (like Termux) when Linux is installed; `simple` opens the command box. */
async function open(simple = false) {
  openSheet('#settings-sheet', false);
  if (simple !== true && canUseShell() && canPty()) {
    const st = await shellStatus();
    if (st.installed && hooks.openFullTerminal) return hooks.openFullTerminal();
  }
  openSheet('#term-sheet', true);
  await refresh();
  unsub?.();
  unsub = await onShellOutput((e) => {
    if (e?.id === ID && busy) append(e.data);
  });
}

async function run() {
  const input = $('#term-in');
  const cmd = input.value;
  if (!cmd.trim() || busy) return;
  busy = true;
  input.value = '';
  append(`$ ${cmd}\n`, 't-cmd');
  $('#term-run').disabled = true;
  try {
    const r = await runShell(cmd, { id: ID, timeoutMs: 300000 });
    if (r.timedOut) append('\n[timed out – the shell was restarted]\n');
    else if (r.ended) append('\n[the shell ended]\n');
    else if (r.exit) append(`[exit ${r.exit}]\n`);
  } catch (e) {
    append(`\n${e.message || e}\n`);
  } finally {
    busy = false;
    $('#term-run').disabled = false;
    input.focus();
  }
}

$('#open-terminal').onclick = () => open();
hooks.openSimpleTerminal = () => open(true);
$('#term-run').onclick = run;
$('#term-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    run();
  }
});
$('#term-stop').onclick = async () => {
  await killShell(ID);
  if (busy) append('\n[stopped]\n');
};
$('#term-clear').onclick = () => (out().textContent = '');
$('#term-install-btn').onclick = async () => {
  const btn = $('#term-install-btn');
  btn.disabled = true;
  const msg = $('#term-status');
  let failed = null;
  try {
    const r = await installLinux(installStep(msg));
    toast(r?.setup === 'ok' ? 'Linux installed' : 'Linux installed – its first tools could not be fetched (no connection?): apt-get update later');
  } catch (e) {
    failed = e;
  } finally {
    btn.disabled = false;
    await refresh();
    showFailure(failed); // after the refresh, which would write over it
  }
};
$('#term-allfiles').onclick = async () => {
  await hooks.device?.askAllFiles?.().catch(() => null);
  toast('Switch on “Allow access to manage all files”, then come back');
  // when the user comes back: each shell's next command starts it again with /sdcard bound (the mounts changed)
  const back = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', back);
    hooks.device?.status?.().then((st) => {
      if (st?.allFiles) {
        hooks.setShellStorage?.(true);
        toast('The shell now sees your phone storage at /sdcard');
      }
      storageNote();
    });
  };
  document.addEventListener('visibilitychange', back);
};
/** An install that failed: said where the status is (and stays there), and kept in the error log. */
function showFailure(e) {
  if (!e) return;
  const m = String(e?.message || e);
  const text = /^Install failed/.test(m) ? m : 'Install failed: ' + m;
  $('#term-status').textContent = text;
  logError('android', text, { where: 'Linux install' });
}
/** The install's progress in words. */
const installStep = (msg) => (p) =>
  (msg.textContent = { find: 'Finding the newest Debian…', unpack: `Unpacking… ${p.pct || 0}%`, setup: 'Fetching the first tools (certificates, curl, ps)…', done: 'Unpacked.' }[p.phase] || `Downloading… ${p.pct || 0}%`);
$('#term-switch').onclick = async () => {
  if (!confirm('Install Debian in place of Alpine? Your /root folder stays; programs installed in Linux (Claude Code too) have to be installed again.')) return;
  const btn = $('#term-switch');
  btn.disabled = true;
  const msg = $('#term-status');
  let failed = null;
  try {
    const r = await installLinux(installStep(msg));
    out().textContent = '';
    toast(r?.setup === 'ok' ? 'Debian installed' : 'Debian installed – its first tools could not be fetched: apt-get update later');
  } catch (e) {
    failed = e;
  } finally {
    btn.disabled = false;
    await refresh();
    showFailure(failed);
  }
};
$('#term-remove').onclick = async () => {
  if (!confirm('Remove the built-in Linux and everything in it?')) return;
  await uninstallLinux();
  out().textContent = '';
  refresh();
};
