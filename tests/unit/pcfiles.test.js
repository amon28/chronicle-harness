// Files on my PC (decision 223): the real scripts/pc-files.py on a temporary folder, driven by the app's pc_* tools.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, statSync, chmodSync, lstatSync } from 'node:fs';
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

const { runPcTool, pcHealth, pcDefs, pcPrompt, parsePairing, pcCall, DESTRUCTIVE, pcDanger, shortDiff } = await import('../../src/pcfiles.js');

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
    expect(pcDefs([ro]).map((d) => d.function.name)).toEqual(['pc_list', 'pc_search', 'pc_read', 'pc_import', 'pc_write', 'pc_edit']);
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
    expect((await run('pc_read', { path: join(outside, 'private.txt') }, c)).result).toMatch(/^    1\tnot shared\n\[sha256 [0-9a-f]{12}\]$/);
    expect((await run('pc_read', { path: join(root, 'game', '.env') }, c)).result).toMatch(/^    1\tAPI_KEY=secret\n\[sha256 /);
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
    expect(r.result).toMatch(/^Still running after .* – job j[0-9a-f]+, stopped by itself at the 10 min timeout \(10 min from now\)\. It keeps going; follow it with pc_job/);
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
  it('the timeout holds with nobody asking; the same job id sent twice runs once; pc_job list finds a lost id (decision 269)', async () => {
    globalThis.__ocmPcWait = 0.3;
    const c = ctx(box, 'auto');
    const r = await run('pc_shell', { command: `sleep 30; echo late >> ${join(dir, 'late.txt')}`, timeout_s: 1 }, c);
    const job = /job (j[0-9a-f]+)/.exec(r.result)[1];
    expect(r.result).toMatch(/stopped by itself at the 1 s timeout/);
    await new Promise((ok) => setTimeout(ok, 2000)); // no pc_job call in between: the PC ends it on its own
    const l = await run('pc_job', { action: 'list' }, c);
    expect(l.result).toMatch(new RegExp(`${job} – stopped at its 1 s timeout – sleep 30`));
    const w = await run('pc_job', { job, action: 'read' }, c);
    expect(w.result).toMatch(new RegExp(`^Stopped: job ${job} ran past the 1 s timeout and was ended`));
    expect(w.result).toMatch(/bigger timeout_s/);
    // a request sent again (its answer was lost on the way) is the same job – the command ran once
    const body = { command: `echo once >> ${join(dir, 'once.txt')}`, cwd: dir, timeout: 60, wait: 2, job: 'jabcdef0123' };
    const a = await pcCall(box, '/exec', body);
    const b = await pcCall(box, '/exec', body);
    expect([a.job, b.job, b.again]).toEqual(['jabcdef0123', 'jabcdef0123', true]);
    expect(readFileSync(join(dir, 'once.txt'), 'utf8')).toBe('once\n');
    await expect(pcCall(box, '/exec', { ...body, command: 'echo other' })).rejects.toThrow(/already used by another command/);
  }, 30000);
  it('an answer that never came names the job, and says not to run it again', async () => {
    const was = globalThis.__ocmPcHttp;
    globalThis.__ocmPcHttp = async () => {
      throw new Error('request timed out');
    };
    try {
      await expect(run('pc_shell', { command: 'make all' }, ctx(box, 'auto'))).rejects.toThrow(/as job j[0-9a-f]{10}: pc_job \(job "j[0-9a-f]{10}", action read\) shows it.*do not run it again/);
    } finally {
      globalThis.__ocmPcHttp = was;
    }
  });
  it('pc_read reaches past the first 4 MB: line by line, tail_lines for the end, offset for the middle (decision 269)', async () => {
    const c = ctx(box, 'auto');
    const big = join(dir, 'big.txt');
    // about 9 MB: three parts of 4 MB
    writeFileSync(big, Array.from({ length: 300000 }, (_, i) => `entry ${String(i + 1).padStart(6, '0')} ${'x'.repeat(20)}`).join('\n') + '\n');
    const deep = await run('pc_read', { path: big, start_line: 290000, max_lines: 2 }, c);
    expect(deep.result).toMatch(/^290000\tentry 290000 x+\n290001\tentry 290001 x+\n… \[more after line 290001 of 300000 – pc_read with start_line 290002\]$/);
    const end = await run('pc_read', { path: big, tail_lines: 2 }, c);
    expect(end.result).toMatch(/^\[the last 2 lines of .*big\.txt \(.*; line numbers are not counted this far into the file\)\]\nentry 299999 x+\nentry 300000 x+$/);
    const mid = await run('pc_read', { path: big, offset: 5000000, max_lines: 1 }, c);
    expect(mid.result).toMatch(/^\[.*big\.txt from byte \d+ of \d+; line numbers are not counted from an offset\]\nentry \d{6} x+\n… \[more after byte \d+ of \d+ – pc_read with offset \d+\]$/);
    const at = Number(/offset (\d+)\]$/.exec(mid.result)[1]);
    const next = await run('pc_read', { path: big, offset: at, max_lines: 1 }, c);
    expect(Number(/entry (\d+)/.exec(next.result)[1])).toBe(Number(/entry (\d+)/.exec(mid.result)[1]) + 1);
    // a line that is not there says how many there are
    expect((await run('pc_read', { path: join(dir, 'lines.txt'), start_line: 99 }, c)).result).toMatch(/has no line 99 – it has 3\d lines/);
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
    expect(r.result).toMatch(/^   10\tline 10\n   11\tline 11\n   12\tline 12\n… \[more after line 12 of 30 – pc_read with start_line 13\]\n\[sha256 [0-9a-f]{12}\]$/);
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
    const { symlinkSync } = await import('node:fs');
    const bin = join(dir, 'pcfzzz');
    // Node itself under another name: a link to it is run as "pcfzzz" (the process list names it so). A copy of the
    // system's sleep was used before, but on newer Ubuntu (the GitHub runner) that is a multi-call program that quit at
    // once under another name, however it was started.
    symlinkSync(process.execPath, bin);
    const wait = ['-e', 'setTimeout(() => {}, 300000)'];
    const ps = [spawn(bin, wait), spawn(bin, wait)];
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

describe('a kill or delete is the command, not a word in it (decision 270)', () => {
  it('asks for these', () => {
    for (const c of ['rm -rf x', '  del a.txt', 'taskkill /PID 1', 'Get-Process x | Stop-Process', 'sudo kill 12', 'ls; rm a', 'find . | xargs rm', 'find . | xargs -0 rm', 'shutdown /s', 'format c:', 'Remove-Item a', '(kill 1)', 'ri x', 'a && del b']) expect([c, DESTRUCTIVE.test(c)]).toEqual([c, true]);
  });
  it('not for these', () => {
    for (const c of ['git log --format=%H', 'Get-Process | Format-Table', 'echo kill', 'grep shutdown log.txt', 'npm run format', 'ls -la', 'kill-port.sh 3000', 'type rm.txt']) expect([c, DESTRUCTIVE.test(c)]).toEqual([c, false]);
  });
});

describe("a Windows command's output in the console's code page (decision 270)", () => {
  it('is read as UTF-8 when it is, else in the OEM code page; a character cut at the start of a tail is dropped', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = fileURLToPath(new URL('../../scripts/pc-files.py', import.meta.url));
    const py = `
src=open(${JSON.stringify(script)}, encoding='utf-8').read()
g={'IS_WIN':False}
exec(src[src.index('def _oem():'):src.index('def _tail(path):')],g)
out=[g['decode_out']('Größe'.encode()), g['decode_out'](b'\\x9f\\xc3\\xb6x', True)]
g['IS_WIN']=True; g['_oem']=lambda: 'cp850'
out.append(g['decode_out']('Größe'.encode('cp850')))
print('|'.join(out))`;
    expect(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim()).toBe('Größe|öx|Größe');
  });
});

describe('pc_shell asks before destructive admin commands, wherever they stand in the line (decision 274)', () => {
  it("asks for the reviewer's list", () => {
    const yes = ['sudo reboot', 'sudo poweroff', 'systemctl stop nginx', 'sudo systemctl disable --now sshd', 'docker rm -f web', 'docker system prune -af --volumes', 'docker volume rm data', 'docker compose down -v', 'dd if=/dev/zero of=/dev/sda', 'sudo mkfs.ext4 /dev/sdb1', 'zfs destroy tank/data', 'sudo -u www rm -rf /var/www', 'bash -c "rm -rf ~/x"', 'ssh nas "rm -rf /volume1/backup"', 'find /srv -name "*.log" -delete', 'crontab -r', 'truncate -s 0 app.log', 'time rm -rf x', 'powershell -Command "Remove-Item C:\\\\data -Recurse -Force"', 'powershell -c "Stop-Computer -Force"', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem | ForEach-Object { Remove-Item $_ }"', 'pwsh -EncodedCommand ZQBjAGgAbwA=', 'cmd /c del /q C:\\\\x', 'cmd.exe /C "rd /s /q build"', 'wsl rm -rf /mnt/c/x', 'kubectl delete ns prod', 'git reset --hard', 'sc stop wuauserv', 'echo y | sudo tee /dev/null && sudo shutdown now', 'nohup rm -rf old &'];
    for (const c of yes) expect([c, !!pcDanger(c)]).toEqual([c, true]);
    expect(pcDanger('systemctl stop nginx')).toMatch(/systemctl stop/);
    expect(pcDanger('ssh nas "rm -rf /volume1/backup"')).toMatch(/on nas/);
    expect(pcDanger('pwsh -EncodedCommand ZQBjAGgAbwA=')).toMatch(/cannot be read/);
  });
  it('still not for words that only look like it', () => {
    const no = ['git log --format=%H', 'Get-Process | Format-Table', 'echo kill', 'grep shutdown log.txt', 'npm run format', 'systemctl status nginx', 'systemctl restart nginx', 'docker ps -a', 'docker logs web', 'docker compose up -d', 'fdisk -l', 'ssh nas uptime', 'ssh nas', 'powershell -NoProfile -Command "Get-ChildItem C:\\\\data"', 'cmd /c dir', 'crontab -l', 'zfs list', 'find . -name "*.py"', 'kubectl get pods', 'sudo apt-get update', 'echo "rm -rf /"'];
    for (const c of no) expect([c, pcDanger(c)]).toEqual([c, '']);
  });
  it('/preview sees a delete behind sudo, after && and ;, and inside bash -c', async () => {
    const f = await start(['--full', '--no-qr']);
    const box = { id: 'p', name: 'Box', url: f.url, secret: SECRET, full: true, os: 'Linux' };
    const dir = mkdtempSync(join(tmpdir(), 'pcf-prev-'));
    writeFileSync(join(dir, 'a.log'), 'a');
    writeFileSync(join(dir, 'b.log'), 'b');
    for (const command of ['sudo rm -f a.log b.log', 'ls && rm *.log', 'cd . ; rm -f a.log b.log 2>/dev/null', 'bash -c "rm *.log"', 'time rm *.log']) {
      const pv = await pcCall(box, '/preview', { command, cwd: dir });
      expect([command, pv.files.map((x) => x.path.split('/').pop()).sort()]).toEqual([command, ['a.log', 'b.log']]);
    }
    expect((await pcCall(box, '/preview', { command: 'echo rm a.log', cwd: dir })).files).toEqual([]);
    // and so sudo rm of two files is stopped with the list, like rm of two
    const stop = await run('pc_shell', { command: 'sudo -n rm a.log b.log', cwd: dir }, ctx(box, 'auto', { ask: async (q, o) => o[0] }));
    expect(stop.result).toMatch(/^Not run: this would hit 2 things/);
  }, 20000);
  it('sudo that wants a password says how to do it; Windows says cmd and powershell -Command', async () => {
    const f = await start(['--full', '--no-qr']);
    const box = { id: 'p', name: 'Box', url: f.url, secret: SECRET, full: true, os: 'Linux' };
    const r = await run('pc_shell', { command: 'echo "sudo: a terminal is required to read the password; either use the -S option" >&2; exit 1' }, ctx(box, 'auto'));
    expect(r.result).toMatch(/Hint: sudo wanted a password.*sudo -n.*NOPASSWD/s);
    expect((await run('pc_shell', { command: 'echo fine' }, ctx(box, 'auto'))).result).not.toMatch(/Hint/);
    const d = pcDefs([{ ...box, os: 'Windows 11' }]).find((x) => x.function.name === 'pc_shell').function.description;
    expect(d).toMatch(/stdin is closed.*sudo -n/);
    expect(d).toMatch(/Windows runs cmd: for PowerShell use powershell -NoProfile -Command/);
    expect(pcDefs([box]).find((x) => x.function.name === 'pc_shell').function.description).not.toMatch(/Windows runs cmd/);
  }, 20000);
});

describe('the prompt says what a computer reaches (decision 274)', () => {
  it('full control: any absolute path, no "only the folders shown"; shared: only those, hidden files need --dotfiles', () => {
    const full = pcPrompt([{ name: 'Box', full: true, os: 'Linux' }], 'auto');
    expect(full).toMatch(/any file by absolute path/);
    expect(full).not.toMatch(/only the shared folders|Only the folders shown/);
    const shared = pcPrompt([{ name: 'Laptop', folders: ['game'], write: true }], 'ask');
    expect(shared).toMatch(/only the shared folders are reachable/);
    expect(shared).toMatch(/\.github, \.gitignore, \.env.*--dotfiles/);
    const both = pcPrompt([{ name: 'Laptop', folders: ['game'] }, { name: 'Box', full: true }], 'ask');
    expect(both).toMatch(/On "Laptop" only the shared folders.*A full-control computer reaches any file/);
  });
});

describe('pc_write keeps mode, owner and a .bak; a link is written through (decision 274)', () => {
  let pc;
  let share;
  beforeAll(async () => {
    share = mkdtempSync(join(tmpdir(), 'pcf-keep-'));
    writeFileSync(join(share, 'run.sh'), '#!/bin/sh\necho one\n');
    chmodSync(join(share, 'run.sh'), 0o750);
    writeFileSync(join(share, 'secrets.env'), 'A=1\n');
    chmodSync(join(share, 'secrets.env'), 0o600);
    writeFileSync(join(share, 'real.txt'), 'real\n');
    symlinkSync(join(share, 'real.txt'), join(share, 'link.txt'));
    const s = await start(['--write', `keep=${share}`]);
    pc = { id: 'k', name: 'Desk', url: s.url, secret: SECRET, write: true };
  }, 20000);
  it('a 750 script and a 600 file keep their mode; the version before is kept as <file>.bak, once', async () => {
    const a = await run('pc_write', { path: 'keep/run.sh', content: '#!/bin/sh\necho two\n' }, ctx(pc));
    expect(a.ok).toBe(true);
    expect(statSync(join(share, 'run.sh')).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(share, 'run.sh.bak'), 'utf8')).toBe('#!/bin/sh\necho one\n');
    expect(a.result).toMatch(/kept as keep\/run\.sh\.bak \(one \.bak, replaced the next time\)/);
    await run('pc_write', { path: 'keep/run.sh', content: '#!/bin/sh\necho three\n' }, ctx(pc));
    expect(readFileSync(join(share, 'run.sh.bak'), 'utf8')).toBe('#!/bin/sh\necho two\n');
    await run('pc_write', { path: 'keep/secrets.env', content: 'A=2\n' }, ctx(pc));
    expect(statSync(join(share, 'secrets.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(share, 'secrets.env')).uid).toBe(statSync(join(share, 'secrets.env.bak')).uid);
  });
  it('backup: false keeps none; a new file has none to keep', async () => {
    writeFileSync(join(share, 'nobak.txt'), 'x');
    const r = await run('pc_write', { path: 'keep/nobak.txt', content: 'y', backup: false }, ctx(pc));
    expect(r.result).not.toMatch(/\.bak/);
    expect(existsSync(join(share, 'nobak.txt.bak'))).toBe(false);
    const n = await run('pc_write', { path: 'keep/fresh.txt', content: 'new' }, ctx(pc));
    expect(n.result).toBe('Saved keep/fresh.txt on Desk (1 KB).');
  });
  it('a link is written through: the file it points to changes, the link stays a link', async () => {
    const r = await run('pc_write', { path: 'keep/link.txt', content: 'through\n' }, ctx(pc));
    expect(r.ok).toBe(true);
    expect(lstatSync(join(share, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(share, 'real.txt'), 'utf8')).toBe('through\n');
    expect(r.result).toMatch(/keep\/link\.txt is a link: the file it points to \(keep\/real\.txt\) was written/);
  });
  it('an older pc-files.py (no backup field) is named as one to update', async () => {
    const was = globalThis.__ocmPcHttp;
    globalThis.__ocmPcHttp = async (url, o) => {
      const r = await fetch(url, { method: o.method, headers: o.headers, body: o.body });
      let body = await r.text();
      if (url.endsWith('/write')) body = JSON.stringify({ size: JSON.parse(body).size });
      return { status: r.status, headers: {}, body };
    };
    try {
      const r = await run('pc_write', { path: 'keep/run.sh', content: 'old\n' }, ctx(pc));
      expect(r.result).toMatch(/older than version 5 – update it.*no \.bak/);
    } finally {
      globalThis.__ocmPcHttp = was;
    }
  });
});

describe('pc_edit: exact-text edits on the PC (decision 274)', () => {
  let pc;
  let share;
  beforeAll(async () => {
    share = mkdtempSync(join(tmpdir(), 'pcf-edit-'));
    writeFileSync(join(share, 'app.py'), 'def greet():\n    print("hi Alex")\n\ndef bye():\n    print("bye")\n    print("bye")\n');
    chmodSync(join(share, 'app.py'), 0o750);
    writeFileSync(join(share, 'latin.txt'), Buffer.from([0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a]));
    const s = await start(['--write', `code=${share}`]);
    pc = { id: 'e', name: 'Desk', url: s.url, secret: SECRET, write: true };
  }, 20000);
  it('replaces exactly once, keeps the mode and a .bak, shows the diff and the new sha256', async () => {
    const r = await run('pc_edit', { path: 'code/app.py', old_text: 'print("hi Alex")', new_text: 'print("hello Alex")' }, ctx(pc));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(share, 'app.py'), 'utf8')).toContain('print("hello Alex")');
    expect(statSync(join(share, 'app.py')).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(share, 'app.py.bak'), 'utf8')).toContain('print("hi Alex")');
    expect(r.result).toMatch(/^Edited code\/app\.py on Desk: 1 change\. The version before is kept as code\/app\.py\.bak/);
    expect(r.result).toMatch(/--- code\/app\.py\n\+\+\+ code\/app\.py\n@@ line 1 @@\n def greet\(\):\n-    print\("hi Alex"\)\n\+    print\("hello Alex"\)\n/);
    expect(r.result).toMatch(/\n\[sha256 [0-9a-f]{12}\]$/);
  });
  it('not unique, not found: refused, nothing changed; replace_all changes every one', async () => {
    const before = readFileSync(join(share, 'app.py'), 'utf8');
    await expect(run('pc_edit', { path: 'code/app.py', old_text: 'print("bye")', new_text: 'pass' }, ctx(pc))).rejects.toThrow(/appears 2 times/);
    await expect(run('pc_edit', { path: 'code/app.py', old_text: 'nope', new_text: 'x' }, ctx(pc))).rejects.toThrow(/was not found/);
    expect(readFileSync(join(share, 'app.py'), 'utf8')).toBe(before);
    const r = await run('pc_edit', { path: 'code/app.py', edits: [{ old_text: 'print("bye")', new_text: 'print("later")', replace_all: true }] }, ctx(pc));
    expect(r.result).toMatch(/: 2 changes\./);
    expect(readFileSync(join(share, 'app.py'), 'utf8')).not.toContain('bye")');
  });
  it('expect_sha256 from pc_read: a file changed since is refused', async () => {
    const read = await run('pc_read', { path: 'code/app.py' }, ctx(pc));
    const sha = /\[sha256 ([0-9a-f]{12})\]$/.exec(read.result)[1];
    const ok = await run('pc_edit', { path: 'code/app.py', old_text: 'def greet', new_text: 'def greet_alex', expect_sha256: sha }, ctx(pc));
    expect(ok.ok).toBe(true);
    // the sha256 it read is now old: the edit after a change by someone else is refused
    const stale = await run('pc_edit', { path: 'code/app.py', old_text: 'def bye', new_text: 'def farewell', expect_sha256: sha }, ctx(pc));
    expect(stale.ok).toBe(false);
    expect(stale.result).toMatch(/changed on Desk since you read it.*nothing was changed/);
    expect(readFileSync(join(share, 'app.py'), 'utf8')).toContain('def bye');
    const next = /\[sha256 ([0-9a-f]{12})\]$/.exec(ok.result)[1];
    expect((await run('pc_edit', { path: 'code/app.py', old_text: 'def bye', new_text: 'def farewell', expect_sha256: next }, ctx(pc))).ok).toBe(true);
  });
  it('review mode asks with the diff; no means nothing changed; read-only chat and PC refuse; other encodings are left alone', async () => {
    const asked = [];
    const no = await run('pc_edit', { path: 'code/app.py', old_text: 'def farewell', new_text: 'def bye' }, ctx(pc, 'ask', { ask: async (q, o) => (asked.push(q), o[1]) }));
    expect(no.ok).toBe(false);
    expect(asked[0]).toMatch(/^Change code\/app\.py on Desk\?\n\n--- code\/app\.py\n.*\n-def farewell\(\):\n\+def bye\(\):/s);
    expect(readFileSync(join(share, 'app.py'), 'utf8')).toContain('def farewell');
    expect((await run('pc_edit', { path: 'code/app.py', old_text: 'def farewell', new_text: 'def bye' }, ctx(pc, 'readonly'))).result).toMatch(/read-only/);
    expect((await run('pc_edit', { path: 'code/app.py', old_text: 'def farewell', new_text: 'def bye' }, ctx({ ...pc, write: false }))).result).toMatch(/--write/);
    await expect(run('pc_edit', { path: 'code/latin.txt', old_text: 'Gr', new_text: 'gr' }, ctx(pc))).rejects.toThrow(/not UTF-8/);
    await expect(run('pc_edit', { path: 'code/missing.txt', old_text: 'a', new_text: 'b' }, ctx(pc))).rejects.toThrow(/pc_write makes a new file/);
  });
  it('the diff stays short around the change in a long file', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 2500', 'LINE 2500');
    const d = shortDiff(a, b, 'f.txt');
    expect(d).toBe('--- f.txt\n+++ f.txt\n@@ line 2499 @@\n line 2498\n line 2499\n-line 2500\n+LINE 2500\n line 2501\n line 2502');
  });
});

describe('pc_search and pc_import with a real repo: node_modules, big files, what was not searched (decision 274)', () => {
  let pc;
  let repo;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'pcf-repo-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main.js'), 'export const NEEDLE_274 = 1;\n');
    // 400 packages of 6 entries each: more than the 2000 entries the old walk stopped at, before src was reached
    for (let i = 0; i < 400; i++) {
      mkdirSync(join(repo, 'node_modules', `pkg${i}`, 'lib'), { recursive: true });
      for (const n of ['a.js', 'b.js', 'c.js', 'd.js']) writeFileSync(join(repo, 'node_modules', `pkg${i}`, 'lib', n), 'x\n');
    }
    writeFileSync(join(repo, 'node_modules', 'pkg7', 'lib', 'a.js'), 'NEEDLE_274 in a package\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'NEEDLE_274 built\n');
    // a 5 MB log with the match at its very end (it was skipped without a word above 4 MB)
    writeFileSync(join(repo, 'big.log'), 'filler line\n'.repeat(450000) + 'the NEEDLE_274 at the end\n');
    const s = await start([`repo=${repo}`]);
    pc = { id: 'r', name: 'Laptop', url: s.url, secret: SECRET };
  }, 60000);
  it('finds it in src and in a big file, and says which folders were left out', async () => {
    const r = await run('pc_search', { text: 'needle_274' }, ctx(pc));
    expect(r.result).toContain('repo/src/main.js:1: export const NEEDLE_274 = 1;');
    expect(r.result).toContain('repo/big.log:450001: the NEEDLE_274 at the end');
    expect(r.result).not.toContain('node_modules/pkg7');
    expect(r.result).toMatch(/\(left out: repo\/dist, repo\/node_modules – folders a build or an install makes; all: true searches them too\)/);
  }, 30000);
  it('all: true searches them too; count_only counts; regex works; nothing found says how much was searched', async () => {
    const all = await run('pc_search', { text: 'needle_274', all: true }, ctx(pc));
    expect(all.result).toContain('repo/node_modules/pkg7/lib/a.js:1: NEEDLE_274 in a package');
    expect(all.result).toContain('repo/dist/bundle.js:1');
    const n = await run('pc_search', { text: 'needle_274', count_only: true, path: 'repo/src' }, ctx(pc));
    expect(n.result).toBe('repo/src/main.js: 1\n1 matching line in 1 file');
    const rx = await run('pc_search', { text: 'NEEDLE_\\d+ =', regex: true }, ctx(pc));
    expect(rx.result.split('\n')[0]).toBe('repo/src/main.js:1: export const NEEDLE_274 = 1;');
    const none = await run('pc_search', { text: 'not-there-at-all', path: 'repo/src' }, ctx(pc));
    expect(none.result).toBe('Nothing found in 1 file.');
    await expect(run('pc_search', { text: '([', regex: true }, ctx(pc))).rejects.toThrow(/not a valid regular expression/);
  }, 30000);
  it('an older pc-files.py (no skipped field) is named as one to update', async () => {
    const was = globalThis.__ocmPcHttp;
    globalThis.__ocmPcHttp = async () => ({ status: 200, headers: {}, body: JSON.stringify({ matches: [], cut: false }) });
    try {
      expect((await run('pc_search', { text: 'x' }, ctx(pc))).result).toMatch(/^Nothing found\.\n\(pc-files\.py on Laptop is older than version 5 – update it.*skips files over 4 MB/s);
    } finally {
      globalThis.__ocmPcHttp = was;
    }
  });
  it('pc_import of the repo root copies src and says what it left out', async () => {
    const c = ctx(pc);
    const r = await run('pc_import', { path: 'repo' }, c);
    expect(r.ok).toBe(true);
    expect(Object.keys(c.workspace.files).sort()).toEqual(['repo/big.log', 'repo/src/main.js']);
    expect(r.result).toMatch(/Left out \(made again by a build or an install\): repo\/dist, repo\/node_modules – all: true/);
  }, 30000);
});

