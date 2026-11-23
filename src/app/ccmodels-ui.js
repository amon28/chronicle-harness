// Claude Code in Linux in the normal model picker (decision 165): a "Claude Code (your subscription)" section with
// the models the user's own Claude Code offers, a chat that picks one talks to it over ACP (acp-ui.js), and the
// subscription usage that Claude Code's own "/usage" reports. Chronicle offers no sign-in and reads no credentials:
// the picker only shows what the user's Claude Code CLI, signed in by the user in the 🐧 terminal, says.
import { $, convIsRp, el, hooks, isGroup, pref, state, toast } from './core.js';
import { cache, saveSettings } from '../store.js';
import { openSheet, persist } from './chatlist.js';
import { AGENT_ID, readStatus } from '../claudecode.js';
import { canUseShell, shellStatus } from '../shell.js';
import { readUpdate } from '../acp.js';
import { CC_MODEL } from '../api.js';
import { ccTaskInfo } from '../cctask.js';
import { CC_SECTION, ccModelEntries, ccModelFor, mergeModelCache, parseUsageMarkdown, routeToClaudeCode, usageSummary } from '../ccmodels.js';

const USAGE_FRESH = 4 * 60 * 1000; // a background refresh at most this often
const MODELS_FRESH = 12 * 60 * 60 * 1000; // the plan's model list is asked again after this
let modelCache = cache('ccModels');
let usage = cache('ccUsage');
let checked = false; // the status was asked of Linux once this app run (when none was cached)
let lastCheck = 0; // …and when (asked again while Claude Code is not set up)
let lastSeen = null; // what that check found (claude there, its adapter not: said in the picker)
let fetching = null;

/** What the card last read from Linux: installed and signed in (yes/no only – decision 163). */
const ready = () => cache('ccReady');
const isReady = () => !!ready()?.installed;
const rpHere = (conv = state.current) => !!conv && (convIsRp(conv) || isGroup(conv));
// Claude Code as a chat's model: in one-on-one roleplays too (decision 238 – the card goes with the session, the
// lorebook and author's note with each message), never in group chats (it plays one character in one session)
const groupHere = (conv = state.current) => !!conv && isGroup(conv);
// a roleplay does not follow the last Claude Code pick of other chats: it is on Claude Code only when picked in it
const opts = (conv) => ({ ready: isReady(), agentId: AGENT_ID, rp: groupHere(conv), follow: !rpHere(conv) });

hooks.ccStatusSeen = (st) => {
  if (!st || st.unavailable) return;
  cache('ccReady', { installed: !!st.installed, auth: st.auth || 'unknown', at: Date.now() });
};
/**
 * Is the claude_code tool offered in this chat (decision 167)? Only from the cached status (installed and signed in –
 * nothing is asked of Linux for it), never in roleplay or group chats; Settings' switch is checked in core.js.
 */
hooks.ccTaskInfo = (conv) => ccTaskInfo({ on: true, ready: ready(), rp: rpHere(conv), cache: modelCache });
/** The adapter sent its configOptions (a session started, the model changed): keep the model list. */
hooks.ccConfigSeen = (configOptions) => {
  modelCache = mergeModelCache(modelCache, configOptions);
  cache('ccModels', modelCache);
  hooks.updateModelUI?.();
  if ($('#model-sheet').classList.contains('open')) hooks.renderModelList?.();
};
/**
 * Claude Code's own "Default (recommended)" follows the plan; the adapter says which model it is now (description):
 * shown as "Default – Opus 5.5". Before the list is known: a placeholder while it loads.
 */
const named = (m) => {
  if (m.placeholder) return { ...m, name: 'Claude Code', description: '' };
  if (m.ccValue === 'default') return { ...m, name: m.description ? `Default – ${m.description}` : 'Default', description: 'Claude Code’s choice for your plan – change it in Claude Code with /model' };
  return m;
};
// "Default" first (it is Claude Code's own pick), then A–Z like the rest of the picker
const entries = () =>
  ccModelEntries(modelCache)
    .map(named)
    .sort((a, b) => (a.ccValue === 'default' ? -1 : b.ccValue === 'default' ? 1 : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })));
