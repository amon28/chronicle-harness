// Claude Code in Linux (Settings › Account & models): install the official CLI and its ACP adapter in the app's Linux, let the
// user sign in to it themselves in the 🐧 terminal, start it behind acp-bridge on 127.0.0.1, chat with it.
// Chronicle offers no sign-in of its own and never touches Claude Code's credentials (claudecode.js, decision 163).
import { logError } from '../errorlog.js';
import { $, hooks, state, toast } from './core.js';
import { saveSettings } from '../store.js';
import { openSheet } from './chatlist.js';
import { canPty, canUseShell, LOGIN_SHELL, plain, shellStatus } from '../shell.js';
import { AGENT_ID, DIR, NODE_MIN, agentEntry, authLabel, bridgeHealthy, bridgeState, ccExec, cleanCwd, pollInstall, readStatus, setChatsMount, startBridge, startInstall, stopBridge } from '../claudecode.js';
import { ccSkills, syncCcSkills } from '../ccskills.js';
import { hostPath } from '../shellfs.js';

// the chats' workspaces bound into Claude Code's Linux at /chats (decision 166); none in the web build
setChatsMount(() => (globalThis.__ocmCcChatsHost !== undefined ? globalThis.__ocmCcChatsHost : canUseShell() ? hostPath('work') : ''));

let st = null; // the last status read from Linux
let polling = null;
let starting = null;

const cc = () => (state.settings.claudeCode ||= {});
const agents = () => (state.settings.acpAgents ||= []);
const phoneAgent = () => agents().find((a) => a.id === AGENT_ID);

