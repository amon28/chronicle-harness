// Dropdowns: every <select> opens our own bottom sheet instead of Android's default list.
// The <select> stays in the page (its value and change events work as before), only the picker is replaced.
import { openSheet } from './chatlist.js';
import { $, el } from './core.js';

let target = null;

/** The visible label written before a field (without its greyed explanation), or ''. */
const labelBefore = (s) => {
  let n = s.previousElementSibling || s.parentElement?.previousElementSibling;
  for (let i = 0; i < 4 && n; i++, n = n.previousElementSibling) {
    if (!n.matches?.('.label, label, h3')) continue;
    // the label without its greyed explanation – all of it, not its first node: a label that starts with an icon
    // ("🎛 Roleplay preset") has the icon there, and the sheet was titled with the icon alone
    const c = n.cloneNode(true);
    c.querySelectorAll('.dim').forEach((x) => x.remove());
    return c.textContent.trim() || n.textContent.trim();
  }
  return '';
};
const labelOf = (s) => s.getAttribute('aria-label') || labelBefore(s) || 'Choose';

function renderList() {
  const s = target;
  const list = $('#pick-list');
  list.innerHTML = '';
  const q = $('#pick-search').value.trim().toLowerCase();
  const add = (o) => {
    const text = o.textContent.trim() || o.value;
    if (q && !text.toLowerCase().includes(q)) return;
    const b = el('button', 'pick-item' + (o.value === s.value && o === s.selectedOptions[0] ? ' current' : ''));
    b.append(el('span', 'pick-text', text), el('span', 'pick-check', o === s.selectedOptions[0] ? '✓' : ''));
    b.disabled = o.disabled;
    b.onclick = () => {
      s.value = o.value;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      openSheet('#pick-sheet', false);
    };
    list.append(b);
  };
  for (const child of s.children) {
    if (child.tagName === 'OPTGROUP') {
      if (!q) list.append(el('div', 'pick-group', child.label));
      [...child.children].forEach(add);
    } else add(child);
  }
  if (!list.children.length) list.append(el('p', 'hint', 'Nothing matches.'));
}

function open(s) {
  target = s;
  $('#pick-title').textContent = labelOf(s);
  const many = s.options.length > 10;
  $('#pick-search').hidden = !many;
  $('#pick-search').value = '';
  renderList();
  openSheet('#pick-sheet', true);
  setTimeout(() => s.selectedOptions[0] && $('#pick-list .current')?.scrollIntoView({ block: 'center' }), 60);
}

const custom = (e) => {
  const s = e.target.closest?.('select');
  return s && !s.multiple && !s.disabled && !(s.size > 1) && !s.dataset.native ? s : null;
};
// stop the system list from opening (it opens from the mouse-down that follows a tap, so cancel that one – never the
// touch events themselves: cancelling touchstart also cancels the click, and then nothing opens at all), then show ours
for (const type of ['mousedown', 'keydown']) {
  document.addEventListener(
    type,
    (e) => {
      const s = custom(e);
      if (!s) return;
      if (type === 'keydown' && ![' ', 'Enter', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      if (type === 'keydown') open(s);
    },
    { capture: true },
  );
}
document.addEventListener(
  'click',
  (e) => {
    const s = custom(e);
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    open(s);
  },
  true,
);
$('#pick-search').addEventListener('input', () => target && renderList());

// Screen readers: most fields have their label as the element before them (<label class="label"> without `for`), so
// they had no accessible name. Give each such field the label's words – the same lookup the picker uses for its title.
function nameFields(root = document) {
  for (const f of root.querySelectorAll('select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])')) {
    if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.labels?.length) continue;
    const name = labelBefore(f);
    if (name) f.setAttribute('aria-label', name.slice(0, 120));
  }
}
nameFields();
// rows built later (a persona editor, a chat's sheet) get their names when their sheet opens
const sheetWatch = new MutationObserver((list) => {
  for (const m of list) if (m.target.classList.contains('open')) nameFields(m.target);
});
document.querySelectorAll('.sheet').forEach((sh) => sheetWatch.observe(sh, { attributes: true, attributeFilter: ['class'] }));
