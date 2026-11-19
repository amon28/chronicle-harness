import { test, expect, lastRequest } from './helpers.js';

// A shell job that outlives the reply tells the chat when it ends (decision 199), instead of being polled
test.use({ appSettings: { prefs: { tools: true, toolShell: true, agentMode: 'auto' } } });

test('a long build ends after the reply: the chat gets the exit code and the last lines, and the assistant goes on', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShellSoftMs = 150;
    let manifest = '';
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
      exec: async ({ cmd }) => {
        if (cmd.includes("cat > '/usr/local/bin/.toolkit'")) {
          manifest = [...cmd.matchAll(/^([0-9a-f]{64})  (job|doctor|toolkit-pull)$/gm)].map((m) => m[1] + '  ' + m[2]).join('\n');
          return { output: '', exit: 0 };
        }
        if (cmd.includes("sha256sum 'job'")) return { output: manifest, exit: manifest ? 0 : 1 };
        if (cmd.includes('make build')) return new Promise((res) => (globalThis.__finish = () => res({ output: 'compiling…\nBUILD OK\n', exit: 0 })));
        return { output: '', exit: 0 };
      },
      kill: async () => {},
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'DOCALLS [["shell",{"command":"make build"}]]');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && typeof globalThis.__finish === 'function', null, { timeout: 20000 });
  const first = await lastRequest(request);
  expect(JSON.stringify(first.messages)).toContain('Chronicle sends you a message when it ends');
  await app.evaluate(() => globalThis.__finish());
  await expect.poll(async () => JSON.stringify((await lastRequest(request)).messages), { timeout: 20000 }).toContain('BUILD OK');
  const req = await lastRequest(request);
  const note = req.messages.filter((m) => m.role === 'user').at(-1).content;
  expect(String(note)).toMatch(/^\[Message from the Chronicle app, not from the user\] Your shell job job_\w+ finished with exit code 0/);
  expect(String(note)).toContain('make build');
});
