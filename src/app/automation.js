// Automation (Tasker, MacroDroid, a home-screen shortcut…): chronicle://run?token=…&prompt=… runs a prompt (or
// recipe=name&args=…) in a new chat and broadcasts the reply back. Each caller app gets its own token
// (Settings › Agent › 🤖 Automation); a link without a valid token runs nothing.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { $, el, hooks, personaById, state, toast, uid } from './core.js';
import { saveSettings } from '../store.js';
import { newChat, openDrawer, openSheet } from './chatlist.js';
import { setChatPersona } from './render.js';
import { autoGrow, input, send } from './engine.js';
import { askText } from './choose.js';

const Automation = globalThis.__ocmAutomation || (Capacitor.isNativePlatform() ? registerPlugin('Automation') : null);
const callers = () => (state.settings.automation ||= []);
const tokenOk = (t) => {
  const c = callers().find((x) => x.token && x.token === String(t || ''));
  if (c) c.lastUsed = Date.now();
  return c || null;
};

async function finished(conv, from, timeoutMs = 15 * 60 * 1000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const last = conv.messages[conv.messages.length - 1];
    if (!state.runs.has(conv.id) && conv.messages.length > from && last?.role === 'assistant' && !last.streaming) return last;
    if (Date.now() > until) throw new Error('Timed out');
  }
}

/** The link from a caller. → handled (true) or not ours. */
hooks.automationRun = async (u) => {
  const caller = tokenOk(u.searchParams.get('token'));
  if (!caller) {
    toast('An app tried to run something in Chronicle without a valid token – create one in Settings › Agent › 🤖 Automation', 5000);
    return true;
  }
  const prompt = (u.searchParams.get('prompt') || '').trim();
  const recipe = (u.searchParams.get('recipe') || '').trim().toLowerCase();
  const reply = { id: u.searchParams.get('id') || uid().slice(0, 8), action: u.searchParams.get('reply_action') || undefined, package: u.searchParams.get('reply_package') || caller.package || undefined };
  const back = (o) => Automation?.reply({ ...reply, ...o }).catch(() => {});
  if (!prompt && !recipe) {
    back({ ok: false, error: 'Give prompt=… or recipe=…' });
    return true;
  }
  document.querySelectorAll('.sheet.open').forEach((x) => openSheet('#' + x.id, false));
  openDrawer(false);
  newChat();
  const conv = state.current;
  delete conv.permMode; // another app started this run, nobody is here: the default ⚡ Bypass for new chats is not for it
  conv.title = `🤖 ${caller.name}: ${(prompt || recipe).slice(0, 40)}`;
  conv.automation = { caller: caller.name, at: Date.now() };
  const pid = u.searchParams.get('persona');
  if (pid && personaById(pid)) setChatPersona(pid);
  saveSettings(state.settings);
  try {
    const from = conv.messages.length;
    if (recipe) {
      const ok = await hooks.runRecipe(conv, recipe, u.searchParams.get('args') || '');
      if (!ok) throw new Error(`The recipe ${recipe} stopped`);
    } else {
      input.value = prompt;
      autoGrow();
      send();
    }
    const last = await finished(conv, from);
    if (last.error) throw new Error(String(last.error).split('\n')[0]);
    back({ ok: true, text: last.content || '', chat: conv.id });
  } catch (e) {
    back({ ok: false, error: e.message, chat: conv.id });
  }
  return true;
};

// ---------- Settings › Agent › 🤖 Automation ----------
function renderCallers() {
  const list = $('#auto-list');
  list.innerHTML = '';
  if (!callers().length) list.append(el('p', 'hint pad', 'No apps can run things yet.'));
  for (const c of callers()) {
    const row = el('div', 'persona-item');
    const t = el('div', 'persona-text');
    const link = `chronicle://run?token=${c.token}&prompt=…`;
    t.append(el('div', 'persona-title', c.name + (c.package ? ` (${c.package})` : '')), el('div', 'persona-desc mono', link), el('div', 'persona-desc', c.lastUsed ? `last used ${new Date(c.lastUsed).toLocaleString()}` : 'not used yet'));
    const copy = el('button', 'act', 'Copy link');
    copy.onclick = () => navigator.clipboard?.writeText(`chronicle://run?token=${c.token}&prompt=`).then(() => toast('Copied – add your prompt after prompt=')).catch(() => toast(link));
    const rm = el('button', 'act', 'Revoke');
    rm.onclick = () => {
      state.settings.automation = callers().filter((x) => x !== c);
      saveSettings(state.settings);
      renderCallers();
    };
    row.append(t, copy, rm);
    list.append(row);
  }
}
$('#auto-add').onclick = async () => {
  const name = (await askText('Which app is this for?', 'Tasker', { hint: 'e.g. Tasker or MacroDroid', ok: 'Add', max: 40 }))?.trim();
  if (!name) return;
  const pkg = /tasker/i.test(name) ? 'net.dinglisch.android.taskerm' : /macrodroid/i.test(name) ? 'com.arlosoft.macrodroid' : '';
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  const token = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 24);
  callers().push({ name: name.slice(0, 40), token, package: pkg, created: Date.now() });
  saveSettings(state.settings);
  renderCallers();
};
$('#auto-box').addEventListener('toggle', () => $('#auto-box').open && renderCallers());
