// The agent's plan tools: a to-do chip + list, and the question sheet for ask_user.
import { openSheet, selectConv } from './chatlist.js';
import { $, el, hooks, state, toast } from './core.js';
import { persist } from './chatlist.js';
import { acceptEvent, testEvent, PER_HOUR } from '../triggers.js';
import { netName } from '../lan.js';
import { forgetChatOks } from '../device.js';
import { toolLabel } from '../tools.js';

// ---------- to-do list ----------
function updateTodoChip() {
  const t = state.current?.todos || [];
  const btn = $('#todo-btn');
  const left = t.filter((x) => x.status !== 'done').length;
  btn.hidden = !t.length || !left; // gone once everything is done
  if (!btn.hidden) {
    const cur = t.find((x) => x.status === 'in_progress');
    btn.textContent = `📋 ${t.length - left}/${t.length}${cur ? ' · ' + cur.text.slice(0, 22) : ''}`;
  }
}
function renderTodoSheet() {
  const ul = $('#todo-items');
  ul.innerHTML = '';
  for (const it of state.current?.todos || []) ul.append(el('li', 'todo-' + it.status, `${it.status === 'done' ? '☑' : it.status === 'in_progress' ? '▶' : '☐'} ${it.text}`));
}
hooks.todosChanged = () => {
  updateTodoChip();
  if ($('#todo-sheet').classList.contains('open')) renderTodoSheet();
  persist();
};
$('#todo-btn').onclick = () => {
  renderTodoSheet();
  openSheet('#todo-sheet', true);
};
$('#todo-clear').onclick = () => {
  delete state.current.todos;
  updateTodoChip();
  openSheet('#todo-sheet', false);
  persist();
  toast('Cleared');
};
// ---------- goal (/goal or the goal tool) ----------
function updateGoalChip() {
  const g = state.current?.goal;
  const btn = $('#goal-btn');
  btn.hidden = !g || g.status === 'done';
  if (btn.hidden) return;
  btn.classList.toggle('blocked', g.status === 'blocked');
  btn.textContent = g.status === 'blocked' ? '⛔ Goal blocked' : `🎯 ${g.text.slice(0, 26)}${g.text.length > 26 ? '…' : ''}`;
}
hooks.goalChanged = () => {
  updateGoalChip();
  persist();
};
$('#goal-btn').onclick = () => {
  const g = state.current?.goal;
  if (!g) return;
  const info = `Goal (${g.status === 'active' ? 'open' : g.status}, ${g.steps || 0} tool steps so far):\n\n${g.text}${g.summary ? `\n\n${g.summary}` : ''}\n\nWhile a goal is open the assistant keeps working past the usual step limit until it says the goal is done or blocked.`;
  if (confirm(info + '\n\nDrop this goal?')) {
    delete state.current.goal;
    hooks.goalChanged();
    toast('Goal dropped');
  }
};

// ---------- plan mode (/plan) ----------
function updatePlanChip() {
  $('#plan-btn').hidden = true; // the agent-mode chip shows "📋 Plan" now (one switch for Auto / Ask first / Plan)
}
hooks.planChanged = updatePlanChip;
$('#plan-btn').onclick = () => {
  if (confirm('Plan mode is on: the assistant looks around and proposes a plan, and changes nothing until you approve it.\n\nTurn plan mode off?')) hooks.togglePlanMode?.();
};

// ---------- scheduled tasks (schedule_task) ----------
function updateSchedChip() {
  const l = state.current?.schedules || [];
  const btn = $('#sched-btn');
  btn.hidden = !l.length;
  if (l.length) btn.textContent = `⏰ ${l.length}`;
}
hooks.scheduleChanged = updateSchedChip;
$('#sched-btn').onclick = () => openScheduled();
$('#open-sched').onclick = () => openScheduled();

