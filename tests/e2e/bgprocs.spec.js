import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true, toolShell: true } } });

test('a process the shell left running (nohup … &) shows as a chip; tapping it asks, then stops it', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShellSoftMs = 150;
    globalThis.__stopped = false;
    globalThis.__lists = [];
    let manifest = '';
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
      exec: async ({ id, cmd }) => {
        if (cmd.includes("cat > '/usr/local/bin/.toolkit'")) {
          manifest = [...cmd.matchAll(/^([0-9a-f]{64})  (job|doctor|toolkit-pull)$/gm)].map((m) => m[1] + '  ' + m[2]).join('\n');
          return { output: '', exit: 0 };
        }
        if (cmd.includes("sha256sum 'job'")) return { output: manifest, exit: manifest ? 0 : 1 };
        if (id === 'procs' && cmd.includes('@@END')) {
          globalThis.__lists.push(cmd);
          const rows = ['700\t1\t900\tshell\t/bin/sh'];
          // the first look knows the age; later ones cannot read it (0 s), as on some phones after coming back
          const age = globalThis.__lists.length > 1 ? 0 : 125;
          if (!globalThis.__stopped) rows.push(`701\t700\t${age}\tproc\tsh /tmp/rec/recloop.sh`, '702\t701\t120\tproc\tffmpeg -i http://x/live.flv out.mp4');
          return { output: rows.join('\n') + '\n@@END\n', exit: 0 };
        }
        if (id === 'procs' && cmd.includes('P=701')) {
          globalThis.__stopped = true;
          return { output: '@@STOPPED\n', exit: 0 };
        }
        return { output: '', exit: 0 };
      },
      kill: async () => {},
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // no shell used in this chat yet: nothing is looked for
  await app.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await app.waitForTimeout(300);
  expect(await app.evaluate(() => globalThis.__lists.length)).toBe(0);

  await app.fill('#input', 'DOCALLS [["shell",{"command":"nohup /tmp/rec/recloop.sh >/dev/null 2>&1 &"}]]');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await app.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const chip = app.locator('#jobs-bar .bg-proc');
  await expect(chip).toHaveCount(1); // the loop, not ffmpeg under it
  await expect(chip).toContainText('/tmp/rec/recloop.sh'.replace(/^\/\S*\//, '') || 'recloop');
  await expect(chip.locator('.job-time')).toContainText('2m');
  // back from another app: a new look that cannot tell the age does not reset the clock
  await app.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => app.evaluate(() => globalThis.__lists.length)).toBeGreaterThan(1);
  await app.waitForTimeout(300);
  await expect(chip.locator('.job-time')).toContainText('2m');
  // the chat's shell id is never command text
  expect(await app.evaluate(() => globalThis.__lists[0].includes('chat:'))).toBe(false);
  await chip.click();
  await expect(app.locator('#choose-title')).toContainText('Stop');
  await expect(app.locator('#choose-list')).toContainText('and the 1 process it started');
  await app.locator('#choose-list .menu-item', { hasText: 'Stop it' }).click();
  await expect(app.locator('#toast')).toContainText('Stopped');
  await expect(chip).toHaveCount(0);
});