describe('pc_job shows the last lines (decision 274)', () => {
  afterAll(() => delete globalThis.__ocmPcWait);
  it('80 by default with how many were left out; lines: 0 shows all', async () => {
    const f = await start(['--full', '--no-qr']);
    const box = { id: 'j', name: 'Box', url: f.url, secret: SECRET, full: true, os: 'Linux' };
    globalThis.__ocmPcWait = 0.2;
    const c = ctx(box, 'auto');
    const r = await run('pc_shell', { command: 'sleep 0.5; for i in $(seq 1 200); do echo "row $i"; done' }, c);
    const job = /job (j[0-9a-f]+)/.exec(r.result)[1];
    const w = await run('pc_job', { job, action: 'wait', wait_s: 10 }, c);
    expect(w.result).toMatch(/^Exit code 0\. \(in .*\)\n… \(120 earlier lines left out – lines: 0 shows all\)\nrow 121\n/);
    expect(w.result.trim().endsWith('row 200')).toBe(true);
    expect(w.result).not.toContain('row 120\n');
    const some = await run('pc_job', { job, action: 'read', lines: 3 }, c);
    expect(some.result).toMatch(/\(197 earlier lines left out.*\)\nrow 198\nrow 199\nrow 200/);
    const all = await run('pc_job', { job, action: 'read', lines: 0 }, c);
    expect(all.result).toContain('row 1\nrow 2\n');
  }, 30000);
});
