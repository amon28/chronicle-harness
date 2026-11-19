import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normPath, isHidden, parentOf, listCmd, readCmd, treeCmd, sizeCmd, parseList, parseRead, parseTree, parseSizes, sections, secretReason, listDir, readLinuxFile, planFolderCopy, LIST_CAP, KEY_NAME } from '../../src/linuxfiles.js';
import { setGithubAuth } from '../../src/github.js';

const sh = (cmd) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

describe('paths', () => {
  it('normalises: ~, relative, . and .., never above /', () => {
    expect(normPath('~')).toBe('/root');
    expect(normPath('~/a//b/./c/')).toBe('/root/a/b/c');
    expect(normPath('x/../y', '/tmp')).toBe('/tmp/y');
    expect(normPath('/../../etc')).toBe('/etc');
    expect(normPath('')).toBe('/root');
    expect(parentOf('/root/a')).toBe('/root');
    expect(parentOf('/')).toBe('/');
  });
  it('the hidden folder is recognised however the path is written', () => {
    for (const p of ['/root/.config/chronicle', '/root/.config/chronicle/', '/root/.config/chronicle/gh-token', '/root/x/../.config/./chronicle/ssh/key', '//root//.config/chronicle']) expect(isHidden(p), p).toBe(true);
    for (const p of ['/root/.config', '/root/.config/chronicle2', '/root/.config/chronicles/x', '/tmp/root/.config/chronicle']) expect(isHidden(p), p).toBe(false);
  });
  it('private key names', () => {
    expect(KEY_NAME.test('/root/.ssh/id_ed25519')).toBe(true);
    expect(KEY_NAME.test('/root/.ssh/id_rsa')).toBe(true);
    expect(KEY_NAME.test('/root/.ssh/id_rsa.pub')).toBe(false);
  });
  it('a path never reaches a command as text', () => {
    const evil = `/root/a'b"c $(touch /tmp/pwned) \`x\` ;rm -rf /`;
    for (const c of [listCmd(evil), readCmd(evil), treeCmd(evil), sizeCmd(evil, [evil])]) {
      expect(c).not.toContain('pwned');
      expect(c).not.toContain('rm -rf');
    }
  });
});

