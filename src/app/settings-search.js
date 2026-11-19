// Settings › search: one field above the menu finds pages and single settings. The index is read from the Settings
// sheet itself (the menu's items and the labels, switches, headings and buttons on each page), so a setting added to
// index.html is found without a list to keep up to date; src/settingsearch.js adds the words the labels do not use.
import { searchSettings } from '../settingsearch.js';
import { $, el } from './core.js';
import { showSettingsPage } from './settings.js';

const textOf = (node, drop = '.dim, .t-hint, .badge, .info-btn, .info-text, select, input, textarea') => {
  const c = node.cloneNode(true);
  c.querySelectorAll(drop).forEach((x) => x.remove());
  c.querySelectorAll('svg').forEach((x) => x.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};
const extraOf = (node) => [...node.querySelectorAll('.dim, .t-hint, .info-text')].map((x) => x.textContent).join(' '); // explanations behind ⓘ are found too
// a control hidden on purpose (not available here: web build, no Linux…) is not offered
const shown = (node, page) => {
  for (let n = node; n && n !== page; n = n.parentElement) if (n.hidden) return false;
  return true;
};

let index = null;
function buildIndex() {
  const out = [];
  let order = 0;
  const titles = {};
  for (const b of document.querySelectorAll('#set-nav .set-item')) {
    const page = b.dataset.page;
    const label = textOf(b.querySelector('.set-txt b') || b);
    titles[page] = label;
    out.push({ kind: 'page', page, label, hint: b.querySelector('.set-txt small')?.textContent || '', where: '', order: order++ });
  }
  const ITEMS = '.label, label.hint.inline, .toggle, h3.section, summary, .ghost-btn.block, .btn-grid > button, .link-btn';
  for (const page of document.querySelectorAll('#settings-sheet .set-page')) {
    const pid = page.dataset.page;
    let section = '';
    for (const node of page.querySelectorAll(ITEMS)) {
      if (node.matches('h3.section')) section = textOf(node);
      if (!shown(node, page)) continue;
      if (node.matches('button') && node.closest('.toggle, summary')) continue;
      const two = node.matches('.btn-2line') ? node.querySelector('.b-txt b') : null; // "Snippets" + its explanation
      const label = textOf(two || node);
      if (!label || label.length < 2) continue;
      // a label's own hint is the paragraph right after its field
      let hint = extraOf(node) + (two ? ' ' + (node.querySelector('.b-txt small')?.textContent || '') : '');
      const next = node.matches('.label') ? node.nextElementSibling?.nextElementSibling : null;
      if (next?.matches('.hint')) hint += ' ' + next.textContent;
      out.push({ kind: 'setting', page: pid, label: label.slice(0, 90), hint, where: `${titles[pid] || pid}${section && section !== label ? ` › ${section}` : ''}`, node, order: order++ });
    }
  }
  return out;
}

function render() {
  const q = $('#set-search').value;
  const list = $('#set-results');
  const on = !!q.trim();
  list.hidden = !on;
  document.querySelectorAll('#set-nav > .set-group, #set-nav > .set-item').forEach((x) => (x.hidden = on));
  list.innerHTML = '';
  if (!on) return;
  index ||= buildIndex();
  const found = searchSettings(index, q);
  if (!found.length) {
    list.append(el('p', 'hint', 'Nothing found. Try another word – e.g. “key”, “battery”, “backup”.'));
    return;
  }
  for (const e of found) {
    const b = el('button', 'set-result' + (e.kind === 'page' ? ' page' : ''));
    b.append(el('b', null, e.label), el('small', null, e.kind === 'page' ? 'Page' : e.where));
    b.onclick = () => go(e);
    list.append(b);
  }
}

/** Open the setting's page, scroll to it and light it up for a moment. */
function go(e) {
  showSettingsPage(e.page);
  const node = e.node;
  if (!node?.isConnected) return;
  for (let d = node.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  const flash = [node];
  if (node.matches('.label') && node.nextElementSibling && !node.nextElementSibling.matches('.label, h3')) flash.push(node.nextElementSibling);
  requestAnimationFrame(() => {
    node.scrollIntoView({ block: 'center' });
    for (const f of flash) {
      f.classList.remove('set-flash');
      void f.offsetWidth; // restart the animation
      f.classList.add('set-flash');
      setTimeout(() => f.classList.remove('set-flash'), 1800);
    }
  });
}

$('#set-search').addEventListener('input', render);
$('#set-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#set-results .set-result')?.click();
});
// read the sheet again each time Settings opens: rows shown or hidden by what this phone can do may have changed
new MutationObserver(() => {
  if ($('#settings-sheet').classList.contains('open')) index = null;
}).observe($('#settings-sheet'), { attributes: true, attributeFilter: ['class'] });
export { buildIndex as buildSettingsIndex };
