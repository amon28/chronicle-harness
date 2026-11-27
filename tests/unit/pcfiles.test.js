// Files on my PC (decision 223): the real scripts/pc-files.py on a temporary folder, driven by the app's pc_* tools.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/api.js', () => ({
  httpRequest: async (url, { method = 'GET', headers = {}, body = null } = {}) => {
    const r = await fetch(url, { method, headers, body });
    return { status: r.status, headers: {}, body: await r.text() };
  },
}));
vi.mock('../../src/sandbox.js', () => ({
  cleanPath: (p) => String(p || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').join('/'),
  looksText: (b) => !b.subarray(0, 8192).includes(0),
  bytesToText: (b) => new TextDecoder().decode(b),
  wsPut: (w, p, data) => ((w.files[p] = { data }), p),
}));

const { runPcTool, pcHealth, pcDefs, pcPrompt, parsePairing } = await import('../../src/pcfiles.js');

const SCRIPT = fileURLToPath(new URL('../../scripts/pc-files.py', import.meta.url));
const SECRET = 'test-secret-123';
const procs = [];
async function start(args) {
  const dir = mkdtempSync(join(tmpdir(), 'pcf-'));
  const portFile = join(dir, 'port');
  const p = spawn('python3', [SCRIPT, '--host', '127.0.0.1', '--port', '0', '--port-file', portFile, '--secret-stdin', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.end(SECRET + '\n');
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  procs.push(p);
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(portFile)) throw new Error('pc-files.py did not start: ' + out);
  for (let i = 0; i < 40 && !/Address:/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  return { url: `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`, out: () => out };
}

let root;
let outside;
let ro;
let rw;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pcf-share-'));
  outside = mkdtempSync(join(tmpdir(), 'pcf-outside-'));
  mkdirSync(join(root, 'game', 'src'), { recursive: true });
  writeFileSync(join(root, 'game', 'README.md'), '# My game\nA small game.\n');
  writeFileSync(join(root, 'game', 'src', 'main.py'), 'def main():\n    print("TODO: score")\n');
  writeFileSync(join(root, 'game', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]));
  writeFileSync(join(root, 'game', '.env'), 'API_KEY=secret');
  writeFileSync(join(outside, 'private.txt'), 'not shared');
  symlinkSync(join(outside, 'private.txt'), join(root, 'game', 'escape.txt'));
  symlinkSync(outside, join(root, 'game', 'outdir'));
  const a = await start([join(root, 'game')]);
  const b = await start(['--write', `proj=${join(root, 'game')}`]);
  ro = { id: 'a', name: 'Laptop', url: a.url, secret: SECRET };
  rw = { id: 'b', name: 'Desk', url: b.url, secret: SECRET, write: true, out: b.out };
}, 20000);
afterAll(() => procs.forEach((p) => p.kill()));

const ctx = (pc, mode = 'auto', extra = {}) => ({ settings: { pcFiles: [pc] }, workspace: { files: {} }, phone: { mode: () => mode }, ...extra });
const run = (name, args, c) => runPcTool(name, args, c);

