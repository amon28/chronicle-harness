import { describe, it, expect } from 'vitest';
import { speechText } from '../../src/speech.js';

describe('speechText skipActions', () => {
  it('leaves out *actions* but keeps **bold** and dialogue', () => {
    expect(speechText('*She smiles.* "Hello there." **Really** nice.', { skipActions: true })).toBe('"Hello there." Really nice.');
  });
  it('reads everything without it', () => expect(speechText('*She smiles.* Hi')).toBe('She smiles. Hi'));
});
