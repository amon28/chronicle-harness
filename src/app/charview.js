// A character's page (like Chub's): picture, name, "Chat with…", description, tags, author and the card's definitions.
// Opens when you tap a character on the roleplay start screen.
import { art } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import { openSheet } from './chatlist.js';
import { $, el, hooks, lorebookById, mdOpts, toast } from './core.js';
import { sourceSite } from '../reimport.js';
import { setChatPersona } from './render.js';

const tok = (t) => Math.round(String(t || '').length / 3.6);
const rich = (text) => {
  const d = el('div', 'md cv-text');
  d.innerHTML = renderMarkdown(String(text || ''), mdOpts(false));
  return d;
};

function section(title, hint, nodes, open = false) {
  const det = el('details', 'cv-section');
  det.open = open;
  const sum = el('summary');
  sum.append(el('span', null, title), hint ? el('span', 'dim', ' ' + hint) : '');
  det.append(sum, ...nodes);
  return det;
}
function field(label, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const box = el('div', 'cv-field');
  box.append(el('div', 'cv-label', label), rich(t));
  return box;
}

async function openCharacter(p) {
  const c = p.card || {};
  const body = $('#cv-body');
  body.innerHTML = '';
  $('#cv-title').textContent = p.name;
  // the picture: full card art when there is one
  const url = (p.hasArt && (await art.get(p.id).catch(() => null))) || p.avatar?.image || '';
  if (url) {
    const img = el('img', 'cv-art');
    img.src = url;
    img.alt = p.name;
    body.append(img);
  } else {
    const big = el('div', 'cv-art cv-emoji', p.avatar?.emoji || '🎭');
    big.style.background = p.avatar?.bg || 'var(--bg-3)';
    body.append(big);
  }
  const book = p.lorebookId ? lorebookById(p.lorebookId) : null;
  const greetings = [c.first_mes, ...(c.alternate_greetings || [])].filter((g) => g && g.trim());
  const defTokens = tok([c.description, c.personality, c.scenario, c.mes_example].join(''));
  const pills = el('div', 'cv-pills');
  pills.append(el('span', 'cv-pill', `≈ ${defTokens} tokens`), el('span', 'cv-pill', `${greetings.length} greeting${greetings.length === 1 ? '' : 's'}`));
  if (book) pills.append(el('span', 'cv-pill', `📚 ${book.entries.length} lore entries`));
  body.append(pills);

  const chat = el('button', 'primary-btn block', `💬 Chat with ${p.name}`);
  chat.id = 'cv-chat';
  chat.onclick = () => {
    openSheet('#char-sheet', false);
    setChatPersona(p.id);
  };
  const row = el('div', 'row gap-sm wrap');
  const edit = el('button', 'ghost-btn', '✏️ Edit');
  edit.onclick = () => {
    openSheet('#char-sheet', false);
    hooks.openPersonaEditor?.(p.id);
  };
  const group = el('button', 'ghost-btn', '👥 Group chat');
  group.onclick = () => {
    openSheet('#char-sheet', false);
    hooks.openGroupEditor?.();
  };
  const exp = el('button', 'ghost-btn', '⤴ Export');
  exp.onclick = () => hooks.exportCharacter?.(p);
  const imp = el('button', 'ghost-btn', '⤵ Import chat');
  imp.id = 'cv-import-chat';
  imp.title = 'A chat with this character from a file (Chronicle .json or SillyTavern .jsonl)';
  imp.onclick = () => hooks.importChatFor?.(p);
  row.append(edit, exp, imp, group);
  body.append(chat, row);
  // ⟳ downloaded from a site: look whether there is a newer version (nothing changes until you tap Update)
  const src = hooks.cardSource?.(p);
  if (src) {
    const site = sourceSite(src);
    const re = el('div', 'cv-reimport');
    const btn = el('button', 'ghost-btn', `Checking ${site}…`);
    btn.disabled = true;
    const status = el('div', 'hint');
    re.append(btn, status);
    if (p.reimportUndo) {
      const undo = el('button', 'ghost-btn small', '↩ Undo the last update');
      undo.onclick = async () => {
        if (hooks.undoReimport?.(p)) {
          hooks.renderPersonaLists?.();
          await openCharacter(p);
          toast(`${p.name} is back to how it was`);
        }
      };
      re.append(undo);
    }
    body.append(re);
    const update = async (force = false) => {
      btn.disabled = true;
      btn.textContent = 'Updating…';
      try {
        const changes = await hooks.reimportCharacter(p, { force });
        if (changes == null) return openCharacter(p); // you closed the question
        hooks.renderPersonaLists?.();
        await openCharacter(p);
        toast(changes.length ? `Updated ${p.name}: ${changes.join(', ')}` : `Re-imported ${p.name} from ${site} (nothing had changed)`, 5000);
      } catch (e) {
        toast(`Couldn’t update: ${e.message}`, 5000);
        btn.disabled = false;
        btn.textContent = `⟳ Update from ${site}`;
      }
    };
    hooks
      .checkReimport?.(p)
      .then((chk) => {
        if (!btn.isConnected) return;
        const pic = chk.picture === 'changed' ? ['a new picture'] : [];
        const all = [...chk.changes, ...pic];
        if (all.length || chk.picture === 'unknown') {
          btn.textContent = `⟳ Update from ${site}`;
          btn.disabled = false;
          btn.onclick = () => update();
          status.textContent = all.length ? `Changed there: ${all.join(', ')}` : `The text is the same; you can still take the picture from ${site}.`;
        } else {
          btn.textContent = `✓ Same as on ${site}`;
          status.textContent = p.reimportedAt ? `Last updated ${new Date(p.reimportedAt).toLocaleDateString()}` : '';
          // still: take it again from the source (e.g. to undo your own edits, or to take its picture)
          const again = el('button', 'ghost-btn small', '⟳ Re-import anyway');
          again.onclick = () => {
            again.remove();
            update(true);
          };
          re.insertBefore(again, status.nextSibling);
        }
      })
      .catch((e) => {
        if (!btn.isConnected) return;
        btn.textContent = `⟳ Update from ${site}`;
        btn.disabled = false;
        btn.onclick = () => update();
        status.textContent = `Couldn’t check ${site} (${String(e.message || e).slice(0, 80)}) – tap to try.`;
      });
  }

  // the blurb: the creator's notes if there are any, else the description; clamped with Show more
  const blurb = String(c.creator_notes || c.description || p.description || '').trim();
  if (blurb) {
    const wrap = el('div', 'cv-summary clamped');
    wrap.append(rich(blurb));
    const more = el('button', 'cv-more', 'Show more');
    more.onclick = () => {
      const open = wrap.classList.toggle('clamped');
      more.textContent = open ? 'Show more' : 'Show less';
    };
    body.append(wrap, more);
  }
  const tags = (c.tags || []).filter((t) => typeof t === 'string');
  if (tags.length) {
    const tr = el('div', 'cv-tags');
    for (const t of tags) tr.append(el('span', 'cv-tag', t));
    body.append(tr);
  }
  const author = c.creator || (c.chub_path ? c.chub_path.split('/')[0] : '');
  if (author || c.chub_path) {
    const a = el('div', 'cv-meta');
    a.append(document.createTextNode('Created by '));
    a.append(el('b', null, author ? '@' + author.replace(/^@/, '') : 'unknown'));
    if (c.chub_path) {
      const link = el('a', null, ' · chub.ai');
      link.href = `https://chub.ai/characters/${c.chub_path}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      a.append(link);
    }
    body.append(a);
  }

  // the card itself, folded like Chub's sections
  const defs = [field('Description', c.description), field('Personality', c.personality), field('Scenario', c.scenario), field('Example dialogue', c.mes_example), field('Character system prompt', c.system_prompt), field('Post-history instructions', c.post_history_instructions)].filter(Boolean);
  if (defs.length) body.append(section('Definitions', `(≈ ${defTokens} tokens)`, defs));
  if (greetings.length) body.append(section('Greetings', `(${greetings.length})`, greetings.map((g, i) => field(i ? `Alternate ${i}` : 'First message', g))));
  if (book?.entries?.length) {
    const rows = book.entries.slice(0, 60).map((e) => {
      const r = el('div', 'cv-lore');
      r.append(el('b', null, e.name || (e.keys || [])[0] || 'Entry'), el('span', 'dim', e.keys?.length ? `  🔑 ${e.keys.slice(0, 5).join(', ')}` : e.constant ? '  (always on)' : ''));
      return r;
    });
    body.append(section('Lorebook', `(${book.entries.length} entries)`, rows));
  }
  $('#char-sheet .sheet-card').scrollTop = 0;
  openSheet('#char-sheet', true);
}
hooks.openCharacter = openCharacter;
