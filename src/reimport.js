/**
 * Re-importing a character from where it came from (chub.ai, BotBooru…): the newest card replaces the text, the
 * lorebook and (if you want) the picture, in place – same character, so its chats stay. One step back is kept.
 */
import { chubPath, botbooruId } from './api.js';

/** Where this character can be downloaded again, or ''. A link saved at import, else the Chub path in the card. */
export function cardSource(p) {
  if (!p?.cardMode) return '';
  if (p.sourceUrl && (chubPath(p.sourceUrl) || botbooruId(p.sourceUrl))) return p.sourceUrl;
  if (p.card?.chub_path) return `https://chub.ai/characters/${p.card.chub_path}`;
  return '';
}
export const sourceSite = (url) => (chubPath(url) ? 'chub.ai' : botbooruId(url) ? 'BotBooru' : 'its source');

const FIELDS = [
  ['description', 'description'],
  ['personality', 'personality'],
  ['scenario', 'scenario'],
  ['first_mes', 'first message'],
  ['mes_example', 'example chats'],
  ['system_prompt', 'system prompt'],
  ['post_history_instructions', 'post-history instructions'],
  ['creator_notes', 'creator notes'],
];
/** What differs between two versions of a card (and its lorebook entry counts). → ['description', '+2 greetings', …] */
export function cardChanges(oldCard = {}, newCard = {}, oldEntries = null, newEntries = null) {
  const out = [];
  if ((oldCard.name || '') !== (newCard.name || '')) out.push(`name (${oldCard.name || '–'} → ${newCard.name})`);
  for (const [k, label] of FIELDS) if (String(oldCard[k] || '').trim() !== String(newCard[k] || '').trim()) out.push(label);
  const og = (oldCard.alternate_greetings || []).length;
  const ng = (newCard.alternate_greetings || []).length;
  if (og !== ng) out.push(`${ng > og ? '+' : ''}${ng - og} greeting${Math.abs(ng - og) === 1 ? '' : 's'}`);
  else if (JSON.stringify(oldCard.alternate_greetings || []) !== JSON.stringify(newCard.alternate_greetings || [])) out.push('greetings');
  if (JSON.stringify(oldCard.tags || []) !== JSON.stringify(newCard.tags || [])) out.push('tags');
  if (newEntries != null && oldEntries != null && JSON.stringify(oldEntries) !== JSON.stringify(newEntries)) out.push(`lorebook (${oldEntries.length} → ${newEntries.length} entries)`);
  else if (newEntries != null && oldEntries == null) out.push(`a lorebook (${newEntries.length} entries)`);
  return out;
}
const loreKey = (e) => ({ keys: e.keys, content: e.content, enabled: e.enabled !== false });

/**
 * Apply a freshly downloaded card to a character. deps: { lorebookById, newLorebook(book), cardPrompt, picture: { avatar, art } | null, putArt(id, art) }.
 * → { changes: [...], undo } (undo is stored on the persona as p.reimportUndo).
 */
export async function applyReimport(p, card, book, deps) {
  const oldBook = p.lorebookId ? deps.lorebookById(p.lorebookId) : null;
  const changes = cardChanges(p.card, card, oldBook ? oldBook.entries.map(loreKey) : null, book ? book.entries.map(loreKey) : null);
  if (deps.picture) changes.push('picture');
  p.reimportUndo = { at: Date.now(), name: p.name, description: p.description, prompt: p.prompt, card: p.card, avatar: deps.picture ? p.avatar : undefined, lore: oldBook ? { id: oldBook.id, entries: oldBook.entries } : null };
  Object.assign(p, { name: card.name || p.name, description: String(card.creator_notes || card.description || '').replace(/\s+/g, ' ').slice(0, 80), prompt: deps.cardPrompt(card), card: { ...card, character_book: undefined } });
  if (book) {
    if (oldBook) oldBook.entries = book.entries; // same lorebook (its settings and attachments stay), new entries
    else p.lorebookId = deps.newLorebook(book).id;
  }
  if (deps.picture) {
    p.avatar = { ...(p.avatar || {}), image: deps.picture.avatar };
    if (deps.picture.art) {
      await deps.putArt(p.id, deps.picture.art);
      p.hasArt = true;
    }
  }
  p.reimportedAt = Date.now();
  return { changes };
}

/** Put the character back as it was before the last re-import (text, lorebook entries, avatar). */
export function undoReimport(p, lorebookById) {
  const u = p.reimportUndo;
  if (!u) return false;
  Object.assign(p, { name: u.name, description: u.description, prompt: u.prompt, card: u.card });
  if (u.avatar) p.avatar = u.avatar;
  if (u.lore) {
    const b = lorebookById(u.lore.id);
    if (b) b.entries = u.lore.entries;
  }
  delete p.reimportUndo;
  return true;
}
