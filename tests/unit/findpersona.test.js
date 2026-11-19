import { describe, it, expect } from 'vitest';
import { findPersona } from '../../src/findpersona.js';
import { badArgsMessage } from '../../src/tools.js';

const list = [
  { id: 'p1', name: 'Vega Okonkwo' },
  { id: 'p2', name: 'Persona Maker' },
  { id: 'p3', name: 'Mira Vale' },
  { id: 'p4', name: 'Mira Stone' },
];
describe('finding a persona by what it is called', () => {
  it('matches id, exact name, and a unique partial name', () => {
    expect(findPersona(list, 'p3').persona.id).toBe('p3');
    expect(findPersona(list, 'persona maker').persona.id).toBe('p2');
    expect(findPersona(list, 'Vega').persona.id).toBe('p1');
    expect(findPersona(list, 'okonkwo').persona.id).toBe('p1');
    expect(findPersona(list, 'maker').persona.id).toBe('p2');
  });
  it('reports several candidates instead of guessing, and nothing for no match', () => {
    expect(findPersona(list, 'Mira').candidates.map((p) => p.id)).toEqual(['p3', 'p4']);
    expect(findPersona(list, 'Nobody')).toEqual({ candidates: [] });
    expect(findPersona(list, '')).toEqual({ candidates: [] });
  });
});

describe('bad tool arguments', () => {
  it('shows where the JSON broke and how long it was', () => {
    const raw = '{"a": "' + 'x'.repeat(300) + '" "b": 1}';
    let err;
    try {
      JSON.parse(raw);
    } catch (e) {
      err = e;
    }
    const msg = badArgsMessage(err, raw);
    expect(msg).toContain('⟨HERE⟩');
    expect(msg).toContain(`${raw.length} characters long`);
  });
  it('says so when the arguments were cut off', () => {
    expect(badArgsMessage(new Error('Unexpected end of JSON input'), '{"card": {"name": "Vega", "description": "long text')).toContain('cut off');
  });
});
