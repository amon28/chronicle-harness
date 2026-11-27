// 🩺 Timing history (decision 245): every timings report is kept here (the newest 30, on this phone only) instead of
// a box over the chat – that box covered most of the screen, so typing could not be tested with it open.
import { $, el, toast, copyText } from './core.js';
import { openSheet } from './chatlist.js';
import { onPerfReport } from '../perf.js';

const KEY = 'ocm.perfHistory';
const MAX = 30;
const read = () => {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
const write = (l) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX)));
  } catch {
    /* full or blocked: the history is a convenience */
  }
};
const when = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
};
const asText = (e) => `${when(e.at)} – ${e.text}`;

onPerfReport((text, meta = {}) => {
  write([{ at: Date.now(), label: meta.label || text.split('\n')[0].replace(/:$/, ''), line: meta.line || '', slow: !!meta.slow, text: String(text).slice(0, 12000) }, ...read()]);
  render();
  // a word only when something was slow – nothing over the chat either way
  if (meta.slow) toast(`🩺 Saved: ${meta.line} – Settings › Data › Timing history`, 3500);
});

function render() {
  const all = read();
  const count = $('#perf-count');
  if (count) count.textContent = all.length ? `(${all.length})` : '';
  if (!$('#perf-sheet').classList.contains('open')) return;
  const list = $('#perf-list');
  list.innerHTML = '';
  if (!all.length) list.append(el('p', 'hint pad', 'Nothing yet. Turn on 🩺 timings, then send a message or type.'));
  all.forEach((e, i) => {
    const d = el('details', 'errlog-item perf-item' + (e.slow ? ' slow' : ''));
    const sum = el('summary');
    const head = el('div', 'errlog-head');
    head.append(el('span', 'errlog-kind' + (e.slow ? ' k-app' : ''), e.label), el('span', 'errlog-time', when(e.at)));
    sum.append(head, el('div', 'errlog-msg', e.line || ''));
    const body = el('pre', 'perf-text', e.text);
    const copy = el('button', 'ghost-btn small', 'Copy');
    copy.onclick = () => copyText(asText(e));
    d.append(sum, body, copy);
    if (i === 0) d.open = true;
    list.append(d);
  });
}

$('#perf-open').onclick = () => {
  openSheet('#perf-sheet', true);
  render();
};
$('#perf-copy-all').onclick = () => {
  const all = read();
  if (!all.length) return toast('Nothing to copy');
  copyText(all.map(asText).join('\n\n'));
};
$('#perf-clear').onclick = () => {
  if (!read().length) return;
  write([]);
  render();
  toast('Timing history cleared');
};
render();
