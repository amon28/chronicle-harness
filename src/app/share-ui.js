// Share to Chronicle: what other apps share (a link, text, pictures, files) → pick what to do with it.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { filesFromBase64 } from '../clip.js';
import { newChat, openSheet, setMode } from './chatlist.js';
import { $, el, state, toast } from './core.js';
import { attachFiles } from './composer.js';
import { updateToolsChip } from './extras.js';

const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t || '').trim());
let shared = null;

function actionsFor(s) {
  const url = isUrl(s.text) ? s.text.trim() : '';
  const hasImg = s.files.some((f) => f.type.startsWith('image/'));
  const acts = [];
  if (url) {
    acts.push(['📖 Read it and summarize', `Read this page and summarize it for me: ${url}`, true, true]);
    acts.push(['📸 See how it looks (phone + desktop)', `Take screenshots of ${url} on a phone and a desktop and describe its layout and design.`, true, true]);
  } else if (s.text) {
    acts.push(['📝 Summarize', 'Summarize this:', true, false]);
    acts.push(['🌍 Translate to English', 'Translate this to English:', true, false]);
    acts.push(['💡 Explain it simply', 'Explain this simply:', true, false]);
  } else if (hasImg) {
    acts.push(['👁 Describe it', 'Describe this picture in detail.', true, false]);
    acts.push(['🔤 Read the text in it', 'Transcribe all the text in this picture.', true, false]);
  } else if (s.files.length) {
    acts.push(['📝 Summarize it', 'Summarize this file:', true, true]);
  }
  acts.push(['💬 Just open it in a chat', '', false, !!url]);
  return acts;
}

function show(s) {
  shared = s;
  const p = $('#share-preview');
  p.innerHTML = '';
  if (s.subject && s.subject !== s.text) p.append(el('div', null, s.subject));
  if (s.text) p.append(el('div', null, s.text.slice(0, 600) + (s.text.length > 600 ? '…' : '')));
  for (const f of s.files) p.append(el('div', 'share-file', `📎 ${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`));
  const box = $('#share-actions');
  box.innerHTML = '';
  for (const [label, prompt, send, tools] of actionsFor(s)) {
    const b = el('button', 'menu-item', label);
    b.onclick = () => run(prompt, send, tools);
    box.append(b);
  }
  $('#share-here').checked = false;
  openSheet('#share-sheet', true);
}

async function run(prompt, send, tools) {
  const s = shared;
  const here = $('#share-here').checked;
  openSheet('#share-sheet', false);
  if (!here || !state.current) {
    if (document.body.classList.contains('mode-rp')) setMode('chat', { fresh: false });
    newChat();
  }
  if (tools) {
    state.current.tools = true; // reading a page / taking screenshots needs the agent tools
    updateToolsChip();
  }
  const input = $('#input');
  const body = [prompt, s.text].filter(Boolean).join(prompt && s.text && !isUrl(s.text) ? '\n\n' : ' ').trim();
  input.value = prompt && isUrl(s.text) && prompt.includes(s.text) ? prompt : body;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (s.files.length) await attachFiles(s.files);
  if (send && input.value.trim()) $('#send-btn').click();
  else input.focus();
}

export function handleShare(payload) {
  const files = filesFromBase64((payload.files || []).map((f) => ({ mime: f.mime, base64: f.base64 }))).map((f, i) => {
    const name = payload.files[i].name || f.name;
    return new File([f], name, { type: f.type });
  });
  if (!payload.text && !files.length) return toast('Nothing to share');
  show({ text: (payload.text || '').trim(), subject: payload.subject || '', files });
}
globalThis.__ocmOnShare = handleShare; // for tests

if (Capacitor.isNativePlatform()) {
  registerPlugin('ShareTarget').addListener('share', (e) => handleShare(e));
}
