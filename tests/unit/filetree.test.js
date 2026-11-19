import { describe, it, expect } from 'vitest';
import { buildTree, filterFiles, ago } from '../../src/filetree.js';

const files = [
  { path: 'site/index.html', size: 100, mtime: 5 },
  { path: 'site/css/app.css', size: 50, mtime: 9 },
  { path: 'README.md', size: 10, mtime: 1 },
  { path: 'output/screenshots/a.jpg', size: 1000, mtime: 3 },
  { path: 'site/page10.html', size: 1, mtime: 2 },
  { path: 'site/page2.html', size: 1, mtime: 2 },
];

describe('chat files as folders', () => {
  it('groups paths into folders with counts, sizes and the newest change', () => {
    const t = buildTree(files);
    expect(t.count).toBe(6);
    expect(t.files.map((f) => f.name)).toEqual(['README.md']);
    expect(t.dirs.map((d) => d.name)).toEqual(['output', 'site']);
    const site = t.dirs[1];
    expect(site).toMatchObject({ path: 'site', count: 4, size: 152, mtime: 9 });
    expect(site.dirs[0]).toMatchObject({ name: 'css', path: 'site/css', count: 1 });
    // numbers in names sort like a person would: page2 before page10
    expect(site.files.map((f) => f.name)).toEqual(['index.html', 'page2.html', 'page10.html']);
  });
  it('sorts by newest or size', () => {
    expect(buildTree(files, 'newest').dirs.map((d) => d.name)).toEqual(['site', 'output']);
    expect(buildTree(files, 'size').dirs.map((d) => d.name)).toEqual(['output', 'site']);
  });
  it('finds files by every word of the search, in any order', () => {
    expect(filterFiles(files, 'SITE html').map((f) => f.path)).toEqual(['site/index.html', 'site/page10.html', 'site/page2.html']);
    expect(filterFiles(files, 'css app').map((f) => f.path)).toEqual(['site/css/app.css']);
    expect(filterFiles(files, '  ')).toBe(files);
  });
  it('says how long ago', () => {
    expect(ago(0)).toBe('');
    expect(ago(1000, 1000 + 10e3)).toBe('just now');
    expect(ago(0 + 1, 1 + 5 * 60e3)).toBe('5 min ago');
    expect(ago(1, 1 + 3 * 3600e3)).toBe('3 h ago');
  });
});
