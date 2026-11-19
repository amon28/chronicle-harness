// One small editor for two kinds of user rules: 🔁 regex scripts (roleplay) and 🪝 hooks (agent).
import { saveSettings } from '../store.js';
import { applyRegexScripts, compileFind, newRegexScript } from '../regexscripts.js';
import { HOOK_EVENTS, newHook } from '../hooks.js';
import { PERMISSION_TOOLS } from '../permissions.js';
import { openSheet } from './chatlist.js';
import { $, el, personas, state } from './core.js';

const KINDS = {
  regex: {
    key: 'regexScripts',
    title: '🔁 Regex scripts',
    hint: 'Find & replace on messages, like SillyTavern. "Saved" changes the message once when it is written; "Only shown" changes what you see; "Only sent" changes what the model gets. Find: plain text, or a regex like /\\*+/g. In Replace, $1 or {{match}} insert what was found.',
    make: newRegexScript,
    render: regexCard,
  },
  hooks: {
    key: 'hooks',
    title: '🪝 Hooks',
    hint: 'Your own shell commands at fixed points of the agent loop, run in the chat\'s built-in Linux (Settings › Linux terminal) in /workspace. Exit code 2 blocks: a tool call is refused, or the agent must keep working instead of finishing. Other failures are only reported. The command sees $TOOL_NAME, $TOOL_ARGS (JSON) and $TOOL_RESULT.',
    make: newHook,
    render: hookCard,
  },
  perms: {
    key: 'toolPerms',
    title: '🔐 Tool permissions',
    hint: 'Allow: the assistant uses it freely. Ask: you get a question before each call ("Allow once", "Allow for this chat", "Deny" – or type what it should do instead). Never: the tool is refused. Hooks can add finer rules (e.g. only block "rm -rf").',
    static: true,
  },
};
let kind = 'regex';
const list = () => (state.settings[KINDS[kind].key] ||= []);
const perms = () => (state.settings.toolPerms ||= {});
const save = () => saveSettings(state.settings);

