// ⓘ buttons: a small round "i" next to a setting; tapping it opens a bubble that explains the setting.
// <button class="info-btn" data-info="key"> – the text comes from INFO[key] (a string, or a function for text that
// depends on the models the app has right now); a plain <button class="info-btn"> shows the hidden
// <span class="info-text"> right after it (the longer explanations in index.html). A tap outside, Back or Escape closes it.
import { learnCandidates } from '../memory.js';
import { $, el, pref, state } from './core.js';

const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;
/** The model the background helpers (story memory, scene sheet) use now, in words. */
export function fastModelText(chatModel = state.current?.model || state.settings.model) {
  if (pref('storyModel') === 'chat') return `the chat's own model (${modelName(chatModel) || 'the one selected in the chat'})`;
  const id = learnCandidates(state.models, 'auto', chatModel)[0];
  return id ? modelName(id) : "the chat's own model (no fast model in your list)";
}

const FAST_RULE =
  'A fast model is the cheapest small “Flash” model in your list: the newest DeepSeek Flash first, then the newest GLM Flash, then the cheapest other Flash model. Free Zen models and image-only models are never picked. With no Flash model, the chat’s own model is used.';

export const INFO = {
  'fast-model': () => `Right now: ${fastModelText()}.\n\n${FAST_RULE}\n\nPick “the chat’s model” to have these notes written by the model you are chatting with (slower, and costs as much as a reply).`,
  tracker: () =>
    `After each reply, a small request asks ${fastModelText()} to update the scene sheet – the fields below – from the newest messages. The sheet is sent with every message, so the story keeps track of the time, place, clothes and mood.\n\nNew roleplays start with it on; each chat can turn it on or off in its own settings, where the sheet can also be read and edited.\n\nThe model is set under 📜 Story memory (“using …”).`,
};

let open = null; // { pop, btn }
/** Close the bubble; true when one was open (Android's Back closes it before anything else). */
export function closeInfo() {
  const was = !!open;
  close();
  return was;
}
function close() {
  if (!open) return;
  open.pop.remove();
  open.btn.setAttribute('aria-expanded', 'false');
  open = null;
}
function show(btn) {
  const key = btn.dataset.info;
  const v = INFO[key] ?? btn.dataset.text;
  const text = typeof v === 'function' ? v() : v;
  // or the explanation written next to it in the page (<span class="info-text" hidden>…</span>, links and all)
  const rich = !text && btn.nextElementSibling?.classList.contains('info-text') ? btn.nextElementSibling : null;
  if (!text && !rich) return;
  const pop = el('div', 'info-pop');
  pop.setAttribute('role', 'dialog');
  if (rich) {
    const p = el('p');
    p.append(...[...rich.cloneNode(true).childNodes]);
    pop.append(p);
  } else for (const para of String(text).split('\n\n')) pop.append(el('p', null, para));
  document.body.append(pop);
  // under the button (or above it when there is no room), kept on the screen
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  pop.style.width = w + 'px';
  pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
  const h = pop.offsetHeight;
  const below = r.bottom + 8 + h <= window.innerHeight - 12;
  pop.style.top = (below ? r.bottom + 8 : Math.max(12, r.top - 8 - h)) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  open = { pop, btn };
}

// one listener for every ⓘ: inside a <label> it must not toggle the checkbox
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('.info-btn');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const same = open?.btn === btn;
      close();
      if (!same) show(btn);
      return;
    }
    if (open && !open.pop.contains(e.target)) close();
  },
  true,
);
document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
document.addEventListener('scroll', (e) => open && !open.pop.contains(e.target) && close(), true); // the page moved under it
window.addEventListener('resize', close);
window.addEventListener('popstate', close);

/** The option that says which fast model is used (Story memory › using …). */
export function labelFastModelOption() {
  const o = $('#pref-story-model')?.querySelector('option[value="auto"]');
  if (!o) return;
  const id = learnCandidates(state.models, 'auto', state.settings.model)[0];
  o.textContent = id ? `a fast model (${modelName(id)})` : 'a fast model';
}
