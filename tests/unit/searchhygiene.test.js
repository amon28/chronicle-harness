// Search result hygiene (the owner's harness report, G2): sign-up walls out of the page text, a cut said with its
// size, and results that match nothing marked as such.
import { describe, it, expect } from 'vitest';
import { dropBoilerplate, oldSnippetDate, weakMatch } from '../../src/websearch.js';

describe('search hygiene', () => {
  it('drops sign-up, member and cookie lines, keeps the article', () => {
    const t = ['Version 4.7 "Now, Lay Laughter to All Stars" is live since November 11.', 'What can you do as a free member?', 'Sign up for free to unlock all guides', 'We use cookies to improve your experience', 'The new banner features two five-star characters.'].join('\n');
    expect(dropBoilerplate(t)).toBe('Version 4.7 "Now, Lay Laughter to All Stars" is live since November 11.\nThe new banner features two five-star characters.');
  });
  it('keeps a long paragraph that only mentions a newsletter in passing', () => {
    const long = 'The studio announced in its newsletter that ' + 'the next chapter continues the story of the city and its factions. '.repeat(4);
    expect(dropBoilerplate(long)).toBe(long.trim());
  });
  it('marks a result that shares no searched word as a weak match', () => {
    // one shared word of six ("stress") is chance – weak, every run, whatever the engines return
    expect(weakMatch('__nonexistent_query_zzz_qwerty_12345_stress', { title: 'SQL stress test tool', url: 'https://github.com/x/y', snippet: 'Benchmark your database' })).toBe(true);
    expect(weakMatch('__nonexistent_query_zzz_qwerty_12345_stress', { title: 'Keyboard mash song qwerty', url: 'https://youtube.com/watch?v=2', snippet: 'zzz' })).toBe(false); // two of six
    expect(weakMatch('zzqx qwvb', { title: 'Keyboard mash song', url: 'https://youtube.com/watch?v=1', snippet: '' })).toBe(true);
    expect(weakMatch('Honkai Star Rail latest version', { title: 'Honkai: Star Rail 4.7', url: 'https://hsr.example', snippet: '' })).toBe(false);
    expect(weakMatch('the and', { title: 'x' })).toBe(false); // nothing to compare
  });
  it('drops a sign-up block with its short perk lines, not the article after it', () => {
    const t = ['Honkai: Star Rail Version 4.7 release date and banners', 'What can you do as a free member?', 'Bookmark articles', 'Post comments', '✓', 'Get notified', 'The 4.7 update brings a new story chapter set in the Penacony dreamscape, with two limited five-star characters.'].join('\n');
    expect(dropBoilerplate(t)).toBe('Honkai: Star Rail Version 4.7 release date and banners\nThe 4.7 update brings a new story chapter set in the Penacony dreamscape, with two limited five-star characters.');
  });
  it('flags a snippet dated more than about six months ago', () => {
    const now = Date.UTC(2026, 10, 15);
    expect(oldSnippetDate('Version 3.0 ... January 14, 2025 – patch notes', now)).toBe('2025-01-14');
    expect(oldSnippetDate('Released 14 Jan 2025', now)).toBe('2025-01-14');
    expect(oldSnippetDate('Posted 2026-11-11: version 4.7 is live', now)).toBe('');
    expect(oldSnippetDate('No date here', now)).toBe('');
    expect(oldSnippetDate('Due December 1, 2027', now)).toBe(''); // a future date is not "old"
  });
});
