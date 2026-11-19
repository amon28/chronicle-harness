// A small pick-one menu for the app's own questions ("Export as…", "Keep my picture?"), and a one-line text question
// (askText: a name, a commit message) – the app's own sheets instead of the system's prompt()/confirm() boxes, which
// look foreign on Android and do not follow the theme. The assistant's questions use the ask sheet.
import { $, el, hooks } from './core.js';
import { openSheet } from './chatlist.js';

let pending = null;
/** → the chosen option's value, or null when closed. options: [{ label, sub?, value, danger?, current? }] */
export function chooseOne(title, options, hint = '') {
  pending?.(null);
  $('#choose-title').textContent = title;
  $('#choose-hint').hidden = !hint;
  $('#choose-hint').textContent = hint;
  const list = $('#choose-list');
  list.innerHTML = '';
  return new Promise((resolve) => {
    pending = resolve;
    for (const o of options) {
      const b = el('button', 'menu-item' + (o.danger ? ' danger' : '') + (o.current ? ' current' : ''));
      b.append(el('span', null, o.label));
      if (o.sub) b.append(el('span', 'dim choose-sub', o.sub));
      b.onclick = () => {
        pending = null;
        openSheet('#choose-sheet', false);
        resolve(o.value);
      };
      list.append(b);
    }
    openSheet('#choose-sheet', true);
  });
}
// closed without choosing
new MutationObserver(() => {
  if (!$('#choose-sheet').classList.contains('open') && pending) {
    const r = pending;
    pending = null;
    r(null);
  }
}).observe($('#choose-sheet'), { attributes: true, attributeFilter: ['class'] });
hooks.chooseOne = chooseOne;

// ---------- one line of text ----------
let textPending = null;
const finishText = (v) => {
  const r = textPending;
  textPending = null;
  openSheet('#text-sheet', false);
  r?.(v);
};
/**
 * Ask for one line of text. → the text as typed (not trimmed), or null when cancelled or closed.
 * opts: { hint, placeholder, ok (button label), max (length) }
 */
export function askText(title, def = '', { hint = '', placeholder = '', ok = 'OK', max = 0 } = {}) {
  textPending?.(null);
  textPending = null;
  $('#text-title').textContent = title;
  $('#text-hint').hidden = !hint;
  $('#text-hint').textContent = hint;
  const inp = $('#text-input');
  inp.value = def ?? '';
  inp.placeholder = placeholder;
  inp.setAttribute('aria-label', title);
  if (max) inp.maxLength = max;
  else inp.removeAttribute('maxlength');
  $('#text-ok').textContent = ok;
  return new Promise((resolve) => {
    textPending = resolve;
    openSheet('#text-sheet', true);
    setTimeout(() => {
      inp.focus();
      inp.select();
    }, 60);
  });
}
$('#text-ok').onclick = () => finishText($('#text-input').value);
$('#text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    finishText($('#text-input').value);
  }
});
new MutationObserver(() => {
  if (!$('#text-sheet').classList.contains('open') && textPending) finishText(null);
}).observe($('#text-sheet'), { attributes: true, attributeFilter: ['class'] });
/** A yes/no question on the choose sheet. → true only when the first (danger) option was tapped. */
export const confirmSheet = async (title, hint, yes = 'Delete', no = 'Cancel') => (await chooseOne(title, [{ label: yes, value: true, danger: true }, { label: no, value: false }], hint)) === true;
