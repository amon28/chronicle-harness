import { describe, it, expect } from 'vitest';
import { buildChatExport, chatPersonaIds, detectChatFile, parseChatExport, planChatImport, CHAT_EXPORT_VERSION } from '../../src/chatexport.js';
import { toStChat } from '../../src/stchat.js';

const sera = { id: 'p_sera', name: 'Seraphina', rp: true, cardMode: true, avatar: { emoji: '🌿', bg: '#22c55e' }, prompt: 'You are Seraphina.', card: { description: 'A guardian of the glade.', first_mes: 'Easy now.', alternate_greetings: ['Who goes there?'] }, hasArt: true, lorebookId: 'lb_glade', reimportUndo: { big: 'x' } };
const finn = { id: 'p_finn', name: 'Finn', rp: true, prompt: 'You are Finn.', avatar: { emoji: '🗡', bg: '#000' }, apiKey: 'sk-leak' };
const me = { id: 'u_me', name: 'Rich', description: 'A lost traveller.' };
const book = { id: 'lb_glade', name: 'Glade', entries: [{ keys: ['glade'], content: 'A clearing.' }] };
const conv = {
  id: 'c1',
  title: 'In the glade',
  titleSource: 'user',
  createdAt: 1000,
  updatedAt: 2000,
  personaId: 'p_sera',
  userPersonaId: 'u_me',
  group: { members: ['p_sera', 'p_finn'], mode: 'auto', name: 'Glade', scenario: 'A forest' },
  rpPreset: 'preset_vivid',
  authorsNote: { text: 'Keep it cozy', depth: 4 },
  tracker: { text: 'Time: dusk', at: 1500, upto: 3 },
  trackerOn: true,
  story: { text: 'Rich woke up in the glade.', upto: 3, at: 1600 },
  lorebookIds: ['lb_glade'],
  pinned: true,
  folderId: 'f_1',
  phoneFolder: { uri: 'content://x' },
  git: { auto: true, token: 'ghp_secret' },
  schedules: [{ at: 1 }],
  messages: [
    { role: 'assistant', greeting: true, content: 'Easy now.', personaId: 'p_sera', alts: [{ content: 'Easy now.', personaId: 'p_sera' }, { content: 'Who goes there?', personaId: 'p_sera' }], altIndex: 0 },
    { role: 'user', content: 'Where am I?', at: 1100 },
    { role: 'assistant', content: 'In my glade.', personaId: 'p_sera', alts: [{ content: 'In my glade.', personaId: 'p_sera' }, { content: 'Safe.', personaId: 'p_finn' }], altIndex: 1, tool: { args: { apiKey: 'sk-deep' } } },
  ],
};
const ctx = { personas: [sera, finn, { id: 'p_other', name: 'Other' }], userPersonas: [{ id: 'u_def', name: 'Default' }, me], defaultUserPersonaId: 'u_def', lorebooks: [book], art: { p_sera: 'data:image/png;base64,AAAA' }, memories: [{ id: 'm1', conv: 'c1', text: 'Rich likes tea', scope: 'p_sera' }, { id: 'm2', conv: 'c2', text: 'not this one' }], now: Date.UTC(2026, 10, 14) };

let n = 0;
const ids = () => ({ newId: () => `new${++n}-aaaaaaaa`, newPersonaId: () => `p_new${++n}`, newMemoryId: () => `m_new${++n}` });
const roundTrip = (data) => JSON.parse(JSON.stringify(data));