describe('the commands, run by a real sh against a real tree', () => {
  let T, H, A;
  beforeAll(() => {
    T = realpathSync(mkdtempSync(join(tmpdir(), 'lfs-')));
    H = T + '/root/.config/chronicle';
    A = T + '/root/astral dimension';
    mkdirSync(H + '/ssh', { recursive: true });
    writeFileSync(H + '/gh-token', 'gho_secret');
    writeFileSync(H + '/ssh/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
    mkdirSync(A + '/src/deep', { recursive: true });
    mkdirSync(A + '/.git/objects', { recursive: true });
    mkdirSync(A + '/node_modules/pkg', { recursive: true });
    writeFileSync(A + '/.git/HEAD', 'ref: refs/heads/main\n');
    writeFileSync(A + '/.git/objects/x', 'x'.repeat(5000));
    writeFileSync(A + '/node_modules/pkg/index.js', 'module.exports=1');
    writeFileSync(A + '/README.md', '# Astral\n');
    writeFileSync(A + '/src/main.js', 'console.log(1)\n');
    writeFileSync(A + '/src/deep/x.txt', 'deep');
    writeFileSync(A + `/q'uote "it" $HOME.txt`, 'quoted');
    writeFileSync(A + '/ünïcødé 名前.txt', 'unicode');
    writeFileSync(A + '/-dash.txt', 'dash');
    writeFileSync(A + '/line\nbreak.txt', 'nl');
    writeFileSync(A + '/.hidden', 'dot');
    symlinkSync('../.config/chronicle', A + '/sneaky');
    symlinkSync('src', A + '/srclink');
  });

  it('lists one folder: folders first, counts, links, odd names', () => {
    const r = parseList(sh(listCmd(A, { hidden: H })), { hidden: H });
    expect(r.error).toBeUndefined();
    expect(r.real).toBe(A);
    const names = r.entries.map((e) => e.name);
    expect(names.slice(0, 5).sort()).toEqual(['.git', 'node_modules', 'sneaky', 'src', 'srclink'].sort()); // links to folders count as folders
    for (const n of ['README.md', `q'uote "it" $HOME.txt`, 'ünïcødé 名前.txt', '-dash.txt', 'line\nbreak.txt', '.hidden']) expect(names, n).toContain(n);
    const src = r.entries.find((e) => e.name === 'src');
    expect(src).toMatchObject({ isDir: true, kind: 'dir', count: 2 });
    expect(r.entries.find((e) => e.name === '.git')).toMatchObject({ heavy: true });
    expect(r.entries.find((e) => e.name === 'sneaky')).toMatchObject({ kind: 'link', isDir: true });
    expect(r.entries.find((e) => e.name === 'README.md')).toMatchObject({ kind: 'file', size: 9 });
    expect(r.entries.find((e) => e.name === 'README.md').mtime).toBeGreaterThan(1e12);
  });

  it('the hidden folder: not listed in its parent, refused by path and through a link', () => {
    const cfg = parseList(sh(listCmd(T + '/root/.config', { hidden: H })), { hidden: H });
    expect(cfg.entries.map((e) => e.name)).not.toContain('chronicle');
    expect(parseList(sh(listCmd(H, { hidden: H })), { hidden: H }).error).toBe('hidden');
    expect(parseList(sh(listCmd(A + '/sneaky', { hidden: H })), { hidden: H }).error).toBe('hidden');
    expect(parseRead(sh(readCmd(A + '/sneaky/gh-token', { hidden: H }))).error).toBe('hidden');
    expect(parseRead(sh(readCmd(H + '/gh-token', { hidden: H }))).error).toBe('hidden');
  });

  it('reads files with odd names, in pieces', () => {
    for (const [n, want] of [[`q'uote "it" $HOME.txt`, 'quoted'], ['ünïcødé 名前.txt', 'unicode'], ['-dash.txt', 'dash'], ['line\nbreak.txt', 'nl']]) {
      const r = parseRead(sh(readCmd(A + '/' + n, { hidden: H })));
      expect(r.error, n).toBeUndefined();
      expect(new TextDecoder().decode(r.bytes), n).toBe(want);
      expect(r.real).toBe(A + '/' + n);
    }
    writeFileSync(T + '/big.bin', Buffer.alloc(1024 * 1024 + 10, 7));
    const p0 = parseRead(sh(readCmd(T + '/big.bin', { chunk: 0, hidden: H })));
    const p1 = parseRead(sh(readCmd(T + '/big.bin', { chunk: 1, hidden: H })));
    expect([p0.size, p0.bytes.byteLength, p1.bytes.byteLength]).toEqual([1024 * 1024 + 10, 1024 * 1024, 10]);
    expect(parseRead(sh(readCmd(A + '/src', { hidden: H })))).toMatchObject({ dir: true });
    expect(parseRead(sh(readCmd(A + '/nope', { hidden: H }))).error).toBe('missing');
  });

  it('a folder copy plan skips .git, node_modules and the hidden folder; links are not followed', () => {
    const t = parseTree(sh(treeCmd(T + '/root', { hidden: H })), { hidden: H });
    const rels = t.files.map((f) => f.rel);
    expect(rels).toContain('astral dimension/src/deep/x.txt');
    expect(rels).toContain('astral dimension/line\nbreak.txt');
    expect(rels.some((r) => r.includes('.git/') || r.includes('node_modules') || r.includes('chronicle') || r.includes('sneaky'))).toBe(false);
    expect(t.skipped.sort()).toEqual(['astral dimension/.git', 'astral dimension/node_modules']);
  });

  it('sizes of .git and node_modules', () => {
    const s = parseSizes(sh(sizeCmd(A, ['.git', 'node_modules'], { hidden: H })));
    expect(s['.git']).toBeGreaterThanOrEqual(4096);
    expect(s.node_modules).toBeGreaterThan(0);
  });
});

describe('parsing and caps', () => {
  it('caps a big folder and says how many more', () => {
    const lines = ['@@REAL', '/root/big', '@@STAT'];
    for (let i = 0; i < 1200; i++) lines.push(`81a4|10|1700000000|f${String(i).padStart(4, '0')}.txt`);
    lines.push('41ed|4096|1700000000|zdir', '@@LINKDIRS', '@@COUNT', '3|zdir', '@@END');
    const r = parseList(lines.join('\n'));
    expect(r.entries).toHaveLength(LIST_CAP);
    expect(r.total).toBe(1201);
    expect(r.more).toBe(1201 - LIST_CAP);
    expect(r.entries[0]).toMatchObject({ name: 'zdir', isDir: true, count: 3 });
  });
  it('an error section, and garbage', () => {
    expect(parseList('@@REAL\n/x\n@@ERR hidden\n').error).toBe('hidden');
    expect(parseList('sh: oops').error).toBe('no answer');
    expect(sections('@@A\n1\n@@B\n2\n3')).toMatchObject({ A: ['1'], B: ['2', '3'] });
  });
  it('a stat record never puts a hidden name or a name with a slash into the list', () => {
    const r = parseList(['@@REAL', '/root/.config', '@@STAT', '41c0|4096|1|chronicle', '41ed|4096|1|gh', '81a4|1|1|a/b', '@@END'].join('\n'));
    expect(r.entries.map((e) => e.name)).toEqual(['gh']);
  });
});

describe('secrets', () => {
  afterEach(() => setGithubAuth(null, () => {}));
  const enc = (s) => new TextEncoder().encode(s);
  it('private keys and the token are refused, ordinary text is not', () => {
    expect(secretReason(enc('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n'))).toMatch(/private key/);
    expect(secretReason(enc('cert\n-----BEGIN RSA PRIVATE KEY-----\nxx'))).toMatch(/private key/);
    expect(secretReason(enc('-----BEGIN PUBLIC KEY-----\nxx'))).toBe('');
    expect(secretReason(enc('hello'))).toBe('');
    setGithubAuth({ githubToken: 'gho_abcdefghijklmnop', githubUser: { login: 'me' } }, () => {});
    expect(secretReason(enc('github.com:\n  oauth_token: gho_abcdefghijklmnop\n'))).toMatch(/token/);
  });
});

describe('through a stand-in shell', () => {
  let T;
  beforeAll(() => {
    T = realpathSync(mkdtempSync(join(tmpdir(), 'lfs2-'))); // the hidden folder through a real sh is covered above
    mkdirSync(T + '/root/proj', { recursive: true });
    writeFileSync(T + '/root/proj/a.txt', 'hello');
    writeFileSync(T + '/root/proj/key', '-----BEGIN OPENSSH PRIVATE KEY-----\nzz\n');
    writeFileSync(T + '/root/proj/big.bin', Buffer.alloc(2 * 1024 * 1024 + 5, 1));
  });
  afterEach(() => delete globalThis.__ocmShell);
  const install = () => {
    const ids = [];
    // the commands name real paths; this runs them under T by rewriting /root to T/root inside the base64
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      exec: async ({ id, cmd }) => {
        ids.push(id);
        const fixed = cmd.replace(/'([A-Za-z0-9+/=]{4,})'/g, (m, b) => {
          const s = Buffer.from(b, 'base64').toString('utf8');
          return s.startsWith('/') ? `'${Buffer.from(T + s).toString('base64')}'` : m;
        });
        return { output: sh(fixed).replaceAll(T, ''), exit: 0 };
      },
    };
    return ids;
  };
  it('lists, reads in pieces, refuses keys, uses its own shell id', async () => {
    const ids = install();
    const l = await listDir('/root/proj');
    expect(l.entries.map((e) => e.name)).toEqual(['a.txt', 'big.bin', 'key']);
    const a = await readLinuxFile('/root/proj/a.txt');
    expect(new TextDecoder().decode(a.bytes)).toBe('hello');
    const big = await readLinuxFile('/root/proj/big.bin');
    expect(big.bytes.byteLength).toBe(2 * 1024 * 1024 + 5);
    expect(await readLinuxFile('/root/proj/key')).toMatchObject({ error: 'secret' });
    expect(await readLinuxFile('/root/proj/big.bin', { max: 1000 })).toMatchObject({ error: 'toobig' });
    expect(await readLinuxFile('/root/.config/chronicle/gh-token')).toMatchObject({ error: 'hidden' });
    expect(await listDir('/root/../root/.config/chronicle')).toMatchObject({ error: 'hidden' });
    expect(new Set(ids)).toEqual(new Set(['files-browser']));
    const plan = await planFolderCopy('/root/proj', { maxBytes: 1024 * 1024 });
    expect(plan.files.map((f) => f.rel).sort()).toEqual(['a.txt', 'key']);
    expect(plan.tooBig).toBe(1);
    expect(readFileSync(T + '/root/proj/a.txt', 'utf8')).toBe('hello'); // read-only
  });
});

describe('copying picked phone-folder files into a chat', () => {
  it('keeps the caps and leaves out git data and packages', async () => {
    const { planPickedCopy } = await import('../../src/linuxfiles.js');
    const sel = [
      { path: 'site/index.html', size: 10 },
      { path: 'site/.git/HEAD', size: 5 },
      { path: 'site/node_modules/x/a.js', size: 5 },
      { path: 'site/app.js', size: 20 },
      { path: 'site/big.bin', size: 100 },
    ];
    const r = planPickedCopy(sel, { maxFiles: 10, maxBytes: 50 });
    expect(r.files.map((x) => x.path)).toEqual(['site/index.html', 'site/app.js']);
    expect(r.skipped.sort()).toEqual(['site/.git', 'site/node_modules']);
    expect(r).toMatchObject({ more: 1, bytes: 30 });
    expect(planPickedCopy(sel, { maxFiles: 1 }).files).toHaveLength(1);
  });
});
