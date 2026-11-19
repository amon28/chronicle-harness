// The bridge, exercised on the device: the same code path a chat uses (mount → shell → reconcile),
// without needing a chat or a model. Triggered by the same adb intent as the native self-test
// (MainActivity leaves a one-shot flag for the web layer); every line goes to logcat.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { runShell, killShell, shellStatus, ensureShellToolkit, runShellTool } from './shell.js';
import { mountSpec, syncWork } from './bridge.js';
import { deleteWorkspace, sandbox } from './sandbox.js';
import { registerSkillScripts } from './skills.js';
import { sha256Hex } from './hash.js';
import { canControlBrowser, runBrowser, closeBrowser, browserFor, captureFrame } from './browsercontrol.js';

const native = Capacitor.isNativePlatform() ? registerPlugin('SelfTest') : null;

/** Is this app being asked to run the self-test? (one shot: the flag is consumed) */
export async function selfTestRequested() {
  try {
    const r = await native?.pending();
    if (r?.only) globalThis.__ocmSelfTestOnly = String(r.only);
    return !!r?.js;
  } catch {
    return false;
  }
}

const say = async (ok, name, detail) => {
  const line = (ok == null ? 'WAIT ' : ok ? 'PASS ' : 'FAIL ') + name + '  ' + detail; // WAIT: a progress note, not a result
  try {
    await native?.log({ text: line });
  } catch {
    /* the native side is the only reason this runs */
  }
};

/** A line in the self-test log (the runner waits for "perf done"). */
export const selfTestLine = (name, detail) => say(true, name, detail);

const C = 'selftest-js';
const SHELL = 'selftest:bridge';

/**
 * The five things that were broken and the tests that caught them: a file written in the shell must
 * reach read_file, a file deleted in the app must leave the shell, and the reverse of both.
 * Returns { ok, fail }.
 */
