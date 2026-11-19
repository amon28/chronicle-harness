import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { listCmd, parseProcs, stopCmd, reapCmd, startMark } from '../../src/procs.js';

const sh = (script) => execFileSync('sh', ['-c', script], { encoding: 'utf8' });
const linux = process.platform === 'linux';
const kids = [];
afterAll(() => kids.forEach((k) => k.kill('SIGKILL')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('processes a chat shell left running', () => {
  it('parses the listing: only what the shell started, with the processes under each', () => {
    const out = ['10\t1\t500\tshell\t/bin/sh', '11\t10\t60\tproc\tsh /tmp/rec/recloop.sh', '12\t11\t59\tproc\tffmpeg -i x out.mp4', '13\t10\t20\tproc\tpython3 -m http.server', '@@END'].join('\n');
    expect(parseProcs(out)).toEqual([
      { pid: 11, cmd: 'sh /tmp/rec/recloop.sh', age: 60, kids: 1 },
      { pid: 13, cmd: 'python3 -m http.server', age: 20, kids: 0 },
    ]);
    expect(parseProcs('')).toEqual([]);
    // the app's own bare shells and a command that is just finishing are not shown
    expect(parseProcs(['10\t1\t500\tshell\t/bin/sh', '20\t10\t30\tproc\t/bin/sh', '21\t10\t30\tproc\tsh -i', '22\t10\t2\tproc\tcurl -O x', '23\t10\t30\tproc\tsh rec.sh'].join('\n')).map((p) => p.pid)).toEqual([23]);
  });
  it('stopCmd takes only a number', () => {
    expect(() => stopCmd('chat:x', '1; rm -rf /')).toThrow();
    expect(() => stopCmd('chat:x', 1)).toThrow();
    expect(stopCmd('chat:x', 42)).toContain('P=42');
  });
  it.runIf(linux)('finds a background process of this chat (not of another one) and stops it with its children', async () => {
    const id = "chat:t'1 $x";
    // a stand-in for the chat's persistent shell: it starts a loop in the background (like nohup … &) and stays up
    const shell = spawn('sh', ['-c', 'sh -c "sleep 300 & sleep 301" & while :; do sleep 1; done'], { env: { ...process.env, OCM_SHELL: id }, detached: true });
    const other = spawn('sh', ['-c', 'sh -c "sleep 302" & while :; do sleep 1; done'], { env: { ...process.env, OCM_SHELL: 'chat:other' }, detached: true });
    kids.push(shell, other);
    await wait(500);
    const found = parseProcs(sh(listCmd(id)), { minAge: 0 });
    const loop = found.find((p) => /sleep 300 & sleep 301/.test(p.cmd));
    expect(loop).toBeTruthy();
    expect(loop.kids).toBe(2);
    expect(found.some((p) => /302/.test(p.cmd))).toBe(false); // another chat's
    // a phone that cannot read /proc/uptime: the age comes from the process's own /proc folder date instead
    await wait(1200);
    const noUptime = parseProcs(sh(listCmd(id).replace('/proc/uptime', '/nonexistent/uptime')), { minAge: 0 });
    expect(noUptime.find((p) => p.pid === loop.pid).age).toBeGreaterThanOrEqual(1);
    expect(sh(stopCmd('chat:other', loop.pid))).toContain('@@NOTOURS');
    expect(sh(stopCmd(id, loop.pid))).toContain('@@STOPPED');
    await wait(200);
    const after = parseProcs(sh(listCmd(id)), { minAge: 0 });
    expect(after.some((p) => /sleep 30[01]/.test(p.cmd))).toBe(false);
    expect(sh('ps -eo args').split('\n').some((l) => /^sleep 30[01]$/.test(l.trim()))).toBe(false); // its children went too
    process.kill(-shell.pid, 'SIGKILL');
    process.kill(-other.pid, 'SIGKILL');
  }, 20000);
});

describe('reapCmd (bug D: a dropped shell leaves nothing running)', () => {
  it('matches the exact shell id (not its :aux shell), passes the id as base64, and keeps older processes when given a window', async () => {
    const s = reapCmd("chat:a'b", 30);
    expect(s).not.toContain("a'b");
    expect(s).toContain('grep -qxF "OCM_SHELL=$S"');
    expect(s).not.toContain(':aux');
    expect(s).toContain('LIM=32');
    expect(reapCmd('chat:x', null)).toContain('LIM=-1');
    expect(s).toMatch(/kill -STOP \$all.*kill -KILL \$all/s);
    expect(s).toContain('/proc/self/stat'); // bug F: not $$, the reaper's long-lived shell
  });
  it("keeps what the timed-out line started with nohup or setsid, and says which (tagged OCM_KEEP=1, no new process per command)", () => {
    const m = startMark('chat:c1');
    expect(m).toContain('nohup() { env OCM_KEEP=1 nohup "$@"; }');
    expect(m).toContain('setsid() { env OCM_KEEP=1 setsid "$@"; }');
    expect(m).not.toMatch(/\$\(/); // no command substitution: nothing forks before the command
    const s = reapCmd('chat:x', 8);
    expect(s).toContain('grep -qxF "OCM_KEEP=1"');
    expect(s).toContain('@@KEPT');
  });
});

describe('reapCmd on real processes', () => {
  it('stops the timed-out command and its shell, so it writes nothing more; a server started before it and the :aux shell live on', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(tmpdir() + '/reap-');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const env = (id) => ({ ...process.env, OCM_SHELL: id });
    // a killed process whose parent is gone can stay a zombie (state Z) until init collects it: that is not running
    const alive = (p) => {
      try {
        return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${p}/stat`, 'utf8'));
      } catch {
        return false;
      }
    };
    // the reaper runs in a long-lived shell of its own, as in the app (commands typed into it), started before the
    // rest: its first untagged ancestor (here node) is the app (bug F: its $$ is older than everything below)
    const rsh = spawn('sh', [], { env: env('reaper'), stdio: ['pipe', 'pipe', 'ignore'] });
    let rout = '';
    rsh.stdout.on('data', (d) => (rout += d));
    const reap = async (sinceS) => {
      rout = '';
      rsh.stdin.write(reapCmd('chat:reap', sinceS) + '\necho @@EOF\n');
      for (let i = 0; i < 100 && !rout.includes('@@EOF'); i++) await wait(50);
      return rout;
    };
    await wait(1200);
    // as in the app: a root (proot, a child of the app) and in it the chat shell, started before the command (bug G:
    // left alive it would go on with `echo finished` once its sleep is killed)
    const inner = `sleep 300 & echo $! > ${dir}/server; sleep 5; echo partial > ${dir}/f; sleep 30; echo finished >> ${dir}/f`;
    const shell = spawn('sh', ['-c', `sh -c '${inner}'; :`], { env: env('chat:reap'), stdio: 'ignore', detached: true });
    const aux = spawn('sleep', ['300'], { env: env('chat:reap:aux'), stdio: 'ignore', detached: true });
    // bug E: a `nohup … &` server from an earlier command, its shell long gone, so it is reparented to init
    execFileSync('sh', ['-c', `sleep 300 >/dev/null 2>&1 & echo $! > ${dir}/orphan`], { env: env('chat:reap'), stdio: 'ignore' });
    await wait(4500);
    const since = Date.now();
    await wait(1500);
    const out = await reap((Date.now() - since) / 1000);
    await wait(300);
    const server = +readFileSync(dir + '/server', 'utf8');
    const orphan = +readFileSync(dir + '/orphan', 'utf8');
    try {
      expect(out).toMatch(/@@REAPED [1-9]/);
      expect(alive(shell.pid)).toBe(false);
      expect(alive(server)).toBe(true);
      expect(alive(aux.pid)).toBe(true);
      expect(alive(orphan)).toBe(true);
      expect(await reap(null)).toContain('@@REAPED 2');
      await wait(300);
      expect(alive(server)).toBe(false);
      expect(alive(orphan)).toBe(false);
      expect(readFileSync(dir + '/f', 'utf8')).toBe('partial\n');
    } finally {
      rsh.kill('SIGKILL');
      for (const p of [server, orphan, aux.pid, shell.pid]) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20000);
});
