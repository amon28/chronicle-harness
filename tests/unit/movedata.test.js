import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeValue, decodeValue, localEntries, putLocalEntries, packHomeCmd, unpackHomeCmd, homeStatusCmd, parseHomeStatus } from '../../src/movedata.js';

// Decision 218: "Export everything" to move to another app id or phone.
const sh = (cmd) => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
const wait = async (dir) => {
  for (let i = 0; i < 100; i++) {
    const s = parseHomeStatus(sh(homeStatusCmd({ dir })));
    if (s.done) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('tar did not finish');
};
const put = (p, text) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, text));

describe('values with bytes', () => {
  it('git objects (bytes), Maps and Sets survive JSON', () => {
    const v = { objects: new Map([['abc', new Uint8Array([1, 2, 255])]]), refs: { main: 'abc' }, seen: new Set(['x']), buf: new Uint8Array([9]).buffer };
    const back = decodeValue(encodeValue(v));
    expect(back.objects.get('abc')).toEqual(new Uint8Array([1, 2, 255]));
    expect(back.refs).toEqual({ main: 'abc' });
    expect([...back.seen]).toEqual(['x']);
    expect(new Uint8Array(back.buf)).toEqual(new Uint8Array([9]));
  });
});

describe('the app\'s own lists on this phone', () => {
  it('moves usage history and learned abilities, not caches, logs or the settings copy', () => {
    const store = new Map([['ocm.usageLog', '[1]'], ['ocm.cap.glm', '{}'], ['ocm.cache.models', 'x'], ['ocm.errlog', 'e'], ['ocm.settings', '{"apiKey":"k"}'], ['other', 'y']]);
    const ls = { get length() { return store.size; }, key: (i) => [...store.keys()][i], getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const e = localEntries(ls);
    expect(e).toEqual({ 'ocm.usageLog': '[1]', 'ocm.cap.glm': '{}' });
    store.clear();
    expect(putLocalEntries({ ...e, 'ocm.settings': 'no', evil: 'no' }, ls)).toBe(2);
    expect([...store.keys()]).toEqual(['ocm.usageLog', 'ocm.cap.glm']);
  });
});

describe('the Linux home folder', () => {
  it('packs /root without Claude Code\'s sign-in, the app\'s own sign-in folder or caches, and unpacks it elsewhere', async () => {
    const base = mkdtempSync(join(tmpdir(), 'move-'));
    const home = join(base, 'root');
    const dir = join(base, 'move');
    put(join(home, 'project/src/main.js'), 'export const x = 1;\n');
    put(join(home, ".ssh/id_ed25519"), 'KEY');
    put(join(home, '.claude/settings.json'), '{}');
    put(join(home, '.claude/.credentials.json'), 'SIGN-IN');
    put(join(home, '.claude/backups/x.json'), 'B');
    put(join(home, '.claude.json'), 'ACCOUNT');
    put(join(home, '.claude.json.backup.1'), 'ACCOUNT');
    put(join(home, '.config/chronicle/gh-token'), 'TOKEN');
    put(join(home, '.cache/pip/x'), 'C');
    put(join(home, "odd name's.txt"), 'ok');
    // proot's hard-link emulation leaves git's half-written temporary objects as links to themselves (on the phone they
    // cannot be opened, and tar gave up on the whole home): they are left out
    mkdirSync(join(home, 'ocm/.git/objects/4b'), { recursive: true });
    execFileSync('ln', ['-s', '.l2s.tmp_obj_TyYBj60001', join(home, 'ocm/.git/objects/4b/.l2s.tmp_obj_TyYBj60001')]);
    put(join(home, 'ocm/.git/objects/4b/realobject'), 'git object');
    expect(sh(packHomeCmd({ home, dir }))).toMatch(/@@STARTED/);
    const s = await wait(dir);
    expect(s.ok).toBe(true);
    expect(s.bytes).toBeGreaterThan(0);
    const list = sh(`tar -tzf '${dir}/linux-home.tar.gz'`);
    expect(list).toMatch(/project\/src\/main\.js/);
    expect(list).toMatch(/\.ssh\/id_ed25519/);
    expect(list).toMatch(/\.claude\/settings\.json/);
    expect(list).toMatch(/odd name's\.txt/);
    expect(list).not.toMatch(/credentials|\.claude\.json|backups|gh-token|\.cache\/pip/);
    expect(list).toMatch(/ocm\/\.git\/objects\/4b\/realobject/);
    expect(list).not.toMatch(/\.l2s\.tmp_obj_/);
    expect(s.skipped).toBe(0);
    // somewhere else (the new app's Linux): unpacked into its home, the archive removed afterwards
    const home2 = join(base, 'root2');
    mkdirSync(home2);
    copyFileSync(join(dir, 'linux-home.tar.gz'), join(base, 'in.tar.gz'));
    sh(unpackHomeCmd(join(base, 'in.tar.gz'), { home: home2, dir }));
    expect((await wait(dir)).ok).toBe(true);
    expect(readFileSync(join(home2, 'project/src/main.js'), 'utf8')).toBe('export const x = 1;\n');
    expect(existsSync(join(home2, '.claude/.credentials.json'))).toBe(false);
    expect(existsSync(join(base, 'in.tar.gz'))).toBe(false);
  }, 30000);
});

describe('a home folder with files that cannot be read', () => {
  it('they are skipped and named, and the rest is still packed (exit 0 with --ignore-failed-read)', () => {
    const out = "@@EXIT 0 52428800\n@@SKIPPED 2\ntar: ./ocm/.git/objects/cf/.l2s.tmp_obj_pLQ7qg0001: Cannot open: Too many levels of symbolic links\ntar: ./work/locked.db: Cannot open: Permission denied\n";
    const s = parseHomeStatus(out);
    expect(s).toMatchObject({ done: true, ok: true, bytes: 52428800, skipped: 2 });
    expect(s.skippedNames).toEqual(['ocm/.git/objects/cf/.l2s.tmp_obj_pLQ7qg0001', 'work/locked.db']);
    expect(parseHomeStatus('@@EXIT 2 0\n@@SKIPPED 0\ntar: Exiting with failure status').ok).toBe(false);
  });
  it('the pack command asks GNU tar to skip unreadable files, and only GNU tar (busybox has no such option)', () => {
    expect(packHomeCmd()).toMatch(/tar --version 2>\/dev\/null \| grep -q GNU && F="--ignore-failed-read --warning=no-file-changed"/);
  });
});
