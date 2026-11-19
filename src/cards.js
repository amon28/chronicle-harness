// Character cards (the format used by SillyTavern and most roleplay apps):
// - PNG with a tEXt chunk "chara" (V2, base64 JSON) or "ccv3" (V3)
// - plain JSON (chara_card_v2 / chara_card_v3, or legacy V1 fields at the top level)
// - .charx (zip with card.json + assets)
import { unzipSync, strFromU8 } from 'fflate';
import { importLorebook } from './lore.js';

const b64ToStr = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const strToB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// ---------- PNG chunks ----------
function readPngText(bytes) {
  const out = {};
  // Some cards carry the same key twice (Chub writes a second, stubbed "chara" whose first message is "..."):
  // the fuller one is the card.
  const put = (key, text) => {
    if (!(key in out) || text.length > out[key].length) out[key] = text;
  };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) return out;
  let p = 8;
  const dec = new TextDecoder('latin1');
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = dec.decode(bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) put(dec.decode(data.subarray(0, z)).toLowerCase(), dec.decode(data.subarray(z + 1)));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = dec.decode(data.subarray(0, z)).toLowerCase();
        // keyword\0 compression-flag compression-method lang\0 translated\0 text
        let q = z + 3;
        q = data.indexOf(0, q) + 1;
        q = data.indexOf(0, q) + 1;
        if (data[z + 1] === 0) put(key, new TextDecoder().decode(data.subarray(q)));
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert tEXt chunks (key → latin1 text) before IEND, replacing existing ones with the same key. */
export function writePngText(png, entries) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const dec = new TextDecoder('latin1');
  const chunks = [];
  let p = 8;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = dec.decode(png.subarray(p + 4, p + 8));
    const whole = png.subarray(p, p + 12 + len);
    if (type === 'tEXt') {
      const data = png.subarray(p + 8, p + 8 + len);
      const key = dec.decode(data.subarray(0, data.indexOf(0))).toLowerCase();
      if (!(key in entries)) chunks.push(whole);
    } else if (type !== 'IEND') chunks.push(whole);
    p += 12 + len;
    if (type === 'IEND') break;
  }
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  for (const [k, v] of Object.entries(entries)) {
    if (v == null) continue; // null = just remove that chunk
    const data = new Uint8Array([...enc(k), 0, ...enc(v)]);
    const chunk = new Uint8Array(12 + data.length);
    const cdv = new DataView(chunk.buffer);
    cdv.setUint32(0, data.length);
    chunk.set(enc('tEXt'), 4);
    chunk.set(data, 8);
    cdv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    chunks.push(chunk);
  }
  const iend = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0) + iend.length;
  const out = new Uint8Array(total);
  out.set(png.subarray(0, 8));
  let o = 8;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  out.set(iend, o);
  return out;
}

// ---------- parsing ----------
function normalize(json) {
  const d = json?.data && (json.spec || json.data.name) ? json.data : json; // V2/V3 have .data, V1 is flat
  if (!d || typeof d !== 'object' || !d.name) throw new Error('This file has no character in it');
  const book = d.character_book;
  return {
    name: String(d.name).trim(),
    description: d.description || '',
    personality: d.personality || '',
    scenario: d.scenario || '',
    first_mes: d.first_mes || '',
    mes_example: d.mes_example || '',
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter(Boolean) : [],
    system_prompt: d.system_prompt || '',
    post_history_instructions: d.post_history_instructions || '',
    creator_notes: d.creator_notes || d.creatorcomment || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
    creator: d.creator || '',
    character_book: book && (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length) ? book : null,
    spec: json.spec || 'chara_card_v1',
    // V3: {{char}} uses the nickname when set
    nickname: d.nickname || '',
    group_only_greetings: Array.isArray(d.group_only_greetings) ? d.group_only_greetings.filter(Boolean) : [],
    // SillyTavern "Character's Note": injected into the chat at a depth
    depth_prompt: d.extensions?.depth_prompt?.prompt ? { prompt: d.extensions.depth_prompt.prompt, depth: d.extensions.depth_prompt.depth ?? 4, role: d.extensions.depth_prompt.role || 'system' } : null,
    // chub.ai can link separate lorebooks (not embedded in the card)
    related_lorebooks: d.extensions?.chub?.related_lorebooks || [],
    chub_path: d.extensions?.chub?.full_path || '',
    extensions: d.extensions || {},
  };
}

/**
 * Read a card file. Returns { card, image: Blob|null }.
 */
export async function readCard(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const t = readPngText(bytes);
    const raw = t.ccv3 || t.chara;
    if (!raw) throw new Error('This PNG has no character card inside');
    let json;
    try {
      json = JSON.parse(b64ToStr(raw));
    } catch {
      json = JSON.parse(raw);
    }
    return { card: normalize(json), image: new Blob([bytes], { type: 'image/png' }) };
  }
  if (name.endsWith('.charx') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const z = unzipSync(bytes);
    if (!z['card.json']) throw new Error('card.json missing in .charx');
    const json = JSON.parse(strFromU8(z['card.json']));
    const icon = (json.data?.assets || []).find((a) => a.type === 'icon');
    let image = null;
    const path = icon?.uri?.replace(/^embeded:\/\/|^embedded:\/\//, '');
    const imgEntry = (path && z[path]) || Object.entries(z).find(([k]) => /^assets\/.*\.(png|jpe?g|webp)$/i.test(k))?.[1];
    if (imgEntry) image = new Blob([imgEntry]);
    return { card: normalize(json), image };
  }
  const text = new TextDecoder().decode(bytes);
  return { card: normalize(JSON.parse(text)), image: null };
}