export async function runBridgeSelfTest() {
  let ok = 0;
  let fail = 0;
  const check = async (pass, name, detail) => {
    if (pass) ok++;
    else fail++;
    await say(pass, name, detail);
  };
  const sh = (cmd) => runShell(cmd, { id: SHELL, timeoutMs: 90000, mounts: mount.mounts });

  const st = await shellStatus();
  if (!st.installed) {
    await check(false, 'bridge', 'Linux is not installed');
    return { ok, fail };
  }
  const w = { id: C, files: {}, shellState: {} };
  const mount = await mountSpec({ phone: { folder: () => null } }, C);
  try {
    await check(!!mount.workHost, 'mount', mount.mounts || mount.error || 'no mount');

    // 1. app -> shell
    w.files['js-app.txt'] = { data: new TextEncoder().encode('from-the-app') };
    await syncWork(w, C);
    const seen = await sh('cat /workspace/js-app.txt 2>&1');
    await check(/from-the-app/.test(seen.output || ''), 'app -> shell', seen.output.trim().slice(0, 40) || 'nothing');

    // 2. shell -> app  (the direction that did not exist: a file written in the shell)
    await sh('printf from-the-shell > /workspace/js-shell.txt');
    const back = await syncWork(w, C);
    const got = w.files['js-shell.txt'] ? new TextDecoder().decode(w.files['js-shell.txt'].data) : '';
    await check(got === 'from-the-shell', 'shell -> app', got || 'not in the workspace (' + back.down + ' came back)');

    // 3. app delete -> gone in the shell
    delete w.files['js-app.txt'];
    await syncWork(w, C);
    const gone = await sh('cat /workspace/js-app.txt 2>&1');
    await check(/No such file|cannot open/i.test(gone.output || ''), 'app delete -> shell', gone.output.trim().slice(0, 50) || 'still there');

    // 4. shell delete -> gone in the app
    await sh('rm -f /workspace/js-shell.txt');
    await syncWork(w, C);
    await check(!w.files['js-shell.txt'], 'shell delete -> app', w.files['js-shell.txt'] ? 'still in the workspace' : 'removed');

    // 5. a file big enough to matter: both sides must agree on its hash, and the crossing must be
    //    fast enough to be useful (the old base64 pipe managed 1.6 MB/s)
    const MB = 1024 * 1024;
    const big = new Uint8Array(16 * MB);
    for (let i = 0; i < big.length; i += 4096) big[i] = i / 4096;
    w.files['js-big.bin'] = { data: big };
    const t0 = Date.now();
    await syncWork(w, C);
    const ms = Date.now() - t0;
    const mine = await sha256Hex(big);
    const theirs = await sh('sha256sum /workspace/js-big.bin 2>&1 | cut -c1-64');
    const sameHash = (theirs.output || '').trim().startsWith(mine.slice(0, 16));
    await check(sameHash, '16 MiB crosses', (sameHash ? 'sha256 matches' : 'sha ' + (theirs.output || '').trim().slice(0, 16) + ' vs ' + mine.slice(0, 16)) + ', ' + ms + ' ms = ' + (16 / (ms / 1000)).toFixed(1) + ' MB/s');

    // 5b. the other direction, same size: a file the shell wrote, read back into the app (this was the
    //     slow one - one base64 string for the whole file - before reads went through the WebView)
    await sh('head -c 16777216 /dev/urandom > /workspace/js-down.bin');
    const t1 = Date.now();
    await syncWork(w, C, { prefer: 'b' });
    const ms1 = Date.now() - t1;
    const downBytes = w.files['js-down.bin']?.data;
    const downMine = downBytes ? await sha256Hex(downBytes) : '';
    const downTheirs = await sh('sha256sum /workspace/js-down.bin 2>&1 | cut -c1-64');
    const downSame = !!downMine && (downTheirs.output || '').trim().startsWith(downMine.slice(0, 16));
    await check(downSame && downBytes.byteLength === 16 * MB, '16 MiB comes back', (downSame ? 'sha256 matches' : 'sha differs or missing') + ', ' + ms1 + ' ms = ' + (16 / (ms1 / 1000)).toFixed(1) + ' MB/s');
    delete w.files['js-down.bin'];
    await syncWork(w, C);

    // 6. over the cap: refused once, nothing written, and the app's copy must survive the next pass
    const tooBig = new Uint8Array(33 * MB);
    tooBig[0] = 1;
    w.files['js-toobig.bin'] = { data: tooBig };
    const rb = await syncWork(w, C);
    const inShell = await sh('ls -l /workspace/js-toobig.bin 2>&1');
    await syncWork(w, C, { prefer: 'b' }); // the pass that used to prefer the shell side
    const kept = w.files['js-toobig.bin']?.data?.byteLength === tooBig.byteLength;
    await check(rb.skipped.includes('js-toobig.bin') && /No such file|cannot access/i.test(inShell.output || '') && kept, 'over the cap', kept ? 'refused, nothing written, the app copy intact' : 'THE APP COPY WAS LOST');

    // 7. the exec bit survives a round trip: created in the shell with +x, read by the app, rewritten
    //    by the app - a plain write would leave it 600 and the toolkit would certify a script nobody can run
    await sh('printf "#!/bin/sh\\necho hi" > /workspace/js-run.sh; chmod 755 /workspace/js-run.sh');
    await syncWork(w, C);
    const sawExec = w.files['js-run.sh']?.exec === true;
    w.files['js-run.sh'] = { data: new TextEncoder().encode('#!/bin/sh\necho changed'), exec: true };
    await syncWork(w, C);
    const stillExec = await sh('[ -x /workspace/js-run.sh ] && echo RUNNABLE || echo NOT-EXECUTABLE');
    await check(sawExec && /RUNNABLE/.test(stillExec.output || ''), 'exec bit', sawExec ? '/RUNNABLE/ after the app rewrote it' : 'the app never saw it as executable');

    // 8. a directory tree does not survive its last file
    await sh('mkdir -p /workspace/js-deep/a/b && printf x > /workspace/js-deep/a/b/f.txt');
    await syncWork(w, C);
    delete w.files['js-deep/a/b/f.txt'];
    await syncWork(w, C);
    const treeGone = await sh('[ -d /workspace/js-deep ] && echo STILL-THERE || echo GONE');
    await check(/GONE/.test(treeGone.output || ''), 'empty dirs', (treeGone.output || '').trim());

    // 9. a delete the shell never saw: the file exists only in the app, nothing to tombstone
    w.files['js-only-app.txt'] = { data: new TextEncoder().encode('x') };
    await syncWork(w, C);
    delete w.files['js-only-app.txt'];
    const r5 = await syncWork(w, C);
    const gone2 = await sh('cat /workspace/js-only-app.txt 2>&1');
    await check(/No such file|cannot open/i.test(gone2.output || '') && r5.deletedB === 1, 'app delete (second time)', gone2.output.trim().slice(0, 50) || 'still there');

    // 10. the exec bit through Python too (round 5): the round-4 fix only covered the disk half, so
    //     a 755 from the shell arrived 0o666 in Pyodide and an os.chmod in Pyodide arrived 600 in the shell
    try {
      await sh('printf "#!/bin/sh\\necho py" > /workspace/js-py-in.sh; chmod 755 /workspace/js-py-in.sh');
      await syncWork(w, C, { prefer: 'b' });
      const r = await sandbox.run(w, "import os\nopen('js-py-out.sh','w').write('#!/bin/sh\\necho out\\n')\nos.chmod('js-py-out.sh', 0o755)\noct(os.stat('js-py-in.sh').st_mode & 0o777)", { timeoutMs: 180000 });
      const inPy = String(r.value || r.error || '').trim();
      await syncWork(w, C);
      const out = await sh('[ -x /workspace/js-py-out.sh ] && echo RUNNABLE || echo NOT-EXECUTABLE');
      const pass = inPy === '0o755' && /RUNNABLE/.test(out.output || '');
      await check(pass, 'exec bit via python', 'shell 755 -> python ' + (inPy || '?') + ', python 755 -> shell ' + (out.output || '').trim());
    } catch (e) {
      await check(false, 'exec bit via python', 'python did not run: ' + String(e?.message || e));
    } finally {
      sandbox.kill();
    }

    // 11. the whole mode, not just the exec bit: a 644 in the shell must not arrive 666 in Pyodide
    //     (write bits added) and a 600 must not lose its protection; and an os.chmod 640 must cross back
    try {
      await sh('printf x > /workspace/js-m644; chmod 644 /workspace/js-m644; printf y > /workspace/js-m600; chmod 600 /workspace/js-m600');
      await syncWork(w, C, { prefer: 'b' });
      const r = await sandbox.run(
        w,
        "import os\nopen('js-m640','w').write('z')\nos.chmod('js-m640', 0o640)\noct(os.stat('js-m644').st_mode & 0o777) + ' ' + oct(os.stat('js-m600').st_mode & 0o777)",
        { timeoutMs: 180000 },
      );
      const inPy = String(r.value || r.error || '').trim();
      await syncWork(w, C);
      const out = await sh('stat -c %a /workspace/js-m640');
      const shellMode = (out.output || '').trim();
      const pass = inPy === '0o644 0o600' && shellMode === '640';
      await check(pass, 'modes via python', 'shell 644/600 -> python ' + (inPy || '?') + ', python 640 -> shell ' + (shellMode || '?'));
    } catch (e) {
      await check(false, 'modes via python', 'python did not run: ' + String(e?.message || e));
    } finally {
      sandbox.kill();
    }

    // 11b. a refused file leaves no name behind (open-problems P1): written in Python over the cap, an
    //      empty name planted in the shell as any older build or script could, three quiet passes,
    //      then the delete reaches the name
    try {
      await sandbox.run(w, "import os\nos.makedirs('output', exist_ok=True)\nopen('output/_p1.bin','wb').write(b'x' * (34 << 20))", { timeoutMs: 180000 });
      const r1 = await syncWork(w, C);
      const e1 = await sh('[ -e /workspace/output/_p1.bin ] && echo PHANTOM || echo NONE');
      await sh(': > /workspace/output/_p1.bin');
      await syncWork(w, C, { prefer: 'b' });
      const e2 = await sh('[ -e /workspace/output/_p1.bin ] && echo PHANTOM || echo NONE');
      let noisy = 0;
      for (let i = 0; i < 3; i++) if (/_p1\.bin/.test((await syncWork(w, C, { prefer: i % 2 ? 'a' : 'b' })).note || '')) noisy++;
      const kept = w.files['output/_p1.bin']?.data?.byteLength === 34 << 20;
      await sandbox.run(w, "import os\nos.remove('output/_p1.bin')");
      await syncWork(w, C);
      const e3 = await sh('[ -e /workspace/output/_p1.bin ] && echo PHANTOM || echo NONE');
      // the bridge's note: "too big for the chat workspace (over 32 MB), kept in the shell only: output/_p1.bin"
      const once = /too big[^:\n]*: [^\n]*output\/_p1\.bin/.test(r1.note || '') && !/disagreed/.test(r1.note || '');
      const pass = once && /NONE/.test(e1.output) && /NONE/.test(e2.output) && /NONE/.test(e3.output) && !noisy && kept && !w.files['output/_p1.bin'];
      await check(pass, 'no phantom', 'refused ' + (once ? 'once' : 'NOT once: ' + (r1.note || '').slice(0, 60)) + ', shell ' + [e1, e2, e3].map((e) => (e.output || '').trim()).join('/') + ', re-reports ' + noisy + ', original ' + (kept ? 'intact' : 'LOST'));
    } catch (e) {
      await check(false, 'no phantom', 'python did not run: ' + String(e?.message || e));
    } finally {
      sandbox.kill();
    }

    // 11b. a skill's scripts/ folder is a toolkit source: no TOOLKIT_URL is given here, so the line the app
    //      wrote into /workspace/.toolkit-url has to be enough for toolkit-pull to install the script into PATH.
    //      The toolkit is refreshed first, or this would test whatever an older build left in the rootfs.
    const skTk = await ensureShellToolkit(SHELL, mount.mounts).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    await registerSkillScripts(w, 'selftest-skill', { 'scripts/st-hello': '#!/bin/sh\r\necho hello-from-skill\r\n' });
    await syncWork(w, C);
    const sk = await sh('toolkit-pull 2>&1; echo "EXIT=$?"; st-hello 2>&1');
    const so = sk.output || '';
    const skExit = /EXIT=0/.test(so);
    const helloRan = /hello-from-skill/.test(so);
    await check(!!skTk?.ok && skExit && helloRan, 'skill scripts -> PATH', (skTk?.ok ? '' : 'toolkit not refreshed: ' + (skTk?.error || '?') + '; ') + (so.match(/EXIT=\d+/) || ['no exit'])[0] + ', hello ' + (helloRan ? 'ran' : 'did not run') + (skTk?.ok && skExit && helloRan ? '' : ' | ' + so.trim().split('\n').slice(-3).join(' / ').slice(0, 160)));
    await sh('rm -f /usr/local/bin/st-hello; sed -i "/st-hello/d" /usr/local/bin/.toolkit-extra 2>/dev/null');

    // 11c. the case the agent hit: a skill is installed in the app but was never "used" in this chat, and
    //      the model goes straight to the shell. The shell tool itself must put the skill's tool in PATH.
    try {
      const skills = [{ name: 'selftest-auto', description: 'd', instructions: 'i', enabled: true, files: { 'scripts/st-auto': '#!/bin/sh\r\necho auto-from-skill\r\n' } }];
      const r = await runShellTool({ command: 'command -v st-auto && st-auto' }, { workspace: w, convId: C, settings: { agentSkills: skills }, phone: { folder: () => null } });
      const out = String(r.result || '');
      const ran = /auto-from-skill/.test(out);
      await check(ran && /skill scripts in PATH: st-auto/.test(out), 'installed skill -> PATH (no use_skill)', ran ? 'ran from ' + ((out.match(/\/\S*st-auto/) || ['?'])[0]) : out.split('\n').slice(0, 4).join(' / ').slice(0, 180));
    } catch (e) {
      await check(false, 'installed skill -> PATH (no use_skill)', String(e?.message || e));
    } finally {
      await sh('rm -f /usr/local/bin/st-auto; sed -i "/st-auto/d" /usr/local/bin/.toolkit-extra 2>/dev/null');
      await killShell('chat:' + C).catch(() => {});
    }
    // 12. toolkit-pull in URL mode: the manifest's own comment line is not a script, and a clean pull exits 0.
    //     First the step a chat's shell tool does before its first command: put this build's scripts in
    //     place (runShell alone would test whatever an older build left in the rootfs)
    const tk = await ensureShellToolkit(SHELL, mount.mounts).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    const pull = await sh('TOOLKIT_URL=file:///usr/local/bin toolkit-pull 2>&1; echo "EXIT=$?"');
    const po = pull.output || '';
    const badLine = po.split('\n').find((l) => /generated|bad manifest|FAILED/.test(l));
    await check(!!tk?.ok && /EXIT=0/.test(po) && !badLine, 'toolkit-pull url mode', (tk?.ok ? '' : 'toolkit not refreshed: ' + (tk?.error || '?') + '; ') + (po.match(/EXIT=\d+/) || ['no exit'])[0] + (badLine ? ' | ' + badLine.trim().slice(0, 80) : ''));

    // 13. the workspace as a real origin: a redirect to a second page, its stylesheet, localStorage across pages,
    //     an honest failure for a missing page, a painted screenshot, and a server started in the shell
    if (canControlBrowser()) {
      const bctx = { convId: C, workspace: w, browserId: 'selftest-site' };
      const te = new TextEncoder();
      w.files['site/a.html'] = { data: te.encode("<!doctype html><title>A</title><script>localStorage.setItem('k','v');location.replace('b.html#x')</script>") };
      w.files['site/b.html'] = { data: te.encode('<!doctype html><link rel="stylesheet" href="s.css"><h1 id="h">B</h1><script>document.title="B:"+localStorage.getItem("k")+":"+getComputedStyle(document.getElementById("h")).color</script>') };
      w.files['site/s.css'] = { data: te.encode('#h{color:rgb(1, 2, 3)}') };
      try {
        await runBrowser({ action: 'open', url: '/workspace/site/a.html' }, bctx);
        await runBrowser({ action: 'wait_for', url_contains: 'b.html', timeout_ms: 8000 }, bctx);
        const t = await runBrowser({ action: 'eval', script: 'location.href + " | " + document.title' }, bctx);
        const seen = String(t.result || '').split('\n').pop();
        await check(/^"?https:\/\/c[0-9a-z]+\.workspace\.localhost\/site\/b\.html#x \| B:v:rgb\(1, 2, 3\)/.test(seen), 'workspace origin: redirect, css, storage', seen.slice(0, 120));
        const shot = await captureFrame(browserFor('selftest-site'));
        await check(!shot.blank, 'workspace origin: painted screenshot', shot.blank ? 'flat ' + (shot.shot?.color || '?') : 'drawn');
        // a page with little ink (one line of 30px text on a dark background) is a real picture, not a flat frame
        w.files['site/small.html'] = { data: te.encode('<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#101418;color:rgb(110,231,168);font:30px sans-serif">COLD CAPTURE OK</body>') };
        await runBrowser({ action: 'open', url: '/workspace/site/small.html' }, bctx);
        const small = await captureFrame(browserFor('selftest-site'));
        await check(small.verdict === 'ok', 'little-ink page is captured', small.verdict + (small.shot?.ink != null ? ', ' + small.shot.ink + '+ inked px' : '') + (small.message ? ' | ' + small.message.slice(0, 90) : ''));
        const miss = await runBrowser({ action: 'open', url: '/workspace/site/nope.html' }, bctx);
        await check(!miss.ok && /404/.test(miss.result), 'workspace origin: missing page is ok=0', String(miss.result).split('\n')[0].slice(0, 100));
        // a server the way an agent starts one: python3 when this Linux has it, else busybox-extras' httpd
        const srv = await sh('cd /workspace/site; if command -v python3 >/dev/null; then (nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/st-srv.log 2>&1 &); echo VIA=python3; elif command -v httpd >/dev/null; then httpd -p 127.0.0.1:8765 -h /workspace/site && echo VIA=httpd; else echo VIA=none; fi; for i in 1 2 3 4 5 6 7 8 9 10; do (echo > /dev/tcp/127.0.0.1/8765) 2>/dev/null && break; wget -q -O /dev/null http://127.0.0.1:8765/b.html 2>/dev/null && break; sleep 0.5; done; echo started');
        const via = ((srv.output || '').match(/VIA=(\w+)/) || [])[1] || '?';
        if (via === 'none') await check(true, 'loopback server from the shell (SKIPPED)', 'no python3 or httpd in this Linux to start one with');
        else {
          const lb = await runBrowser({ action: 'open', url: 'http://127.0.0.1:8765/b.html' }, bctx).catch((e) => ({ ok: false, result: String(e?.message || e) }));
          await check(lb.ok && /B/.test(lb.result), 'loopback server from the shell', (lb.ok ? 'opened, served by ' + via : String(lb.result).split('\n')[0] + ' | ' + (srv.output || '').trim()).slice(0, 140));
        }
      } catch (e) {
        await check(false, 'workspace origin', String(e?.message || e));
      } finally {
        await closeBrowser('selftest-site');
        await sh('pkill -f "http.server 8765" 2>/dev/null; pkill -f "httpd -p 127.0.0.1:8765" 2>/dev/null; true');
      }
    }
  } catch (e) {
    await check(false, 'bridge threw', String(e?.message || e));
  } finally {
    await sh('rm -rf /workspace/js-app.txt /workspace/js-shell.txt /workspace/js-only-app.txt /workspace/js-big.bin /workspace/js-down.bin /workspace/js-toobig.bin /workspace/js-run.sh /workspace/js-deep /workspace/js-py-in.sh /workspace/js-py-out.sh /workspace/js-m644 /workspace/js-m600 /workspace/js-m640 /workspace/output/_p1.bin /workspace/skills /workspace/.toolkit-url /workspace/site');
    await killShell(SHELL);
    await deleteWorkspace(C).catch(() => {});
    await say(true, 'bridge done', 'ok=' + ok + ' fail=' + fail);
  }
  return { ok, fail };
}

/** Every tool, speed and smoothness (src/perfsim.js), closed with a "perf done" line. */
export async function runPerfSelfTest() {
  if (!(await shellStatus()).installed) return say(false, 'perf', 'Linux is not installed');
  const { runPerfScenarios } = await import('./perfsim.js');
  let r = { ok: 0, fail: 1 };
  try {
    r = await runPerfScenarios(say);
  } catch (e) {
    await say(false, 'perf threw', String(e?.message || e));
  }
  await say(true, 'perf done', 'ok=' + r.ok + ' fail=' + r.fail + ' (' + document.visibilityState + ')');
}

/** The agent scenarios (src/agentsim.js), reported the same way and closed with an "agent done" line. */
export async function runAgentSelfTest() {
  if (!(await shellStatus()).installed) return say(false, 'agent', 'Linux is not installed');
  const { runAgentScenarios } = await import('./agentsim.js');
  let r = { ok: 0, fail: 1 };
  try {
    r = await runAgentScenarios(say);
  } catch (e) {
    await say(false, 'agent threw', String(e?.message || e));
  }
  await say(true, 'agent done', 'ok=' + r.ok + ' fail=' + r.fail);
}