describe('Files on my PC: pc-files.py and the pc_* tools', () => {
  it('says what it shares, and a wrong secret is refused', async () => {
    expect(await pcHealth(ro)).toMatchObject({ folders: ['game'], write: false });
    expect(await pcHealth(rw)).toMatchObject({ folders: ['proj'], write: true });
    await expect(pcHealth({ ...ro, secret: 'nope' })).rejects.toThrow(/refused the secret/);
  });
  it('lists the shared folders and their files; hidden files and links that lead out are left out', async () => {
    const top = await run('pc_list', {}, ctx(ro));
    expect(top.result.trim()).toBe('game/');
    const all = await run('pc_list', { path: 'game', recursive: true }, ctx(ro));
    expect(all.result).toContain('game/src/main.py');
    expect(all.result).toContain('game/README.md');
    expect(all.result).not.toContain('.env');
    expect(all.result).not.toContain('escape.txt');
    expect(all.result).not.toContain('outdir');
  });
  it('reads text, and refuses .., hidden files, links out of the folder and other folders', async () => {
    expect((await run('pc_read', { path: 'game/src/main.py' }, ctx(ro))).result).toContain('TODO: score');
    expect((await run('pc_read', { path: 'game/logo.png' }, ctx(ro))).result).toMatch(/not a text file/);
    await expect(run('pc_read', { path: 'game/../../etc/passwd' }, ctx(ro))).rejects.toThrow(/"\.\." is not allowed/);
    await expect(run('pc_read', { path: 'game/.env' }, ctx(ro))).rejects.toThrow(/hidden files/);
    await expect(run('pc_read', { path: 'game/escape.txt' }, ctx(ro))).rejects.toThrow(/outside the shared folder/);
    await expect(run('pc_read', { path: 'game/outdir/private.txt' }, ctx(ro))).rejects.toThrow(/outside the shared folder/);
    await expect(run('pc_read', { path: 'etc/passwd' }, ctx(ro))).rejects.toThrow(/no shared folder called 'etc'/);
  });
  it('searches by name and by text', async () => {
    expect((await run('pc_search', { name: '*.py' }, ctx(ro))).result).toBe('game/src/main.py');
    expect((await run('pc_search', { text: 'todo' }, ctx(ro))).result).toBe('game/src/main.py:2: print("TODO: score")');
  });
  it('copies a file or a whole folder into the workspace, bytes intact', async () => {
    const c = ctx(ro);
    const r = await run('pc_import', { path: 'game' }, c);
    expect(r.ok).toBe(true);
    expect(Object.keys(c.workspace.files).sort()).toEqual(['game/README.md', 'game/logo.png', 'game/src/main.py']);
    expect([...c.workspace.files['game/logo.png'].data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]);
    const c2 = ctx(ro);
    await run('pc_import', { path: 'game/src/main.py', to: 'code' }, c2);
    expect(Object.keys(c2.workspace.files)).toEqual(['code/main.py']);
  });
  it('a read-only PC and a read-only chat save nothing', async () => {
    const a = await run('pc_write', { path: 'game/new.txt', content: 'x' }, ctx(ro));
    expect(a.ok).toBe(false);
    expect(a.result).toMatch(/read-only|--write/);
    expect(existsSync(join(root, 'game', 'new.txt'))).toBe(false);
    const b = await run('pc_write', { path: 'proj/new.txt', content: 'x' }, ctx(rw, 'readonly'));
    expect(b.ok).toBe(false);
    expect(existsSync(join(root, 'game', 'new.txt'))).toBe(false);
  });
  it('saves with --write: at once in auto mode, after a yes in review mode, nothing after a no; read back to prove it', async () => {
    const a = await run('pc_write', { path: 'proj/out/summary.md', content: '# Done' }, ctx(rw, 'auto'));
    expect(a.ok).toBe(true);
    expect(a.meta.proof).toMatch(/read-back/);
    expect(readFileSync(join(root, 'game', 'out', 'summary.md'), 'utf8')).toBe('# Done');

    const asked = [];
    const no = await run('pc_write', { path: 'proj/README.md', content: 'gone' }, ctx(rw, 'ask', { ask: async (q, o) => (asked.push(q), o[1]) }));
    expect(no.ok).toBe(false);
    expect(asked[0]).toMatch(/^Replace proj\/README\.md on Desk/);
    expect(readFileSync(join(root, 'game', 'README.md'), 'utf8')).toContain('My game');

    const c = ctx(rw, 'ask', { ask: async (q, o) => o[0] });
    c.workspace.files['chart.png'] = { data: new Uint8Array([1, 2, 3, 0, 255]) };
    const yes = await run('pc_write', { path: 'proj/chart.png', from_workspace: 'chart.png' }, c);
    expect(yes.ok).toBe(true);
    expect([...readFileSync(join(root, 'game', 'chart.png'))]).toEqual([1, 2, 3, 0, 255]);
    // even with --write, a hidden file or a link out of the folder is not written
    await expect(run('pc_write', { path: 'proj/.bashrc', content: 'x' }, ctx(rw))).rejects.toThrow(/hidden/);
    await expect(run('pc_write', { path: 'proj/escape.txt', content: 'x' }, ctx(rw))).rejects.toThrow(/outside/);
    expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('not shared');
  });
  it('a folder typed with a dash in front, or a quote swallowed by cmd, is explained or understood', async () => {
    const { spawnSync } = await import('node:child_process');
    const dash = spawnSync('python3', [SCRIPT, '-' + join(root, 'game')], { encoding: 'utf8' });
    expect(dash.status).not.toBe(0);
    expect(dash.stderr).toContain('Folders are written without a dash in front');
    expect(dash.stderr).toContain('is a folder, so use that');
    const opt = spawnSync('python3', [SCRIPT, '--writ', join(root, 'game')], { encoding: 'utf8' });
    expect(opt.stderr).toMatch(/unknown option --writ/);
    // cmd: "C:\\…\\game\\" --write arrives as one word ending in a quote and the rest
    const a = await start([join(root, 'game') + '" --write --dotfiles']);
    expect(a.out()).toContain('read and save');
  });
  it('the tools and the prompt name the computers; with two, the assistant picks one', async () => {
    expect(pcDefs([ro]).map((d) => d.function.name)).toEqual(['pc_list', 'pc_search', 'pc_read', 'pc_import', 'pc_write']);
    expect(pcDefs([ro, rw])[0].function.parameters.properties.pc.enum).toEqual(['Laptop', 'Desk']);
    expect(pcPrompt([{ ...ro, folders: ['game'], write: false }], 'ask')).toMatch(/"Laptop" \(shares game; read-only\)/);
    const two = { settings: { pcFiles: [ro, rw] }, workspace: { files: {} }, phone: { mode: () => 'auto' } };
    expect((await run('pc_list', { pc: 'Desk' }, two)).result.trim()).toBe('proj/');
    await expect(run('pc_list', { pc: 'Nope' }, two)).rejects.toThrow(/No computer called "Nope"/);
    await expect(run('pc_list', {}, { settings: {}, workspace: { files: {} } })).rejects.toThrow(/No computer is connected/);
  });
});

