import { test, expect } from './helpers.js';
import { BUILTIN_PERSONAS } from '../../src/personas.js';

// Decision 252: a reply stopped before it reached Claude Code does not make the chat count as "changed" – the session
// goes on, and the message that did not reach it goes with the next one. (Before, every such stop cost a new session
// with a cut-down copy of the chat: slow, and a roleplay lost most of its story.)
const shell = (port) => {
  // the bridge's health check can be held, so a reply can be stopped while it is still "starting Claude Code…"
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).endsWith('/health') && globalThis.__holdHealth) await globalThis.__holdHealth;
    return realFetch(u, o);
  };
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    addListener: async () => ({ remove() {} }),
    kill: async () => {},
    exec: async ({ cmd }) => {
      const head = cmd.split('\n')[0];
      if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
      if (head === '# ocm-claude start') {
        const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
        await realFetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
        return { output: `@@PORT ${port}\n`, exit: 0 };
      }
      return { output: '', exit: 0 };
    },
  };
};
const MIRA = { id: 'p_mira', name: 'Mira', rp: true, cardMode: true, prompt: '', card: { name: 'Mira', description: 'Mira guards the old library.', first_mes: '*looks up* We are closed.' } };
test.use({ appSettings: { personas: [...BUILTIN_PERSONAS.map((p) => ({ ...p, builtin: true })), MIRA] } });

test('a reply stopped before it reached Claude Code: the same session goes on, and the stopped message goes with the next one', async ({ app }) => {
  await app.addInitScript(shell, 41800);
  await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const t = q.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put({ id: 'rp1', title: 'Library', personaId: 'p_mira', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'assistant', personaId: 'p_mira', greeting: true, content: '*looks up* We are closed.', at: Date.now() }] }); t.oncomplete = res; }; }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]').click());
  await app.evaluate(() => [...document.querySelectorAll('.conv-item')].find((x) => x.textContent.includes('Library'))?.click());
  await app.evaluate(() => document.body.classList.contains('drawer-open') && document.getElementById('scrim').click());
  await app.evaluate(() => document.querySelector('#model-btn').click());
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
  const reply = app.locator('.msg.assistant').last();
  const turn = async (t) => {
    await app.fill('#input', t);
    await app.click('#send-btn');
    await expect(reply).toContainText('Echo from s', { timeout: 30000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    return reply.innerText();
  };
  const first = await turn('echo one');
  const sid = /Echo from (s\d+)/.exec(first)[1];

  // the next one is stopped while Claude Code is still being checked: it never reaches the session
  await app.evaluate(() => {
    globalThis.__holdHealth = new Promise((r) => (globalThis.__releaseHealth = r));
  });
  await app.fill('#input', 'echo two (stopped)');
  await app.click('#send-btn');
  await expect(reply).toContainText('starting Claude Code', { timeout: 15000 });
  await app.click('#send-btn'); // ■ Stop
  await expect(reply).toContainText('stopped before it was sent', { timeout: 15000 });
  await app.evaluate(() => {
    globalThis.__releaseHealth();
    globalThis.__holdHealth = null;
  });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

  const third = await turn('echo three');
  expect(third).toContain(`Echo from ${sid}`); // the same session, not a new one
  expect(third).not.toContain('A new Claude Code session');
  expect(third).toContain('Earlier message of mine that did not reach you'); // the stopped one went along
  // …and only once: the turn after it does not repeat it
  const fourth = await turn('echo four');
  expect(fourth).toContain(`Echo from ${sid}`);
  expect(fourth).not.toContain('did not reach you');
});

// Decision 253: asking again for the last reply (Retry) copies the session to just before that message (ACP
// session/fork at the cursor Claude Code announced for it) – the story goes on as real turns, not as a new session
// given a copy of the chat as text.
test('Retry on a Claude Code roleplay reply forks the session before the message, with the earlier turns, no new session', async ({ app }) => {
  await app.addInitScript(shell, 41801);
  await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const t = q.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put({ id: 'rp1', title: 'Library', personaId: 'p_mira', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'assistant', personaId: 'p_mira', greeting: true, content: '*looks up* We are closed.', at: Date.now() }] }); t.oncomplete = res; }; }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]').click());
  await app.evaluate(() => [...document.querySelectorAll('.conv-item')].find((x) => x.textContent.includes('Library'))?.click());
  await app.evaluate(() => document.body.classList.contains('drawer-open') && document.getElementById('scrim').click());
  await app.evaluate(() => document.querySelector('#model-btn').click());
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
  const reply = app.locator('.msg.assistant').last();
  const done = async () => {
    await expect(reply).toContainText('Echo from s', { timeout: 30000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    return reply.innerText();
  };
  await app.fill('#input', 'echo one');
  await app.click('#send-btn');
  const sid = /Echo from (s\d+)/.exec(await done())[1];
  await app.fill('#input', 'echo two');
  await app.click('#send-btn');
  expect(await done()).toContain(`Echo from ${sid}`);
  await reply.locator('button[aria-label="Retry"]').click();
  await expect(reply).not.toContainText('echo two |', { timeout: 15000 }); // the new attempt replaced it on screen
  const again = await done();
  expect(again).toMatch(new RegExp(`forked from ${sid} with 1 earlier turns`)); // the story so far, as real turns
  expect(again).not.toContain('A new Claude Code session');
  expect(again).not.toContain('Earlier in this chat');
  // a second Retry: the fork's first turn announced no cursor (nothing to anchor it to, as Claude Code), so it goes back to
  // the original session's stored history at the same point – not a new session (decision 255)
  await reply.locator('button[aria-label="Retry"]').click();
  await expect(reply).not.toContainText(`forked from ${sid} with 1 earlier turns | `, { timeout: 15000 }).catch(() => {});
  const third = await done();
  expect(third).toMatch(new RegExp(`forked from ${sid} with 1 earlier turns`));
  expect(third).not.toContain('A new Claude Code session');
  expect(third).not.toContain('Earlier in this chat');
  expect(/Echo from (s\d+)/.exec(third)[1]).not.toBe(/Echo from (s\d+)/.exec(again)[1]); // a fresh copy
  // and it goes on in the forked session
  const forkSid = /Echo from (s\d+)/.exec(third)[1];
  await app.fill('#input', 'echo three');
  await app.click('#send-btn');
  expect(await done()).toContain(`Echo from ${forkSid}`);
});

