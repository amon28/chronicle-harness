import { describe, it, expect } from 'vitest';
import { chubPath, chubCardUrl, botbooruId, botbooruCardUrl } from '../../src/api.js';

describe('chub links', () => {
  it('reads creator/slug from the usual link shapes', () => {
    expect(chubPath('https://chub.ai/characters/Anonymous/seraphina-4b2d1c')).toBe('Anonymous/seraphina-4b2d1c');
    expect(chubPath('https://www.chub.ai/characters/someone/island-of-the-dead?tab=details')).toBe('someone/island-of-the-dead');
    expect(chubPath('venus.chub.ai/characters/a.b/c_d')).toBe('a.b/c_d');
    expect(chubPath('https://characterhub.org/characters/x/y/')).toBe('x/y');
  });
  it('rejects other links', () => {
    expect(chubPath('https://chub.ai/lorebooks/x/y')).toBeNull();
    expect(chubPath('https://example.com/characters/x/y')).toBeNull();
    expect(chubPath('hello')).toBeNull();
  });
  it('points at the full card PNG', () => {
    expect(chubCardUrl('a/b')).toBe('https://avatars.charhub.io/avatars/a/b/chara_card_v2.png');
  });
});

describe('botbooru links', () => {
  it('reads the post id', () => {
    expect(botbooruId('https://botbooru.com/post/12345')).toBe('12345');
    expect(botbooruId('botbooru.com/post/7?tags=x')).toBe('7');
    expect(botbooruId('https://botbooru.com/')).toBeNull();
    expect(botbooruId('https://chub.ai/characters/a/b')).toBeNull();
  });
  it('points at the card PNG', () => {
    expect(botbooruCardUrl('99')).toBe('https://botbooru.com/download/png/99');
  });
});
