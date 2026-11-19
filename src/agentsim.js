// Agent scenarios: the device self-test drives the real tools the way an agent does – the same runTool calls, the
// same workspace, shell, Python and browser – with scripted steps instead of a model, so every run does the same
// thing and costs no tokens. Each scenario is a job an agent is really asked to do (build and test a site, a data
// job, write code and its tests, a long job, a small server) and checks what a user would check.
import { runTool } from './tools.js';
import { closeBrowser } from './browsercontrol.js';
import { sandbox, deleteWorkspace } from './sandbox.js';
import { killShell, setShellSoftLimit, SHELL_SOFT_MS } from './shell.js';

const CONV = 'agentsim';
const td = new TextDecoder();

// ---------- the site an agent builds: a login page, a guarded dashboard, data fetched from the same origin ----------
export const SITE = {
  's1/index.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="app.css"><title>Login</title></head>' +
    '<body><main class="card"><h1>Sign in</h1><form id="f"><input id="user" placeholder="User"><input id="pass" type="password" placeholder="Password"><button type="submit">Log in</button></form><p id="msg"></p></main>' +
    '<script src="app.js"></script><script>Auth.guardLogin();document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();var u=document.getElementById("user"),p=document.getElementById("pass");if(Auth.login(u.value,p.value)){location.replace("dash.html")}else{document.getElementById("msg").textContent="Wrong user or password.";p.value=""}})</script></body></html>',
  's1/app.js':
    'window.Auth={login:function(u,p){if(u==="demo"&&p==="pw123"){localStorage.setItem("session",u);return true}return false},user:function(){return localStorage.getItem("session")},logout:function(){localStorage.removeItem("session");location.replace("index.html")},guardLogin:function(){if(this.user())location.replace("dash.html")},guardDash:function(){if(!this.user())location.replace("index.html")}};',
  's1/app.css': 'body{margin:0;font:16px system-ui;background:#0f172a;color:#e2e8f0}.card{max-width:360px;margin:15vh auto;padding:24px;background:#1e293b;border-radius:12px}input,button{display:block;width:100%;margin:8px 0;padding:10px;font:inherit}#msg{color:#f87171}table{width:100%;border-collapse:collapse}td{padding:6px;border-bottom:1px solid #334155}',
  's1/dash.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="app.css"><title>Dashboard</title><script src="app.js"></script><script>Auth.guardDash()</script></head>' +
    '<body><main class="card"><h1 id="hi"></h1><p id="count">loading</p><table><tbody id="rows"></tbody></table><button id="out">Log out</button></main>' +
    '<script>document.getElementById("hi").textContent="Welcome "+Auth.user();fetch("jobs.json").then(function(r){return r.json()}).then(function(j){document.getElementById("count").textContent=j.length+" jobs";document.getElementById("rows").innerHTML=j.map(function(x){return "<tr><td>"+x.name+"</td><td>"+x.state+"</td></tr>"}).join("")});document.getElementById("out").onclick=function(){Auth.logout()}</script></body></html>',
  's1/jobs.json': JSON.stringify([{ name: 'build', state: 'done' }, { name: 'deploy', state: 'running' }]),
};

// ---------- pages for the WebView checks: real input, tall captures, repaint after a click, long element lists ----------
export const WV = {
  'wv/act.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Act</title></head><body style="margin:0;font:16px system-ui">' +
    '<button id="copy" style="margin:40px;padding:20px">Copy</button><p id="out">none</p>' +
    '<div style="position:relative;margin:40px;height:80px"><button id="under" style="width:200px;height:60px">Under</button><div id="lid" style="position:absolute;inset:0;background:rgba(0,0,0,.05)"></div></div><p id="out2">none</p>' +
    '<script>document.getElementById("copy").addEventListener("click",function(e){var o=document.getElementById("out");var t="trusted="+e.isTrusted+" active="+!!(navigator.userActivation&&navigator.userActivation.isActive);o.textContent=t+" clip=pending";' +
    'try{navigator.clipboard.writeText("chronicle-copy").then(function(){o.textContent=t+" clip=ok"},function(x){o.textContent=t+" clip=refused:"+(x&&x.name)})}catch(x){o.textContent=t+" clip=threw"}});' +
    'document.getElementById("under").addEventListener("click",function(e){document.getElementById("out2").textContent="under clicked trusted="+e.isTrusted})</script></body></html>',
  'wv/copy2.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Copy</title></head><body style="margin:0;font:16px system-ui">' +
    '<button id="a" style="margin:40px;padding:20px">Copy A</button><button id="b" style="margin:40px;padding:20px">Copy B</button><textarea id="t">uuid-from-textarea</textarea>' +
    '<script>document.getElementById("a").onclick=function(){navigator.clipboard.writeText("uuid-1234")};' +
    'document.getElementById("b").onclick=function(){var t=document.getElementById("t");t.focus();t.select();document.execCommand("copy")}</script></body></html>',
  'wv/tall.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Tall</title></head><body style="margin:0;font:18px system-ui;background:#fff">' +
    '<section style="height:900px;background:#f59e0b"><h1>Top</h1></section><section style="height:900px;background:#10b981"><h2>Middle</h2></section>' +
    '<section style="height:900px;background:#2563eb;color:#fff"><h2>Bottom</h2><p id="end">The last paragraph of the page.</p></section></body></html>',
  'wv/repaint.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Repaint</title></head><body style="margin:0">' +
    '<button id="go" style="position:fixed;top:0;left:0;width:100%;height:60px">Make it red</button><div id="box" style="position:fixed;top:120px;left:0;width:100%;height:500px;background:#e5e7eb"></div>' +
    '<script>document.getElementById("go").onclick=function(){document.getElementById("box").style.background="#dc2626";var v=document.createElement("p");v.id="v4";v.textContent="v4";document.body.appendChild(v)}</script></body></html>',
  'wv/transition.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Transition</title><style>body{margin:0;background:#0b0d10}#box{position:absolute;left:100px;top:200px;width:180px;height:180px;background:#111820;transition:background-color .6s ease}#box.on{background:#b8f14a}#go{position:fixed;top:0;left:0;width:100%;height:60px}</style></head>' +
    '<body><button id="go">Go</button><div id="box"></div><script>document.getElementById("go").onclick=function(){document.getElementById("box").className="on"}</script></body></html>',
  'wv/rows.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Rows</title></head><body style="margin:0;font:14px system-ui"><button id="v4">v4</button>' +
    Array.from({ length: 1000 }, (_, i) => `<div class="item">row ${i + 1} <button class="copy">Copy</button></div>`).join('') +
    '</body></html>',
  'wv/fullscreen.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>FS</title></head><body style="margin:0"><button id="fs" style="margin:40px;padding:20px">Fullscreen</button><button id="b" style="margin:40px;padding:20px">Next</button><p id="o">none</p>' +
    '<script>document.getElementById("fs").onclick=function(){try{document.documentElement.requestFullscreen().catch(function(){})}catch(e){}};document.getElementById("b").onclick=function(){document.getElementById("o").textContent="active="+navigator.userActivation.isActive}</script></body></html>',
  'wv/many.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Many</title></head><body style="margin:0">' +
    Array.from({ length: 150 }, (_, i) => `<button style="width:60px;height:24px;font-size:10px">b${i + 1}</button>`).join('') +
    '</body></html>',
};

