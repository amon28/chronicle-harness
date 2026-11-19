import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true, toolShell: true } } });

test('a slow command comes back as a job handle, and shell_job reports how it ended', async ({ app }) => {
  await app.addInitScript(() => {
    // the app's own soft deadline is 30 s; a test cannot wait that long
    globalThis.__ocmShellSoftMs = 150;
    let manifest = '';
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
      exec: ({ cmd }) => {
        // the toolkit install carries its manifest; answer the verification with the same hashes
        if (cmd.includes("cat > '/usr/local/bin/.toolkit'")) {
          manifest = [...cmd.matchAll(/^([0-9a-f]{64})  (job|doctor|toolkit-pull)$/gm)].map((m) => m[1] + '  ' + m[2]).join('\n');
          return Promise.resolve({ output: '', exit: 0 });
        }
        if (cmd.includes("sha256sum 'job'")) return Promise.resolve({ output: manifest, exit: manifest ? 0 : 1 });
        // the command comes after a line that marks its start (for the timeout's reaper)
        if (cmd.replace(/^\{ read -r ocm_up[^\n]*\n/, '') === 'sleep 45; echo ok') return new Promise((resolve) => setTimeout(() => resolve({ output: 'ok\n', exit: 0 }), 400));
        return Promise.resolve({ output: '', exit: 0 });
      },
      kill: async () => {},
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');

  await app.fill('#input', 'SHELLJOB build the audio and tell me when it is done');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

  const cards = app.locator('.tool-card');
  await expect(cards).toHaveCount(2);

  // the first answer is a handle, not a timeout: it says what is still running and how to follow it
  await expect(cards.nth(0)).toContainText('still running');
  await expect(cards.nth(0)).toContainText('shell_job');
  await expect(cards.nth(0)).toContainText('surface=linux-shell');

  // the second one is the honest end of it: exit code, output and the evidence
  await expect(cards.nth(1)).toContainText('Shell job');
  await expect(cards.nth(1)).toContainText('DONE exit=0');
  await expect(cards.nth(1)).toContainText('surface=linux-shell');
  await expect(app.locator('.msg.assistant').last()).toContainText('finished cleanly');
});

test('doctor is offered to the assistant and reports each surface it exercised', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
      exec: async ({ cmd }) => (cmd === 'doctor 2>&1' ? { output: 'kernel   Linux 6.1 aarch64\nffmpeg   MISSING', exit: 0 } : { output: '', exit: 0 }),
      kill: async () => {},
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');

  await app.fill('#input', 'DOCTORME before we start');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

  const card = app.locator('.tool-card').first();
  await expect(card).toContainText('Checked the machine');
  await expect(card).toContainText('shell');
  await expect(card).toContainText('ffmpeg   MISSING');
  await expect(card).toContainText('surface=harness');
});