describe('Chronicle chat export', () => {
  it('carries the whole chat, its characters (with the picture), you, the lorebook and its memories', () => {
    const x = buildChatExport(conv, ctx);
    expect(x).toMatchObject({ format: 'chronicle-chat', version: CHAT_EXPORT_VERSION, exportedAt: '2026-11-14T00:00:00.000Z' });
    expect(x.chat).toMatchObject({ title: 'In the glade', createdAt: 1000, updatedAt: 2000, rpPreset: 'preset_vivid', authorsNote: { text: 'Keep it cozy' }, tracker: { text: 'Time: dusk' }, story: { text: 'Rich woke up in the glade.' }, group: { members: ['p_sera', 'p_finn'], scenario: 'A forest' } });
    expect(x.chat.messages).toHaveLength(3);
    expect(x.chat.messages[0]).toMatchObject({ greeting: true, alts: [{}, { content: 'Who goes there?' }] });
    expect(x.chat.messages[2].altIndex).toBe(1);
    expect(x.characters.map((p) => p.id)).toEqual(['p_sera', 'p_finn']);
    expect(x.characters[0].art).toBe('data:image/png;base64,AAAA');
    expect(x.characters[0].card.alternate_greetings).toEqual(['Who goes there?']);
    expect(x.characters[0].reimportUndo).toBeUndefined();
    expect(x.userPersona).toMatchObject({ id: 'u_me', name: 'Rich', usedByChat: true });
    expect(x.lorebooks.map((b) => b.id)).toEqual(['lb_glade']);
    expect(x.memories.map((m) => m.text)).toEqual(['Rich likes tea']);
  });

  it('has no keys or tokens and nothing that belongs to this phone', () => {
    const text = JSON.stringify(buildChatExport(conv, ctx));
    for (const s of ['sk-leak', 'sk-deep', 'ghp_secret', 'content://x', 'apiKey']) expect(text).not.toContain(s);
    const x = JSON.parse(text);
    for (const k of ['pinned', 'folderId', 'phoneFolder', 'git', 'schedules']) expect(x.chat[k]).toBeUndefined();
    expect(x.note).toMatch(/Workspace files/);
  });

  it('lists every character the chat uses, also ones only in another version of a reply', () => {
    expect(chatPersonaIds({ personaId: 'a', messages: [{ personaId: 'b', alts: [{ personaId: 'c' }] }] })).toEqual(['a', 'b', 'c']);
  });
});