/**
 * The context window of a Claude model, by its name (Claude Code does not report it): 200K for Haiku 4.5 and the
 * Claude 4.5-and-older models, 1M for Claude 4.6 and later (Anthropic's model table); '' when the name says nothing.
 */
export function ccContext(m) {
  const t = `${m.name} ${m.description || ''}`.toLowerCase();
  const v = /(opus|sonnet|haiku|fable|mythos)\s*(\d+)(?:[.\s-](\d+))?/.exec(t);
  if (!v) return '';
  const major = +v[2];
  const minor = v[3] ? +v[3] : 0;
  return major > 4 || (major === 4 && minor >= 6) ? '1M' : '200K';
}
const entryFor = (value) => entries().find((m) => m.ccValue === value) || named({ ...ccModelEntries({ models: [{ value, name: value }] })[0], ...(value === 'default' ? { placeholder: true } : {}) });
/** The Claude Code model's window in tokens, by its name – until Claude Code reports its own (usage_update). */
hooks.ccWindow = () => {
  const m = hooks.ccShown?.();
  const c = m ? ccContext(m) : '';
  return c === '1M' ? 1e6 : c === '200K' ? 2e5 : 0;
};
/** Claude Code's models for Settings' background-job lists (decision 169): [id, label], none when it is not set up. */
hooks.ccJobModels = () => (isReady() && ready()?.auth !== 'no' ? entries().map((m) => [CC_MODEL + m.ccValue, `Claude Code · ${m.name}`]) : []);
/**
 * Claude Code's slash commands (decision 173), as its sessions announce them (available_commands_update): remembered
 * across app runs, for the "/" menu of a Claude Code chat.
 */
hooks.ccCommandsSeen = (list) => {
  if (!Array.isArray(list) || !list.length) return;
  cache('ccCommands', { at: Date.now(), list });
};
hooks.ccCommands = () => (isReady() ? cache('ccCommands')?.list || [] : []);
hooks.ccModelName = (value) => entryFor(value || 'default').name;

/** The Claude Code model the open chat uses (a model object for the header and the 🧠 chip), or null. */
hooks.ccShown = () => {
  const v = ccModelFor(state.current, state.settings, opts(state.current));
  return v ? entryFor(v) : null;
};
/** At send: a chat whose model is a Claude Code one becomes a Claude Code chat. */
hooks.ccRoute = (conv) => routeToClaudeCode(conv, state.settings, opts(conv));

/** A normal model was picked: a chat that picked Claude Code goes back to being a normal chat. */
hooks.ccLeave = () => {
  const conv = state.current;
  if (state.settings.ccPick && !rpHere(conv)) {
    state.settings.ccPick = null;
    saveSettings(state.settings);
  }
  if (conv?.acp && !conv.acp.cc) return toast(`This chat stays with ${conv.acp.agentId === AGENT_ID ? 'Claude Code' : 'its PC agent'} – the model is for other chats`);
  if (!conv?.acp?.cc) return;
  // the ACP session is let go: closed in Claude Code (its transcript stays in Claude Code's own history); picking
  // Claude Code again starts a new session that gets this chat so far as context
  hooks.acpCloseSession?.(AGENT_ID, conv.acp.sessionId);
  delete conv.acp;
  if (conv.messages.some((m) => !m.greeting)) persist(conv);
};

/** Whether Claude Code is set up here (installed, as last seen) – for the warm-up. */
hooks.ccIsReady = () => isReady();