function show(id, on) {
  const n = $(id);
  if (n) n.hidden = !on;
}
function log(text) {
  const pre = $('#cc-log');
  if (!pre) return;
  pre.hidden = !text;
  const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = plain(text).replace(/^@@[A-Z_]+.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (near) pre.scrollTop = pre.scrollHeight;
}

/** The status line and which buttons make sense now. */
function render() {
  const line = $('#cc-status');
  if (!line) return;
  const run = bridgeState();
  const installed = !!st?.installed;
  show('#cc-stop', run.running || !!st?.running);
  show('#cc-chat', run.running);
  $('#cc-install').disabled = !!st?.installing || !!polling;
  $('#cc-install').textContent = installed ? 'Update' : 'Install';
  $('#cc-start').disabled = !installed || !!starting;
  $('#cc-start').textContent = run.running ? 'Restart' : 'Start';
  if (!st) return;
  const parts = [];
  if (st.unavailable) parts.push(st.unavailable);
  else {
    if (st.installing || polling) parts.push('Installing…');
    else if (installed) parts.push(`✓ Claude Code ${st.claude} installed (Node ${st.node})`);
    else if (st.nodeMajor && st.nodeMajor < NODE_MIN) parts.push(`Node ${st.node} is too old: Claude Code needs Node ${NODE_MIN} or newer. Remove and install Linux again (Settings › Linux terminal) to get the newest Alpine.`);
    else parts.push('Not installed yet.');
    if (installed) parts.push(st.auth === 'yes' ? `✓ ${authLabel(st)} (in Claude Code)` : `${authLabel(st)} – sign in inside Claude Code (step 2)`);
    if (run.running) parts.push(`● running on 127.0.0.1:${run.port} in ${run.cwd}`);
    else if (st.running) parts.push('● running from before – Restart to connect');
  }
  line.textContent = parts.join(' · ');
}

async function refresh() {
  if (!canUseShell()) {
    st = { unavailable: 'Claude Code in Linux works in the Android app, with the built-in Linux.' };
    return render();
  }
  const s = await shellStatus();
  if (!s.available) st = { unavailable: 'This phone cannot run the built-in Linux.' };
  else if (!s.installed) st = { unavailable: 'Install Linux first: Settings › Linux terminal › Install.' };
  else {
    try {
      st = await readStatus();
    } catch (e) {
      st = { unavailable: 'Linux did not answer: ' + (e.message || e) };
    }
    if (st.installing && !polling) follow();
    hooks.ccStatusSeen?.(st);
  }
  render();
}

/** Show the install's output as it comes (the install itself runs in Linux, detached). */
function follow() {
  if (polling) return;
  polling = (async () => {
    for (;;) {
      const r = await pollInstall().catch((e) => ({ state: 'failed', log: String(e?.message || e) }));
      log(r.log);
      if (r.state !== 'running') {
        if (r.state === 'done') toast(`Installed: Claude Code ${r.versions.claude || ''}`.trim());
        else if (r.state === 'node-old') toast(`Node ${r.nodeOld || ''} is too old – Claude Code needs Node ${NODE_MIN}+`);
        else if (r.state === 'failed') {
          // the end of the install's output says why: kept in the error log too
          logError('claudecode', 'Install failed: ' + (String(r.log || '').match(/@@FAIL[^\n]*/)?.[0] || String(r.log || '').trim().split('\n').slice(-3).join(' | ')));
          toast('The install stopped – see its output');
        }
        return;
      }
      render();
      await new Promise((res) => setTimeout(res, 1500));
    }
  })().finally(() => {
    polling = null;
    refresh();
  });
}

async function install() {
  $('#cc-install').disabled = true;
  log('Starting the install…');
  try {
    await startInstall();
    follow();
  } catch (e) {
    log(e.message || String(e));
    $('#cc-install').disabled = false;
  }
  render();
}

/** Start (or restart) the bridge and point the phone agent at it. */
function start(cwd = cc().cwd || '/root') {
  if (starting) return starting;
  starting = (async () => {
    hooks.acpForget?.(AGENT_ID);
    const r = await startBridge({ cwd });
    cc().cwd = cleanCwd(cwd);
    const entry = agentEntry(r.port, cwd);
    state.settings.acpAgents = [...agents().filter((a) => a.id !== AGENT_ID), entry];
    saveSettings(state.settings);
    hooks.renderAcpAgents?.();
    // an earlier attempt's error (another port, a start that timed out) no longer applies: it is running now
    log('');
    return entry;
  })().finally(() => {
    starting = null;
    render();
  });
  render();
  return starting;
}

hooks.ccRunning = () => bridgeState().running;

/**
 * Chronicle's enabled skills (packs and imported plugins too) as Claude Code skills in ~/.claude/skills (decision
 * 166), before a Claude Code session starts and whenever they changed: a signature of all of them is compared
 * first, so an unchanged set costs nothing. Only the folders Chronicle wrote are ever changed or removed.
 */
let skillsSynced = null; // the signature last written (null: not yet in this app run)
let skillsSyncing = null;
hooks.ccSyncSkills = async () => {
  if (skillsSyncing) return skillsSyncing;
  skillsSyncing = (async () => {
    const prepared = await ccSkills(state.settings.agentSkills);
    if (prepared.signature === skillsSynced) return null;
    const r = await syncCcSkills(null, { exec: (cmd) => ccExec(cmd), dir: DIR, prepared });
    skillsSynced = prepared.signature;
    if (r.user.length) console.warn('Claude Code skills: a folder of your own has the name, so it was left alone:', r.user.join(', '));
    return r;
  })().finally(() => (skillsSyncing = null));
  return skillsSyncing;
};
/** Before a message to the phone agent: running and answering with our secret, else started again. */
/**
 * Opening a Claude Code chat (or picking one of its models) starts Claude Code in the background (decision 178): after
 * an app update or restart Linux starts empty, and starting the bridge and Claude Code under proot takes a while – done
 * while you read and type instead of after you press send. Nothing happens when it already runs or is not set up.
 */
let warming = null;
hooks.ccWarm = (conv) => {
  const cc = conv?.acp ? conv.acp.agentId === AGENT_ID : !!hooks.ccShown?.();
  if (!cc || warming || bridgeState().running || !(st?.installed || hooks.ccIsReady?.())) return;
  warming = hooks
    .claudeCodeEnsure()
    .catch(() => {}) // a real send says what is wrong; a warm-up stays quiet
    .finally(() => (warming = null));
};

hooks.claudeCodeEnsure = async () => {
  if (bridgeState().running) {
    // a phone that just woke up (the app came back from the background) can be slow to answer for a few seconds: asked
    // again before Claude Code is restarted – a restart ends every open session, and the next message would have to
    // send the whole chat again (decision 234)
    for (let i = 0; i < 4; i++) {
      if (await bridgeHealthy()) return;
      if (i < 3) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
    logError('claudecode', 'Claude Code did not answer after 4 tries – starting it again (open sessions are reopened from disk when it can)');
  }
  if (!st?.installed) st = await readStatus().catch(() => st);
  hooks.ccStatusSeen?.(st);
  if (!st?.installed) throw new Error('Claude Code is not installed in Linux yet – Settings › Account & models › Claude Code');
  await start(phoneAgent()?.cwd || cc().cwd || '/root');
};

$('#cc-install').onclick = install;
$('#cc-recheck').onclick = () => refresh();
$('#cc-terminal').onclick = async () => {
  openSheet('#settings-sheet', false);
  // the user's own terminal with `claude` typed at the prompt: the user presses Enter and does the sign-in there
  if (canPty() && hooks.openFullTerminal) return hooks.openFullTerminal(LOGIN_SHELL, 'Terminal', { prefill: 'claude' });
  hooks.openSimpleTerminal?.();
  toast('Signing in needs the full terminal (☰ › Terminal) – the command box cannot show Claude Code');
};
$('#cc-start').onclick = async () => {
  try {
    await start(($('#cc-cwd').value || '/root').trim());
    toast('Claude Code is running – pick one of its models in the model picker, or New chat');
  } catch (e) {
    log(e.message || String(e));
    logError('claudecode', 'Start failed: ' + (e.message || String(e)));
    toast('Claude Code did not start');
  }
};
$('#cc-stop').onclick = async () => {
  hooks.acpForget?.(AGENT_ID);
  skillsSynced = null;
  await stopBridge().catch(() => {});
  toast('Claude Code in Linux stopped');
  refresh();
};
$('#cc-chat').onclick = () => {
  const a = phoneAgent();
  if (a) hooks.acpNewChat?.(a);
};
$('#cc-box').addEventListener('toggle', () => {
  if (!$('#cc-box').open) return;
  $('#cc-cwd').value = cc().cwd || '/root';
  refresh();
});
