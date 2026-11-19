import { describe, it, expect } from 'vitest';
import { fileLang, highlightFile, FILE_HL_MAX } from '../../src/filehl.js';

describe('file viewer highlighting', () => {
  it('finds the language from the name', () => {
    expect(fileLang('src/app.js')).toBe('javascript');
    expect(fileLang('main.py')).toBe('python');
    expect(fileLang('a/Dockerfile')).toBe('dockerfile');
    expect(fileLang('x.tsx')).toBe('typescript');
    expect(fileLang('notes.txt')).toBe('');
    expect(fileLang('README')).toBe('');
  });
  it('escapes the text and leaves big or unknown files plain', () => {
    const html = highlightFile('a.js', 'const x = "<img src=x onerror=alert(1)>";');
    expect(html).toContain('hljs-keyword');
    expect(html).not.toContain('<img');
    expect(highlightFile('a.txt', 'hello')).toBe('');
    expect(highlightFile('a.js', 'x'.repeat(FILE_HL_MAX + 1))).toBe('');
  });
});