// Decision 254: a queued message that drains into a long Claude Code reply gives the box back at once – what you type and
// attach while it runs is not put back to the old draft when the reply ends.
test('typing during a queued message\'s Claude Code reply is kept when the reply ends', async ({ app }) => {
  await app.addInitScript(shell, 41802);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#model-btn').click());
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
  const type = (t) =>
    app.evaluate((v) => {
      const i = document.querySelector('#input');
      i.value = v;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, t);
  const allow = () => app.click('#ask-options .menu-item:has-text("Allow")');
  // a reply that waits on a permission question, and a message queued behind it
  await app.fill('#input', 'please edit main.py');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Edit main.py', { timeout: 20000 });
  await type('queued one');
  await app.evaluate(() => document.querySelector('#send-btn').click()); // = queue
  await expect(app.locator('#queue-bar')).toContainText('queued one');
  // the first reply ends; the queued one drains and waits on its own question – meanwhile you type the next message
  await allow();
  await expect(app.locator('.msg.user').last()).toContainText('queued one', { timeout: 20000 });
  await expect(app.locator('#ask-sheet.open')).toContainText('Edit main.py', { timeout: 20000 });
  await type('my next message, typed while it ran');
  await allow();
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await app.waitForTimeout(500);
  await expect(app.locator('#input')).toHaveValue('my next message, typed while it ran');
});

// Decision 257: not only the last one – an older reply asked again, or an older message of yours edited, forks the session
// at the point before that message too, with the turns before it (the later ones are kept as a swipe / a version)
test.describe('going back further in a Claude Code roleplay', () => {
  const open = async (app, port) => {
    await app.addInitScript(shell, port);
    await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const t = q.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put({ id: 'rp1', title: 'Library', personaId: 'p_mira', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'assistant', personaId: 'p_mira', greeting: true, content: '*looks up* We are closed.', at: Date.now() }] }); t.oncomplete = res; }; }));
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => document.querySelector('#menu-btn').click());
    await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]').click());
    await app.evaluate(() => [...document.querySelectorAll('.conv-item')].find((x) => x.textContent.includes('Library'))?.click());
    await app.evaluate(() => document.body.classList.contains('drawer-open') && document.getElementById('scrim').click());
    await app.evaluate(() => document.querySelector('#model-btn').click());
    await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
  };
  const reply = (app) => app.locator('.msg.assistant').last();
  const done = async (app) => {
    await expect(reply(app)).toContainText('Echo from s', { timeout: 30000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    return reply(app).innerText();
  };
  const turn = async (app, t) => {
    await app.fill('#input', t);
    await app.click('#send-btn');
    return done(app);
  };
  const threeTurns = async (app) => {
    const sid = /Echo from (s\d+)/.exec(await turn(app, 'echo one'))[1];
    expect(await turn(app, 'echo two')).toContain(`Echo from ${sid}`);
    expect(await turn(app, 'echo three')).toContain(`Echo from ${sid}`);
    return sid;
  };

  test('Retry on an older reply forks the session before the message it answered', async ({ app }) => {
    await open(app, 41803);
    const sid = await threeTurns(app);
    // the reply to "echo two": the second of the three
    const older = app.locator('.msg.assistant').nth(1);
    await expect(older).toContainText('echo two |');
    await older.locator('button[aria-label="Retry"]').click();
    await expect(app.locator('.msg.user')).toHaveCount(2, { timeout: 15000 }); // "echo three" and its reply went to the old version
    const again = await done(app);
    expect(again).toContain('echo two |');
    expect(again).toMatch(new RegExp(`forked from ${sid} with 1 earlier turns`)); // "echo one" and its reply, as real turns
    expect(again).not.toContain('A new Claude Code session');
    expect(again).not.toContain('Earlier in this chat');
  });

  test('editing an older message of yours forks the session before it, and the story goes on from there', async ({ app }) => {
    await open(app, 41804);
    const sid = await threeTurns(app);
    await app.locator('.msg.user').nth(1).locator('button[aria-label="Edit"]').click();
    await expect(app.locator('#input')).toHaveValue('echo two');
    await app.fill('#input', 'echo two, said another way');
    await app.click('#send-btn');
    await expect(app.locator('.msg.user')).toHaveCount(2, { timeout: 15000 });
    const edited = await done(app);
    expect(edited).toContain('echo two, said another way |');
    expect(edited).toMatch(new RegExp(`forked from ${sid} with 1 earlier turns`));
    expect(edited).not.toContain('A new Claude Code session');
    const forkSid = /Echo from (s\d+)/.exec(edited)[1];
    expect(forkSid).not.toBe(sid);
    // and it goes on in the fork; editing the last message again goes back to the same point once more
    expect(await turn(app, 'echo four')).toContain(`Echo from ${forkSid}`);
    await app.locator('.msg.user').last().locator('button[aria-label="Edit"]').click();
    await app.fill('#input', 'echo four, again');
    await app.click('#send-btn');
    const last = await done(app);
    expect(last).toContain('echo four, again |');
    expect(last).not.toContain('A new Claude Code session');
    expect(last).toMatch(/forked from s\d+ with 2 earlier turns/);
  });
});
