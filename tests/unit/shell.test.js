import { describe, it, expect, vi, beforeEach } from 'vitest';
// Docker Hub, as it answers for Debian's image (decision 190): a token, the list of images, the arm64 one's layers
const LAYER = 'sha256:' + 'ab'.repeat(32);
vi.mock('../../src/api.js', () => ({
  httpRequest: async (url, o = {}) => {
    // GitHub, where Debian's image builder publishes the same image (tests switch it off to reach Docker Hub)
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      if (globalThis.__noGithub || !url.endsWith('/dist-arm64v8/trixie/slim/oci/index.json')) return { status: 404, headers: {}, body: '404: Not Found' };
      const man = { layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: 30213962, digest: 'sha256:' + 'cd'.repeat(32) }] };
      return { status: 200, headers: {}, body: JSON.stringify({ manifests: [{ digest: 'sha256:m', platform: { os: 'linux', architecture: 'arm64', variant: 'v8' }, data: btoa(JSON.stringify(man)) }] }) };
    }
    const auth = o.headers?.Authorization;
    if (url.startsWith('https://auth.docker.io/token')) return { status: 200, headers: {}, body: JSON.stringify({ token: 'tok123' }) };
    if (auth !== 'Bearer tok123') return { status: 401, headers: {}, body: '{}' };
    if (url.endsWith('/manifests/trixie-slim'))
      return { status: 200, headers: {}, body: JSON.stringify({ manifests: [{ digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }, { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } }] }) };
    if (url.endsWith('/manifests/sha256:arm')) return { status: 200, headers: {}, body: JSON.stringify({ layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: 29123456, digest: 'sha256:' + 'ab'.repeat(32) }] }) };
    return { status: 404, headers: {}, body: '' };
  },
}));
const { debianImage, clipOutput, plain, runShellTool, runShellJobTool, shellDefs, shellJobDefs, setShellSoftLimit, finishedResult, NOT_RUN, uninstallLinux } = await import('../../src/shell.js');
const { toolkitMeta } = await import('../../src/toolkit.js');
const { getJob, listJobs } = await import('../../src/jobs.js');

let calls;
let pending;
let verify;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const sleepCmd = 'sleep 45; echo ok';

// every command goes out with its start mark first (procs.startMark): the stand-in looks at the command itself
const marked = [];
const unmark = (a) => {
  const m = /^\{ read -r ocm_up[^\n]*\n/.exec(a.cmd || '');
  if (m) marked.push(a.cmd);
  return m ? { ...a, cmd: a.cmd.slice(m[0].length) } : a;
};
beforeEach(async () => {
  calls = [];
  pending = [];
  setShellSoftLimit(30000);
  const files = await toolkitMeta();
  verify = files.map((f) => f.sha256 + '  ' + f.name).join('\n');
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    exec: (a0) => {
      const a = unmark(a0);
      calls.push(a);
      // the toolkit check reads the installed copies back by hash
      if (a.cmd.includes("sha256sum 'job'")) return Promise.resolve({ output: verify, exit: 0 });
      if (/mkdir|touch|find |base64 -d/.test(a.cmd)) return Promise.resolve({ output: '', exit: 0 });
      if (a.cmd === sleepCmd) return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({ output: '\u001b[32mhello\u001b[0m\r\n', exit: 0 });
    },
    kill: async (a) => calls.push({ kill: a.id }),
  };
});

