import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseCmd, parseDiagnose } from '../../src/claudecode.js';
import { AcpClient } from '../../src/acp.js';

// Decision 216: when the phone's bridge stops answering, Linux is asked why before the user is told.
const run = (dir) => execFileSync('/bin/sh', ['-c', diagnoseCmd({ dir })], { encoding: 'utf8' });

describe('what became of the bridge', () => {
  it('the script runs in a real shell: a pid that is gone, the log\'s last lines, memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccdiag-'));
    writeFileSync(join(dir, 'bridge.pid'), '999999\n');
    writeFileSync(join(dir, 'bridge.log'), 'acp-bridge: agent running (pid 12)\nIn Chronicle › Settings\nTraceback (most recent call last):\nMemoryError\n');
    const out = run(dir);
    expect(out).toMatch(/@@BRIDGE gone/);
    expect(out).toMatch(/@@AGENTS \d+/);
    expect(out).toMatch(/@@MEM \d+/);
    const d = parseDiagnose(out);
    expect(d.alive).toBe(false);
    expect(d.why).toMatch(/the bridge process is gone.*stopped from outside.*runs short of memory.*Linux has \d+ MB of memory free now/s);
    expect(d.why).toMatch(/The last lines of its log: Traceback \(most recent call last\): \| MemoryError/);
    expect(d.why).not.toMatch(/agent running|In Chronicle/);
  });
  it('a bridge still running is alive (this process stands in for it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccdiag-'));
    writeFileSync(join(dir, 'bridge.pid'), String(process.pid));
    const d = parseDiagnose(run(dir));
    expect(d.alive).toBe(true);
    expect(d.why).toMatch(/still running but did not answer – Linux was too busy/);
  });
  it('no answer from Linux at all', () => {
    expect(parseDiagnose('').why).toMatch(/Linux itself did not answer either/);
  });
});

describe('the client asks before giving up', () => {
  // the request is sent; then the bridge stops answering
  const dead = async (url, o) => {
    if (o.method === 'POST') return { status: 200, body: '{}' };
    throw new Error('connection refused');
  };
  it('gone: the error says why', async () => {
    const c = new AcpClient({ url: 'http://127.0.0.1:1', secret: 's', http: dead, deadAfterMs: 30, retryMs: 5 });
    c.probe = async () => ({ alive: false, why: 'the bridge process is gone' });
    const p = c.request('session/prompt', {}).catch((e) => e.message);
    await c.loop();
    expect(await p).toBe('the bridge does not answer any more (it or the agent stopped): the bridge process is gone – send again to start it anew');
  });
  it('still running: waited for longer (up to the grace), probed at most every 10 s', async () => {
    let probes = 0;
    const c = new AcpClient({ url: 'http://127.0.0.1:1', secret: 's', http: dead, deadAfterMs: 30, retryMs: 5, graceMs: 200 });
    c.probe = async () => (probes++, { alive: true, why: 'busy' });
    const t0 = Date.now();
    const p = c.request('session/prompt', {}).catch((e) => e.message);
    await c.loop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(probes).toBe(1);
    expect(await p).toMatch(/: busy – send again/);
  });
});