describe('full control, the QR code and the pairing link (decision 230)', () => {
  let fullPc;
  beforeAll(async () => {
    const f = await start(['--full', '--no-qr']);
    fullPc = { id: 'f', name: 'Box', url: f.url, secret: SECRET, full: true, os: 'Linux' };
  }, 20000);
  it('--full: it says so, reaches any file by absolute path (hidden ones too) and saves there', async () => {
    expect(await pcHealth(fullPc)).toMatchObject({ full: true, write: true });
    const c = ctx(fullPc, 'auto');
    expect((await run('pc_read', { path: join(outside, 'private.txt') }, c)).result).toBe('    1\tnot shared');
    expect((await run('pc_read', { path: join(root, 'game', '.env') }, c)).result).toBe('    1\tAPI_KEY=secret');
    const w = await run('pc_write', { path: join(outside, 'new', 'made.txt'), content: 'hello' }, c);
    expect(w.ok).toBe(true);
    expect(readFileSync(join(outside, 'new', 'made.txt'), 'utf8')).toBe('hello');
    expect((await run('pc_list', { path: join(root, 'game', 'src') }, c)).result).toContain(join(root, 'game', 'src', 'main.py'));
  });
  it('pc_shell runs a command (asked first in review mode, refused read-only); a PC without --full refuses it', async () => {
    const asked = [];
    const r = await run('pc_shell', { command: 'echo hi && pwd', cwd: outside }, ctx(fullPc, 'ask', { ask: async (q, o) => (asked.push(q), o[0]) }));
    expect(asked[0]).toBe(`Run on Box (in ${outside}):\n\necho hi && pwd`);
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(new RegExp(`^Exit code 0\\. \\(in ${outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\nhi\\n`));
    const no = await run('pc_shell', { command: 'touch x' }, ctx(fullPc, 'ask', { ask: async (q, o) => o[1] }));
    expect(no.ok).toBe(false);
    expect((await run('pc_shell', { command: 'echo x' }, ctx(fullPc, 'readonly'))).result).toMatch(/read-only/);
    const fail = await run('pc_shell', { command: 'exit 3' }, ctx(fullPc));
    expect(fail.ok).toBe(false);
    expect(fail.result).toMatch(/^Exit code 3/);
    await expect(run('pc_shell', { command: 'echo x' }, ctx({ ...rw, full: true }))).rejects.toThrow(/full control/);
    expect(pcDefs([ro]).map((d) => d.function.name)).not.toContain('pc_shell');
    expect(pcDefs([ro, fullPc]).map((d) => d.function.name)).toContain('pc_shell');
  });
  it('the QR code pc-files.py draws reads back as the pairing link, and the link is understood', async () => {
    const { execFileSync } = await import('node:child_process');
    const jsQR = (await import('jsqr')).default;
    const link = 'chronicle://pc?u=http%3A%2F%2F100.101.102.103%3A8766&s=Qx9-Zr_4aWm2Lk8pVt0yHnB3&n=DESKTOP-1';
    const rows = execFileSync('python3', [SCRIPT, '--qr-matrix', link], { encoding: 'utf8' }).trim().split('\n');
    const n = rows.length, sc = 5, q = 4, W = (n + 2 * q) * sc;
    const img = new Uint8ClampedArray(W * W * 4).fill(255);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rows[y][x] === '1') for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) img.fill(0, (((y + q) * sc + dy) * W + (x + q) * sc + dx) * 4, (((y + q) * sc + dy) * W + (x + q) * sc + dx) * 4 + 3);
    expect(jsQR(img, W, W)?.data).toBe(link);
    expect(parsePairing(link)).toEqual({ url: 'http://100.101.102.103:8766', secret: 'Qx9-Zr_4aWm2Lk8pVt0yHnB3', name: 'DESKTOP-1' });
    expect(parsePairing('chronicle://pc?u=javascript%3Aalert(1)&s=x')).toBeNull();
    expect(parsePairing('chronicle://run?token=x')).toBeNull();
    expect(parsePairing('https://example.com')).toBeNull();
  });
});