describe('built-in Linux', () => {
  it("finds Debian's arm64 image on GitHub (no sign-in, no download limit): the layer's address and its SHA-256 (decision 190)", async () => {
    expect(await debianImage()).toEqual({ url: 'https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-arm64v8/trixie/slim/oci/blobs/rootfs.tar.gz', sha256: 'cd'.repeat(32), size: 30213962 });
  });
  it("…and on Docker Hub when GitHub does not answer: the layer's address, its SHA-256 and the sign-in for it (decision 190)", async () => {
    globalThis.__noGithub = true;
    const i = await debianImage();
    expect(i).toEqual({ url: 'https://registry-1.docker.io/v2/library/debian/blobs/' + LAYER, sha256: 'ab'.repeat(32), size: 29123456, auth: 'Bearer tok123' });
    await expect(debianImage({ arch: 'riscv64' })).rejects.toThrow(/GitHub: the image list answered 404; Docker Hub: Docker Hub has no riscv64 Debian image/);
    delete globalThis.__noGithub;
  });
  it('strips colour codes and keeps the start and end of long output', () => {
    expect(plain('\u001b[31mred\u001b[0m')).toBe('red');
    const long = 'a'.repeat(30000);
    const c = clipOutput(long, 1000);
    expect(c.length).toBeLessThan(1100);
    expect(c).toMatch(/characters left out/);
  });
  it('the shell tool runs in a per-chat shell and reports the exit code', async () => {
    const r = await runShellTool({ command: 'echo hello', timeout_s: 5 }, { convId: 'c1' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('exit code 0');
    expect(r.result).toContain('hello');
    expect(calls.find((c) => c.cmd === 'echo hello')).toMatchObject({ id: 'chat:c1', cmd: 'echo hello', timeoutMs: 5000 });
    // the command's start is marked first, so a timeout stops what it started and not a server started just before
    expect(marked.some((c) => c.endsWith('\necho hello') && c.includes('/tmp/.ocm-start-'))).toBe(true);
  });
  it('two helper jobs at once each get a shell of their own; in one shell a second command waits its turn (decision 186)', async () => {
    // like Android: a shell refuses a command while another one runs in it
    const running = new Set();
    const ran = [];
    const exec0 = globalThis.__ocmShell.exec;
    globalThis.__ocmShell.exec = (a) => {
      if (!/sleep 1; echo ok/.test(a.cmd)) return exec0(a);
      if (running.has(a.id)) return Promise.reject(new Error('The previous command in this shell is still running'));
      running.add(a.id);
      ran.push(a.id);
      return new Promise((res) => setTimeout(() => (running.delete(a.id), res({ output: 'ok\n', exit: 0 })), 60));
    };
    const ws = (id) => ({ id, files: {} });
    const both = await Promise.all(['job_aaaaaa', 'job_bbbbbb'].map((k) => runShellTool({ command: 'sleep 1; echo ok', timeout_s: 20 }, { convId: 'c5', workspace: ws('c5'), shellKey: k, shellCwd: '/workspace' })));
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    expect(both.every((r) => /ok/.test(r.result))).toBe(true);
    expect(new Set(ran)).toEqual(new Set(['chat:c5:job_aaaaaa', 'chat:c5:job_bbbbbb']));
    // the same shell: no refusal, the second one waits
    ran.length = 0;
    const same = await Promise.all([1, 2].map(() => runShellTool({ command: 'sleep 1; echo ok', timeout_s: 20 }, { convId: 'c6', workspace: ws('c6') })));
    expect(same.map((r) => r.ok)).toEqual([true, true]);
    expect(ran).toEqual(['chat:c6', 'chat:c6']);
    globalThis.__ocmShell.exec = exec0;
  });
  it('two shells starting at once share one toolkit check: the second does not hash a script the first is writing (decision 187)', async () => {
    globalThis.__ocmShell.uninstall = async () => {};
    await uninstallLinux(); // a fresh root filesystem: the toolkit has to go in again
    calls.length = 0;
    const both = await Promise.all(['job_cccccc', 'job_dddddd'].map((k) => runShellTool({ command: 'echo hi', timeout_s: 5 }, { convId: 'c8', workspace: { id: 'c8', files: {} }, shellKey: k })));
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    expect(both.some((r) => /toolkit NOT verified/.test(r.result))).toBe(false);
    // the check (and install) ran in one of the two shells only; the other waited for it
    expect(new Set(calls.filter((c) => c.cmd?.includes("sha256sum 'job'")).map((c) => c.id)).size).toBe(1);
  });
  it('a command given up on while it waited for the shell never runs later (decision 186)', async () => {
    let release;
    const cmds = [];
    const exec0 = globalThis.__ocmShell.exec;
    globalThis.__ocmShell.exec = (a) => {
      if (/sleep 10/.test(a.cmd)) return (cmds.push('sleep'), new Promise((res) => (release = () => res({ output: '', exit: 0 }))));
      if (/x\.txt/.test(a.cmd)) return (cmds.push('echo'), Promise.resolve({ output: '', exit: 0 }));
      return exec0(a);
    };
    const holder = runShellTool({ command: 'sleep 10', timeout_s: 20 }, { convId: 'c7', workspace: { id: 'c7', files: {} } });
    await tick(20);
    const ac = new AbortController();
    const waiting = runShellTool({ command: 'echo X > x.txt', timeout_s: 20 }, { convId: 'c7', workspace: { id: 'c7', files: {} }, killOnAbort: true, signal: ac.signal });
    await tick(20);
    ac.abort();
    const r = await waiting; // answered at once, not when the shell is free
    expect(r.ok).toBe(false);
    expect(r.result).toBe(NOT_RUN + '.');
    release();
    await holder;
    await tick(50);
    expect(cmds).toEqual(['sleep']); // the echo never reached the shell
    globalThis.__ocmShell.exec = exec0;
  });
  it("a cancelled helper's command is killed, not left to finish and write later (decision 183)", async () => {
    // the real shell ends the command when it is killed: the fake one does the same
    globalThis.__ocmShell.kill = async (a) => {
      calls.push({ kill: a.id });
      pending.splice(0).forEach((resolve) => resolve({ output: 'partial\n', exit: 137 }));
    };
    for (const timeout_s of [20, undefined]) {
      const ac = new AbortController();
      const run = runShellTool({ command: sleepCmd, ...(timeout_s ? { timeout_s } : {}) }, { convId: 'c9', workspace: { id: 'c9', files: {} }, killOnAbort: true, signal: ac.signal });
      await tick(20);
      ac.abort();
      const r = await run;
      expect(r.ok).toBe(false);
      expect(r.result).toMatch(/KILLED mid-way: the job that ran it was cancelled.*kept in the files/);
      expect(calls.some((c) => c.kill === 'chat:c9')).toBe(true);
      calls.length = 0;
    }
    // the main assistant's own command (no killOnAbort) is not killed by its signal here
    const ac = new AbortController();
    const run = runShellTool({ command: sleepCmd, timeout_s: 20 }, { convId: 'c8', workspace: { id: 'c8', files: {} }, signal: ac.signal });
    await tick(20);
    ac.abort();
    await tick(20);
    expect(calls.some((c) => c.kill === 'chat:c8')).toBe(false);
    pending.splice(0).forEach((resolve) => resolve({ output: 'ok', exit: 0 }));
    expect((await run).ok).toBe(true);
  });
  it("a helper's command starts in the chat's /workspace, whatever folder the chat's shell was left in (decision 182)", async () => {
    const r = await runShellTool({ command: 'echo sh1 > harness_test/r3_sh.txt', timeout_s: 5 }, { convId: 'c1', shellCwd: '/workspace' });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => /r3_sh/.test(c.cmd || ''))?.cmd).toBe("cd '/workspace' 2>/dev/null; echo sh1 > harness_test/r3_sh.txt");
    // the chat's own shell (not a helper) keeps its folder, as before
    await runShellTool({ command: 'pwd', timeout_s: 5 }, { convId: 'c1' });
    expect(calls.some((c) => c.cmd === 'pwd')).toBe(true);
  });
  it('a failing command is a failed result, and restart kills the old shell first', async () => {
    globalThis.__ocmShell.exec = async (a0) => { const a = unmark(a0); return (calls.push(a), a.cmd === 'false' ? { output: 'nope', exit: 2 } : { output: '', exit: 0 }); };
    const r = await runShellTool({ command: 'false', restart: true }, { convId: 'c1' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('exit code 2');
    expect(calls.some((c) => c.kill === 'chat:c1')).toBe(true);
  });
  it('tells the assistant how to get Linux when it is not installed', async () => {
    globalThis.__ocmShell.status = async () => ({ available: true, installed: false });
    const r = await runShellTool({ command: 'ls' }, {});
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/Settings → Linux terminal/);
    expect(shellDefs()[0].function.name).toBe('shell');
  });
});

describe('job handles', () => {
  it('an id from the job script is pointed at job out, not only "no job" (decision 269)', async () => {
    const r = await runShellJobTool({ action: 'poll', job_id: '17' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/No job 17 among the shell tool's jobs\. If 17 came from the job script \(job run\) inside the shell, follow it there: shell \{"command":"job out 17"\}/);
    expect((await runShellJobTool({ action: 'poll', job_id: 'job_zz' })).result).not.toMatch(/job script/);
    expect(JSON.stringify(shellDefs())).not.toMatch(/start it with & \(it is left alone\) and follow it with shell_job/);
  });
  it('returns a handle in well under a second instead of dying on a timeout', async () => {
    setShellSoftLimit(60);
    const t0 = Date.now();
    const r = await runShellTool({ command: sleepCmd }, { convId: 'c1', workspace: { id: 'c1', files: {} } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/still running after/);
    expect(r.display.job).toMatch(/^job_/);
    expect(getJob(r.display.job)).toBeTruthy();
    const poll = await runShellJobTool({ action: 'poll', job_id: r.display.job });
    expect(poll.result).toMatch(/RUNNING/);
    // the command finishes later; the handle is still valid
    pending[0]({ output: 'ok\n', exit: 0 });
    await tick(20);
    await tick(20);
    const done = await runShellJobTool({ action: 'poll', job_id: r.display.job });
    expect(done.result).toMatch(/DONE exit=0/);
    expect(done.result).toContain('ok');
    expect(done.ok).toBe(true);
  });
  it('a job tells the chat when it ends (decision 199) – not one whose end was already seen, nor a helper’s', async () => {
    setShellSoftLimit(60);
    const told = [];
    const ctx = { convId: 'c3', workspace: { id: 'c3', files: {} }, onJobDone: (j) => told.push(j) };
    const r = await runShellTool({ command: sleepCmd }, ctx);
    expect(r.result).toContain('Chronicle sends you a message when it ends');
    expect(told.map((j) => j.id)).toEqual([r.display.job]);
    expect(told[0].seenDone).toBeFalsy();
    pending.at(-1)({ output: 'built\n', exit: 0 });
    await tick(20);
    await tick(20);
    await runShellJobTool({ action: 'poll', job_id: r.display.job });
    expect(told[0].seenDone).toBe(true); // polled after it ended: no message needed
    // a helper's job (its own shell) is not announced to the chat
    const helper = [];
    const h = await runShellTool({ command: sleepCmd }, { convId: 'c4', shellKey: 'chat:c4:job_x', workspace: { id: 'c4', files: {} }, onJobDone: (j) => helper.push(j) });
    expect(helper).toEqual([]);
    expect(h.result).not.toContain('Chronicle sends you a message');
    pending.forEach((resolve) => resolve({ output: 'ok', exit: 0 }));
    await tick(30);
  });
  it('a job in the main shell does not block a second command', async () => {
    setShellSoftLimit(40);
    const job = await runShellTool({ command: sleepCmd }, { convId: 'c2', workspace: { id: 'c2', files: {} } });
    expect(job.display.job).toMatch(/^job_/);
    const second = await runShellTool({ command: 'echo hi', timeout_s: 5 }, { convId: 'c2', workspace: { id: 'c2', files: {} } });
    expect(second.result).toMatch(/busy with/);
    expect(calls.some((c) => c.id === 'chat:c2:aux' && c.cmd === 'echo hi')).toBe(true);
    pending.forEach((resolve) => resolve({ output: 'ok', exit: 0 }));
    await tick(30);
  });
  it('shell_job lists what is running and refuses an unknown id', async () => {
    const list = await runShellJobTool({ action: 'list' });
    expect(list.ok).toBe(true);
    const missing = await runShellJobTool({ action: 'poll', job_id: 'job_nope' });
    expect(missing.ok).toBe(false);
    expect(missing.result).toMatch(/No job/);
    expect(shellJobDefs()[0].function.name).toBe('shell_job');
    expect(listJobs()).toBeTruthy();
  });

  it('does not print a note that only repeats part of a longer one', () => {
    const longer = '1 file into /workspace; the two copies of output/_tr.bin disagreed (one was empty or neither had been synced yet) - the newer one won';
    const r = finishedResult({ output: '', exit: 0, cmd: 'ls' }, { notes: ['1 file into /workspace', longer] });
    const lines = r.result.split('\n');
    expect(lines.filter((l) => l.startsWith('1 file into /workspace'))).toHaveLength(1);
    expect(r.result).toContain(longer);
  });

  it('still prints notes that say different things', () => {
    const r = finishedResult({ output: '', exit: 0, cmd: 'ls' }, { prep: { note: '2 files into /workspace' }, post: { note: '1 file back from /workspace' }, notes: ['2 files into /workspace'] });
    expect(r.result).toContain('2 files into /workspace');
    expect(r.result).toContain('1 file back from /workspace');
    expect(r.result.match(/2 files into \/workspace/g)).toHaveLength(1);
  });
});

describe('a path outside /workspace in the file tools (decision 276)', () => {
  it('is refused with where to go, instead of landing in /workspace/root/…', async () => {
    const { outsideWorkspace, writeFileTool } = await import('../../src/codetools.js');
    expect(() => outsideWorkspace('/root/app/x.js')).toThrow(/\/root\/app\/x\.js is outside \/workspace – it is on the Linux shell's own disk.*\/workspace\/<name>/);
    expect(() => outsideWorkspace('/phone/a.txt')).toThrow(/phone_\* tools/);
    expect(() => outsideWorkspace('/workspace/a.txt', 'src/a.js', '', undefined)).not.toThrow();
    const w = { id: 'x', files: {} };
    await expect(writeFileTool({ path: '/root/app/x.js', content: 'a' }, {}, w)).rejects.toThrow(/outside \/workspace/);
    expect(Object.keys(w.files)).toEqual([]);
  });
});