/** Runs every scenario. check(pass, name, detail) is the self-test's reporter. → { ok, fail } */
export async function runAgentScenarios(check) {
  let ok = 0;
  let fail = 0;
  const report = async (pass, name, detail) => {
    if (pass) ok++;
    else fail++;
    await check(pass, 'agent: ' + name, String(detail || '').replace(/\s+/g, ' ').slice(0, 700));
  };
  const w = { id: CONV, files: {}, shellState: {} };
  const ctx = {
    convId: CONV,
    browserId: 'agentsim-browser',
    workspace: w,
    vision: true,
    settings: { agentSkills: [], prefs: { pyTimeout: 300 } },
    phone: { folder: () => null, mode: () => 'auto' },
    onStatus: () => {},
  };
  const tool = async (name, args) => {
    const t0 = Date.now();
    const what = `${name}${args?.action ? ' ' + args.action : ''}${args?.url ? ' ' + args.url : ''}`;
    // a call that never returns would stall the whole run with nothing in the log: say which one it is every 30 s,
    // and give up on it after 3 minutes so the scenario fails and the rest still run
    const tick = setInterval(() => check(null, 'agent: still waiting', `${what} for ${Math.round((Date.now() - t0) / 1000)} s`).catch(() => {}), 30000);
    let giveUp;
    let r;
    try {
      r = await Promise.race([
        runTool({ name, arguments: JSON.stringify(args) }, ctx),
        new Promise((res) => (giveUp = setTimeout(() => res({ ok: false, result: `self-test: ${what} did not return in 180 s` }), 180000))),
      ]);
    } catch (e) {
      r = { ok: false, result: 'threw: ' + String(e?.message || e) };
    } finally {
      clearInterval(tick);
      clearTimeout(giveUp);
    }
    r.ms = Date.now() - t0;
    r.text = String(r.result || '');
    return r;
  };
  const file = (p) => (w.files[p] ? td.decode(w.files[p].data) : null);
  const scenario = async (name, fn) => {
    if (globalThis.__ocmSelfTestOnly && !globalThis.__ocmSelfTestOnly.split(',').some((x) => name.includes(x))) return;
    const t0 = Date.now();
    try {
      const out = await fn();
      if (out !== undefined) await report(!!out.pass, name, (out.detail || '') + ` (${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (e) {
      await report(false, name, 'threw: ' + String(e?.message || e));
    }
  };

  try {
    // 1. build a site with write_file, look at it, then use it like a person: wrong password, sign in, the
    //    guard both ways, log out, the back-door URL – all through the browser tool
    await scenario('site: write the files', async () => {
      const res = [];
      for (const [p, c] of Object.entries(SITE)) res.push(await tool('write_file', { path: p, content: c }));
      const bad = res.filter((r) => !r.ok);
      return { pass: !bad.length && Object.keys(SITE).every((p) => file(p) === SITE[p]), detail: bad.length ? bad[0].text.slice(0, 120) : `${res.length} files, contents exact` };
    });
    await scenario('site: preview_page renders, no JS errors', async () => {
      const r = await tool('preview_page', { path: 's1/index.html', view: 'mobile' });
      return { pass: r.ok && /No JavaScript errors/.test(r.text) && /workspace\.localhost\/s1\/index\.html/.test(r.text), detail: r.text.split('\n').slice(0, 3).join(' | ') };
    });
    await scenario('site: wrong password is refused, field cleared', async () => {
      // a run before this one (or another chat) may have left a session in this origin's storage: start signed out
      await tool('browser', { action: 'open', url: '/workspace/s1/app.css' });
      await tool('browser', { action: 'eval', script: 'localStorage.clear(); return 1' });
      await tool('browser', { action: 'open', url: '/workspace/s1/index.html' });
      const r = await tool('browser', { action: 'read', steps: [{ action: 'type', selector: '#user', text: 'demo' }, { action: 'type', selector: '#pass', text: 'nope' }, { action: 'click', selector: 'button[type=submit]' }, { action: 'wait_for', text_present: 'Wrong user' }] });
      const v = await tool('browser', { action: 'get', property: 'value', selector: '#pass' });
      return { pass: r.ok && /Wrong user or password/.test(r.text) && /""/.test(v.text.replace(/\[surface=[^\]]*\]/g, '')), detail: (r.ok ? 'message shown' : r.text.slice(-160)) + ', password field ' + JSON.stringify(v.text.slice(0, 200)) };
    });
    await scenario('site: right password signs in and redirects', async () => {
      const r = await tool('browser', { action: 'read', steps: [{ action: 'type', selector: '#user', text: 'demo' }, { action: 'type', selector: '#pass', text: 'pw123' }, { action: 'click', selector: 'button[type=submit]' }, { action: 'wait_for', url_contains: 'dash.html' }, { action: 'wait_for', text_present: '2 jobs' }, { action: 'read' }] });
      return { pass: r.ok && /URL: https:\/\/[a-z0-9-]+\.workspace\.localhost\/s1\/dash\.html/.test(r.text) && /Welcome demo/.test(r.text) && /deploy/.test(r.text), detail: r.ok ? 'on dash.html, "Welcome demo", 2 jobs fetched from jobs.json' : r.text.slice(-200) };
    });
    await scenario('site: login page while signed in skips to the dashboard', async () => {
      const r = await tool('browser', { action: 'read', steps: [{ action: 'open', url: '/workspace/s1/index.html' }, { action: 'wait_for', url_contains: 'dash.html' }] });
      return { pass: r.ok, detail: r.ok ? 'skipped to dash.html' : r.text.slice(-160) };
    });
    await scenario('site: log out goes back to login, dashboard is guarded', async () => {
      const r = await tool('browser', { action: 'read', steps: [{ action: 'click', selector: '#out' }, { action: 'wait_for', url_contains: 'index.html' }, { action: 'open', url: '/workspace/s1/dash.html' }, { action: 'wait_for', url_contains: 'index.html' }, { action: 'read' }] });
      return { pass: r.ok && /URL: https:\/\/[a-z0-9-]+\.workspace\.localhost\/s1\/index\.html/.test(r.text), detail: r.ok ? 'logged out; dash.html without a session bounced to index.html' : r.text.slice(-200) };
    });
    await scenario('site: an edit is served on the next load', async () => {
      await tool('write_file', { path: 's1/jobs.json', content: JSON.stringify([{ name: 'a', state: 'x' }, { name: 'b', state: 'x' }, { name: 'c', state: 'x' }]) });
      const r = await tool('browser', { action: 'read', steps: [{ action: 'type', selector: '#user', text: 'demo' }, { action: 'type', selector: '#pass', text: 'pw123' }, { action: 'click', selector: 'button[type=submit]' }, { action: 'wait_for', text_present: '3 jobs' }] });
      return { pass: r.ok, detail: r.ok ? 'the new jobs.json (3 jobs) was served without reopening' : r.text.slice(-160) };
    });
    await scenario('site: preview_page with steps ends on the dashboard', async () => {
      await tool('browser', { action: 'eval', script: 'localStorage.clear(); return 1' });
      const r = await tool('preview_page', { path: 's1/index.html', view: 'mobile', steps: [{ action: 'type', selector: '#user', text: 'demo' }, { action: 'type', selector: '#pass', text: 'pw123' }, { action: 'click', selector: 'button[type=submit]' }, { action: 'wait_for', url_contains: 'dash.html' }] });
      return { pass: r.ok && /ended up at https:\/\/[a-z0-9-]+\.workspace\.localhost\/s1\/dash\.html/.test(r.text), detail: r.text.split('\n').filter((l) => /Preview|ended|FAILED/.test(l)).join(' | ').slice(0, 200) };
    });
    await scenario('site: a broken script is reported as an error', async () => {
      await tool('write_file', { path: 's1/broken.html', content: '<!doctype html><title>B</title><script src="missing.js"></script><script>undefinedThing()</script><p>broken page</p>' });
      const r = await tool('preview_page', { path: 's1/broken.html', view: 'mobile' });
      return { pass: /undefinedThing/.test(r.text) && /could not load \/s1\/missing\.js/.test(r.text), detail: (r.text.match(/JavaScript errors:[\s\S]*?(?=\n[A-Z]|$)/) || [r.text.slice(0, 160)])[0] };
    });
    await scenario("site: another chat's site does not see this chat's login", async () => {
      // preview_page above left "session" set in this chat's storage; a second chat serves its own folder
      const other = { ...ctx, convId: CONV + '-other', browserId: 'agentsim-other', workspace: { id: CONV + '-other', files: {}, shellState: {} } };
      other.workspace.files['peek.html'] = { data: new TextEncoder().encode('<!doctype html><title>peek</title><p id="s"></p><script>document.getElementById("s").textContent="session="+localStorage.getItem("session")</script>') };
      try {
        const r = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'read', steps: [{ action: 'open', url: '/workspace/peek.html' }, { action: 'wait_for', text_present: 'session=' }, { action: 'read' }] }) }, other);
        const seen = (String(r.result).match(/session=\w+/) || ['?'])[0];
        return { pass: r.ok && seen === 'session=null', detail: 'the other chat saw ' + seen };
      } finally {
        await closeBrowser('agentsim-other');
        await killShell('chat:' + CONV + '-other').catch(() => {});
        await deleteWorkspace(CONV + '-other').catch(() => {});
      }
    });
    await closeBrowser('agentsim-browser');

    // 2. a data job in Python: read a CSV the agent wrote, compute, write a report; the shell sees the same file
    await scenario('python: CSV -> report.json, read back', async () => {
      await tool('write_file', { path: 'data/sales.csv', content: 'region,amount\nnorth,120\nsouth,80\nnorth,30\neast,50\n' });
      const r = await tool('run_python', { code: "import csv, json, os\nrows = list(csv.DictReader(open('data/sales.csv')))\nby = {}\nfor x in rows:\n    by[x['region']] = by.get(x['region'], 0) + int(x['amount'])\nos.makedirs('output', exist_ok=True)\njson.dump({'total': sum(by.values()), 'by_region': by}, open('output/report.json', 'w'), sort_keys=True)\nprint('rows', len(rows))" });
      const back = await tool('read_file', { path: 'output/report.json' });
      let j = null;
      try {
        j = JSON.parse(file('output/report.json'));
      } catch {
        /* reported below */
      }
      return { pass: r.ok && /rows 4/.test(r.text) && back.ok && j?.total === 280 && j?.by_region?.north === 150, detail: r.ok ? `report ${file('output/report.json')}` : r.text.slice(0, 160) };
    });
    await scenario('python -> shell: the shell reads what Python wrote', async () => {
      const r = await tool('shell', { command: "python3 -c \"import json;print('total', json.load(open('/workspace/output/report.json'))['total'])\" 2>/dev/null || awk -F'\"total\": ' '{split($2,a,\"[,}]\");print \"total\", a[1]}' /workspace/output/report.json" });
      return { pass: r.ok && /total 280/.test(r.text), detail: r.text.split('\n').filter(Boolean).slice(0, 2).join(' | ') };
    });
    await scenario('python: an exception is ok=0 with the traceback', async () => {
      const r = await tool('run_python', { code: "def f(x):\n    return 1 / x\nf(0)" });
      return { pass: !r.ok && /ZeroDivisionError/.test(r.text), detail: (r.text.match(/ZeroDivisionError[^\n]*/) || [r.text.slice(0, 120)])[0] };
    });
    sandbox.kill?.();

    // a time limit stops the command and what it started, and nothing else: a server started earlier with nohup … &
    // keeps running, and the rest of the timed-out line (echo finished) never runs (bugs E, F, G)
    await scenario('shell: a timed-out command spares an earlier nohup server (reap)', async () => {
      await tool('shell', { command: "mkdir -p /workspace/reap && cd /workspace/reap && rm -f hb_old.txt hb_new.txt t8.txt && nohup sh -c 'while :; do date +%s >> hb_old.txt; sleep 1; done' >/dev/null 2>&1 &" });
      const t = await tool('shell', { command: "cd /workspace/reap && echo start > t8.txt; sh -c 'while :; do date +%s >> hb_new.txt; sleep 1; done' & sleep 60; echo finished >> t8.txt", timeout_s: 8 });
      await new Promise((r) => setTimeout(r, 15000));
      const c = await tool('shell', { command: 'cd /workspace/reap && echo "now=$(date +%s) old=$(tail -1 hb_old.txt) new=$(tail -1 hb_new.txt) t8=$(tr "\\n" , < t8.txt)"' });
      await tool('shell', { command: "pkill -f 'hb_old.txt' 2>/dev/null; true" });
      const n = (k) => Number((c.text.match(new RegExp(k + '=(\\d+)')) || [])[1]);
      const now = n('now'), old = n('old'), nw = n('new');
      const t8 = (c.text.match(/t8=([^\s\[]*)/) || [])[1] || '?';
      const pass = now > 0 && now - old <= 3 && nw > 0 && now - nw >= 10 && t8 === 'start,';
      return { pass, detail: `old server last beat ${now - old} s ago (want ≤3), timed-out loop ${now - nw} s ago (want ≥10), t8.txt "${t8}" (want "start,"); check said: ${c.text.slice(0, 160).replace(/\n/g, ' ')}; the timed-out call said: ${t.text.slice(0, 120).replace(/\n/g, ' ')}` };
    });

    // the app's copy written BEFORE a newer write in the shell, and synced after it, must not replace it (round 11):
    // the newer one stays the file, the older is kept beside it as a conflict copy, and the reply says so
    await scenario('sync: an older app copy does not replace a newer shell write (collide)', async () => {
      await tool('write_file', { path: 'coll/c.txt', content: 'START' });
      await tool('shell', { command: "cd /workspace/coll && rm -f c.conflict-other*.txt && cat c.txt && nohup sh -c 'sleep 2; printf \"HELPER B\" > c.txt' >/dev/null 2>&1 &" });
      await tool('write_file', { path: 'coll/c.txt', content: 'LOCAL 1' }); // older: before the shell's write lands
      await new Promise((r) => setTimeout(r, 3500));
      const c = await tool('shell', { command: 'cd /workspace/coll && echo "file=$(cat c.txt) end"' });
      const app = await tool('read_file', { path: 'coll/c.txt' });
      // the losing copy is kept on the side that lost (the app) and reaches the shell with the next sync
      const other = (await tool('read_file', { path: 'coll/c.conflict-other.txt' })).text;
      const file = (c.text.match(/file=([^\n]*?) end/) || [])[1] || '?';
      const said = /CONFLICT: coll\/c\.txt/.test(c.text);
      const pass = file === 'HELPER B' && /HELPER B/.test(app.text) && /LOCAL 1/.test(other) && said;
      return { pass, detail: `shell file "${file}" (want HELPER B), app copy ${/HELPER B/.test(app.text) ? 'HELPER B' : JSON.stringify(app.text.slice(0, 40))}, conflict copy "${other.slice(0, 30)}" (want LOCAL 1), conflict said: ${said}; reply: ${c.text.slice(0, 300).replace(/\n/g, ' ')}` };
    });

    // what the timed-out line itself started with nohup or setsid is left running, as timeout(1) would, and the reply
    // names it; a plain `cmd &` on the same line is still stopped. Heartbeat files only grow: no "disagreed" warning
    await scenario('shell: a timed-out line keeps its own nohup/setsid server and says so (reap keep)', async () => {
      const loop = (f) => `sh -c 'while :; do date +%s >> ${f}; sleep 1; done'`;
      const t = await tool('shell', { command: `mkdir -p /workspace/reap2 && cd /workspace/reap2 && rm -f hb_*.txt t9.txt; echo start > t9.txt; nohup ${loop('hb_keep.txt')} >/dev/null 2>&1 & setsid ${loop('hb_sid.txt')} >/dev/null 2>&1 & ${loop('hb_kill.txt')} & sleep 60; echo finished >> t9.txt`, timeout_s: 8 });
      await new Promise((r) => setTimeout(r, 12000));
      const c = await tool('shell', { command: 'cd /workspace/reap2 && echo "now=$(date +%s) keep=$(tail -1 hb_keep.txt) sid=$(tail -1 hb_sid.txt) kill=$(tail -1 hb_kill.txt) lines=$(wc -l < hb_keep.txt) t9=$(tr "\\n" , < t9.txt)"' });
      await new Promise((r) => setTimeout(r, 3000));
      // several more syncs while both heartbeats grow (the warning came back on later syncs, not only the first)
      const more = [];
      for (let i = 0; i < 5; i++) {
        more.push(await tool('shell', { command: 'cd /workspace/reap2 && wc -l < hb_keep.txt' }));
        await new Promise((r) => setTimeout(r, 700));
      }
      // the app's copy has every second, with no gap (nothing dropped by a "newer one won")
      const app = await tool('read_file', { path: 'reap2/hb_keep.txt' });
      const secs = (app.text.match(/^\d{9,}$/gm) || []).map(Number);
      const gaps = secs.slice(1).filter((s, i) => s - secs[i] > 2).length;
      await tool('shell', { command: "pkill -f 'hb_keep.txt' 2>/dev/null; pkill -f 'hb_sid.txt' 2>/dev/null; true" });
      const n = (k) => Number((c.text.match(new RegExp(k + '=(\\d+)')) || [])[1]);
      const now = n('now'), keep = n('keep'), sid = n('sid'), kill = n('kill');
      const t9 = (c.text.match(/t9=([^\s\[]*)/) || [])[1] || '?';
      const said = /still running: pid \d+/.test(t.text);
      const warned = [t, c, ...more].some((x) => /disagreed|before they were ever synced|became EMPTY|changed while it was being copied/.test(x.text));
      const pass = now - keep <= 3 && now - sid <= 3 && now - kill >= 8 && t9 === 'start,' && said && !warned && secs.length >= 10 && !gaps;
      return { pass, detail: `nohup beat ${now - keep} s ago, setsid ${now - sid} s ago (want ≤3), plain & ${now - kill} s ago (want ≥8), t9 "${t9}", reply names what it kept: ${said}, a sync warning over 7 syncs: ${warned}, app copy ${secs.length} beats with ${gaps} gaps; the timed-out call said: ${(t.text.match(/TIMED OUT[^\n]*/) || [t.text.slice(0, 200)])[0].slice(0, 400)}` };
    });

    // 3. write code and its tests, run them in the shell, break it, see the failure, fix it
    const calc = 'def add(a, b):\n    return a + b\n\ndef mean(xs):\n    if not xs:\n        raise ValueError("empty")\n    return sum(xs) / len(xs)\n';
    const tests = 'import unittest\nfrom calc import add, mean\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_mean(self):\n        self.assertEqual(mean([1, 2, 3]), 2)\n    def test_empty(self):\n        with self.assertRaises(ValueError):\n            mean([])\n\nif __name__ == "__main__":\n    unittest.main()\n';
    await scenario('code: tests pass in the shell', async () => {
      await tool('write_file', { path: 'proj/calc.py', content: calc });
      await tool('write_file', { path: 'proj/test_calc.py', content: tests });
      const r = await tool('shell', { command: 'cd /workspace/proj && python3 -m unittest -v 2>&1; echo "EXIT=$?"' });
      return { pass: /EXIT=0/.test(r.text) && /Ran 3 tests/.test(r.text) && /OK/.test(r.text), detail: (r.text.match(/Ran \d+ tests?[\s\S]*?(OK|FAILED[^\n]*)/) || [r.text.slice(-160)])[0] + ' ' + ((r.text.match(/EXIT=\d+/) || [''])[0]) };
    });
    await scenario('code: a bug fails the tests, the fix passes', async () => {
      await tool('write_file', { path: 'proj/calc.py', content: calc.replace('return a + b', 'return a - b') });
      const broken = await tool('shell', { command: 'cd /workspace/proj && python3 -m unittest 2>&1; echo "EXIT=$?"' });
      // the agent fixes it with sed in the shell this time, and read_file must see the shell's edit
      await tool('shell', { command: "cd /workspace/proj && sed -i 's/return a - b/return a + b/' calc.py" });
      const seen = await tool('read_file', { path: 'proj/calc.py' });
      const fixed = await tool('shell', { command: 'cd /workspace/proj && python3 -m unittest 2>&1; echo "EXIT=$?"' });
      const brokeRight = /EXIT=1/.test(broken.text) && /FAILED \(failures=1\)/.test(broken.text) && /test_add/.test(broken.text);
      return { pass: brokeRight && /return a \+ b/.test(seen.text) && /EXIT=0/.test(fixed.text), detail: `broken: ${(broken.text.match(/FAILED[^\n]*/) || ['?'])[0]}; read_file sees the sed fix: ${/return a \+ b/.test(seen.text)}; fixed: ${fixed.text.slice(-400)}` };
    });
    await scenario('code: a failing command says its exit code', async () => {
      const r = await tool('shell', { command: 'echo about to fail; exit 3' });
      return { pass: /exit(=|\s|:\s*|\s+code\s+)3/i.test(r.text), detail: JSON.stringify(r.text) };
    });
    await scenario('files: list_files sees what every surface wrote', async () => {
      await tool('shell', { command: 'mkdir -p /workspace/proj/out && echo from-shell > /workspace/proj/out/s.txt' });
      const r = await tool('list_files', { path: 'proj' });
      return { pass: /calc\.py/.test(r.text) && /test_calc\.py/.test(r.text) && /out\/s\.txt/.test(r.text), detail: r.text.split('\n').filter((l) => /proj/.test(l)).slice(0, 4).join(' | ').slice(0, 200) };
    });

    // 3b. editing like a coding agent: exact edits, no blind overwrite of the shell's change, a syntax check
    await scenario('edit: edit_file changes one place, the shell runs it', async () => {
      const e = await tool('edit_file', { path: 'proj/calc.py', edits: [{ old_text: '    return sum(xs) / len(xs)', new_text: '    return sum(xs) / float(len(xs))' }] });
      const t = await tool('shell', { command: 'cd /workspace/proj && grep -c "float(len" calc.py; python3 -m unittest 2>&1 | tail -1; echo "EXIT=$?"' });
      const g = await tool('grep_files', { pattern: 'def mean', glob: 'proj/*.py' });
      return { pass: e.ok && /│ {5}return sum\(xs\) \/ float/.test(e.text) && /^1$/m.test(t.text) && /OK/.test(t.text) && /proj\/calc\.py\n {2}4: def mean/.test(g.text), detail: `edit ok=${e.ok ? 1 : 0}; shell sees it: ${/^1$/m.test(t.text)}; tests: ${(t.text.match(/^(OK|FAILED.*)$/m) || ['?'])[0]}; grep: ${g.text.split('\n').slice(0, 2).join(' ')}` };
    });
    await scenario('edit: a file the shell changed is not overwritten blindly', async () => {
      await tool('read_file', { path: 'proj/calc.py' });
      await tool('shell', { command: 'echo "# added by the shell" >> /workspace/proj/calc.py' });
      const blind = await tool('write_file', { path: 'proj/calc.py', content: calc });
      const after = file('proj/calc.py') || '';
      const forced = await tool('write_file', { path: 'proj/calc.py', content: calc, overwrite: true });
      return { pass: !blind.ok && /changed by the shell/.test(blind.text) && after.includes('# added by the shell') && forced.ok, detail: `blind ok=${blind.ok ? 1 : 0} (${blind.text.slice(0, 90)}); shell line kept: ${after.includes('# added by the shell')}; overwrite:true ok=${forced.ok ? 1 : 0}` };
    });
    await scenario('edit: a syntax error is reported right after the write', async () => {
      const bad = await tool('edit_file', { path: 'proj/calc.py', old_text: 'def add(a, b):', new_text: 'def add(a, b)' });
      const js = await tool('write_file', { path: 'proj/x.js', content: 'const a = {;\n' });
      const fix = await tool('edit_file', { path: 'proj/calc.py', old_text: 'def add(a, b)\n', new_text: 'def add(a, b):\n' });
      return { pass: /⚠ Syntax check: Python: .*line 1/.test(bad.text) && /⚠ Syntax check: JavaScript/.test(js.text) && fix.ok && !/⚠/.test(fix.text), detail: `python: ${(bad.text.match(/⚠[^\n]*/) || ['none'])[0]}; js: ${(js.text.match(/⚠[^\n]*/) || ['none'])[0]}; fixed clean: ${!/⚠/.test(fix.text)}` };
    });
    await scenario('context: a huge output is spilled to .out/, start and end kept', async () => {
      const r = await tool('shell', { command: 'seq 1 30000' });
      // the file this result names (a run that was stopped half-way can leave older ones in .out/)
      const named = (/saved in \/?(?:workspace\/)?(\.out\/shell-[^\s)'"]+)/.exec(r.text) || [])[1];
      const spill = named && w.files[named] ? named : Object.keys(w.files).filter((p) => p.startsWith('.out/shell-')).pop();
      const full = spill ? file(spill) : '';
      const checks = { start: /(^|\n)1\n2\n3\n/.test(r.text), end: /\n30000\b/.test(r.text), middleInFile: full.includes('\n15000\n'), pointer: !!spill && r.text.includes('saved in ' + spill) };
      return { pass: !!spill && r.text.length < 20000 && Object.values(checks).every(Boolean), detail: `result ${r.text.length} chars; file ${spill} ${full.length} chars; ${JSON.stringify(checks)}` };
    });
    await scenario('script: run_script loops over tools in the sandbox', async () => {
      const code = 'const list = (await tools.glob_files({ pattern: "proj/*.py" })).paths;\nfor (const p of list) { const r = await tools.read_file({ path: p }); print(p, r.result.split("\\n").length + " lines"); }\nconst no = await tools.ask_user({ question: "x" });\nprint("ask_user refused:", !no.ok);';
      const r = await tool('run_script', { code, timeout_s: 60 });
      return { pass: r.ok && /proj\/calc\.py \d+ lines/.test(r.text) && /proj\/test_calc\.py \d+ lines/.test(r.text) && /ask_user refused: true/.test(r.text) && /glob_files, read_file×2/.test(r.text), detail: r.text.replace(/\n/g, ' | ').slice(0, 300) };
    });
    await scenario('plan: nothing changes before the plan is approved', async () => {
      const pctx = { ...ctx, planMode: { blocking: () => true } };
      const call = (name, args) => runTool({ name, arguments: JSON.stringify(args) }, pctx);
      const wr = await call('write_file', { path: 'plan/x.txt', content: 'x' });
      const sh = await call('shell', { command: 'touch /workspace/plan-made.txt' });
      const rd = await call('read_file', { path: 'proj/calc.py' });
      const sc = await call('run_script', { code: 'const r = await tools.write_file({ path: "plan/y.txt", content: "y" }); print(r.ok, r.result.slice(0, 40))' });
      return { pass: !wr.ok && !sh.ok && rd.ok && !w.files['plan/x.txt'] && !w.files['plan/y.txt'] && /false Not run: plan mode/.test(sc.result), detail: `write ok=${wr.ok ? 1 : 0}, shell ok=${sh.ok ? 1 : 0}, read ok=${rd.ok ? 1 : 0}, script: ${String(sc.result).split('\n')[0]}` };
    });

    // 4. a long command comes back as a job; the agent keeps working and collects it with shell_job
    await scenario('jobs: a long command becomes a job, shell_job collects it', async () => {
      setShellSoftLimit(3000);
      try {
        const r = await tool('shell', { command: 'for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done; echo LONG-DONE' });
        const id = (r.text.match(/"job_id"\s*:\s*"([^"]+)"/) || [])[1];
        if (!id) return { pass: false, detail: 'no job id in: ' + r.text.slice(0, 200) };
        const back = await tool('shell_job', { action: 'wait', job_id: id, wait_s: 20 });
        return { pass: /LONG-DONE/.test(back.text) && /exit[= ]0|DONE/i.test(back.text), detail: `job ${id} after ${r.ms} ms; wait -> ${back.text.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 120)}` };
      } finally {
        setShellSoftLimit(SHELL_SOFT_MS);
      }
    });

    // 5. a small API server in the shell, a page that calls it, opened in the browser on 127.0.0.1
    await scenario('server: a page on 127.0.0.1 calls an API in the shell', async () => {
      await tool('write_file', {
        path: 'api/server.py',
        content:
          'import json\nfrom http.server import HTTPServer, SimpleHTTPRequestHandler\nfrom urllib.parse import urlparse, parse_qs\n\nclass H(SimpleHTTPRequestHandler):\n    def do_GET(self):\n        u = urlparse(self.path)\n        if u.path == "/api/sum":\n            q = parse_qs(u.query)\n            body = json.dumps({"sum": int(q["a"][0]) + int(q["b"][0])}).encode()\n            self.send_response(200)\n            self.send_header("Content-Type", "application/json")\n            self.end_headers()\n            self.wfile.write(body)\n            return\n        return super().do_GET()\n\n    def log_message(self, *a):\n        pass\n\nHTTPServer(("127.0.0.1", 8766), H).serve_forever()\n',
      });
      await tool('write_file', { path: 'api/index.html', content: '<!doctype html><title>API</title><p id="r">waiting</p><script>fetch("/api/sum?a=2&b=3").then(function(r){return r.json()}).then(function(j){document.getElementById("r").textContent="sum is "+j.sum})</script>' });
      const start = await tool('shell', { command: 'cd /workspace/api && (nohup python3 server.py >/tmp/api.log 2>&1 &) ; for i in 1 2 3 4 5 6 7 8 9 10; do wget -q -O /dev/null "http://127.0.0.1:8766/api/sum?a=1&b=1" 2>/dev/null && echo UP && break; sleep 0.5; done' });
      if (!/UP/.test(start.text)) return { pass: false, detail: 'server did not come up: ' + start.text.slice(0, 160) };
      const r = await tool('browser', { action: 'read', steps: [{ action: 'open', url: 'http://127.0.0.1:8766/index.html' }, { action: 'wait_for', text_present: 'sum is 5' }] });
      return { pass: r.ok && /sum is 5/.test(r.text), detail: r.ok ? 'page fetched /api/sum from the shell server: "sum is 5"' : r.text.slice(-200) };
    });
    await tool('shell', { command: 'pkill -f "python3 server.py" 2>/dev/null; true' });
    await closeBrowser('agentsim-browser');

    // 6. honest failures an agent must see as failures
    await scenario('errors: missing file, bad page address, LAN address', async () => {
      const a = await tool('read_file', { path: 'nope/missing.txt' });
      const b = await tool('browser', { action: 'open', url: '/workspace/s1/nope.html' });
      const c = await tool('browser', { action: 'open', url: 'http://192.168.1.1/' });
      return { pass: !a.ok && !b.ok && /404/.test(b.text) && !c.ok && /local address/.test(c.text), detail: `read_file ok=${a.ok ? 1 : 0}; missing page ${(b.text.match(/HTTP \d+/) || ['?'])[0]} ok=${b.ok ? 1 : 0}; LAN ok=${c.ok ? 1 : 0}` };
    });
    // 7. the WebView itself: real taps with user activation, whole-page captures without black parts, a capture that
    //    shows what a click just changed, saved screenshots, the element list's count
    for (const [p, c] of Object.entries(WV)) await tool('write_file', { path: p, content: c });
    const savedOf = (r) => (/Saved as \/workspace\/(\S+?\.jpg)/.exec(r.text) || [])[1] || '';
    const pixel = async (path, fx, fy) => {
      const f = w.files[path];
      if (!f) return null;
      const bmp = await createImageBitmap(new Blob([f.data], { type: 'image/jpeg' }));
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const g = cv.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const css = typeof fx === 'object' ? fx : null; // {x, y} in CSS pixels of a 390-wide phone view
      const k = bmp.width / 390;
      const X = css ? css.x * k : fx * bmp.width;
      const Y = css ? css.y * k : fy * bmp.height;
      const d = g.getImageData(Math.min(bmp.width - 1, Math.round(X)), Math.min(bmp.height - 1, Math.round(Y)), 1, 1).data;
      return { rgb: [d[0], d[1], d[2]], w: bmp.width, h: bmp.height };
    };
    const near = (rgb, want, tol = 40) => !!rgb && rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
    await scenario('webview: a click is a real tap with user activation', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/act.html' });
      const r = await tool('browser', { action: 'click', selector: '#copy' });
      await tool('browser', { action: 'wait_for', text_present: 'clip=', ms: 800 });
      const out = await tool('browser', { action: 'get', property: 'text', selector: '#out' });
      const said = (r.text.match(/Tapped[^\n]*|Clicked by script[^\n]*|The real tap[^\n]*/) || ['?'])[0];
      return { pass: r.ok && /activation:true/.test(r.text) && /trusted=true active=true/.test(out.text), detail: `${said.slice(0, 120)} | page saw: ${(out.text.match(/trusted=\S+ active=\S+ clip=\S+/) || [out.text.slice(-80)])[0]}` };
    });
    await scenario('webview: eval gesture:true runs with activation', async () => {
      const a = await tool('browser', { action: 'eval', script: 'return !!navigator.userActivation.isActive' });
      const b = await tool('browser', { action: 'eval', gesture: true, script: 'return [navigator.userActivation.isActive, await navigator.clipboard.writeText("x").then(()=>"clip ok",(e)=>"clip "+e.name)]' });
      return { pass: b.ok && /activation:true/.test(b.text) && /\[\s*true/.test(b.text), detail: `without: ${(a.text.match(/(true|false)\s*$/) || ['?'])[0]} | with gesture: ${b.text.split('\n').slice(-3).join(' ').slice(0, 140)}` };
    });
    await scenario('webview: a covered button is said, and still clicked', async () => {
      const r = await tool('browser', { action: 'click', selector: '#under' });
      const out = await tool('browser', { action: 'get', property: 'text', selector: '#out2' });
      return { pass: r.ok && /did not reach this element/.test(r.text) && /activation:false/.test(r.text) && /under clicked/.test(out.text), detail: (r.text.match(/The real tap[^\n]*/) || [r.text.slice(0, 120)])[0].slice(0, 160) + ' | ' + (out.text.match(/under clicked \S+/) || ['not clicked'])[0] };
    });
    await scenario('webview: full-page mobile capture has no black part', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/tall.html' });
      const r = await tool('browser', { action: 'screenshot', full_page: true });
      const path = savedOf(r);
      const top = await pixel(path, 0.5, 0.05);
      const mid = await pixel(path, 0.5, 0.5);
      const bot = await pixel(path, 0.5, 0.97);
      const parts = (r.images || []).length;
      return {
        pass: r.ok && !!path && near(top?.rgb, [245, 158, 11]) && near(mid?.rgb, [16, 185, 129]) && near(bot?.rgb, [37, 99, 235]) && !/never painted|cut off|left out/.test(r.text),
        detail: `${path || 'not saved'} ${top ? top.w + '×' + top.h : ''}; ${parts} parts; top ${top?.rgb} mid ${mid?.rgb} bottom ${bot?.rgb}${/cut off|left out/.test(r.text) ? ' | ' + (r.text.match(/Warning:[^\n]*/) || [''])[0].slice(0, 160) : ''}`,
      };
    });
    await scenario('webview: preview_page full_page mobile paints', async () => {
      const r = await tool('preview_page', { path: 'wv/tall.html', view: 'mobile', full_page: true });
      const saved = (/\/workspace\/(output\/screenshots\/preview-[^\s,;]+?\.jpg)/.exec(r.text) || [])[1] || Object.keys(w.files).filter((k) => k.startsWith('output/screenshots/preview-wv_tall')).pop();
      const bot = saved ? await pixel(saved, 0.5, 0.97) : null;
      return { pass: r.ok && !/never painted|PREVIEW FAILED/.test(r.text) && near(bot?.rgb, [37, 99, 235]), detail: `${r.text.split('\n')[0].slice(0, 120)} | bottom ${bot?.rgb} (${saved || 'no file'})` };
    });
    await scenario('webview: a screenshot right after a click shows the change', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/repaint.html' });
      const r = await tool('browser', { action: 'read', steps: [{ action: 'click', selector: '#go' }, { action: 'screenshot' }] });
      const path = savedOf(r);
      const px = await pixel(path, 0.5, 0.4);
      return { pass: r.ok && near(px?.rgb, [220, 38, 38]), detail: `${path || 'not saved'}: box ${px?.rgb} (want red 220,38,38)` };
    });
    await scenario('webview: a capture right after a click waits for the transition', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/transition.html' });
      // how many frames the hidden page gets in half a second (a page on screen gets about 30)
      const fr = await tool('browser', { action: 'eval', script: 'let n = 0; const t = performance.now(); await new Promise((r) => { const f = () => { n++; if (performance.now() - t > 500) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(r, 1500); }); return n' });
      const frames = (fr.text.match(/(\d+)\s*(\[surface|$)/) || [])[1];
      const r = await tool('browser', { action: 'read', steps: [{ action: 'click', selector: '#go' }, { action: 'screenshot' }] });
      const path = savedOf(r);
      // CSS pixels, not screen fractions: the capture is cropped to the page's content (the box is absolute)
      const px = await pixel(path, { x: 190, y: 290 });
      const p = await tool('preview_page', { path: 'wv/transition.html', view: 'mobile', steps: [{ action: 'click', selector: '#go' }] });
      const pp = (/\/workspace\/(output\/screenshots\/preview-[^\s,;]+?\.jpg)/.exec(p.text) || [])[1] || Object.keys(w.files).filter((k) => k.startsWith('output/screenshots/preview-wv_transition')).pop();
      const px2 = pp ? await pixel(pp, { x: 190, y: 290 }) : null;
      return { pass: r.ok && near(px?.rgb, [184, 241, 74]) && near(px2?.rgb, [184, 241, 74]), detail: `${frames ?? '?'} frames in 0.5 s; browser: box ${px?.rgb} in ${px?.w}×${px?.h}; preview_page: box ${px2?.rgb} in ${px2?.w}×${px2?.h} (want lime 184,241,74; the start colour is 17,24,32)` };
    });
    await scenario('webview: frames keep coming through a long wait and between calls', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/transition.html' });
      await tool('browser', { action: 'eval', script: 'window.__n = 0; const f = () => { window.__n++; requestAnimationFrame(f); }; requestAnimationFrame(f); return 1' });
      const read = async () => Number(((await tool('browser', { action: 'eval', script: 'return window.__n' })).text.match(/(\d+)\s*(\[surface|$)/) || [])[1]);
      const a = await read();
      await tool('browser', { action: 'wait_for', ms: 9000 });
      const b = await read();
      await new Promise((r) => setTimeout(r, 9000)); // no calls at all: the window runs out
      const c = await read();
      const during = b - a, idle = c - b;
      // a page that is quiet for a while, then starts animating on its own (a timer, no call from us)
      await tool('browser', { action: 'reload' });
      await tool('browser', { action: 'eval', script: 'window.__m = -1; setTimeout(() => { window.__m = 0; const f = () => { window.__m++; requestAnimationFrame(f); }; requestAnimationFrame(f); }, 8000); return 1' });
      await new Promise((r) => setTimeout(r, 12000));
      const late = Number(((await tool('browser', { action: 'eval', script: 'return window.__m' })).text.match(/(-?\d+)\s*(\[surface|$)/) || [])[1]);
      return { pass: during > 150 && late > 100, detail: `${during} frames during a 9 s wait_for; ${idle} in 9 s without calls; an animation the page started by itself after 8 quiet seconds got ${late} frames in its first 4 s` };
    });
    await scenario('webview: 1000 rows – the list says how many are left out', async () => {
      const r = await tool('browser', { action: 'open', url: '/workspace/wv/rows.html' });
      const line = (r.text.match(/… \d+ more[^\n]*/) || [''])[0];
      const listed = (r.text.match(/^\[\d+\] /gm) || []).length;
      const more = Number((line.match(/… (\d+) more/) || [])[1] || 0);
      return { pass: r.ok && listed > 0 && listed + more === 1001 && /further down/.test(line), detail: `${listed} listed; "${line}"` };
    });
    await scenario("webview: copy buttons copy into the page's own clipboard (no phone popup)", async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/copy2.html' });
      const a = await tool('browser', { action: 'click', selector: '#a' });
      const g1 = await tool('browser', { action: 'get', property: 'clipboard' });
      const b = await tool('browser', { action: 'click', selector: '#b' });
      const g2 = await tool('browser', { action: 'get', property: 'clipboard' });
      const pass = /copied "uuid-1234"/.test(a.text) && /uuid-1234/.test(g1.text) && /copied "uuid-from-textarea"/.test(b.text) && /uuid-from-textarea/.test(g2.text) && /execCommand\(copy\)/.test(g2.text);
      return { pass, detail: `${(a.text.match(/The page copied[^)]*\)/) || ['A: no copy note'])[0]} | ${(b.text.match(/The page copied "[^"]*"/) || ['B: no copy note'])[0]} | get: ${g2.text.split('\n')[0].slice(0, 120)}` };
    });
    await scenario('webview: activation is read at the click, after a failed fullscreen too', async () => {
      await tool('browser', { action: 'open', url: '/workspace/wv/fullscreen.html' });
      const a = await tool('browser', { action: 'click', selector: '#fs' });
      const b = await tool('browser', { action: 'click', selector: '#b' });
      const o = await tool('browser', { action: 'get', property: 'text', selector: '#o' });
      const said = (x) => (x.text.match(/activation:\w+/) || ['?'])[0];
      return { pass: /activation:true/.test(a.text) && /activation:true/.test(b.text) && /active=true/.test(o.text), detail: `fullscreen click ${said(a)}; next click ${said(b)}; page saw ${(o.text.match(/active=\w+/) || ['?'])[0]}` };
    });
    await scenario('webview: the element list says how many more', async () => {
      const r = await tool('browser', { action: 'open', url: '/workspace/wv/many.html' });
      const more = (r.text.match(/… (\d+) more\b[^\n]*scroll, or use a selector/) || [])[1];
      const listed = (r.text.match(/^\[\d+\] /gm) || []).length;
      return { pass: r.ok && listed === 80 && Number(more) === 70, detail: `${listed} listed, "${more ?? 'no'} more"` };
    });

    // 8. building different kinds of code the way an agent does: write the files, open them, use them, check
    const put = async (files) => {
      for (const [path, content] of Object.entries(files)) {
        const r = await tool('write_file', { path, content });
        if (!r.ok) throw new Error(`write_file ${path}: ${r.text.slice(0, 160)}`);
      }
    };
    const textOf = async (sel) => {
      const r = await tool('browser', { action: 'get', property: 'text', selector: sel });
      const t = (r.text.split('\n').slice(1).join('\n') || r.text).replace(/\s*\[surface[^\]]*\]\s*$/, '').trim();
      try {
        const v = JSON.parse(t);
        return typeof v === 'string' ? v : t;
      } catch {
        return t;
      }
    };
    const PAGE = (body, head = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta charset="utf-8">${head}</head><body style="margin:0;font:16px system-ui">${body}</body></html>`;
    await scenario('build: ES modules, JSON and CSS from separate files', async () => {
      await put({
        'b/mod/index.html': PAGE('<p id="o">waiting</p><script type="module" src="./app.js"></script>', '<link rel="stylesheet" href="style.css">'),
        'b/mod/app.js': "import { sum } from './lib/math.js';\nconst d = await (await fetch('./data.json')).json();\ndocument.getElementById('o').textContent = 'total ' + sum(d.nums) + ' bg ' + getComputedStyle(document.body).backgroundColor;\n",
        'b/mod/lib/math.js': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n',
        'b/mod/data.json': '{"nums":[1,2,3,4]}',
        'b/mod/style.css': 'body{background:rgb(1, 2, 3)!important;color:#fff}',
      });
      await tool('browser', { action: 'open', url: '/workspace/b/mod/index.html' });
      const w8 = await tool('browser', { action: 'wait_for', text_present: 'total 10', timeout_ms: 6000 });
      const t = await textOf('#o');
      const c = await tool('browser', { action: 'console' });
      return { pass: w8.ok && /total 10 bg rgb\(1, 2, 3\)/.test(t), detail: `"${t}"${w8.ok ? '' : '; console: ' + c.text.slice(0, 200)}` };
    });
    await scenario('build: a canvas game loop answers arrow keys', async () => {
      await put({
        'b/game/index.html': PAGE(
          '<canvas id="c" width="300" height="200" style="display:block;background:#000"></canvas><p id="x">x=20</p>' +
            '<script>var c=document.getElementById("c"),g=c.getContext("2d"),x=20,frames=0;' +
            'addEventListener("keydown",function(e){if(e.key==="ArrowRight")x+=20;if(e.key==="ArrowLeft")x-=20;document.getElementById("x").textContent="x="+x});' +
            'function loop(){frames++;g.fillStyle="#000";g.fillRect(0,0,300,200);g.fillStyle="#b8f14a";g.fillRect(x,90,20,20);requestAnimationFrame(loop)}requestAnimationFrame(loop);</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/game/index.html' });
      for (let i = 0; i < 3; i++) await tool('browser', { action: 'press', key: 'ArrowRight' });
      const t = await textOf('#x');
      const sh = await tool('browser', { action: 'screenshot' });
      const px = await pixel(savedOf(sh), { x: 90, y: 100 }); // CSS pixels: a short page's capture is cropped
      const fr = await tool('browser', { action: 'eval', script: 'return frames' });
      return { pass: t === 'x=80' && near(px?.rgb, [184, 241, 74]), detail: `${t}; player pixel ${px?.rgb} in ${px?.w}×${px?.h}; ${(fr.text.match(/(\d+)\s*(\[surface|$)/) || [])[1]} frames drawn` };
    });
    await scenario('build: a localStorage to-do list survives a reload', async () => {
      await put({
        'b/todo/index.html': PAGE(
          '<form id="f"><input id="t" placeholder="New item"><button>Add</button></form><ul id="l"></ul>' +
            '<script>var k="todos",l=document.getElementById("l");function draw(){l.innerHTML="";JSON.parse(localStorage.getItem(k)||"[]").forEach(function(s){var li=document.createElement("li");li.textContent=s;l.appendChild(li)})}' +
            'document.getElementById("f").onsubmit=function(e){e.preventDefault();var a=JSON.parse(localStorage.getItem(k)||"[]");a.push(document.getElementById("t").value);localStorage.setItem(k,JSON.stringify(a));document.getElementById("t").value="";draw()};draw()</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/todo/index.html' });
      await tool('browser', { action: 'storage', area: 'local', op: 'clear' });
      await tool('browser', { action: 'reload' });
      await tool('browser', { action: 'type', selector: '#t', text: 'buy milk', submit: true });
      await tool('browser', { action: 'type', selector: '#t', text: 'call mum', submit: true });
      await tool('browser', { action: 'reload' });
      const t = await textOf('#l');
      return { pass: /buy milk/.test(t) && /call mum/.test(t), detail: `after reload: "${t.replace(/\n/g, ' | ')}"` };
    });
    await scenario('build: a Web Worker computes off the page', async () => {
      await put({
        'b/worker/index.html': PAGE('<p id="o">working</p><script>var w=new Worker("worker.js");w.onmessage=function(e){document.getElementById("o").textContent="fib "+e.data};w.onerror=function(e){document.getElementById("o").textContent="worker error "+e.message};w.postMessage(25)</script>'),
        'b/worker/worker.js': 'function fib(n){return n<2?n:fib(n-1)+fib(n-2)}\nonmessage=function(e){postMessage(fib(e.data))};\n',
      });
      await tool('browser', { action: 'open', url: '/workspace/b/worker/index.html' });
      await tool('browser', { action: 'wait_for', text_present: 'fib', timeout_ms: 6000 });
      const t = await textOf('#o');
      return { pass: t === 'fib 75025', detail: `"${t}"` };
    });
    await scenario('build: form controls – select, checkbox, number', async () => {
      await put({
        'b/form/index.html': PAGE(
          '<label>Size <select id="size"><option>S</option><option>M</option><option>L</option></select></label> <label><input type="checkbox" id="gift"> Gift</label> <input type="number" id="qty" value="1"> <output id="o">S x1</output>' +
            '<script>function u(){document.getElementById("o").textContent=document.getElementById("size").value+" x"+document.getElementById("qty").value+(document.getElementById("gift").checked?" gift":"")}["change","input"].forEach(function(t){document.addEventListener(t,u)})</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/form/index.html' });
      const a = await tool('browser', { action: 'select', selector: '#size', text: 'L' });
      const b = await tool('browser', { action: 'check', selector: '#gift' });
      const c = await tool('browser', { action: 'type', selector: '#qty', text: '3' });
      const t = await textOf('#o');
      return { pass: t === 'L x3 gift', detail: `"${t}"` + [a, b, c].filter((x) => !x.ok).map((x) => ' | ' + x.text.slice(0, 120)).join('') };
    });
    await scenario('build: confirm() is answered the way you set, and said', async () => {
      await put({ 'b/dlg/index.html': PAGE('<button id="b" style="padding:20px">Delete</button><p id="o">none</p><script>document.getElementById("b").onclick=function(){document.getElementById("o").textContent=confirm("Delete it?")?"yes":"no"}</script>') });
      await tool('browser', { action: 'open', url: '/workspace/b/dlg/index.html' });
      await tool('browser', { action: 'dialog', mode: 'dismiss' });
      const c1 = await tool('browser', { action: 'click', selector: '#b' });
      const t1 = await textOf('#o');
      await tool('browser', { action: 'dialog', mode: 'accept' });
      await tool('browser', { action: 'click', selector: '#b' });
      const t2 = await textOf('#o');
      const said = /Delete it\?/.test(c1.text);
      return { pass: t1 === 'no' && t2 === 'yes' && said, detail: `dismiss → "${t1}", accept → "${t2}"; the click result ${said ? 'quotes' : 'does not mention'} the dialog` };
    });
    await scenario('build: drag and drop moves an item', async () => {
      await put({
        'b/drag/index.html': PAGE(
          '<div id="a" draggable="true" style="width:120px;height:60px;background:#f59e0b;margin:20px">Card</div><div id="zone" style="width:300px;height:120px;border:3px dashed #888;margin:20px">Drop here</div><p id="o">not dropped</p>' +
            '<script>var z=document.getElementById("zone");document.getElementById("a").addEventListener("dragstart",function(e){e.dataTransfer.setData("text/plain","a")});z.addEventListener("dragover",function(e){e.preventDefault()});z.addEventListener("drop",function(e){e.preventDefault();z.appendChild(document.getElementById(e.dataTransfer.getData("text/plain")||"a"));document.getElementById("o").textContent="dropped"})</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/drag/index.html' });
      const d = await tool('browser', { action: 'drag', selector: '#a', to_selector: '#zone' });
      const t = await textOf('#o');
      const inZone = await tool('browser', { action: 'eval', script: 'return document.getElementById("a").parentNode.id' });
      return { pass: t === 'dropped' && /zone/.test(inZone.text), detail: `"${t}"; card is in #${(inZone.text.match(/"?(\w+)"?\s*(\[surface|$)/) || [])[1]}${d.ok ? '' : ' | ' + d.text.slice(0, 150)}` };
    });
    await scenario('build: content that loads when scrolled into view', async () => {
      await put({
        'b/lazy/index.html': PAGE('<div style="height:3000px;background:linear-gradient(#fff,#ddd)">Top</div><p id="lazy">not yet</p><script>new IntersectionObserver(function(es){if(es[0].isIntersecting)document.getElementById("lazy").textContent="loaded"}).observe(document.getElementById("lazy"))</script>'),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/lazy/index.html' });
      const before = await textOf('#lazy');
      await tool('browser', { action: 'scroll', direction: 'bottom' });
      await tool('browser', { action: 'wait_for', text_present: 'loaded', timeout_ms: 3000 });
      const after = await textOf('#lazy');
      return { pass: before === 'not yet' && after === 'loaded', detail: `before "${before}", after scrolling "${after}"` };
    });
    await scenario('build: Python draws a PNG, the page shows it', async () => {
      const py = await tool('run_python', {
        code: [
          'import zlib, struct',
          'W, H = 200, 100',
          'rows = []',
          'for y in range(H):',
          '    row = bytearray([0])',
          '    for x in range(W):',
          '        bar = (x // 40) * 18 + 10',
          '        on = (H - y) <= bar and x % 40 < 30',
          '        row += bytes((40, 160, 255) if on else (255, 255, 255))',
          '    rows.append(bytes(row))',
          'def chunk(t, d):',
          '    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)',
          'png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")',
          'import os',
          'os.makedirs("b/chart", exist_ok=True)',
          'open("b/chart/chart.png", "wb").write(png)',
          'print("wrote", len(png), "bytes")',
        ].join('\n'),
      });
      if (!py.ok) return { pass: false, detail: 'run_python: ' + py.text.slice(0, 200) };
      await put({ 'b/chart/index.html': PAGE('<img id="c" src="chart.png"><p id="o">loading</p><script>var i=document.getElementById("c");i.onload=function(){document.getElementById("o").textContent="w="+i.naturalWidth+" h="+i.naturalHeight};i.onerror=function(){document.getElementById("o").textContent="broken image"}</script>') });
      await tool('browser', { action: 'open', url: '/workspace/b/chart/index.html' });
      await tool('browser', { action: 'wait_for', text_present: 'w=', timeout_ms: 4000 });
      const t = await textOf('#o');
      return { pass: t === 'w=200 h=100', detail: `${py.text.split('\n')[0].slice(0, 60)}; page: "${t}"` };
    });
    await scenario('build: a Node.js script in the shell', async () => {
      const has = await tool('shell', { command: 'command -v node >/dev/null && node --version || echo NO_NODE' });
      if (/NO_NODE/.test(has.text)) return { pass: true, detail: 'node is not installed in the shell (apt-get install nodejs) – skipped' };
      await put({ 'b/node/count.js': "const fs = require('fs');\nconst words = fs.readFileSync(process.argv[2], 'utf8').split(/\\s+/).filter(Boolean);\nconsole.log(JSON.stringify({ words: words.length }));\n", 'b/node/text.txt': 'one two three four five' });
      const r = await tool('shell', { command: 'cd /workspace/b/node && node count.js text.txt' });
      return { pass: /"words":5/.test(r.text), detail: `${has.text.split('\n')[0].trim()}: ${r.text.split('\n')[0].slice(0, 80)}` };
    });
    await scenario('build: the desktop and phone layouts both show', async () => {
      await put({ 'b/resp/index.html': PAGE('<p id="m">phone layout</p><p id="d">desktop layout</p>', '<style>#d{display:none}@media (min-width:800px){#m{display:none}#d{display:block}}</style>') });
      await tool('browser', { action: 'open', url: '/workspace/b/resp/index.html' });
      const m = await tool('browser', { action: 'get', property: 'visible', selector: '#m' });
      await tool('browser', { action: 'open', url: '/workspace/b/resp/index.html', view: 'desktop' });
      const d = await tool('browser', { action: 'get', property: 'visible', selector: '#d' });
      const width = await tool('browser', { action: 'eval', script: 'return innerWidth' });
      await tool('browser', { action: 'open', url: '/workspace/b/resp/index.html', view: 'mobile' });
      const val = (r) => /true/.test(r.text.split('\n').slice(1).join(' ') || r.text);
      return { pass: val(m) && val(d), detail: `mobile #m visible ${val(m)}; desktop (${(width.text.match(/(\d+)\s*(\[surface|$)/) || [])[1]} px wide) #d visible ${val(d)}` };
    });
    await scenario('build: a page inside an iframe can be read and clicked', async () => {
      await put({
        'b/frame/index.html': PAGE('<h1>Outer</h1><iframe id="f" src="inner.html" style="width:100%;height:300px;border:0"></iframe>'),
        'b/frame/inner.html': PAGE('<p id="i">inside the frame</p><button id="b" style="padding:20px">Inner button</button><p id="o">not clicked</p><script>document.getElementById("b").onclick=function(){document.getElementById("o").textContent="clicked inside"}</script>'),
      });
      const r = await tool('browser', { action: 'open', url: '/workspace/b/frame/index.html' });
      const sees = /inside the frame/.test(r.text);
      const lists = /Inner button/.test(r.text);
      const c = lists ? await tool('browser', { action: 'click', selector: 'text=Inner button' }) : null;
      const e = await tool('browser', { action: 'eval', script: 'return document.getElementById("f").contentDocument.getElementById("o").textContent' });
      const clicked = /clicked inside/.test(e.text);
      return { pass: sees && lists && clicked, detail: `frame text ${sees ? 'in' : 'NOT in'} the page read; inner button ${lists ? 'listed' : 'NOT listed'}; click ${c ? (clicked ? 'worked' : 'did not reach it: ' + c.text.slice(0, 100)) : 'not tried'}` };
    });
    await scenario('build: a library from a CDN loads', async () => {
      await put({ 'b/cdn/index.html': PAGE('<p id="o">loading</p><script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js"></script><script>document.getElementById("o").textContent=typeof dayjs==="function"?"dayjs "+dayjs("2026-01-02").format("DD/MM/YYYY"):"no library"</script>') });
      const r = await tool('browser', { action: 'open', url: '/workspace/b/cdn/index.html', wait_ms: 2500 });
      const t = await textOf('#o');
      const c = t === 'dayjs 02/01/2026' ? '' : (await tool('browser', { action: 'console' })).text.slice(0, 200);
      return { pass: t === 'dayjs 02/01/2026', detail: `"${t}"${c ? '; console: ' + c : ''}${r.ok ? '' : '; open: ' + r.text.slice(0, 100)}` };
    });
    await scenario('build: a service worker (PWA) registers and serves offline', async () => {
      await put({
        'b/pwa/index.html': PAGE('<p id="o">starting</p><script>navigator.serviceWorker?navigator.serviceWorker.register("sw.js").then(function(){return navigator.serviceWorker.ready}).then(function(){document.getElementById("o").textContent="sw ready, controlled="+!!navigator.serviceWorker.controller}).catch(function(e){document.getElementById("o").textContent="sw failed: "+e.message}):document.getElementById("o").textContent="no serviceWorker API"</script>'),
        'b/pwa/sw.js': "self.addEventListener('install', (e) => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', (e) => { if (e.request.url.endsWith('/hello.txt')) e.respondWith(new Response('from the worker')); });\n",
      });
      await tool('browser', { action: 'open', url: '/workspace/b/pwa/index.html' });
      await tool('browser', { action: 'wait_for', text_present: 'sw ', timeout_ms: 6000 });
      const t = await textOf('#o');
      const f = await tool('browser', { action: 'eval', script: 'return await (await fetch("hello.txt")).text()' });
      const served = /from the worker/.test(f.text);
      return { pass: /sw ready/.test(t) && served, detail: `"${t}"; fetch through the worker: ${served ? 'served by it' : f.text.split('\n').slice(-2, -1)[0] || f.text.slice(0, 100)}` };
    });
    await scenario('build: a sound plays after a tap', async () => {
      await put({
        'b/audio/index.html': PAGE(
          '<button id="b" style="padding:20px">Play</button><p id="o">idle</p><script>function wav(){var n=8000,b=new ArrayBuffer(44+n*2),v=new DataView(b),w=function(o,s){for(var i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};w(0,"RIFF");v.setUint32(4,36+n*2,true);w(8,"WAVEfmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,"data");v.setUint32(40,n*2,true);for(var i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i/4)*3000,true);return URL.createObjectURL(new Blob([b],{type:"audio/wav"}))}' +
            'var a=new Audio(wav());document.getElementById("b").onclick=function(){a.play().then(function(){document.getElementById("o").textContent="playing"},function(e){document.getElementById("o").textContent="refused: "+e.name})}</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/audio/index.html' });
      await tool('browser', { action: 'click', selector: '#b' });
      await tool('browser', { action: 'wait_for', text_present: 'i', timeout_ms: 2000 });
      const t = await textOf('#o');
      return { pass: t === 'playing', detail: `"${t}"` };
    });
    await scenario('build: a pointer-event slider and drag', async () => {
      await put({
        'b/pdrag/index.html': PAGE(
          '<div id="track" style="position:relative;margin:40px 20px;width:300px;height:40px;background:#ddd;touch-action:none"><div id="knob" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#3b82f6"></div></div><div id="goal" style="margin:20px;width:300px;height:60px;background:#eee">goal</div><p id="o">x=0</p>' +
            '<script>var k=document.getElementById("knob"),tr=document.getElementById("track"),down=false;k.addEventListener("pointerdown",function(e){down=true;k.setPointerCapture&&k.setPointerCapture(e.pointerId)});' +
            'addEventListener("pointermove",function(e){if(!down)return;var r=tr.getBoundingClientRect(),x=Math.max(0,Math.min(260,e.clientX-r.left-20));k.style.left=x+"px";document.getElementById("o").textContent="x="+Math.round(x)});addEventListener("pointerup",function(){down=false})</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/pdrag/index.html' });
      const d = await tool('browser', { action: 'drag', selector: '#knob', to_selector: '#goal' });
      const t = await textOf('#o');
      const x = Number((t.match(/x=(\d+)/) || [])[1] || 0);
      return { pass: x > 100, detail: `after drag to the middle of #goal: "${t}"${d.ok ? '' : ' | ' + d.text.slice(0, 150)}` };
    });
    await scenario('build: typing into a rich-text editor', async () => {
      await put({ 'b/edit/index.html': PAGE('<div id="ed" contenteditable="true" style="min-height:80px;border:1px solid #888;margin:20px;padding:8px"></div><p id="o">0 words</p><script>var ed=document.getElementById("ed");ed.addEventListener("input",function(){document.getElementById("o").textContent=ed.innerText.trim().split(/\\s+/).filter(Boolean).length+" words"})</script>') });
      await tool('browser', { action: 'open', url: '/workspace/b/edit/index.html' });
      const a = await tool('browser', { action: 'type', selector: '#ed', text: 'hello rich text world', force: true });
      const t = await textOf('#o');
      const html = await textOf('#ed');
      return { pass: t === '4 words' && /hello rich text world/.test(html), detail: `"${t}", editor holds "${html}"${a.ok ? '' : ' | ' + a.text.slice(0, 150)}` };
    });
    await scenario('build: numpy in run_python', async () => {
      const r = await tool('run_python', { code: 'import numpy as np\na = np.arange(12).reshape(3, 4)\nprint("sum", int(a.sum()), "shape", a.shape)' });
      return { pass: r.ok && /sum 66 shape \(3, 4\)/.test(r.text), detail: r.text.split('\n').find((l) => /sum|Error|rror/.test(l))?.slice(0, 160) || r.text.slice(0, 160) };
    });
    await scenario('build: git in the shell', async () => {
      const r = await tool('shell', { command: 'command -v git >/dev/null || { echo NO_GIT; exit 0; }; cd /workspace && rm -rf b/repo && mkdir -p b/repo && cd b/repo && git init -q && git config user.email t@t && git config user.name t && echo one > a.txt && git add . && git commit -qm first && echo two >> a.txt && git commit -qam second && git log --oneline | wc -l && git diff HEAD~1 --stat | tail -1' });
      if (/NO_GIT/.test(r.text)) return { pass: true, detail: 'git is not installed in the shell (apt-get install git) – skipped' };
      return { pass: /\n\s*2\s*\n/.test('\n' + r.text) || /^\s*2\s*$/m.test(r.text), detail: r.text.replace(/\s+/g, ' ').slice(0, 160) };
    });
    await scenario('build: a single-page app with routes and Back', async () => {
      await put({
        'b/spa/index.html': PAGE(
          '<nav><a href="about" data-r>About</a> <a href="contact" data-r>Contact</a></nav><h1 id="v">Home</h1>' +
            '<script>function show(){var p=location.pathname.split("/").pop();document.getElementById("v").textContent=p==="about"?"About page":p==="contact"?"Contact page":"Home"}' +
            'document.addEventListener("click",function(e){var a=e.target.closest("a[data-r]");if(!a)return;e.preventDefault();history.pushState({},"",a.getAttribute("href"));show()});addEventListener("popstate",show);show()</script>',
        ),
      });
      await tool('browser', { action: 'open', url: '/workspace/b/spa/index.html' });
      await tool('browser', { action: 'click', selector: 'text=About' });
      const a = await textOf('#v');
      await tool('browser', { action: 'click', selector: 'text=Contact' });
      const b = await textOf('#v');
      const back = await tool('browser', { action: 'back' });
      const c = await textOf('#v');
      const re = await tool('browser', { action: 'reload' });
      const d = re.ok ? await textOf('#v') : 'reload failed: ' + re.text.slice(0, 80);
      return { pass: a === 'About page' && b === 'Contact page' && c === 'About page' && d === 'About page', detail: `About → "${a}", Contact → "${b}", Back → "${c}"${back.ok ? '' : ' (' + back.text.slice(0, 80) + ')'}; reload on /about → "${String(d).slice(0, 80)}"` };
    });

    // 9. browsing: real sites (they need the internet) and the awkward kinds of page agents meet
    const lastVal = (r) => {
      const t = r.text.replace(/\s*\[surface[^\]]*\]\s*$/, '');
      const body = t.slice(t.indexOf(':\n') + 2);
      try {
        return JSON.parse(body);
      } catch {
        return body.trim();
      }
    };
    await scenario('browse: a simple site, then a link, then Back', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://example.com/' });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 160) };
      const link = /\[\d+\] link "[^"]*(More information|Learn more)[^"]*"/.test(a.text);
      const c = await tool('browser', { action: 'click', selector: 'a' });
      const moved = /iana\.org/.test(c.text);
      const b = await tool('browser', { action: 'back' });
      return { pass: /Example Domain/.test(a.text) && link && moved && /example\.com/.test(b.text), detail: `title ${/Example Domain/.test(a.text)}; link listed ${link}; click went to iana.org ${moved}; Back on example.com ${/example\.com/.test(b.text)}${/example\.com/.test(b.text) ? '' : ' – back said: ' + b.text.replace(/\s+/g, ' ').slice(0, 200)}` };
    });
    await scenario('browse: a long Wikipedia article – facts by eval, the whole text by read full', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://en.wikipedia.org/wiki/Alan_Turing' });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 160) };
      const born = lastVal(await tool('browser', { action: 'eval', script: 'const r = [...document.querySelectorAll(".infobox tr")].find((tr) => /Born/.test(tr.textContent)); return r ? r.textContent.replace(/\\s+/g, " ").trim().slice(0, 120) : null' }));
      const full = await tool('browser', { action: 'read', full: true, max_chars: 2000 });
      const len = Number((full.text.match(/of (\d[\d,]*) characters|textLen\D*(\d+)|(\d[\d,]{3,}) characters/) || []).slice(1).find(Boolean)?.replace(/,/g, '') || 0);
      return { pass: /1912/.test(String(born)) && full.ok, detail: `born: "${String(born).slice(0, 80)}"; read full ok=${full.ok ? 1 : 0}${len ? `, ${len} characters` : ''}: ${full.text.split('\n')[0].slice(0, 100)}` };
    });
    await scenario('browse: redirects end on the right address', async () => {
      const r = await tool('browser', { action: 'open', url: 'https://httpbin.org/redirect/3' });
      return { pass: r.ok && /httpbin\.org\/get/.test(r.text), detail: r.ok ? `ended on ${(r.text.match(/https:\/\/httpbin\.org\/\S+/) || ['?'])[0]}` : r.text.slice(0, 160) };
    });
    await scenario('browse: an error page says its HTTP status', async () => {
      const r = await tool('browser', { action: 'open', url: 'https://httpbin.org/status/404' });
      return { pass: !r.ok && /404/.test(r.text), detail: `ok=${r.ok ? 1 : 0}: ${r.text.split('\n')[0].slice(0, 140)}` };
    });
    await scenario('browse: a slow page (3 s) is waited for', async () => {
      const r = await tool('browser', { action: 'open', url: 'https://httpbin.org/delay/3' });
      return { pass: r.ok && /"url"/.test(r.text), detail: r.ok ? `loaded in ${Math.round(r.ms / 1000)} s` : r.text.slice(0, 160) };
    });
    await scenario('browse: a real form – fields, radio, submit, the server echoes them', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://httpbin.org/forms/post' });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 160) };
      await tool('browser', { action: 'type', selector: 'input[name=custname]', text: 'Ada Lovelace' });
      await tool('browser', { action: 'check', selector: 'input[value=medium]' });
      await tool('browser', { action: 'check', selector: 'input[value=cheese]' });
      const s2 = await tool('browser', { action: 'click', selector: 'button' });
      const ok = /Ada Lovelace/.test(s2.text) && /medium/.test(s2.text) && /cheese/.test(s2.text);
      return { pass: ok, detail: ok ? 'the server got custname, size=medium, topping=cheese' : s2.text.slice(0, 220) };
    });
    await scenario('browse: cookies a site sets can be read', async () => {
      await tool('browser', { action: 'open', url: 'https://httpbin.org/cookies/set?flavour=oat' });
      const c = await tool('browser', { action: 'cookies', op: 'get' });
      return { pass: /flavour/.test(c.text) && /oat/.test(c.text), detail: c.text.split('\n').slice(0, 3).join(' ').slice(0, 160) };
    });
    await scenario('browse: a strict-CSP site still answers eval and lists its elements', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://github.com/' });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 160) };
      const n = (a.text.match(/^\[\d+\] /gm) || []).length;
      const e = await tool('browser', { action: 'eval', script: 'return document.title' });
      return { pass: n > 5 && e.ok && /GitHub/.test(e.text), detail: `${n} elements listed; eval ok=${e.ok ? 1 : 0}: ${String(lastVal(e)).slice(0, 80)}` };
    });
    await put({
      'b/shadow/index.html': PAGE('<my-card></my-card><p id="o">none</p><script>customElements.define("my-card",class extends HTMLElement{connectedCallback(){var r=this.attachShadow({mode:"open"});r.innerHTML="<p>Inside the shadow</p><button id=\\"in\\" style=\\"padding:20px\\">Shadow button</button>";r.getElementById("in").onclick=function(){document.getElementById("o").textContent="shadow clicked"}}})</script>'),
      'b/newtab/index.html': PAGE('<a id="l" href="target.html" target="_blank" style="display:block;padding:20px">Open in a new tab</a><button id="w" style="padding:20px">window.open</button><script>document.getElementById("w").onclick=function(){window.open("target.html?via=open","_blank")}</script>'),
      'b/newtab/target.html': PAGE('<h1>Target page</h1><p id="op"></p><script>document.getElementById("op").textContent=window.opener?"opened by the page":"no opener"</script>'),
      'b/hover/index.html': PAGE('<style>#menu ul{display:none}#menu:hover ul{display:block}</style><div id="menu" style="padding:20px;background:#eee">Products<ul><li><a id="pro" href="pro.html">Pro plan</a></li></ul></div>'),
      'b/hover/pro.html': PAGE('<h1>Pro plan page</h1>'),
      'b/listbox/index.html': PAGE('<div id="dd" role="combobox" tabindex="0" style="padding:16px;border:1px solid #888;margin:20px">Choose a colour</div><div id="lb" role="listbox" style="display:none;margin:0 20px;border:1px solid #888"><div role="option" style="padding:12px">Red</div><div role="option" style="padding:12px">Green</div><div role="option" style="padding:12px">Blue</div></div><p id="o">none</p><script>var lb=document.getElementById("lb");document.getElementById("dd").onclick=function(){lb.style.display="block"};lb.addEventListener("click",function(e){var o=e.target.closest("[role=option]");if(!o)return;document.getElementById("o").textContent="picked "+o.textContent;document.getElementById("dd").textContent=o.textContent;lb.style.display="none"})</script>'),
      'b/dl/index.html': PAGE('<a id="d" download="report.csv" href="report.csv" style="display:block;padding:20px">Download the report</a><a id="b" download="hello.txt" href="data:text/plain,hello%20there" style="display:block;padding:20px">Download hello</a><button id="x" style="padding:20px">Export CSV</button><script>document.getElementById("x").onclick=function(){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["n,sq\\n3,9\\n"],{type:"text/csv"}));a.download="export.csv";a.click()}</script>'),
      'b/dl/report.csv': 'a,b\n1,2\n',
    });
    await scenario('browse: a button inside shadow DOM is listed and clicked', async () => {
      const a = await tool('browser', { action: 'open', url: '/workspace/b/shadow/index.html' });
      const listed = /Shadow button/.test(a.text);
      const read = /Inside the shadow/.test(a.text);
      const c = await tool('browser', { action: 'click', selector: listed ? 'text=Shadow button' : 'my-card' });
      const t = await textOf('#o');
      return { pass: listed && read && t === 'shadow clicked', detail: `button ${listed ? 'listed' : 'NOT listed'}; text ${read ? 'read' : 'NOT read'}; after click "${t}"${c.ok ? '' : ' | ' + c.text.slice(0, 100)}` };
    });
    await scenario('browse: a target=_blank link and window.open open a tab of their own (window.open keeps its opener)', async () => {
      await tool('browser', { action: 'open', url: '/workspace/b/newtab/index.html' });
      const a = await tool('browser', { action: 'click', selector: '#l' });
      const one = /Target page/.test(a.text) && /opened a new tab/.test(a.text);
      await tool('browser', { action: 'tabs', op: 'close' });
      const b = await tool('browser', { action: 'click', selector: '#w' });
      const two = /Target page/.test(b.text) && /via=open/.test(b.text) && /opened by the page/.test(b.text);
      const l = await tool('browser', { action: 'tabs' });
      const listed = /2 tabs/.test(l.text);
      const back = await tool('browser', { action: 'tabs', op: 'switch', index: 0 });
      const home = /Open in a new tab/.test(back.text);
      return { pass: one && two && listed && home, detail: `target=_blank → ${one ? 'new tab' : 'not a new tab: ' + a.text.split('\n')[0].slice(0, 80)}; window.open → ${two ? 'new tab with its opener' : 'no: ' + b.text.split('\n')[0].slice(0, 80)}; tabs ${listed ? 'listed 2' : 'NOT 2: ' + l.text.slice(0, 80)}; switch back ${home ? 'ok' : 'failed'}` };
    });
    await scenario('browse: Tab moves the focus and Backspace deletes (a real key, or done by hand)', async () => {
      await put({ 'b/keys/index.html': PAGE('<input id="a" value="abc" style="padding:12px"><input id="b" style="padding:12px">') });
      await tool('browser', { action: 'open', url: '/workspace/b/keys/index.html' });
      await tool('browser', { action: 'press', selector: '#a', key: 'End' });
      await tool('browser', { action: 'press', key: 'Backspace' });
      const v = await tool('browser', { action: 'get', selector: '#a', property: 'value' });
      await tool('browser', { action: 'press', key: 'Tab' });
      const f = await tool('browser', { action: 'eval', script: 'document.activeElement.id' });
      const del = /"ab"/.test(v.text);
      const moved = /"b"/.test(f.text);
      return { pass: del && moved, detail: `Backspace → ${del ? 'deleted' : v.text.slice(-40)}; Tab → ${moved ? 'focus on #b' : f.text.slice(-40)}` };
    });
    await scenario('browse: a menu that only shows on hover', async () => {
      await tool('browser', { action: 'open', url: '/workspace/b/hover/index.html' });
      const h = await tool('browser', { action: 'hover', selector: '#menu' });
      const shown = /Pro plan/.test(h.text);
      const c = await tool('browser', { action: 'click', selector: '#pro' });
      return { pass: shown && /Pro plan page/.test(c.text), detail: `after hover the link is ${shown ? 'listed' : 'NOT listed'}; click → ${/Pro plan page/.test(c.text) ? 'Pro plan page' : c.text.split('\n')[0].slice(0, 100)}` };
    });
    await scenario('browse: a custom dropdown (role=listbox)', async () => {
      await tool('browser', { action: 'open', url: '/workspace/b/listbox/index.html' });
      const a = await tool('browser', { action: 'click', selector: '#dd' });
      const opts = /option "Green"/.test(a.text);
      await tool('browser', { action: 'click', selector: 'role=option[name="Green"]' });
      const t = await textOf('#o');
      return { pass: opts && t === 'picked Green', detail: `options ${opts ? 'listed' : 'NOT listed'} after opening; "${t}"` };
    });
    await scenario('browse: downloads land in the workspace', async () => {
      await tool('browser', { action: 'open', url: '/workspace/b/dl/index.html' });
      const out = [];
      for (const [sel, want, body] of [['#d', 'report.csv', 'a,b'], ['#b', 'hello.txt', 'hello there'], ['#x', 'export.csv', 'n,sq']]) {
        const r = await tool('browser', { action: 'click', selector: sel });
        const path = (r.text.match(/saved as \/workspace\/(\S+?)\.(?=\s|$)/) || [])[1];
        const got = path ? file(path) : null;
        out.push({ want, path, ok: !!got && got.includes(body), note: (r.text.match(/The page (downloaded|tried)[^\n]*/) ||['no download note'])[0].slice(0, 110) });
      }
      return { pass: out.every((o) => o.ok), detail: out.map((o) => `${o.want}: ${o.ok ? o.path : o.note}`).join('; ') };
    });

    // 10. a web page saved as a PDF: a page of ours, a long article, and Notion (an app that scrolls inside a box)
    const keep = async (name, bytes) => {
      try {
        const { Capacitor, registerPlugin } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        let b = '';
        for (let i = 0; i < bytes.length; i += 32768) b += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
        await registerPlugin('SelfTest').keep({ name, base64: btoa(b) });
      } catch {
        /* only for looking at by hand */
      }
    };
    /** how much of a preview picture is not white (0–1): a blank page is ~0 */
    const ink = async (url) => {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const cv = document.createElement('canvas');
      cv.width = 120;
      cv.height = Math.round((120 * bmp.height) / bmp.width);
      const g = cv.getContext('2d');
      g.drawImage(bmp, 0, 0, cv.width, cv.height);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
      return n / (d.length / 4);
    };
    const pdfOf = async (label, r) => {
      const path = (r.text.match(/as \/workspace\/(output\/pdf\/\S+?\.pdf)/) || [])[1];
      const f = path && w.files[path];
      const pages = Number((r.text.match(/: (\d+) pages?,/) || [])[1] || 0);
      const pics = r.images || [];
      const inks = [];
      for (const im of pics) {
        inks.push(Math.round((await ink(im.url)) * 1000) / 10);
        await keep(`${label}-${String(im.path).replace(/\D+/g, '_')}.jpg`, Uint8Array.from(atob(im.url.split(',')[1]), (c) => c.charCodeAt(0)));
      }
      if (f) await keep(`${label}.pdf`, f.data);
      const head = f ? td.decode(f.data.subarray(0, 5)) : '';
      return { path, pages, isPdf: head === '%PDF-', bytes: f?.data.byteLength || 0, inks, note: r.text.split('\n').filter((l) => /scrolls inside|Went through|Warning|empty page/.test(l)).join(' ').slice(0, 200) };
    };
    await put({
      'b/pdf/index.html': PAGE(
        '<style>h2{break-before:page}section{padding:20px}</style>' +
          ['Introduction', 'Method', 'Results', 'Discussion'].map((h, i) => `<section><h2>${i + 1}. ${h}</h2>${'<p>' + 'This paragraph of the report has enough words to fill lines on a printed page. '.repeat(6) + '</p>'.repeat(1)}`.repeat(1) + '<p>'.repeat(0) + Array.from({ length: 6 }, () => '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '.repeat(5) + '</p>').join('') + '</section>').join(''),
      ),
    });
    await scenario('pdf: a page of ours becomes a multi-page PDF', async () => {
      await tool('browser', { action: 'open', url: '/workspace/b/pdf/index.html' });
      const r = await tool('browser', { action: 'pdf', name: 'report' });
      if (!r.ok) return { pass: false, detail: r.text.slice(0, 200) };
      const o = await pdfOf('ours', r);
      return { pass: o.isPdf && o.pages >= 4 && o.inks.every((x, i) => x > (i === o.inks.length - 1 ? 0.2 : 1)), detail: `${o.path}: ${o.pages} pages, ${Math.round(o.bytes / 1024)} KB, ink per preview ${o.inks.join('/')}%` };
    });
    await scenario('pdf: a long Wikipedia article', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://en.wikipedia.org/wiki/Alan_Turing' });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 120) };
      const r = await tool('browser', { action: 'pdf' });
      if (!r.ok) return { pass: false, detail: r.text.slice(0, 200) };
      const o = await pdfOf('wikipedia', r);
      return { pass: o.isPdf && o.pages > 8 && o.inks.every((x, i) => x > (i === o.inks.length - 1 ? 0.2 : 1)) && Number((o.note.match(/first \((\d+) screen/) || [])[1]) > 3, detail: `${o.pages} pages, ${Math.round(o.bytes / 1024)} KB, ink ${o.inks.join('/')}%; ${o.note}` };
    });
    await scenario('pdf: a Notion page (scrolls inside a box, loads blocks as you scroll)', async () => {
      const a = await tool('browser', { action: 'open', url: 'https://notion.notion.site/Vision-Mission-75555f93bcea423cb672ebd102791fa0', wait_ms: 4000 });
      if (!a.ok) return { pass: false, detail: 'open: ' + a.text.slice(0, 120) };
      await tool('browser', { action: 'wait_for', ms: 2000 });
      const full = await tool('browser', { action: 'read', full: true, max_chars: 400 });
      const textLen = Number((full.text.match(/(\d[\d,]{2,}) characters/) || [])[1]?.replace(/,/g, '') || 0);
      const r = await tool('browser', { action: 'pdf', name: 'notion' });
      if (!r.ok) return { pass: false, detail: r.text.slice(0, 200) };
      const o = await pdfOf('notion', r);
      return { pass: o.isPdf && o.pages >= 2 && o.inks.every((x, i) => x > (i === o.inks.length - 1 ? 0.2 : 1)), detail: `${o.pages} pages, ${Math.round(o.bytes / 1024)} KB, ink ${o.inks.join('/')}%; page text ${textLen} chars; ${o.note}` };
    });

    // 11. how long each tool takes, as the agent sees it (the whole call: the harness, the tool, the evidence line):
    //     5 runs each – the first (cold) apart, then the median and the slowest of the rest
    const timeTool = async (label, name, args, n = 5) => {
      const ms = [];
      let fails = 0;
      for (let i = 0; i < n; i++) {
        const a = typeof args === 'function' ? args(i) : args;
        const r = await tool(name, a);
        if (!r.ok) fails++;
        ms.push(r.ms);
      }
      const rest = ms.slice(1).sort((a, b) => a - b);
      return { label, first: ms[0], p50: rest[Math.floor((rest.length - 1) / 2)], max: rest[rest.length - 1], fails };
    };
    const timingLine = (rows) => rows.map((r) => `${r.label} ${r.first}/${r.p50}/${r.max}${r.fails ? ` (${r.fails} failed)` : ''}`).join('; ');
    const timingScenario = (label, make) =>
      scenario(`timing: ${label} (ms: first/median/slowest)`, async () => {
        const rows = [];
        for (const [l, name, args, n] of make()) rows.push(await timeTool(l, name, args, n));
        return { pass: rows.every((r) => !r.fails), detail: timingLine(rows) };
      });
    await put({
      'timing/a.txt': Array.from({ length: 200 }, (_, i) => `line ${i} of a plain text file for timing`).join('\n'),
      'timing/index.html': PAGE('<button id="b" onclick="document.getElementById(\'o\').textContent=\'clicked \'+Date.now()">Go</button><p id="o">idle</p>' + '<p>filler text</p>'.repeat(40)),
    });
    await timingScenario('files', () => [
      ['read_file', 'read_file', { path: 'timing/a.txt' }],
      ['write_file', 'write_file', (i) => ({ path: `timing/w${i}.txt`, content: 'x'.repeat(2000) })],
      ['edit_file', 'edit_file', (i) => ({ path: 'timing/a.txt', old_text: `line ${i + 1} of`, new_text: `line ${i + 1} OF` })],
      ['list_files', 'list_files', { path: 'timing' }],
      ['glob_files', 'glob_files', { pattern: '**/*.txt' }],
      ['grep_files', 'grep_files', { pattern: 'line 1\\d\\d' }],
    ]);
    await timingScenario('shell and code', () => [
      ['shell echo', 'shell', { command: 'echo hi' }],
      ['shell ls+wc', 'shell', { command: 'ls /workspace/timing | wc -l' }],
      ['run_python', 'run_python', { code: 'print(sum(range(1000)))' }],
      ['run_script 1 call', 'run_script', { code: 'print((await tools.read_file({ path: "timing/a.txt" })).ok)' }],
      ['run_script 5 calls', 'run_script', { code: 'for (let i = 0; i < 5; i++) await tools.list_files({ path: "timing" }); print("ok")' }],
    ]);
    await timingScenario('browser', () => [
      ['open', 'browser', { action: 'open', url: '/workspace/timing/index.html' }],
      ['read', 'browser', { action: 'read' }],
      ['click', 'browser', { action: 'click', selector: '#b' }],
      ['get', 'browser', { action: 'get', property: 'text', selector: '#o' }],
      ['eval', 'browser', { action: 'eval', script: 'return document.title' }],
      ['screenshot', 'browser', { action: 'screenshot' }],
      ['preview_page', 'preview_page', { path: 'timing/index.html', view: 'mobile' }],
    ]);
    // 12. the browser waits for a page to be done after an action, not a fixed time: content a click fetches, a change
    //     a moment later, a link to another page, a page that never holds still (each right with no wait_for, and quick)
    await put({
      'wait/later.html': PAGE(`<button id="b" onclick="setTimeout(function(){document.getElementById('o').textContent='changed later'},250)">Go</button><p id="o">idle</p>`),
      'wait/fetch.html': PAGE(`<button id="b" onclick="fetch('https://httpbin.org/delay/1').then(function(r){return r.json()}).then(function(){document.getElementById('o').textContent='loaded from the network'},function(e){document.getElementById('o').textContent='fetch failed '+e})">Go</button><p id="o">idle</p>`),
      'wait/xhr.html': PAGE(`<button id="b" onclick="var x=new XMLHttpRequest();x.open('GET','https://httpbin.org/delay/1');x.onload=function(){document.getElementById('o').textContent='xhr loaded'};x.onerror=function(){document.getElementById('o').textContent='xhr failed'};x.send()">Go</button><p id="o">idle</p>`),
      'wait/busy.html': PAGE(`<p id="t">0</p><button id="b" onclick="document.getElementById('o').textContent='clicked'">Go</button><p id="o">idle</p><script>var n=0;setInterval(function(){document.getElementById('t').textContent=++n},50)</script>`),
      'wait/link.html': PAGE(`<a id="a" href="two.html">to page two</a>`),
      'wait/two.html': PAGE(`<h1>Page two</h1><p id="o">arrived</p>`),
      'wait/late.html': PAGE(`<p id="o">loading…</p><script>setTimeout(function(){fetch('data.json').then(function(r){return r.json()}).then(function(j){document.getElementById('o').textContent=j.msg})},300)</script>`),
      'wait/data.json': JSON.stringify({ msg: 'filled in after load' }),
      'wait/fade.html': PAGE(`<div id="f" style="opacity:0;transition:opacity .7s">fading</div><p id="o">idle</p><script>requestAnimationFrame(function(){requestAnimationFrame(function(){var f=document.getElementById('f');f.addEventListener('transitionend',function(){document.getElementById('o').textContent='faded in'});f.style.opacity=1})})</script>`),
    });
    const waitCase = (name, url, act, want, maxMs) =>
      scenario(`wait: ${name}`, async () => {
        const o = await tool('browser', { action: 'open', url });
        if (!o.ok) return { pass: false, detail: 'open: ' + o.text.slice(0, 120) };
        globalThis.__ocmSettleLog = [];
        const c = act ? await tool('browser', act) : o;
        const slog = globalThis.__ocmSettleLog.join(' | ').slice(0, 500);
        globalThis.__ocmSettleLog = null;
        const g = await tool('browser', { action: 'get', property: 'text', selector: '#o' });
        const got = (g.text.match(/(changed later|loaded from the network|fetch failed[^\n]*|xhr loaded|xhr failed|clicked|arrived|filled in after load|faded in|loading…|idle)/) || [])[1] || g.text.slice(0, 80);
        const ms = act ? c.ms : o.ms;
        return { pass: c.ok && got === want && ms <= maxMs, detail: `${act ? act.action : 'open'} took ${ms} ms (at most ${maxMs}); then #o said "${got}"; probes: ${slog}` };
      });
    await waitCase('a click that changes the page 250 ms later', '/workspace/wait/later.html', { action: 'click', selector: '#b' }, 'changed later', 1000);
    await waitCase('a click whose text comes from a 1 s fetch', '/workspace/wait/fetch.html', { action: 'click', selector: '#b' }, 'loaded from the network', 3500);
    await waitCase('a click whose text comes from a 1 s XHR', '/workspace/wait/xhr.html', { action: 'click', selector: '#b' }, 'xhr loaded', 3500);
    await waitCase('a click on a page that never stops changing', '/workspace/wait/busy.html', { action: 'click', selector: '#b' }, 'clicked', 1800);
    await waitCase('a link to another page', '/workspace/wait/link.html', { action: 'click', selector: '#a' }, 'arrived', 2500);
    await waitCase('a page that fetches its text 300 ms after it loads', '/workspace/wait/late.html', null, 'filled in after load', 2500);
    await waitCase('a page that fades in over 0.7 s (a CSS transition)', '/workspace/wait/fade.html', null, 'faded in', 2500);
    await timingScenario('real sites', () => [
      ['open wikipedia article', 'browser', { action: 'open', url: 'https://en.m.wikipedia.org/wiki/Hypertext' }],
      ['read', 'browser', { action: 'read', max_chars: 2000 }],
      ['open httpbin html', 'browser', { action: 'open', url: 'https://httpbin.org/html' }],
      ['back', 'browser', { action: 'back' }],
    ]);
    await timingScenario('network', () => [
      ['fetch_url example.com', 'fetch_url', { urls: ['https://example.com/'] }],
      ['browser open example.com', 'browser', { action: 'open', url: 'https://example.com/' }],
    ]);
    await closeBrowser('agentsim-browser');
  } finally {
    await closeBrowser('agentsim-browser').catch(() => {});
    // the shell's copy of the workspace outlives the app's: empty it, so the next run starts from nothing
    await tool('shell', { command: 'pkill -f "python3 server.py" 2>/dev/null; rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true' }).catch(() => {});
    await killShell('chat:' + CONV).catch(() => {});
    await killShell('chat:' + CONV + ':check').catch(() => {}); // the syntax checker's shell
    sandbox.kill?.();
    await deleteWorkspace(CONV).catch(() => {});
  }
  return { ok, fail };
}