function pick(m) {
  const conv = state.current;
  const rp = rpHere(conv); // a roleplay picks for itself, not for the next new chats (decision 238)
  if (!rp) {
    state.settings.ccPick = m.ccValue;
    saveSettings(state.settings);
  }
  if (conv?.acp && conv.acp.agentId !== AGENT_ID) toast('This chat talks to a PC agent – new chats will use Claude Code');
  else if (conv?.acp) conv.acp.model = m.ccValue;
  else if (conv && (rp || conv.messages.some((x) => !x.greeting))) conv.acp = { agentId: AGENT_ID, cc: true, model: m.ccValue };
  if (conv?.acp && conv.messages.some((x) => !x.greeting)) persist(conv);
  hooks.updateModelUI?.();
  openSheet('#model-sheet', false);
  if (!isReady() || ready()?.auth === 'no') toast('Sign in inside Claude Code first: Settings › Account & models › Claude Code', 4000);
  else hooks.ccWarm?.(state.current); // starts while you type the first message
}

const favKey = (m) => CC_MODEL + m.ccValue;
/** How many of Claude Code's models are favourites (the Favorites chip's count). */
hooks.ccFavCount = () => (isReady() && !groupHere() ? entries().filter((m) => hooks.isFav?.(favKey(m))).length : 0);
/**
 * Claude Code's models for the picker: notes (not signed in, its adapter missing) and one row per model, by name. The
 * picker puts the rows in A–Z among the other models (its "claude" badge and the Claude chip tell them apart); only
 * the Claude chip shows them under their own heading.
 */
hooks.ccModelRows = (q, current, { onlyFav = false } = {}) => {
  const notes = [];
  const rows = [];
  if (groupHere()) return { notes, rows };
  if (!isReady()) {
    // claude runs in the terminal, but the adapter Chronicle talks to it through is not there (a claude installed by
    // hand, or an install that stopped half way): said, instead of no Claude models and no reason
    if (lastSeen?.claude && !lastSeen.acp && !onlyFav && !q)
      notes.push(el('p', 'hint cc-note', `Claude Code ${lastSeen.claude} is in Linux, but the part that connects it to Chronicle (claude-agent-acp) is not – Settings › Account & models › Claude Code › Install adds it (your sign-in stays).`));
    return { notes, rows };
  }
  const items = entries().filter((m) => (!onlyFav || hooks.isFav?.(favKey(m))) && (!q || m.name.toLowerCase().includes(q) || m.ccValue.toLowerCase().includes(q) || 'claude code'.includes(q)));
  if (!items.length) return { notes, rows };
  if (ready()?.auth === 'no') notes.push(el('p', 'hint cc-note', 'Claude Code is not signed in yet – sign in inside Claude Code in the 🐧 terminal (Settings › Account & models › Claude Code).'));
  for (const m of items) {
    const active = current?.id === m.id;
    const b = el('button', 'model-item cc-model' + (active ? ' active' : ''));
    const top = el('div', 'model-top');
    top.append(el('span', 'model-title', m.name));
    if (active) top.append(el('span', 'check', '✓'));
    if (hooks.favStar && !m.placeholder) top.append(hooks.favStar(favKey(m), m.name));
    b.append(top);
    const badges = el('div', 'badges');
    badges.append(el('span', 'badge claude', 'claude'));
    const ctx = ccContext(m);
    if (ctx) badges.append(el('span', 'badge', ctx + ' ctx'));
    badges.append(el('span', 'badge', 'reasoning'), el('span', 'badge', 'vision'));
    b.append(badges);
    b.append(el('div', 'model-desc', m.placeholder ? (fetching ? 'Loading the models of your plan…' : 'Its own default model – the list of your plan’s models loads when Claude Code answers.') : m.description || 'Runs in your Claude Code in this phone’s Linux, on your own plan.'));
    b.onclick = () => pick(m);
    rows.push({ name: m.name, node: b, first: m.ccValue === 'default' });
  }
  return { notes, rows };
};
/** The Claude chip: Claude Code's models alone, under their own heading ("Default" first, then A–Z). */
hooks.renderCcModels = (list, q, current) => {
  const { notes, rows } = hooks.ccModelRows(q, current);
  if (!rows.length) return list.append(...notes);
  const head = el('div', 'cc-models-head');
  head.append(el('span', 'cc-models-title', CC_SECTION));
  list.append(head, ...notes, ...rows.map((r) => r.node));
};