/** Lorebook from a card's character_book (keeps SillyTavern's per-entry extensions). */
export function cardLorebook(card, id) {
  if (!card.character_book) return null;
  try {
    return importLorebook(card.character_book, `${card.name}'s lorebook`, id);
  } catch {
    return null;
  }
}

/** Build a persona system prompt from a card. {{char}}/{{user}} stay as macros (filled in at send time). */
export function cardPrompt(c) {
  const parts = [];
  if (c.system_prompt.trim()) parts.push(c.system_prompt.replace(/\{\{original\}\}/gi, '').trim());
  parts.push(`You are {{char}}. Stay in character as {{char}} in this roleplay with {{user}}. Never speak or act for {{user}}.`);
  if (c.description.trim()) parts.push(`## {{char}}\n${c.description.trim()}`);
  if (c.personality.trim()) parts.push(`## Personality\n${c.personality.trim()}`);
  if (c.scenario.trim()) parts.push(`## Scenario\n${c.scenario.trim()}`);
  if (c.mes_example.trim()) parts.push(`## Example dialogue (style reference only)\n${c.mes_example.replace(/<START>/gi, '---').trim()}`);
  if (c.post_history_instructions.trim()) parts.push(`## Instructions\n${c.post_history_instructions.trim()}`);
  return parts.join('\n\n');
}

/** Persona → Character Card V2 JSON. */
export function personaToCard(p, lorebook) {
  const card = p.card || {};
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: p.name,
      description: card.description ?? p.prompt,
      personality: card.personality || '',
      scenario: card.scenario || '',
      first_mes: card.first_mes || '',
      mes_example: card.mes_example || '',
      creator_notes: p.description || card.creator_notes || '',
      system_prompt: card.description != null ? card.system_prompt || '' : '',
      post_history_instructions: card.post_history_instructions || '',
      alternate_greetings: card.alternate_greetings || [],
      tags: card.tags || [],
      creator: card.creator || 'Chronicle',
      character_version: '1',
      extensions: { ...(card.extensions || {}), ...(card.depth_prompt ? { depth_prompt: card.depth_prompt } : {}) },
      ...(lorebook
        ? {
            character_book: {
              name: lorebook.name,
              scan_depth: lorebook.scanDepth || 4,
              extensions: {},
              entries: lorebook.entries.map((e, i) => ({
                keys: e.keys,
                secondary_keys: e.secondaryKeys || [],
                selective: !!e.selective,
                content: e.content,
                enabled: e.enabled !== false,
                constant: !!e.constant,
                insertion_order: e.order ?? 100,
                case_sensitive: !!e.caseSensitive,
                position: e.position === 'after' ? 'after_char' : 'before_char',
                comment: e.name || '',
                id: i,
                extensions: {
                  position: e.position === 'depth' ? 4 : e.position === 'after' ? 1 : 0,
                  depth: e.depth ?? 4,
                  role: { system: 0, user: 1, assistant: 2 }[e.role || 'system'],
                  selectiveLogic: { and_any: 0, not_all: 1, not_any: 2, and_all: 3 }[e.logic || 'and_any'],
                  probability: e.probability ?? 100,
                  useProbability: (e.probability ?? 100) < 100,
                  match_whole_words: e.wholeWords !== false,
                  sticky: Number(e.sticky) || 0,
                  cooldown: Number(e.cooldown) || 0,
                  delay: Number(e.delay) || 0,
                },
              })),
            },
          }
        : {}),
    },
  };
}

/** Make a PNG card: the avatar image (or a generated one) with the card JSON embedded. */
export async function exportCardPng(p, lorebook, artUrl = null) {
  const json = JSON.stringify(personaToCard(p, lorebook));
  // full art that is already a PNG: keep the original pixels, just (re)write the card data
  if (artUrl?.startsWith('data:image/png;base64,')) {
    const bin = atob(artUrl.slice(22));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return writePngText(bytes, { chara: strToB64(json), ccv3: null });
  }
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = Math.round(size * 1.5);
  const g = c.getContext('2d');
  const full = artUrl ? new Image() : null;
  if (full) {
    full.src = artUrl;
    await full.decode().catch(() => {});
  }
  if (full?.width) {
    // keep the character art at its own shape and full size
    c.width = full.naturalWidth || full.width;
    c.height = full.naturalHeight || full.height;
    g.drawImage(full, 0, 0, c.width, c.height);
  } else if (p.avatar?.image) {
    const img = new Image();
    img.src = p.avatar.image;
    await img.decode().catch(() => {});
    const s = Math.max(c.width / img.width, c.height / img.height);
    g.drawImage(img, (c.width - img.width * s) / 2, (c.height - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    g.fillStyle = p.avatar?.bg || '#64748b';
    g.fillRect(0, 0, c.width, c.height);
    g.font = `${size * 0.5}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(p.avatar?.emoji || '🤖', c.width / 2, c.height / 2);
  }
  const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  return writePngText(png, { chara: strToB64(json) });
}

/** Fill {{char}} / {{user}} macros. */
export const fillMacros = (text, charName, userName) =>
  String(text || '')
    .replace(/\{\{char\}\}|<BOT>/gi, charName)
    .replace(/\{\{user\}\}|<USER>/gi, userName);
