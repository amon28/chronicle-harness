// 🧪 Prompt test: send one message to several models and/or system prompts at once and compare the answers side by side.
import { streamChat } from '../api.js';
import { openSheet } from './chatlist.js';
import { $, chatPrompt, el, state, toast, userName } from './core.js';
import { modelName } from './render.js';

const MAX = 4;
let variants = [];
let running = [];

function renderVariants() {
  const box = $('#pt-variants');
  box.innerHTML = '';
  variants.forEach((v, i) => {
    const card = el('div', 'pt-variant');
    const head = el('div', 'row gap-sm');
    head.append(el('b', null, String.fromCharCode(65 + i)));
    const model = el('select', 'field');
    for (const m of state.models) {
      const o = el('option', null, m.name || m.id);
      o.value = m.id;
      model.append(o);
    }
    model.value = v.model;
    model.onchange = () => (v.model = model.value);
    const prompt = el('select', 'field');
    for (const [val, label] of [['current', "This chat's prompt"], ['none', 'No system prompt'], ['custom', 'Custom prompt…']]) {
      const o = el('option', null, label);
      o.value = val;
      prompt.append(o);
    }
    prompt.value = v.prompt;
    prompt.onchange = () => {
      v.prompt = prompt.value;
      renderVariants();
    };
    head.append(model, prompt);
    if (variants.length > 2) {
      const x = el('button', 'icon-btn small', '✕');
      x.onclick = () => {
        variants.splice(i, 1);
        renderVariants();
      };
      head.append(x);
    }
    card.append(head);
    if (v.prompt === 'custom') {
      const ta = el('textarea', 'field');
      ta.rows = 3;
      ta.placeholder = 'You are …';
      ta.value = v.custom;
      ta.oninput = () => (v.custom = ta.value);
      card.append(ta);
    }
    const out = el('div', 'pt-out');
    out.id = 'pt-out-' + i;
    out.textContent = v.text || '';
    card.append(out, el('div', 'hint', v.stat || ''));
    box.append(card);
  });
  $('#pt-add').hidden = variants.length >= MAX;
}

function openPromptTest() {
  const conv = state.current;
  const last = [...(conv?.messages || [])].reverse().find((m) => m.role === 'user');
  $('#pt-msg').value = last?.content || '';
  const cur = state.settings.model || state.models[0]?.id;
  const other = state.models.find((m) => m.id !== cur)?.id || cur;
  variants = [
    { model: cur, prompt: 'current', custom: '', text: '', stat: '' },
    { model: other, prompt: 'current', custom: '', text: '', stat: '' },
  ];
  renderVariants();
  openSheet('#pt-sheet', true);
}

function run() {
  const conv = state.current;
  const msg = $('#pt-msg').value.trim();
  if (!msg) return toast('Type the message to test');
  if (!state.settings.apiKey && !state.settings.providers?.length) return toast('Set your API key first');
  for (const h of running) h.cancel?.();
  running = [];
  const withChat = $('#pt-ctx').checked;
  const history = withChat ? (conv?.messages || []).filter((m) => m.content && !m.streaming && !m.hidden).slice(-10).map((m) => ({ role: m.role, content: m.content })) : [];
  $('#pt-run').disabled = true;
  let left = variants.length;
  variants.forEach((v, i) => {
    v.text = '';
    v.stat = 'Waiting…';
    const sys = v.prompt === 'current' ? chatPrompt(conv).replace(/\{\{user\}\}/gi, userName(conv)) : v.prompt === 'custom' ? v.custom : '';
    const t0 = performance.now();
    const set = () => {
      const o = document.getElementById('pt-out-' + i);
      if (o) {
        o.textContent = v.text;
        o.nextSibling.textContent = v.stat;
      }
    };
    const finish = () => {
      if (--left === 0) $('#pt-run').disabled = false;
    };
    const h = streamChat(state.settings, { model: v.model, sessionId: (conv?.id || 'x') + '-helper', temperature: 0.7, kind: 'helper', messages: [...(sys.trim() ? [{ role: 'system', content: sys }] : []), ...history, { role: 'user', content: msg }] }, {
      onContent: (t) => {
        v.text += t;
        v.stat = 'Writing…';
        set();
      },
      onReasoning: () => {},
      onDone: () => {
        v.stat = `${modelName(v.model)} · ${((performance.now() - t0) / 1000).toFixed(1)} s · ~${Math.round(v.text.length / 3.6)} tokens`;
        set();
        finish();
      },
      onError: (e) => {
        v.stat = 'Failed: ' + e.message;
        set();
        finish();
      },
    });
    running.push(h);
  });
}

$('#cm-ptest').onclick = () => {
  openSheet('#chat-menu', false);
  openPromptTest();
};
$('#pt-add').onclick = () => {
  if (variants.length < MAX) variants.push({ ...variants[variants.length - 1], text: '', stat: '' });
  renderVariants();
};
$('#pt-run').onclick = run;