describe('Chronicle chat import', () => {
  const file = () => JSON.stringify(buildChatExport(conv, ctx));

  it('on another phone: makes the characters, you and the lorebook from the copies, under a new chat id', () => {
    const data = parseChatExport(file());
    const plan = planChatImport(data, { personas: [{ id: 'p_asst', name: 'Assistant', builtin: true }], userPersonas: [{ id: 'u_x', name: 'Someone' }], lorebooks: [], ...ids() });
    expect(plan.addPersonas.map((p) => p.id)).toEqual(['p_sera', 'p_finn']); // their own ids are free here
    expect(plan.addPersonas[0]).toMatchObject({ name: 'Seraphina', rp: true, hasArt: true, lorebookId: 'lb_glade' });
    expect(plan.addPersonas[0].art).toBeUndefined();
    expect(plan.art).toEqual([{ id: 'p_sera', dataUrl: 'data:image/png;base64,AAAA' }]);
    expect(plan.addUserPersonas).toEqual([{ id: 'u_me', name: 'Rich', description: 'A lost traveller.' }]);
    expect(plan.addLorebooks.map((b) => b.id)).toEqual(['lb_glade']);
    expect(plan.conv.id).not.toBe('c1');
    expect(plan.conv).toMatchObject({ title: 'In the glade', personaId: 'p_sera', userPersonaId: 'u_me', rpPreset: 'preset_vivid', createdAt: 1000, updatedAt: 2000, lorebookIds: ['lb_glade'] });
    expect(plan.conv.messages[2].alts[1]).toEqual({ content: 'Safe.', personaId: 'p_finn' });
    expect(plan.memories).toEqual([{ id: expect.stringMatching(/^m_new/), conv: plan.conv.id, text: 'Rich likes tea', scope: 'p_sera' }]);
    expect(plan.made).toEqual(['Seraphina', 'Finn']);
  });

  it('on the same phone: reuses the characters, you and the lorebook – nothing is duplicated or overwritten', () => {
    const plan = planChatImport(parseChatExport(file()), { personas: [sera, { ...finn, apiKey: undefined }], userPersonas: [me], lorebooks: [book], ...ids() });
    expect(plan.addPersonas).toEqual([]);
    expect(plan.addUserPersonas).toEqual([]);
    expect(plan.addLorebooks).toEqual([]);
    expect(plan.art).toEqual([]);
    expect(plan.reused).toEqual(['Seraphina', 'Finn']);
    expect(plan.conv.id).not.toBe('c1');
    expect(plan.conv.personaId).toBe('p_sera');
  });

  it('an identical character under another id is reused; a different one with the same id gets a new id', () => {
    const twin = { ...sera, id: 'p_twin', hasArt: false };
    const clash = { id: 'p_finn', name: 'Someone else entirely', prompt: 'x' };
    const plan = planChatImport(parseChatExport(file()), { personas: [twin, clash], userPersonas: [], lorebooks: [], ...ids() });
    expect(plan.conv.personaId).toBe('p_twin');
    expect(plan.addPersonas).toHaveLength(1);
    const finnCopy = plan.addPersonas[0];
    expect(finnCopy.name).toBe('Finn');
    expect(finnCopy.id).not.toBe('p_finn');
    expect(plan.conv.group.members).toEqual(['p_twin', finnCopy.id]);
    expect(plan.conv.messages[2].alts[1].personaId).toBe(finnCopy.id);
  });

  it('survives JSON and keeps the chat on its side: a group of roleplay characters stays a roleplay', () => {
    const plan = planChatImport(roundTrip(parseChatExport(file())), { personas: [], userPersonas: [], lorebooks: [], ...ids() });
    expect(plan.addPersonas.every((p) => p.rp)).toBe(true);
    expect(plan.conv.pinned).toBeUndefined();
    expect(plan.conv.folderId).toBeUndefined();
  });

  it('refuses a newer format, a file without a version, and things that are not chat files', () => {
    const x = JSON.parse(file());
    expect(() => parseChatExport(JSON.stringify({ ...x, version: CHAT_EXPORT_VERSION + 1 }))).toThrow(/newer version/);
    expect(() => parseChatExport(JSON.stringify({ ...x, version: undefined }))).toThrow(/no version/);
    expect(() => parseChatExport(JSON.stringify({ ...x, chat: {} }))).toThrow(/no messages/);
    expect(() => parseChatExport('{"spec":"chara_card_v2"}')).toThrow(/not a Chronicle chat/);
    expect(() => parseChatExport('nope')).toThrow(/not valid JSON/);
    // an old file (version 1) without the optional parts still imports
    const old = parseChatExport(JSON.stringify({ format: 'chronicle-chat', version: 1, chat: { title: 'Old', messages: [{ role: 'user', content: 'hi' }] } }));
    const plan = planChatImport(old, { personas: [], userPersonas: [], lorebooks: [], ...ids() });
    expect(plan.conv).toMatchObject({ title: 'Old', messages: [{ role: 'user', content: 'hi' }] });
    expect(plan.conv.userPersonaId).toBeUndefined();
  });

  it('tells a Chronicle file from a SillyTavern chat', () => {
    expect(detectChatFile(file())).toBe('chronicle');
    expect(detectChatFile('﻿' + file())).toBe('chronicle');
    expect(detectChatFile(toStChat(conv, { user: 'Rich', character: 'Seraphina' }))).toBe('st');
    expect(detectChatFile('{"name":"Seraphina","is_user":false,"mes":"Hi"}')).toBe('st');
    expect(detectChatFile('{"spec":"chara_card_v2","data":{}}')).toBe(null);
    expect(detectChatFile('{\n  "a": 1\n}')).toBe(null);
    expect(detectChatFile('hello')).toBe(null);
    expect(detectChatFile('')).toBe(null);
  });
});
