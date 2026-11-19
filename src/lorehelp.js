// Lore suggestions: after a while a roleplay has introduced people, places, items and rules that are only in the chat.
// A model reads the chat and proposes lorebook entries; you pick which to keep.
export const LORE_SYSTEM = `You find lore worth saving from a roleplay, for a lorebook (world info).
A lorebook entry is a fact sheet that is added to the prompt only when its keywords appear in the chat – so it should be about one specific thing: a named person, a place, a group, an item, an ability, a rule of the world, or a past event that matters again later.
Rules:
- Only propose things the chat actually established or clearly implies. Never invent.
- Skip anything already covered by the existing entries (you get their names and keys), the main character's own description, and passing details that will not matter again.
- Each entry: "name" (short title), "keys" (2–6 words people would actually write when it comes up, including nicknames and spellings), "content" (2–6 plain sentences: concrete facts in present tense, third person, no flourishes).
- Propose at most 8 entries, the most useful first. If nothing is worth saving, return an empty list.
Reply with ONLY a JSON object: {"entries": [{"name": "...", "keys": ["..."], "content": "..."}]}`;

export function buildLoreRequest({ transcript, existing, charName, userName }) {
  const known = (existing || []).map((e) => `- ${e.name || '(untitled)'}: ${(e.keys || []).join(', ')}`).join('\n') || '(none yet)';
  return `Roleplay between ${charName} and ${userName}.\n\nEXISTING ENTRIES (do not repeat):\n${known}\n\nTHE CHAT:\n${transcript}`;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Model text → clean suggestions, without the ones the lorebook already has. */
export function parseLoreSuggestions(text, existing = []) {
  let json;
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    json = JSON.parse(m ? m[0] : text);
  } catch {
    return [];
  }
  const list = Array.isArray(json) ? json : json?.entries;
  if (!Array.isArray(list)) return [];
  const have = new Set();
  for (const e of existing) {
    have.add(norm(e.name));
    for (const k of e.keys || []) have.add(norm(k));
  }
  const out = [];
  for (const raw of list) {
    const content = String(raw?.content || '').trim();
    const keys = [...new Set((Array.isArray(raw?.keys) ? raw.keys : String(raw?.keys || '').split(',')).map((k) => String(k).trim()).filter(Boolean))].slice(0, 8);
    const name = String(raw?.name || keys[0] || '').trim().slice(0, 60);
    if (!content || !keys.length || !name) continue;
    if (have.has(norm(name)) || keys.every((k) => have.has(norm(k)))) continue;
    keys.forEach((k) => have.add(norm(k)));
    have.add(norm(name));
    out.push({ name, keys, content: content.slice(0, 1200) });
    if (out.length >= 8) break;
  }
  return out;
}
