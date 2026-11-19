// 🗺 Story map: the chat's forks as a tree, and the points where you tried other versions.
import { alternates, flattenTree, forkTree } from '../storymap.js';
import { openSheet, selectConv } from './chatlist.js';
import { $, el, hooks, state } from './core.js';

function render() {
  const conv = state.current;
  const tree = flattenTree(forkTree(state.convs, conv));
  const box = $('#smap-tree');
  box.innerHTML = '';
  if (tree.length === 1) box.append(el('p', 'hint', 'This chat has not been forked yet. Fork it from the ⋯ menu of any message to try another direction – the branches will show up here.'));
  for (const n of tree) {
    const b = el('button', `smap-node${n.current ? ' current' : ''}`);
    b.style.paddingLeft = 12 + n.depth * 18 + 'px';
    b.append(el('span', 'smap-dot', n.current ? '●' : n.depth ? '└' : '○'), el('span', 'smap-title', n.title), el('span', 'dim', `  ${n.messages} msg${n.at != null ? ` · forked after #${n.at + 1}` : ''}`));
    b.onclick = () => {
      if (n.current) return;
      openSheet('#smap-sheet', false);
      openSheet('#chat-sheet', false);
      selectConv(n.id);
    };
    box.append(b);
  }
  const alts = alternates(conv);
  const list = $('#smap-alts');
  list.innerHTML = '';
  $('#smap-alts-title').hidden = !alts.length;
  for (const a of alts) {
    const head = el('div', 'smap-fork');
    head.append(el('span', 'smap-dot', a.kind === 'edit' ? '✎' : '↻'), el('span', 'smap-title', `#${a.index + 1} · ${a.kind === 'edit' ? 'you rewrote this message' : 'the reply was retried'} · ${a.count} versions`));
    list.append(head);
    for (const o of a.options) {
      const b = el('button', `smap-node smap-opt${o.current ? ' current' : ''}`);
      const more = [o.after ? `${o.after} message${o.after === 1 ? '' : 's'} after` : 'nothing after', o.forks ? `${o.forks} more fork${o.forks === 1 ? '' : 's'} inside` : ''].filter(Boolean).join(' · ');
      b.append(el('span', 'smap-dot', o.current ? '●' : '└'), el('span', 'smap-title', `${o.n + 1}. ${o.snippet || '(empty)'}`), el('span', 'dim', `  ${more}`));
      b.onclick = () => {
        openSheet('#smap-sheet', false);
        openSheet('#chat-sheet', false);
        // go to that version: the messages that followed it come back with it
        if (!o.current) hooks.switchBranch?.(a.index, a.kind, o.n);
        setTimeout(() => document.querySelector(`#messages .msg[data-mi="${a.index}"]`)?.scrollIntoView({ block: 'center' }), 60);
      };
      list.append(b);
    }
  }
}
$('#chat-map').onclick = () => {
  render();
  openSheet('#smap-sheet', true);
};