/** The picker opened: the status once if none is known, the model list and usage when Claude Code is running. */
hooks.ccPickerOpened = () => {
  // once per app run when it is set up (Linux or Claude Code may have been removed, or signed out since); while it is
  // not, at every open (at most every 15 s) – installed meanwhile (Settings or the terminal), it shows up without a restart
  if ((!checked || (!isReady() && Date.now() - lastCheck > 15000)) && canUseShell()) {
    checked = true;
    lastCheck = Date.now();
    shellStatus()
      .then((s) => (s.installed ? readStatus() : { installed: false }))
      .then((st) => {
        if (!st) return;
        lastSeen = st;
        // gone (Linux or Claude Code really removed): no section until it is set up again; a check that could not tell
        // (Linux busy, a timeout) changes nothing
        if (st.installed === false && st.answered) cache('ccReady', null);
        else if (st.installed) hooks.ccStatusSeen(st);
        hooks.renderModelList?.();
        hooks.updateModelUI?.();
        if ($('#model-sheet').classList.contains('open')) modelsOrUsage(); // the first open of this app run
      })
      .catch(() => {});
  }
  modelsOrUsage();
};
// the models of the plan are shown as soon as the picker opens: when none are known yet (or they are more than half
// a day old), Claude Code is started in the background and asked – the same hidden session as the usage
function modelsOrUsage() {
  const stale = !modelCache?.models?.length || Date.now() - (modelCache.at || 0) > MODELS_FRESH;
  if (isReady() && ready()?.auth !== 'no' && !groupHere() && stale) {
    refreshUsage();
    hooks.renderModelList?.(); // "Loading the models of your plan…"
  } else refreshUsage({ background: true });
}
/** How many Claude Code models the picker shows (the "Claude" filter chip), 0 when it is not set up here. */
hooks.ccModelCount = () => (isReady() && !groupHere() ? entries().length : 0);

// ---------- subscription usage ----------
/** "/usage" in a session of the app's own (in no chat), closed afterwards. → the parsed usage or null. */
const usageOn = () => pref('showClaudeUsage') !== false;
async function fetchUsage() {
  const { client, watch } = await hooks.ccClient();
  const cwd = state.settings.acpAgents?.find((a) => a.id === AGENT_ID)?.cwd || '/root';
  const sid = await client.newSession(cwd);
  if (client.configs.get(sid)) hooks.ccConfigSeen(client.configs.get(sid));
  let text = '';
  watch(sid, (u) => {
    const r = readUpdate(u);
    if (r.text) text += r.text;
    if (r.commands) hooks.ccCommandsSeen(r.commands);
  });
  try {
    // the session itself carries the model list; "/usage" only when the usage is shown anywhere
    if (usageOn()) await client.prompt(sid, '/usage');
  } finally {
    watch(sid, null);
    client.closeSession(sid).catch(() => {});
  }
  return usageOn() ? parseUsageMarkdown(text) : null;
}

/**
 * Refresh the usage. In the background only when Claude Code already runs (it is never started for this) and the
 * last answer is older than a few minutes; on the usage sheet it is started when needed. Failures show nothing.
 */
