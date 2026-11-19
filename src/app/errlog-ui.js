// Settings › Data › Error log (decision 177): the app's own errors, newest first – filter by kind, open the chat an
// entry belongs to, copy or export the lot, clear it.
import { $, el, state, toast } from './core.js';
import { openSheet, selectConv } from './chatlist.js';
import { shareBytes } from './extras.js';
import { KINDS, clearLog, formatLog, onLog, readLog } from '../errorlog.js';

let kind = '';
const when = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
};

function render() {
  const all = readLog();
  const count = $('#errlog-count');
  if (count) count.textContent = all.length ? `(${all.length})` : '';
  if (!$('#errlog-sheet').classList.contains('open')) return;
  const bar = $('#errlog-filters');
  bar.innerHTML = '';
  for (const [k, label] of [['', 'All'], ...Object.entries(KINDS)]) {
    const n = k ? all.filter((e) => e.kind === k).length : all.length;
    if (k && !n) continue;
    const b = el('button', 'filter-chip' + (kind === k ? ' active' : ''), `${label} ${n}`);
    b.onclick = () => {
      kind = k;
      render();
    };
    bar.append(b);
  }
  const list = $('#errlog-list');
  list.innerHTML = '';
  const rows = all.filter((e) => !kind || e.kind === kind).slice(0, 200);
  if (!rows.length) list.append(el('p', 'hint pad', all.length ? 'Nothing of this kind.' : 'No errors logged. 🎉'));
  for (const e of rows) {
    const chat = e.conv && state.convs.find((c) => c.id === e.conv);
    const row = el(chat ? 'button' : 'div', 'errlog-item');
    const head = el('div', 'errlog-head');
    head.append(el('span', 'errlog-kind k-' + e.kind, KINDS[e.kind] || e.kind), el('span', 'errlog-time', when(e.at) + (e.n > 1 ? ` · ×${e.n}` : '')));
    row.append(head, el('div', 'errlog-msg', (e.tool ? e.tool + ': ' : '') + e.msg));
    const meta = [e.model, chat ? `in “${chat.title || 'a chat'}” ›` : e.title ? `in “${e.title}” (deleted)` : '', e.where].filter(Boolean).join(' · ');
    if (meta) row.append(el('div', 'errlog-meta', meta));
    if (chat)
      row.onclick = () => {
        openSheet('#errlog-sheet', false);
        openSheet('#settings-sheet', false);
        selectConv(chat.id);
      };
    list.append(row);
  }
}
onLog(render);

$('#errlog-open').onclick = () => {
  kind = '';
  openSheet('#errlog-sheet', true);
  render();
};
$('#errlog-copy').onclick = async () => {
  const text = formatLog(readLog(kind));
  if (!text) return toast('Nothing to copy');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied the error log');
  } catch {
    toast('Copying is not possible here – use Export');
  }
};
$('#errlog-export').onclick = async () => {
  const text = formatLog(readLog(kind));
  if (!text) return toast('Nothing to export');
  const d = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  try {
    await shareBytes(`chronicle-errors-${d}.txt`, new TextEncoder().encode(`Chronicle error log, exported ${new Date().toString()}\n\n${text}\n`));
  } catch (e) {
    if (!/cancel/i.test(e?.message || '')) toast('Export failed: ' + e.message);
  }
};
$('#errlog-clear').onclick = () => {
  clearLog();
  render();
};
render(); // the count on the Data page
