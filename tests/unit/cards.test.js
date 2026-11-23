import { describe, it, expect } from 'vitest';
import { writePngText, readCard, cardPrompt, cardLorebook } from '../../src/cards.js';

// 1×1 transparent PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Seraphina',
    description: 'A guardian of the forest.',
    personality: 'kind',
    scenario: 'You wake up in her glade.',
    first_mes: '*Seraphina kneels beside you.*',
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
    alternate_greetings: ['Who walks here?'],
    system_prompt: '{{original}} Extra.',
    post_history_instructions: 'Stay gentle.',
    character_book: { entries: [{ keys: ['glade'], content: 'The glade is safe.', enabled: true, insertion_order: 10 }] },
  },
};

describe('character cards', () => {
  it('round-trips a V2 card through PNG tEXt chunks', async () => {
    const png = writePngText(PNG, { chara: b64(JSON.stringify(v2)) });
    const { card, image } = await readCard(new File([png], 'seraphina.png', { type: 'image/png' }));
    expect(card.name).toBe('Seraphina');
    expect(card.alternate_greetings).toEqual(['Who walks here?']);
    expect(card.post_history_instructions).toBe('Stay gentle.');
    expect(image).toBeTruthy();
  });
  it('reads plain JSON cards and builds a prompt and lorebook', async () => {
    const { card } = await readCard(new File([JSON.stringify(v2)], 'card.json'));
    expect(cardPrompt(card)).toContain('A guardian of the forest.');
    const lb = cardLorebook(card, 'lb_x');
    expect(lb.entries[0]).toMatchObject({ keys: ['glade'], content: 'The glade is safe.' });
  });
  it('rejects a PNG without a card', async () => {
    await expect(readCard(new File([PNG], 'x.png'))).rejects.toThrow(/no character card/);
  });
});

import { readCard as readCard2, writePngText as wpt } from '../../src/cards.js';
describe('a PNG with two chara chunks', () => {
  it('uses the full card, not the stub after it', async () => {
    // a minimal PNG: signature + IEND, then two tEXt "chara" chunks appended by hand
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const base = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const full = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Mary', first_mes: 'The afternoon sun streams in.', alternate_greetings: ['a', 'b'] } }) });
    const stub = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Mary', first_mes: '...' } }) });
    // splice the stub's tEXt chunk in after the full one (before IEND)
    const stubChunk = stub.subarray(8, stub.length - 12);
    const both = new Uint8Array(full.length + stubChunk.length);
    both.set(full.subarray(0, full.length - 12));
    both.set(stubChunk, full.length - 12);
    both.set(full.subarray(full.length - 12), full.length - 12 + stubChunk.length);
    const { card } = await readCard2(new File([both], 'mary.png'));
    expect(card.first_mes).toBe('The afternoon sun streams in.');
    expect(card.alternate_greetings).toHaveLength(2);
  });  it('a forked card: the first card is it, not the longer card it was forked from after it', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const base = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const fork = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Mel', description: 'Yozora Mel usually just responds to "Mel."', first_mes: 'Ring station was on lockdown.' } }) });
    const parent = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Yozora Mel (Battle Android)', description: 'Ookami Mio usually just goes by "Mio." ' + 'Mio is an android. '.repeat(40), first_mes: 'Ring station was on lockdown.', creator_notes: 'My 296th bot.' } }) });
    const extra = parent.subarray(8, parent.length - 12);
    const both = new Uint8Array(fork.length + extra.length);
    both.set(fork.subarray(0, fork.length - 12));
    both.set(extra, fork.length - 12);
    both.set(fork.subarray(fork.length - 12), fork.length - 12 + extra.length);
    const { card } = await readCard2(new File([both], 'mel.png'));
    expect(card.name).toBe('Mel');
    expect(card.description).toContain('Yozora Mel');
    expect(card.description).not.toContain('Mio');
  });
  it('a stub first and the card after it: the card', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const base = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const stub = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Mary', first_mes: '...' } }) });
    const full = wpt(base, { chara: b64({ spec: 'chara_card_v2', data: { name: 'Mary', description: 'A guardian.', first_mes: 'Hello.' } }) });
    const extra = full.subarray(8, full.length - 12);
    const both = new Uint8Array(stub.length + extra.length);
    both.set(stub.subarray(0, stub.length - 12));
    both.set(extra, stub.length - 12);
    both.set(stub.subarray(stub.length - 12), stub.length - 12 + extra.length);
    const { card } = await readCard2(new File([both], 'mary.png'));
    expect(card.first_mes).toBe('Hello.');
  });
});