const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
/** Every chat's scheduled tasks: when next, how often, quiet or not, the last runs – run one now, cancel it, open its chat. */
function openScheduled() {
  const box = $('#sched-list');
  box.innerHTML = '';
  const soon = (c) => (c.schedules?.length ? Math.min(...c.schedules.map((t) => t.next ?? Infinity)) : Infinity);
  const chats = (state.convs || []).filter((c) => c.schedules?.length || c.schedDone?.length).sort((a, b) => (b === state.current) - (a === state.current) || soon(a) - soon(b));
  if (!chats.length) box.append(el('p', 'hint pad', 'Nothing is scheduled. Ask the assistant to "check this every hour" or "remind me tomorrow at 9" – it sets it up with schedule_task.'));
  for (const c of chats) {
    box.append(el('h3', 'section', c.title || 'New chat'));
    for (const t of [...(c.schedules || [])].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity))) {
      const row = el('div', 'sched-row');
      row.append(el('div', 'sched-prompt', t.prompt));
      // a trigger (notification / place) runs on an event, not at a time
      const meta = t.when ? [t.when.place ? `📍 place · ${t.when.place.on === 'leave' ? 'leave' : 'arrive'} ${t.when.place.label} (${t.when.place.radius} m)` : `🔔 notification · ${t.when.notification?.label || t.when.notification?.app}${t.when.notification?.contains ? ` containing “${t.when.notification.contains}”` : ''}`, `quiet · at most ${PER_HOUR} an hour`].join(' · ') : [`next ${when(t.next)}`, t.every ? `every ${t.every >= 60 && t.every % 60 === 0 ? `${t.every / 60} h` : `${t.every} min`}` : 'once', t.left != null ? `${t.left} runs left` : '', t.quiet ? 'quiet – only when something is new' : ''].filter(Boolean).join(' · ');
      row.append(el('div', 'hint', meta));
      if (t.history?.length) {
        const h = el('div', 'sched-history');
        for (const r of [...t.history].reverse().slice(0, 4)) h.append(el('div', null, `${when(r.at)} – ${r.result}`));
        row.append(h);
      }
      const acts = el('div', 'row gap-sm wrap');
      const run = el('button', 'ghost-btn small', '▶ Run now');
      run.onclick = () => {
        if (t.when) {
          const r = acceptEvent(t, testEvent(t)); // a test run: its message says nothing happened
          if (!r.ok) return toast(r.why.replace(/^skipped – /, 'Not now – '));
        } else t.next = Date.now() - 1;
        persist(c);
        hooks.runSchedulesNow?.();
        if (state.runs.has(c.id)) toast('The chat is busy – it runs as soon as the current reply is done');
        else toast(t.quiet ? 'Checking – it shows up only if something is new' : 'Running it now');
        setTimeout(openScheduled, 400);
      };
      const cancel = el('button', 'ghost-btn small', 'Cancel');
      cancel.onclick = () => {
        c.schedules = c.schedules.filter((x) => x.id !== t.id);
        persist(c);
        hooks.syncTriggers?.(); // a trigger: Android stops watching for it
        updateSchedChip();
        openScheduled();
      };
      const open = el('button', 'ghost-btn small', 'Open chat');
      open.onclick = () => {
        openSheet('#sched-sheet', false);
        selectConv(c.id);
      };
      acts.append(run, cancel, ...(c === state.current ? [] : [open]));
      row.append(acts);
      box.append(row);
    }
    // one-off tasks that already ran: what came of them
    for (const d of [...(c.schedDone || [])].reverse().slice(0, 3)) {
      const row = el('div', 'sched-row done');
      row.append(el('div', 'sched-prompt', d.prompt), el('div', 'sched-history', `${when(d.at)} – ${d.result}`));
      box.append(row);
    }
  }
  const n = (state.convs || []).reduce((k, c) => k + (c.schedules?.length || 0), 0);
  $('#open-sched-sum').textContent = n ? `${n} scheduled, in ${chats.length} chat${chats.length === 1 ? '' : 's'}` : 'What the assistant will do later, in every chat';
  openSheet('#sched-sheet', true);
}
hooks.openScheduled = openScheduled;