function input(value, onInput, attrs = {}) {
  const i = el(attrs.multiline ? 'textarea' : 'input', 'field' + (attrs.mono ? ' mono' : ''));
  if (attrs.multiline) i.rows = attrs.rows || 2;
  if (attrs.placeholder) i.placeholder = attrs.placeholder;
  if (attrs.type) i.type = attrs.type;
  i.value = value ?? '';
  i.spellcheck = false;
  i.autocapitalize = 'off';
  i.oninput = () => {
    onInput(i.value);
    save();
  };
  return i;
}
function select(options, value, onChange) {
  const s = el('select', 'field');
  for (const [v, label] of options) {
    const o = el('option', null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.onchange = () => {
    onChange(s.value);
    save();
  };
  return s;
}
function check(label, value, onChange) {
  const l = el('label', 'toggle small');
  const c = el('input');
  c.type = 'checkbox';
  c.checked = !!value;
  c.onchange = () => {
    onChange(c.checked);
    save();
  };
  l.append(c, el('span', null, label));
  return l;
}
function head(r, i) {
  const h = el('div', 'row gap-sm rule-head');
  h.append(check('On', r.enabled !== false, (v) => (r.enabled = v)), input(r.name, (v) => (r.name = v), { placeholder: 'Name (for you)' }));
  const del = el('button', 'icon-btn small', '🗑');
  del.title = 'Delete';
  del.onclick = () => {
    list().splice(i, 1);
    save();
    render();
  };
  h.append(del);
  return h;
}

function regexCard(r, i) {
  const card = el('div', 'rule-card');
  const preview = el('div', 'hint mono rule-preview');
  const test = input('', () => upd(), { placeholder: 'Try it: type a sample message here' });
  const upd = () => {
    const bad = r.find && !compileFind(r.find);
    preview.textContent = bad ? '⚠ That pattern is not a valid regex.' : test.value ? '→ ' + applyRegexScripts(test.value, [{ ...r, enabled: true }], { who: (r.on || ['ai'])[0], stage: r.stage || 'save', personaId: r.personaId || null }) : '';
  };
  const who = el('div', 'row gap-sm');
  const on = new Set(r.on || ['ai']);
  for (const [k, label] of [['ai', 'Character / AI messages'], ['user', 'My messages']])
    who.append(
      check(label, on.has(k), (v) => {
        if (v) on.add(k);
        else on.delete(k);
        r.on = [...on];
        upd();
      }),
    );
  const chars = [['', 'Every character'], ...personas().map((p) => [p.id, p.name])];
  card.append(
    head(r, i),
    input(r.find, (v) => ((r.find = v), upd()), { placeholder: 'Find, e.g. /\\*([^*]+)\\*/g or plain text', mono: true }),
    input(r.replace, (v) => ((r.replace = v), upd()), { placeholder: 'Replace with ("" removes it)', mono: true }),
    who,
    el('div', 'row gap-sm', ''),
  );
  const row = card.lastChild;
  row.append(select([['save', 'Saved (changes the message)'], ['display', 'Only shown'], ['prompt', 'Only sent to the model']], r.stage || 'save', (v) => ((r.stage = v), upd())), select(chars, r.personaId || '', (v) => (r.personaId = v || undefined)));
  card.append(test, preview);
  return card;
}

function hookCard(h, i) {
  const card = el('div', 'rule-card');
  const row = el('div', 'row gap-sm');
  const matcher = input(h.matcher, (v) => (h.matcher = v), { placeholder: 'Tools (regex), e.g. write_file|edit_file – empty = all', mono: true });
  matcher.hidden = !/tool/.test(h.event);
  row.append(
    select(HOOK_EVENTS, h.event || 'post_tool', (v) => {
      h.event = v;
      matcher.hidden = !/tool/.test(v);
    }),
    el('span', 'hint inline', 'timeout s'),
    input(String(h.timeout ?? 60), (v) => (h.timeout = Math.max(1, Math.min(600, Number(v) || 60))), { type: 'number' }),
  );
  row.lastChild.classList.add('num');
  card.append(head(h, i), row, matcher, input(h.command, (v) => (h.command = v), { placeholder: 'Shell command, e.g. npx prettier -w "$(echo $TOOL_ARGS | jq -r .path)"', mono: true, multiline: true, rows: 3 }));
  return card;
}

function renderPerms(box) {
  for (const [name, label] of PERMISSION_TOOLS) {
    const row = el('div', 'row gap-sm perm-row');
    row.append(
      el('span', 'perm-label', label),
      select([['allow', 'Allow'], ['ask', 'Ask me'], ['deny', 'Never']], perms()[name] || 'allow', (v) => {
        if (v === 'allow') delete perms()[name];
        else perms()[name] = v;
      }),
    );
    box.append(row);
  }
}

function render() {
  const k = KINDS[kind];
  $('#rules-title').textContent = k.title;
  $('#rules-hint').textContent = k.hint;
  $('#rules-add').hidden = !!k.static;
  const box = $('#rules-list');
  box.innerHTML = '';
  if (k.static) return renderPerms(box);
  if (!list().length) box.append(el('p', 'hint pad', 'Nothing yet.'));
  list().forEach((r, i) => box.append(k.render(r, i)));
  if (kind === 'hooks' && !list().length) {
    const ex = el('div', 'hint');
    ex.append(el('b', null, 'Examples: '), 'after write_file|edit_file → ', el('code', null, 'npx prettier -w . >/dev/null && echo formatted'), '; before shell → ', el('code', null, 'echo "$TOOL_ARGS" | grep -q "rm -rf" && { echo "no rm -rf"; exit 2; } || true'), '; when the reply would end → ', el('code', null, 'npm test >/tmp/t.log 2>&1 || { tail -30 /tmp/t.log; exit 2; }'));
    box.append(ex);
  }
}

export function openRules(k) {
  kind = k;
  render();
  openSheet('#settings-sheet', false);
  openSheet('#rules-sheet', true);
}
$('#rules-add').onclick = () => {
  list().push(KINDS[kind].make());
  save();
  render();
};
$('#open-regex').onclick = () => openRules('regex');
$('#open-hooks').onclick = () => openRules('hooks');
$('#open-perms').onclick = () => openRules('perms');
