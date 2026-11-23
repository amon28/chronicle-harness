import { test, expect } from './helpers.js';
import { BUILTIN_PERSONAS } from '../../src/personas.js';

// Decision 238: Claude Code in a one-on-one roleplay. The card's roleplay prompt goes with the session; the world info
// the last messages trigger and the author's note go with each message. Group chats stay without Claude Code.
const shell = (port) => {
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    addListener: async () => ({ remove() {} }),
    kill: async () => {},
    exec: async ({ cmd }) => {
      const head = cmd.split('\n')[0];
      if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
      if (head === '# ocm-claude start') {
        const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
        await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
        return { output: `@@PORT ${port}\n`, exit: 0 };
      }
      return { output: '', exit: 0 };
    },
  };
};
const MIRA = { id: 'p_mira', name: 'Mira', rp: true, cardMode: true, prompt: '', lorebookId: 'lb_t', card: { name: 'Mira', description: 'Mira guards the old library at night.', personality: 'dry, patient', scenario: 'The library at closing time.', first_mes: '*looks up* We are closed.', mes_example: '<START>\n{{user}}: Hello?\n{{char}}: *sighs* Hello.' } };
test.use({
  appSettings: {
    personas: [...BUILTIN_PERSONAS.map((p) => ({ ...p, builtin: true })), MIRA],
    lorebooks: [{ id: 'lb_t', name: 'Things', scanDepth: 4, entries: [{ id: 'le1', name: 'The sword', keys: ['Moonblade'], content: 'The Moonblade is an old sword that hums.', enabled: true }] }],
  },
});

test('a one-on-one roleplay on Claude Code: the card with the session, world info and author\'s note with the message', async ({ app }) => {
  await app.addInitScript(shell, 41791);
  await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const t = q.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put({ id: 'rp1', title: 'Library', personaId: 'p_mira', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'assistant', personaId: 'p_mira', greeting: true, content: '*looks up* We are closed.', at: Date.now() }, { role: 'user', content: 'Please, one minute.', at: Date.now() }, { role: 'assistant', personaId: 'p_mira', content: 'One minute.', at: Date.now() }] }); t.oncomplete = res; }; }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]').click());
  await app.evaluate(() => [...document.querySelectorAll('.conv-item')].find((x) => x.textContent.includes('Library'))?.click());
  await app.evaluate(() => document.body.classList.contains('drawer-open') && document.getElementById('scrim').click());
  await app.evaluate(() => document.querySelector('#model-btn').click());
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
  await expect(app.locator('#model-name')).toContainText('Claude Code');
  // the chat's author's note, as the chat sheet sets it
  await app.evaluate(() => {
    const t = document.getElementById('an-text');
    t.value = 'Keep replies short.';
    t.dispatchEvent(new Event('change'));
  });

  await app.fill('#input', 'I found the Moonblade in the stacks. show-prompt');
  await app.click('#send-btn');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply).toContainText('SESSION<<', { timeout: 30000 });
  const text = await reply.innerText();
  const session = /SESSION<<([\s\S]*)>>MESSAGE<</.exec(text)[1];
  const message = /MESSAGE<<([\s\S]*)>>/.exec(text)[1];
  // the session: plays Mira, with the card – but not the world info, which changes
  expect(session).toContain('This chat is a fiction roleplay, and you play Mira in it.');
  expect(session).toContain('Mira guards the old library at night.');
  expect(session).toContain("Mira's personality: dry, patient");
  expect(session).toContain('Scenario: The library at closing time.');
  expect(session).not.toContain('Moonblade');
  // the message: this turn's world info and the author's note, then what the user wrote
  expect(message).toContain('[Roleplay context for this reply – follow it, never mention it]');
  expect(message).toContain('[World info for this moment]\nThe Moonblade is an old sword that hums.');
  expect(message).toContain("[Author's note: Keep replies short.]");
  expect(message).toContain('I found the Moonblade in the stacks. show-prompt');

  // the prompt inspector shows what went to Claude Code – not a request for the preset's model (decision 241)
  await app.evaluate(() => document.querySelector('#chat-more-btn').click());
  await app.click('#cm-more');
  await app.click('#cm-inspect');
  await expect(app.locator('#insp-meta')).toContainText('Claude Code');
  await expect(app.locator('#insp-meta')).toContainText('A new Claude Code session');
  await expect(app.locator('.insp-msg').last()).toContainText('I found the Moonblade in the stacks.');
  await expect(app.locator('.insp-msg').first()).toContainText('you play Mira');
  await app.click('#insp-tabs [data-insp="next"]');
  await expect(app.locator('#insp-meta')).toContainText('Claude Code');
  await expect(app.locator('#insp-meta')).toContainText('already running');
  await expect(app.locator('.insp-msg').last()).toContainText('(your next message)');
});