// ---------- what this chat was allowed (decision 271) ----------
const DEVICE_OK = { calendar: '🗓 Read the calendar', contacts: '👥 Look up contacts', location: '📍 Approximate location', 'precise location': '📍 Exact location', places: '🗺 Places nearby', wifi: '📶 Wi-Fi names' };
function grantsOf(c) {
  const out = [];
  if (c?.lanGrant?.ips?.length) out.push({ key: 'lan', text: `🏠 Local network: ${c.lanGrant.ips.join(', ')} – on ${netName(c.lanGrant.net)}` });
  for (const w of c?.deviceOks || []) out.push({ key: 'dev:' + w, text: DEVICE_OK[w] || w });
  for (const t of c?.allowedTools || []) out.push({ key: 'tool:' + t, text: `✅ ${toolLabel(t)} without asking` });
  return out;
}
function updateGrantsChip() {
  const c = state.current;
  const g = grantsOf(c);
  const btn = $('#grants-btn');
  btn.hidden = !g.length;
  if (btn.hidden) return;
  btn.textContent = c.lanGrant?.ips?.length ? `🏠 ${c.lanGrant.ips.length === 1 ? c.lanGrant.ips[0] : `${c.lanGrant.ips.length} local`}${g.length > 1 ? ` +${g.length - 1}` : ''}` : `🔓 ${g.length} allowed`;
  btn.title = 'What this chat was allowed – tap to see or take back';
}
function takeBack(c, key) {
  if (key === 'lan') delete c.lanGrant;
  else if (key.startsWith('dev:')) {
    c.deviceOks = (c.deviceOks || []).filter((w) => w !== key.slice(4));
    forgetChatOks(c.id, key.slice(4));
  } else if (key.startsWith('tool:')) c.allowedTools = (c.allowedTools || []).filter((t) => t !== key.slice(5));
}
function renderGrants() {
  const ul = $('#grants-items');
  ul.innerHTML = '';
  for (const g of grantsOf(state.current)) {
    const li = el('li', 'grant-row');
    li.append(el('span', 'grant-text', g.text));
    const x = el('button', 'ghost-btn small grant-x', 'Take back');
    x.dataset.key = g.key;
    x.onclick = () => {
      takeBack(state.current, g.key);
      hooks.grantsChanged(state.current);
      if (!grantsOf(state.current).length) openSheet('#grants-sheet', false);
      else renderGrants();
      toast('Taken back');
    };
    li.append(x);
    ul.append(li);
  }
}
hooks.grantsChanged = (c) => {
  if (c && c !== state.current) return void persist(c);
  updateGrantsChip();
  persist();
};
$('#grants-btn').onclick = () => {
  renderGrants();
  openSheet('#grants-sheet', true);
};
$('#grants-clear').onclick = () => {
  for (const g of grantsOf(state.current)) takeBack(state.current, g.key);
  hooks.grantsChanged(state.current);
  openSheet('#grants-sheet', false);
  toast('Everything taken back');
};

const prev = hooks.toolsChanged;
hooks.toolsChanged = () => {
  prev?.();
  updateGrantsChip();
  updateTodoChip();
  updateGoalChip();
  updateSchedChip();
  updatePlanChip();
};

// ---------- ask_user ----------
// Questions belong to the chat that asked them: they open only while that chat is on screen (the side menu marks a chat
// that is waiting for you with ❓). Tapping outside never answers: "hide" keeps the question, a chip reopens it.
const queue = []; // { convId, convTitle, questions: [{question, options}], answers: [], page, resolve, reject, hidden }
const SKIP = '(no preference – decide for yourself and say what you chose)';
const here = () => queue.find((r) => r.convId === state.current?.id);
let shown = null;

