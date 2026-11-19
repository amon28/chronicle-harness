// The device self-test's third part: every tool answers (with in-memory stand-ins for your personas, mods, skills and
// schedules, so nothing of yours changes), how fast the common paths are, and how smooth the chat scrolls and streams.
// Run with the app in front (--es selftest 1) and in the background (--es selftest bg): everything but the frame
// timings must pass both ways. Lines go to logcat like the other parts.
import { runTool } from './tools.js';
import { closeBrowser } from './browsercontrol.js';
import { deleteWorkspace, sandbox } from './sandbox.js';
import { killShell } from './shell.js';
import { renderMarkdown } from './markdown.js';

const CONV = 'perfsim';
const td = new TextDecoder();
const now = () => performance.now();
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x) => Math.round(x * 10) / 10;
const frame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** check(pass, name, detail) as in the other parts. → { ok, fail } */
export async function runPerfScenarios(check) {
  let ok = 0;
  let fail = 0;
  // on screen = frames really come (while an agent runs in the background the page is kept "visible" so its timers
  // are not slowed, so visibilityState alone cannot tell)
  const probe = async () => {
    if (document.visibilityState !== 'visible') return false;
    const t0 = now();
    for (let i = 0; i < 5; i++) await Promise.race([frame(), sleep(400)]);
    return (now() - t0) / 5 < 60;
  };
  let onScreen = await probe();
  const shown = () => onScreen;
  const where = onScreen ? 'front' : 'background';
  const report = async (pass, name, detail) => {
    if (pass) ok++;
    else fail++;
    await check(pass, name, String(detail || '').replace(/\s+/g, ' ').slice(0, 600));
  };
  const w = { id: CONV, files: {}, shellState: {} };
  const settings = { agentSkills: [], skills: [], prefs: { pyTimeout: 120 } };
  // ---------- stand-ins for the app's state: kept in memory for this run only ----------
  const people = [{ id: 'p_demo', name: 'Demo Persona', kind: 'persona', prompt: 'You are a demo.', description: 'demo' }];
  const mods = [];
  const schedules = [];
  let goal = null;
  let plan = null;
  let todos = [];
  const asked = [];
  const ctx = {
    convId: CONV,
    browserId: 'perfsim-browser',
    workspace: w,
    vision: true,
    settings,
    phone: { folder: () => null, mode: () => 'auto', link: async () => null },
    todos: { set: (items) => (todos = items) },
    goal: { get: () => goal, set: (g) => (goal = g) },
    schedules: { list: () => schedules, add: (t) => schedules.push(t), remove: (id) => schedules.splice(schedules.findIndex((t) => t.id === id) >>> 0, 1) },
    chats: { list: () => [{ id: 'chat_a', title: 'Trip planning', messages: [{ role: 'user', content: 'Book the train to Kyoto on Friday' }, { role: 'assistant', content: 'Done: the 9:10 train.' }], updatedAt: Date.now() }] },
    planMode: { blocking: () => false, set: (p) => (plan = p) },
    ask: async (q, opts) => (asked.push(q), Array.isArray(q) ? q.map((x) => x.options?.[0] || 'yes') : opts?.[0] || 'yes'),
    creator: {
      list: () => people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, builtin: false, description: p.description || '' })),
      find: (q) => {
        const p = people.find((x) => x.id === q || x.name.toLowerCase() === String(q).toLowerCase());
        return p ? { id: p.id, name: p.name, builtin: false, character: p.kind === 'character' } : null;
      },
      read: (q) => {
        const p = people.find((x) => x.id === q || x.name.toLowerCase() === String(q).toLowerCase());
        return p ? { ...p, builtin: false, character: p.kind === 'character', card: p.card || null, lorebook: null } : null;
      },
      character: async (card, _img, id) => (people.push({ id: id || 'c_' + people.length, name: card.name || card.data?.name || 'card', kind: 'character', card }), { name: card.name || card.data?.name || 'card', updated: !!id }),
      lorebook: async (_t, lb) => ({ entries: (lb.entries || []).length, attached: '' }),
      persona: async (p) => (people.push({ ...p, id: p.id || 'p_' + people.length, kind: 'persona' }), { updated: !!p.id }),
    },
    mods: {
      save: async (m, code) => (mods.push({ ...m, code }), { ok: true, id: m.id, installed: true }),
      list: () => mods.map((m) => ({ id: m.id, name: m.name, version: m.version || '1', enabled: true, permissions: m.permissions || [], running: false, error: '' })),
      read: (id) => mods.find((m) => m.id === id)?.code || null,
    },
    // a helper "model": does the job by calling the real tools, like a sub-agent would
    delegate: async (prompt) => {
      const steps = [];
      const f = /\b([\w./-]*PROGRESS[\w.-]*\.md)\b/.exec(prompt)?.[1];
      if (f) {
        await runTool({ name: 'write_file', arguments: JSON.stringify({ path: f, content: 'round done\nSTATUS: DONE\n', overwrite: true }) }, ctx);
        steps.push({ name: 'write_file' });
      } else {
        const r = await runTool({ name: 'list_files', arguments: '{}' }, ctx);
        steps.push({ name: 'list_files', status: r.ok ? 'ok' : 'error' });
      }
      return { text: 'Finished: looked at the workspace.', steps };
    },
    describeImages: async (imgs) => ({ text: `(${imgs.length} image${imgs.length === 1 ? '' : 's'} described)`, model: 'stand-in' }),
    forkContext: () => 'user: earlier message',
    reloadTools: async () => ({ defs: [], route: {}, errors: [] }),
    onSkillsChanged: () => {},
    onStatus: () => {},
  };
  const tool = async (name, args, ms = 90000) => {
    const t0 = now();
    let r;
    try {
      r = await Promise.race([runTool({ name, arguments: JSON.stringify(args) }, ctx), sleep(ms).then(() => ({ ok: false, result: `no answer within ${ms / 1000} s`, hung: true }))]);
    } catch (e) {
      r = { ok: false, result: 'threw: ' + String(e?.message || e), threw: true };
    }
    r.ms = Math.round(now() - t0);
    r.text = String(r.result || '');
    return r;
  };
  const file = (p) => (w.files[p] ? td.decode(w.files[p].data) : null);

  try {
    // ---------- 1. every tool answers ----------
    // a real 8×8 PNG, written by Python (view_images needs a bitmap)
    const PNG_PY = [
      'import zlib, struct, os',
      'def ch(t, d):',
      "    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)",
      "raw = b''.join(b'\\x00' + b'\\xff\\x00\\x00' * 8 for _ in range(8))",
      "os.makedirs('/workspace/pics', exist_ok=True)",
      "open('/workspace/pics/dot.png', 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 8, 8, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))",
      "print('ok')",
    ].join('\n');
    await tool('run_python', { code: PNG_PY });
    await tool('write_file', { path: 'notes/a.md', content: '# A\nalpha needle\n' });
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Test Card', description: 'A test.', first_mes: 'Hi.', personality: '', scenario: '', mes_example: '' } };
    const T = [
      ['glob_files', { pattern: '**/*.md' }, (r) => r.ok && /notes\/a\.md/.test(r.text)],
      ['view_images', { paths: ['pics/dot.png'] }, (r) => r.ok && (r.images?.length === 1 || /described|Showing/.test(r.text))],
      ['todo_write', { items: [{ text: 'step one', status: 'in_progress' }, { text: 'step two', status: 'pending' }] }, (r) => r.ok && todos.length === 2],
      ['ask_user', { question: 'Pick one', options: ['red', 'blue'] }, (r) => r.ok && /red/.test(r.text) && asked.length > 0],
      ['doctor', {}, (r) => r.ok || /surface|network|shell/i.test(r.text)],
      ['reload_tools', {}, (r) => !r.threw && !r.hung],
      ['delegate', { task: 'List the workspace files and say how many there are.', tools: 'read' }, (r) => r.ok && /Finished/.test(r.text)],
      ['search_chats', { query: 'Kyoto' }, (r) => r.ok && /Trip planning|chat_a/.test(r.text)],
      ['read_chat', { id: 'chat_a' }, (r) => r.ok && /Kyoto/.test(r.text)],
      ['propose_plan', { title: 'Tidy notes', steps: ['read notes', 'merge them'] }, (r) => r.ok && plan?.status === 'approved'],
      ['goal', { action: 'set', text: 'Ship the notes page' }, (r) => r.ok && !!goal],
      ['goal', { action: 'done', summary: 'notes page written and read back' }, (r) => r.ok],
      ['schedule_task', { action: 'add', prompt: 'check the build', in_minutes: 30 }, (r) => r.ok && schedules.length === 1],
      ['schedule_task', { action: 'list' }, (r) => r.ok && /check the build/.test(r.text)],
      ['ralph_loop', { task: 'Write the notes summary.', max_rounds: 2, steps_per_round: 5 }, (r) => r.ok && /DONE|finished|done/i.test(r.text)],
      ['list_personas', {}, (r) => r.ok && /Demo Persona/.test(r.text)],
      ['read_persona', { persona: 'Demo Persona' }, (r) => r.ok && /demo/i.test(r.text)],
      ['save_persona', { name: 'Perf Helper', prompt: 'You help with performance.' }, (r) => r.ok && people.some((p) => p.name === 'Perf Helper')],
      ['save_character', { card }, (r) => r.ok && people.some((p) => p.kind === 'character')],
      ['save_lorebook', { name: 'Test Lore', lorebook: { entries: [{ keys: ['kyoto'], content: 'A city.' }] } }, (r) => r.ok && /1 entr/.test(r.text)],
      ['save_mod', { id: 'perf-mod', name: 'Perf mod', description: 'test', permissions: [], code: 'export default { tools: [] }' }, (r) => !r.threw && mods.length === 1],
      ['list_mods', {}, (r) => r.ok && /perf-mod/.test(r.text)],
      ['read_mod', { id: 'perf-mod' }, (r) => r.ok && /export default/.test(r.text)],
      ['save_skill', { name: 'perf-skill', description: 'test skill', instructions: 'Do the thing.' }, (r) => r.ok && settings.agentSkills.length === 1],
      ['use_skill', { name: 'perf-skill' }, (r) => r.ok && /Do the thing/.test(r.text)],
      ['save_tool', { name: 'add_two', description: 'adds', code: 'def run(a=0, b=0):\n    return a + b\n' }, (r) => r.ok && settings.skills.length === 1],
      ['tool_add_two', { a: 2, b: 3 }, (r) => r.ok && /\b5\b/.test(r.text)],
      ['phone_folder', { action: 'status' }, (r) => !r.threw && !r.hung],
      ['phone_list', {}, (r) => !r.ok && /folder|link/i.test(r.text)],
      ['phone_read', { path: 'x.txt' }, (r) => !r.ok && /folder|link/i.test(r.text)],
      ['phone_write', { path: 'x.txt', content: 'x' }, (r) => !r.ok && /folder|link/i.test(r.text)],
      ['phone_import', { path: 'x.txt' }, (r) => !r.ok && /folder|link/i.test(r.text)],
      ['phone_delete', { path: 'x.txt' }, (r) => !r.ok && /folder|link/i.test(r.text)],
      ['fetch_url', { urls: ['https://example.com/'] }, (r) => r.ok && /Example Domain/i.test(r.text)],
      ['web_search', { query: 'Android WebView user activation' }, (r) => (r.ok && r.text.length > 200) || /key|provider|search/i.test(r.text)],
      ['screenshot_page', { url: 'https://example.com/', view: 'mobile' }, (r) => r.ok && /\/workspace\/output\/screenshots\//.test(r.text)],
    ];
    for (const [name, args, good] of T) {
      const r = await tool(name, args);
      const pass = !r.threw && !r.hung && good(r);
      await report(pass, `tools (${where}): ${name}`, `${r.ok ? 'ok=1' : 'ok=0'} ${r.ms} ms – ${r.text.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 220)}`);
    }
    await closeBrowser('perfsim-browser').catch(() => {});

    // ---------- 2. speed of the common paths ----------
    {
      const n = 300;
      const t0 = now();
      for (let i = 0; i < n; i++) await tool('write_file', { path: `bulk/d${i % 10}/f${i}.txt`, content: `line one\nfile ${i}\n${i % 50 === 0 ? 'needle here\n' : ''}${'x'.repeat(400)}\n` });
      const per = (now() - t0) / n;
      const g = await tool('grep_files', { pattern: 'needle', path: 'bulk' });
      const gl = await tool('glob_files', { pattern: 'bulk/**/*.txt' });
      const ls = await tool('list_files', { path: 'bulk' });
      const rd = await tool('read_file', { path: 'bulk/d0/f0.txt' });
      const hits = (g.text.match(/f\d+\.txt/g) || []).length;
      await report(per < 40 && g.ms < 1500 && gl.ms < 800 && hits >= 6 && rd.ms < 300, `perf (${where}): files`, `write ${r1(per)} ms/file (${n}); grep ${g.ms} ms (${hits} hits); glob ${gl.ms} ms; list ${ls.ms} ms; read ${rd.ms} ms`);
    }
    {
      const times = [];
      for (let i = 0; i < 8; i++) times.push((await tool('shell', { command: 'echo hi' })).ms);
      const py = [];
      for (let i = 0; i < 3; i++) py.push((await tool('run_python', { code: 'print(1+1)' })).ms);
      await report(pct(times, 50) < 600 && pct(py.slice(1), 50) < 1500, `perf (${where}): shell and python round trip`, `shell p50 ${pct(times, 50)} ms, max ${Math.max(...times)} ms; python first ${py[0]} ms, then ${py.slice(1).join(', ')} ms`);
    }
    {
      // the app must stay responsive while a tool produces a lot: the longest the event loop was held up
      let last = now();
      let worst = 0;
      const beat = setInterval(() => {
        const t = now();
        worst = Math.max(worst, t - last - 20);
        last = t;
      }, 20);
      const big = await tool('shell', { command: 'seq 1 300000' });
      const md = await tool('read_file', { path: 'bulk/d0/f0.txt' });
      const toolStall = worst;
      // the same output straight from the shell plugin (no tool layer), and the page parsing a string that size
      worst = 0;
      last = now();
      const { runShell } = await import('./shell.js');
      const t1 = now();
      const raw = await runShell('seq 1 300000', { id: 'chat:' + CONV, timeoutMs: 60000 });
      const rawMs = Math.round(now() - t1);
      const rawStall = worst;
      worst = 0;
      await sleep(60);
      last = now();
      const t2 = now();
      JSON.parse(JSON.stringify({ data: raw.output || '' }));
      const parseMs = Math.round(now() - t2);
      // where the time goes: each step of the tool layer, alone, with the longest stall around it
      const steps = [];
      const step = async (name, fn) => {
        await sleep(40);
        worst = 0;
        last = now();
        const a = now();
        await fn();
        steps.push(`${name} ${Math.round(now() - a)}/${Math.round(worst)}`);
      };
      const { plain, clipOutput } = await import('./shell.js');
      const { spillText, spillName } = await import('./context.js');
      const { wsPut, wsDelete } = await import('./sandbox.js');
      const { collectShell, mountSpec, prepareShell } = await import('./bridge.js');
      const { sha256Hex } = await import('./hash.js');
      const out = raw.output || '';
      let sp = '';
      await step('plain', () => plain(out));
      await step('clip', () => clipOutput(out, 400000));
      await step('spillPut', () => (sp = wsPut(w, spillName('diag'), out, { by: 'the app' })));
      await step('spillText', () => spillText(out, sp));
      await step('sha256', () => sha256Hex(out));
      const mount = await mountSpec(ctx, CONV);
      await step('prepare', () => prepareShell({ w, ctx, convId: CONV, mount }));
      await step('collect', () => collectShell({ w, ctx, convId: CONV, mode: 'auto', mounted: !!mount.workHost }));
      await step('shell true', () => tool('shell', { command: 'true' }));
      if (sp) wsDelete(w, sp);
      await step('shell true (no big file)', () => tool('shell', { command: 'true' }));
      clearInterval(beat);
      worst = toolStall;
      big.text += ` [steps ms/stall: ${steps.join(', ')}]`;
      big.text += ` [plugin alone: ${rawMs} ms, stall ${Math.round(rawStall)} ms; ${(raw.output || '').length} chars; JSON round trip ${parseMs} ms]`;
      await report(big.ok && worst < (shown() ? 400 : 1500), `perf (${where}): app stays responsive during a huge output`, `seq 300000 in ${big.ms} ms; longest stall ${Math.round(worst)} ms${md.ok ? '' : ' (read failed)'}${(big.text.match(/\[plugin alone[^\]]*\]/) || [''])[0]}${(big.text.match(/\[steps[^\]]*\]/) || [''])[0]}`);
    }
    {
      const doc = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nSome **bold** text, a [link](https://example.com/${i}) and \`code\`.\n\n- item a\n- item b\n\n\`\`\`js\nfunction f${i}(x) {\n  return x * ${i}; // comment\n}\n\`\`\`\n\n| a | b |\n|---|---|\n| ${i} | ${i * 2} |\n`).join('\n');
      const t0 = now();
      const html = renderMarkdown(doc);
      const full = now() - t0;
      // streaming: the reply arrives 24 characters at a time and is drawn after each piece, as the chat does
      const sh = globalThis.__ocmRenderTest?.streamingHtml;
      const per = [];
      let codeTail = [];
      if (sh) {
        const msg = { role: 'assistant', content: '', streaming: true };
        for (let i = 24; i <= doc.length; i += 24) {
          msg.content = doc.slice(0, i);
          const a = now();
          sh(msg);
          per.push(now() - a);
        }
        // the worst case: a long code block still open at the end
        const code = '```python\n' + Array.from({ length: 800 }, (_, i) => `x${i} = ${i}  # value`).join('\n');
        const m2 = { role: 'assistant', content: '', streaming: true };
        for (let i = 24; i <= code.length; i += 24) {
          m2.content = code.slice(0, i);
          const a = now();
          sh(m2);
          codeTail.push(now() - a);
        }
      }
      await report(
        full < 600 && (!sh || (pct(per, 95) < 16 && pct(codeTail, 95) < 25)),
        `perf (${where}): markdown and streaming`,
        `${Math.round(doc.length / 1024)} KB rendered in ${Math.round(full)} ms (${Math.round(html.length / 1024)} KB html); streaming ${per.length} pieces p50 ${r1(pct(per, 50))} ms p95 ${r1(pct(per, 95))} ms max ${r1(Math.max(0, ...per))} ms; open code block p95 ${r1(pct(codeTail, 95))} ms max ${r1(Math.max(0, ...codeTail))} ms${sh ? '' : ' (stream renderer not reachable)'}`,
      );
    }

    // ---------- 2b. a reply with many tool calls folds them into step boxes ----------
    const node = globalThis.__ocmRenderTest?.messageNode;
    if (node) {
      const call = (name, args, status = 'done') => ({ id: Math.random().toString(36).slice(2), name, arguments: JSON.stringify(args), status, result: 'ok', display: { ms: 400 } });
      const names = ['browser', 'browser', 'run_python', 'write_file', 'run_python', 'browser', 'browser', 'browser', 'browser', 'browser', 'edit_file'];
      const m = { role: 'assistant', content: 'Done.', at: Date.now(), streaming: false,
        rounds: [{ content: 'Building the page.', calls: names.slice(0, 5).map((n) => call(n, { action: 'open', path: 'site/index.html' })) },
          { content: '', calls: names.slice(5).map((n, i) => call(n, { action: 'click', path: 'site/index.html' }, i === 5 ? 'error' : 'done')) },
          { content: 'One more check.', calls: [call('browser', { action: 'screenshot' })] }] };
      const live = { ...m, streaming: true, content: '', rounds: [{ content: '', calls: [call('browser', { action: 'open' }), call('run_python', {}), call('browser', { action: 'click', selector: '#go' }, 'running')] }] };
      try {
        const a = node(m, 0);
        const groups = [...a.querySelectorAll('.tool-group')];
        const loose = a.querySelectorAll('.msg-col > .tool-card').length;
        const head = groups[0]?.querySelector('summary')?.textContent || '';
        const b = node(live, 0);
        const now = b.querySelector('.tool-group .tg-now')?.textContent || '';
        await report(
          groups.length === 1 && groups[0].querySelectorAll('.tool-card').length === 11 && loose === 1 && /11 steps/.test(head) && /browser ×7/i.test(head) && /1 failed/.test(head) && /click #go/.test(now),
          `ui (${where}): tool calls fold into step boxes`,
          `${groups.length} box(es); header "${head.replace(/\s+/g, ' ').trim()}"; ${loose} lone card after the text; while running: "${now}"`,
        );
      } catch (e) {
        await report(false, `ui (${where}): tool calls fold into step boxes`, String(e?.message || e));
      }
    }

    // ---------- 2c. the workspace files page with a big workspace (a throwaway chat, removed afterwards) ----------
    {
      const ID = 'perfsim-wsm';
      try {
        const sb = await import('./sandbox.js');
        const wsm = await import('./app/wsmanager.js');
        const w = await sb.getWorkspace(ID);
        const t = Date.now();
        for (let i = 0; i < 3000; i++) sb.wsPut(w, `site/page-${String(i).padStart(4, '0')}.html`, `<p>${i}</p>`);
        for (let i = 0; i < 40; i++) sb.wsPut(w, `.out/r-${i}.txt`, 'x');
        for (const f of Object.values(w.files)) f.mtime = t;
        sb.saveWorkspace(w);
        const t0 = now();
        await sb.workspaceSummaries();
        const tSum = now() - t0;
        const t1 = now();
        await wsm.openWorkspaceManager(ID);
        const tOpen = now() - t1;
        const list = document.querySelector('#wsm-list');
        const top = [...list.querySelectorAll('.wsm-row')].length; // the chat's root: "site" and nothing else (.out is hidden)
        const hid = /app's own files/.test(list.textContent);
        list.querySelector('.wsm-open')?.click(); // into site/
        await new Promise((r) => setTimeout(r, 300));
        const t2 = now();
        const rows = list.querySelectorAll('.wsm-row').length;
        const more = list.querySelector('.wsm-more')?.textContent || '';
        list.querySelector('.wsm-more')?.click();
        await new Promise((r) => setTimeout(r, 300));
        const rows2 = list.querySelectorAll('.wsm-row').length;
        const tMore = now() - t2 - 300;
        const s = document.querySelector('#wsm-search');
        s.value = 'page-29';
        const t3 = now();
        s.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 400));
        const found = list.querySelectorAll('.wsm-row').length;
        const tSearch = now() - t3 - 180;
        s.value = '';
        s.dispatchEvent(new Event('input'));
        document.querySelector('#wsm-sheet [data-close]')?.click();
        await report(
          top === 1 && hid && rows === 60 && /more/.test(more) && rows2 === 120 && found === 60 && tOpen < 800,
          `ui (${where}): workspace files page with 3040 files`,
          `index ${Math.round(tSum)} ms, open ${Math.round(tOpen)} ms; root ${top} row + hidden files button ${hid}; site/ ${rows} rows then ${rows2} ("${more}", ${Math.round(tMore)} ms); search "page-29" ${found} rows shown in ~${Math.round(tSearch)} ms`,
        );
      } catch (e) {
        await report(false, `ui (${where}): workspace files page with 3040 files`, String(e?.stack || e).slice(0, 300));
      } finally {
        await deleteWorkspace(ID).catch(() => {});
      }
    }

    // ---------- 3. smoothness: a long chat scrolled, a reply streamed, frame by frame (only on screen) ----------
    onScreen = await probe();
    if (!shown()) {
      await report(true, `ui (${where}): frame timings SKIPPED`, 'the app is not on screen, so nothing is drawn – run with --es selftest 1 for these');
    } else if (!node) {
      await report(false, `ui (${where}): chat renderer`, 'the message renderer is not reachable');
    } else {
      const box = document.createElement('section');
      box.className = 'messages';
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483000;overflow-y:auto;background:var(--bg,#0b0b0c);padding:12px';
      document.body.append(box);
      try {
        const msgs = [];
        for (let i = 0; i < 200; i++) {
          msgs.push(i % 2 ? { role: 'assistant', content: `Answer ${i}.\n\n- point one\n- point **two**\n\n\`\`\`js\nconst v${i} = ${i};\nconsole.log(v${i});\n\`\`\`\n\nMore text about item ${i} with a [link](https://example.com).`, at: Date.now() } : { role: 'user', content: `Question number ${i}: how does part ${i} work?`, at: Date.now() });
        }
        const t0 = now();
        const frag = document.createDocumentFragment();
        msgs.forEach((m, i) => frag.append(node(m, i)));
        box.append(frag);
        box.getBoundingClientRect();
        const build = now() - t0;
        await frame();
        // scroll from the bottom to the top at about 2000 px a second, as a fast fling would
        box.scrollTop = box.scrollHeight;
        await frame();
        const gaps = [];
        let prev = now();
        const until = prev + 3000;
        while (now() < until && box.scrollTop > 0) {
          box.scrollTop -= 34;
          await frame();
          const t = now();
          gaps.push(t - prev);
          prev = t;
        }
        const fps = gaps.length ? 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
        const janky = gaps.filter((g) => g > 34).length;
        await report(build < 1500 && pct(gaps, 95) < 34 && janky / Math.max(1, gaps.length) < 0.1, `ui (${where}): scrolling a 200-message chat`, `built in ${Math.round(build)} ms (${box.scrollHeight} px tall); ${gaps.length} frames, ${Math.round(fps)} fps, p95 ${r1(pct(gaps, 95))} ms, ${janky} frames over 34 ms, worst ${Math.round(Math.max(0, ...gaps))} ms`);

        // a reply streaming in at about 60 characters a frame while you watch, drawn the way the chat does it: the
        // message node is rebuilt each frame; "reuse" keeps the finished part (the fix), "full" draws it all again
        const text = msgs.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n').slice(0, 30000);
        const patch = globalThis.__ocmRenderTest.patchStreaming;
        const stream = async (reuse) => {
          const live = { role: 'assistant', content: '', streaming: true };
          let cur = node(live, 999);
          box.append(cur);
          const gaps = [];
          let prev = now();
          for (let i = 60; i <= text.length && gaps.length < 400; i += 60) {
            live.content = text.slice(0, i);
            const nx = node(live, 999, reuse ? cur : null);
            if (!(reuse && patch(cur, nx))) {
              cur.replaceWith(nx);
              cur = nx;
            }
            box.scrollTop = box.scrollHeight;
            await frame();
            const t = now();
            gaps.push(t - prev);
            prev = t;
          }
          // what is on screen must be what a fresh drawing of the same text shows
          const same = cur.querySelector('.md')?.textContent === node({ ...live }, 998).querySelector('.md')?.textContent;
          cur.remove();
          gaps.same = same;
          return gaps;
        };
        const sum = (g) => `${g.length} frames, ${Math.round(g.length ? 1000 / (g.reduce((a, b) => a + b, 0) / g.length) : 0)} fps, p95 ${r1(pct(g, 95))} ms, ${g.filter((x) => x > 34).length} over 34 ms, worst ${Math.round(Math.max(0, ...g))} ms`;
        const full = await stream(false);
        const inc = await stream(true);
        const sj = inc.filter((g) => g > 34).length;
        await report(inc.same && pct(inc, 95) < 34 && sj / Math.max(1, inc.length) < 0.1, `ui (${where}): a streaming reply`, `drawn as the chat does now: ${sum(inc)}${inc.same ? '' : ' – TEXT DIFFERS from a fresh drawing'} | redrawn in full (before): ${sum(full)}`);
      } finally {
        box.remove();
      }
    }
  } catch (e) {
    await report(false, 'perf threw', String(e?.message || e));
  } finally {
    await closeBrowser('perfsim-browser').catch(() => {});
    await tool('shell', { command: 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true' }).catch(() => {});
    await killShell('chat:' + CONV).catch(() => {});
    await killShell('chat:' + CONV + ':check').catch(() => {});
    sandbox.kill?.();
    await deleteWorkspace(CONV).catch(() => {});
    void file;
  }
  return { ok, fail };
}