async function refreshUsage({ background = false } = {}) {
  if (!isReady()) return null;
  if (background && !usageOn()) return null; // nothing to show: Claude Code is not asked in the background
  if (background && (!hooks.ccRunning?.() || (usage && Date.now() - usage.at < USAGE_FRESH))) return usage;
  if (fetching) return fetching;
  fetching = fetchUsage()
    .then((u) => {
      if (u) {
        usage = u;
        cache('ccUsage', u);
      }
      return usage;
    })
    .catch(() => usage)
    .finally(() => {
      fetching = null;
      renderUsageSheet();
      renderDrawerLine();
      if ($('#model-sheet').classList.contains('open')) hooks.renderModelList?.();
    });
  return fetching;
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
function renderUsageSheet() {
  const box = $('#ccu-list');
  if (!box) return;
  box.innerHTML = '';
  $('#ccu-status').textContent = fetching ? 'Asking your Claude Code…' : usage ? `As of ${fmtTime(usage.at)}` : '';
  if (!usage) {
    if (!fetching) box.append(el('p', 'hint', 'No usage to show (yet).'));
    return;
  }
  for (const w of usage.windows) {
    const row = el('div', 'meter' + (w.pct >= 100 ? ' limited' : w.pct >= 80 ? ' high' : ''));
    const top = el('div', 'meter-top');
    top.append(el('span', null, w.label), el('span', 'dim', `${Math.round(w.pct)}%${w.resetsAt ? ' · resets ' + fmtTime(w.resetsAt) : ''}`));
    const bar = el('div', 'meter-bar');
    const fill = el('i');
    fill.style.width = w.pct + '%';
    bar.append(fill);
    row.append(top, bar);
    box.append(row);
  }
}
function openUsage() {
  renderUsageSheet();
  openSheet('#cc-usage-sheet', true);
  const p = refreshUsage();
  renderUsageSheet();
  return p;
}
hooks.openCcUsage = openUsage;
$('#ccu-refresh').onclick = () => openUsage();

/** "in 3h 10m" / "2d": the drawer's short reset time, like the Go rows above it. */
function resetIn(t) {
  const d = t - Date.now();
  if (!t || Number.isNaN(d)) return '';
  if (d <= 0) return 'now';
  const mins = Math.ceil(d / 6e4);
  const h = Math.floor(mins / 60);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}
/**
 * The drawer's Claude Code usage: the same title row and meters as the OpenCode Go card, and joined to it as one
 * card when both show (decision 168). Only when Claude Code is set up and has answered.
 */
function renderDrawerLine() {
  const box = $('#cc-usage-line');
  if (!box) return;
  const shown = isReady() && usageOn() && !!usage?.windows?.length;
  const sum = shown ? usageSummary(usage, ' ') : '';
  const row = $('#cc-card-usage-row');
  if (row) row.hidden = !usageOn();
  const card = $('#cc-card-usage-sum');
  if (card) card.textContent = sum;
  box.hidden = !shown;
  box.innerHTML = '';
  if (!shown) return;
  const title = el('div', 'go-usage-title');
  title.append(hooks.usageName ? hooks.usageName('Claude Code usage', 'cc') : el('span', null, 'Claude Code usage'));
  const more = el('button', 'go-usage-link', 'Details');
  more.type = 'button';
  more.onclick = () => openUsage();
  title.append(more);
  box.append(title);
  const LABEL = { '5h': '5-hour', week: 'Weekly' };
  hooks.setUsageSum?.('cc', usage.windows.filter((x) => LABEL[x.key]).map((w) => `${w.key === '5h' ? '5h' : 'wk'} ${Math.round(Math.max(0, Math.min(100, w.pct)))}%`).join(' · '));
  for (const w of usage.windows.filter((x) => LABEL[x.key])) {
    const pct = Math.max(0, Math.min(100, w.pct));
    const r = el('div', 'meter' + (pct >= 100 ? ' limited' : pct >= 80 ? ' high' : ''));
    const top = el('div', 'meter-top');
    const when = w.resetsAt ? ` · resets ${resetIn(w.resetsAt)}` : '';
    top.append(el('span', null, LABEL[w.key]), el('span', 'dim', `${Math.round(pct)}%${when}`));
    const bar = el('div', 'meter-bar');
    const fill = el('i');
    fill.style.width = pct + '%';
    bar.append(fill);
    r.append(top, bar);
    box.append(r);
  }
}
hooks.ccDrawer = () => {
  renderDrawerLine();
  refreshUsage({ background: true });
};
$('#cc-card-usage').onclick = () => openUsage();
renderDrawerLine();
hooks.ccUsagePref = () => renderDrawerLine(); // Settings › Data › Show Claude subscription usage