function syncAsking() {
  state.asking = new Set(queue.map((r) => r.convId));
  hooks.syncRuns?.(); // repaints the chat list
}
function resolveReq(r, answers) {
  hooks.clearAskNotification?.(r.convId);
  const i = queue.indexOf(r);
  if (i >= 0) queue.splice(i, 1);
  if (shown === r) {
    shown = null;
    openSheet('#ask-sheet', false);
  }
  syncAsking();
  updateChip();
  r.resolve(answers);
}
/** An answer from a notification: the oldest question waiting in that chat gets it. */
hooks.answerAsk = (convId, answer) => {
  const r = queue.find((x) => x.convId === convId);
  if (!r || answer == null || answer === '') return;
  resolveReq(r, r.questions.map((_, i) => (i === 0 ? String(answer) : SKIP)));
};
function updateChip() {
  const r = here();
  $('#ask-chip').hidden = !(r && (r.hidden || shown !== r));
}
function paint() {
  const r = shown;
  if (!r) return;
  const q = r.questions[r.page];
  const multi = r.questions.length > 1;
  $('#ask-title').textContent = multi ? `Questions` : 'Question';
  $('#ask-pager').hidden = !multi;
  $('#ask-page').textContent = `${r.page + 1} / ${r.questions.length}`;
  $('#ask-prev').disabled = r.page === 0;
  $('#ask-next').disabled = r.page === r.questions.length - 1;
  $('#ask-question').textContent = q.question;
  const box = $('#ask-options');
  box.innerHTML = '';
  for (const o of q.options) {
    const b = el('button', 'menu-item' + (r.answers[r.page] === o ? ' current' : ''), o);
    b.onclick = () => choose(o);
    box.append(b);
  }
  $('#ask-other').value = r.answers[r.page] && !q.options.includes(r.answers[r.page]) && r.answers[r.page] !== SKIP ? r.answers[r.page] : '';
  const last = r.page === r.questions.length - 1;
  $('#ask-send').textContent = multi ? (last ? 'Send answers' : 'Next ›') : 'Answer';
  $('#ask-skip').textContent = multi ? 'Skip this one' : 'Skip – you decide';
}
function choose(value) {
  const r = shown;
  if (!r) return;
  r.answers[r.page] = value;
  if (r.questions.length === 1) return resolveReq(r, [value]);
  if (r.page < r.questions.length - 1) r.page++;
  paint();
}
function sendAll() {
  const r = shown;
  if (!r) return;
  const answers = r.questions.map((_, i) => r.answers[i] || SKIP);
  resolveReq(r, answers);
}
/** Open the question that belongs to the chat on screen (if there is one and it was not hidden). */
function showHere() {
  const r = here();
  if (shown && shown !== r) {
    openSheet('#ask-sheet', false);
    shown = null;
  }
  if (r && !r.hidden && shown !== r) {
    shown = r;
    paint();
    openSheet('#ask-sheet', true);
  }
  updateChip();
}
hooks.askUser = ({ questions, convId, convTitle, signal }) =>
  new Promise((resolve, reject) => {
    const r = { convId, convTitle, questions: questions.map((q) => ({ question: q.question, options: q.options || [] })), answers: [], page: 0, resolve, reject, hidden: false };
    queue.push(r);
    syncAsking();
    showHere();
    // in the background: the question also goes to a notification you can answer from the shade
    if (r.questions.length === 1) hooks.notifyAsk?.({ convId, convTitle, question: r.questions[0].question, options: r.questions[0].options });
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(r);
      if (i < 0) return;
      queue.splice(i, 1);
      if (shown === r) {
        shown = null;
        openSheet('#ask-sheet', false);
      }
      syncAsking();
      updateChip();
      reject(new Error('Stopped'));
    });
  });
$('#ask-send').onclick = () => {
  const r = shown;
  if (!r) return;
  const v = $('#ask-other').value.trim();
  if (v) r.answers[r.page] = v;
  if (r.questions.length === 1) return v ? choose(v) : toast('Type an answer, or pick one of the options');
  if (r.page < r.questions.length - 1) {
    r.page++;
    return paint();
  }
  sendAll();
};
$('#ask-other').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('#ask-send').click()));
$('#ask-skip').onclick = () => {
  const r = shown;
  if (!r) return;
  if (r.questions.length === 1) return resolveReq(r, [SKIP]);
  r.answers[r.page] = SKIP;
  if (r.page < r.questions.length - 1) r.page++;
  paint();
};
$('#ask-prev').onclick = () => {
  if (shown && shown.page > 0) {
    const r = shown;
    const v = $('#ask-other').value.trim();
    if (v) r.answers[r.page] = v;
    r.page--;
    paint();
  }
};
$('#ask-next').onclick = () => {
  const r = shown;
  if (r && r.page < r.questions.length - 1) {
    const v = $('#ask-other').value.trim();
    if (v) r.answers[r.page] = v;
    r.page++;
    paint();
  }
};
// hiding (the arrow, or Android's back button) keeps the question; the chip brings it back
$('#ask-hide').onclick = () => {
  if (shown) shown.hidden = true;
  shown = null;
  openSheet('#ask-sheet', false);
  updateChip();
};
new MutationObserver(() => {
  if (shown && !$('#ask-sheet').classList.contains('open')) {
    shown.hidden = true;
    shown = null;
    updateChip();
  }
}).observe($('#ask-sheet'), { attributes: true, attributeFilter: ['class'] });
$('#ask-chip').onclick = () => {
  const r = here();
  if (!r) return;
  r.hidden = false;
  showHere();
};
// switching chats: the sheet follows the chat
const prevSync = hooks.syncRuns;
hooks.syncRuns = () => {
  prevSync?.();
  showHere();
};