describe("the agent's report: jobs, depth, line numbers, append, and what a kill or delete would hit (decision 233)", () => {
  let box;
  let dir;
  beforeAll(async () => {
    const f = await start(['--full', '--no-qr']);
    box = { id: 'b', name: 'Box', url: f.url, secret: SECRET, full: true, os: 'Linux' };
    dir = mkdtempSync(join(tmpdir(), 'pcf-agent-'));
    mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'c', 'deep.txt'), 'deep');
    writeFileSync(join(dir, 'lines.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  }, 20000);
  afterAll(() => delete globalThis.__ocmPcWait);
  it('a long command comes back as a job, not as "the PC did not answer"; pc_job waits for it, reads it, kills it', async () => {
    globalThis.__ocmPcWait = 0.5;
    const c = ctx(box, 'auto');
    const r = await run('pc_shell', { command: 'echo started; sleep 2; echo finished' }, c);
    expect(r.ok).toBe(true);
    const job = /job (j[0-9a-f]+)/.exec(r.result)[1];
    expect(r.result).toMatch(/^Still running after .* – job j[0-9a-f]+\. It keeps going; follow it with pc_job/);
    expect(r.result).toContain('started');
    const done = await run('pc_job', { job, action: 'wait', wait_s: 10 }, c);
    expect(done.ok).toBe(true);
    expect(done.result).toMatch(/^Exit code 0\..*\nstarted\nfinished/s);
    const slow = await run('pc_shell', { command: 'sleep 60' }, c);
    const j2 = /job (j[0-9a-f]+)/.exec(slow.result)[1];
    const killed = await run('pc_job', { job: j2, action: 'kill' }, c);
    expect(killed.result).toMatch(/^Killed\./);
    expect(killed.ok).toBe(false);
  }, 30000);
  it('pc_list takes a depth and a max; pc_read numbers the lines and reads from start_line; pc_write can append', async () => {
    const c = ctx(box, 'auto');
    const one = await run('pc_list', { path: dir, depth: 2 }, c);
    expect(one.result).toContain(join(dir, 'a', 'b') + '/');
    expect(one.result).not.toContain('deep.txt');
    const all = await run('pc_list', { path: dir, recursive: true }, c);
    expect(all.result).toContain('deep.txt');
    expect((await run('pc_list', { path: dir, recursive: true, max: 2 }, c)).result).toMatch(/cut at 2 entries/);
    const r = await run('pc_read', { path: join(dir, 'lines.txt'), start_line: 10, max_lines: 3 }, c);
    expect(r.result).toBe('   10\tline 10\n   11\tline 11\n   12\tline 12\n… [more after line 12 of 30 – pc_read with start_line 13]');
    await run('pc_write', { path: join(dir, 'lines.txt'), content: '\nline 31', append: true }, c);
    expect(readFileSync(join(dir, 'lines.txt'), 'utf8').endsWith('line 30\nline 31')).toBe(true);
  });
  it('a delete that would hit more than one file is stopped with the list; confirm runs it (asked first in Auto, not in Bypass)', async () => {
    writeFileSync(join(dir, 'x1.log'), 'a');
    writeFileSync(join(dir, 'x2.log'), 'b');
    const asked = [];
    const auto = ctx(box, 'auto', { ask: async (q, o) => (asked.push(q), o[0]) });
    const stop = await run('pc_shell', { command: 'rm *.log', cwd: dir }, auto);
    expect(stop.ok).toBe(false);
    expect(stop.result).toMatch(/^Not run: this would hit 2 things on Box:\nfile .*x1\.log \(1 KB\)\nfile .*x2\.log \(1 KB\)/);
    expect(existsSync(join(dir, 'x1.log'))).toBe(true);
    const go = await run('pc_shell', { command: 'rm *.log', cwd: dir, confirm: true }, auto);
    expect(go.ok).toBe(true);
    expect(asked[0]).toMatch(/rm \*\.log\n\nThis will hit:\nfile .*x1\.log/);
    expect(existsSync(join(dir, 'x1.log'))).toBe(false);
    // one file, in Bypass: no question, it runs
    writeFileSync(join(dir, 'one.log'), 'c');
    const by = ctx(box, 'auto', { ask: async () => { throw new Error('asked in Bypass'); } });
    by.phone.bypass = () => true;
    expect((await run('pc_shell', { command: 'rm one.log', cwd: dir }, by)).ok).toBe(true);
    expect(existsSync(join(dir, 'one.log'))).toBe(false);
  });
  it('a kill that would hit two processes is stopped with their pids – the Notepad lesson', async () => {
    const { copyFileSync, chmodSync } = await import('node:fs');
    const bin = join(dir, 'pcfzzz');
    copyFileSync('/bin/sleep', bin);
    chmodSync(bin, 0o755);
    // started as "sleep": on newer Ubuntu (the GitHub runner) sleep is one multi-call program that picks what to do by
    // the name it is started as, and as "pcfzzz" it quits at once. The process is still called pcfzzz (its file name).
    const ps = [spawn(bin, ['300'], { argv0: 'sleep' }), spawn(bin, ['300'], { argv0: 'sleep' })];
    procs.push(...ps);
    await new Promise((r) => setTimeout(r, 300));
    expect(ps.map((p) => p.exitCode)).toEqual([null, null]); // both really running before the kill is tried
    const by = ctx(box, 'auto');
    by.phone.bypass = () => true;
    const stop = await run('pc_shell', { command: 'pkill pcfzzz' }, by);
    expect(stop.ok).toBe(false);
    expect(stop.result).toContain(`process pcfzzz (pid ${ps[0].pid})`);
    expect(stop.result).toContain(`process pcfzzz (pid ${ps[1].pid})`);
    expect(stop.result).toMatch(/taskkill \/PID 1234/);
    expect(ps[0].exitCode).toBeNull();
    await run('pc_shell', { command: `kill ${ps[0].pid}` }, by);
    await new Promise((r) => setTimeout(r, 300));
    expect(ps[0].signalCode).toBe('SIGTERM');
    expect(ps[1].exitCode).toBeNull();
  });
});
