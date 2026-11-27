import { test, expect, send } from './helpers.js';

// Decision 218: Export everything (keys, git histories, the app's own lists, and the Linux home folder as a second
// file), then Restore with Replace and Import Linux home on the new app.
test('export everything, then bring it all back with Replace; the Linux home goes out and comes back through Linux', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__cmds = [];
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      exec: async ({ cmd }) => {
        globalThis.__cmds.push(cmd);
        if (/@@STARTED/.test(cmd)) return { output: '@@STARTED\n', exitCode: 0 };
        if (/home\.exit/.test(cmd) && /@@RUN/.test(cmd)) return { output: '@@EXIT 0 4096\n', exitCode: 0 };
        return { output: '', exitCode: 0 };
      },
      kill: async () => {},
      addListener: async () => ({ remove() {} }),
    };
    globalThis.__exported = [];
    globalThis.__ocmPhoneFolder = {
      exportLinuxFile: async (o) => (globalThis.__exported.push(o), { name: o.name, folder: 'Download/Chronicle', bytes: 4096 }),
      pickIntoLinux: async (o) => (globalThis.__picked = o.guest, { bytes: 4096, name: 'chronicle-linux-home.tar.gz' }),
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await send(app, 'hello move');
  const id = await app.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => res(r.result); });
    const convs = await new Promise((res) => { const q = globalThis.__ocmChatsReq(); q.onsuccess = () => res(q.result); });
    await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put({ objects: { abc: new Uint8Array([7, 8]) }, head: 'abc' }, 'git:' + convs[0].id); t.oncomplete = res; });
    localStorage.setItem('ocm.usageLog', '[{"t":42}]');
    return convs[0].id;
  });
  app.on('dialog', (d) => d.accept());
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  const [download] = await Promise.all([app.waitForEvent('download'), app.click('#move-export')]);
  const { readFileSync } = await import('node:fs');
  const zipBytes = readFileSync(await download.path());
  expect(download.suggestedFilename()).toMatch(/^chronicle-everything-\d{4}-\d{2}-\d{2}\.zip$/);
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(zipBytes));
  const data = JSON.parse(strFromU8(files['backup.json']));
  expect(data.everything).toBe(true);
  expect(data.settings.apiKey).toBe('good'); // the key is in it
  expect(Object.keys(files)).toContain(`extra/kv/${encodeURIComponent('git:' + id)}.json`);
  expect(JSON.parse(strFromU8(files['extra/local.json']))['ocm.usageLog']).toBe('[{"t":42}]');
  await expect(app.locator('#move-status')).toContainText('Everything exported', { timeout: 20000 });
  await expect(app.locator('#move-status')).toContainText('Linux home folder: chronicle-linux-home-');
  const ex = await app.evaluate(() => globalThis.__exported);
  expect(ex[0].guest || ex[0]).toBeTruthy();
  const cmds = await app.evaluate(() => globalThis.__cmds.join('\n'));
  expect(cmds).toMatch(/tar -czpf/);
  expect(cmds).toMatch(/--exclude='\\''\.\/\.claude\/\.credentials\.json'\\''/); // Claude Code's sign-in stays in Linux

  // "the new app": empty, then Restore with Replace
  await app.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const t = db.transaction(['conversations', 'kv'], 'readwrite'); t.objectStore('conversations').clear(); t.objectStore('kv').delete(`git:${(location.hash, '')}`); t.oncomplete = res; });
    for (const k of Object.keys(localStorage)) if (k === 'ocm.usageLog') localStorage.removeItem(k);
  });
  await app.setInputFiles('#backup-file', { name: 'chronicle-everything.zip', mimeType: 'application/zip', buffer: zipBytes });
  await expect(app.locator('#restore-info')).toContainText('on a new app choose Replace');
  // the app reloads itself a moment after a restore: wait for that new page, not the old one
  await Promise.all([app.waitForEvent('load', { timeout: 20000 }), app.click('#restore-replace')]);
  await app.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  const back = await app.evaluate(async (id) => {
    const db = await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => res(r.result); });
    const git = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('git:' + id); q.onsuccess = () => res(q.result); });
    const convs = await new Promise((res) => { const q = globalThis.__ocmChatsReq(); q.onsuccess = () => res(q.result); });
    return { head: git?.head, bytes: git ? [...git.objects.abc] : null, chats: convs.length, usage: localStorage.getItem('ocm.usageLog') };
  }, id);
  expect(back).toEqual({ head: 'abc', bytes: [7, 8], chats: 1, usage: '[{"t":42}]' });

  // Import Linux home: picked into /var/tmp/chronicle-move, then unpacked into /root
  await app.evaluate(() => {
    document.querySelector('#open-settings').click();
    document.querySelector('.set-item[data-page="data"]').click();
    document.querySelector('#move-linux-import').click();
  });
  await expect(app.locator('#move-status')).toContainText('Linux home folder restored', { timeout: 20000 });
  expect(await app.evaluate(() => globalThis.__picked)).toBe('/var/tmp/chronicle-move/import.tar.gz');
  expect(await app.evaluate(() => globalThis.__cmds.join('\n'))).toMatch(/tar -xzpf "\$1" --no-same-owner/);
});
