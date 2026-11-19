import { test, expect } from './helpers.js';

// Docker Hub, as it answers for Debian's image (decision 190)
const dockerHub = async (app) => {
  // GitHub (the first source) does not answer here: the install falls back to Docker Hub
  await app.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '404: Not Found' }));
  await app.route('https://auth.docker.io/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'tok' }), headers: { 'access-control-allow-origin': '*' } }));
  await app.route('https://registry-1.docker.io/**', (r) => {
    const u = r.request().url();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    if (u.endsWith('/manifests/trixie-slim')) return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ manifests: [{ digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } }] }) });
    if (u.endsWith('/manifests/sha256:arm')) return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: 30000000, digest: 'sha256:' + 'c'.repeat(64) }] }) });
    return r.fulfill({ status: 404, headers: cors, body: '' });
  });
};
const fakeShell = (start = {}) => {
  let st = { available: true, installed: false, ...start };
  const listeners = {};
  globalThis.__installs = [];
  globalThis.__ocmShell = {
    status: async () => st,
    install: async (img) => {
      globalThis.__installs.push(img);
      listeners.install?.({ phase: 'download', pct: 40 });
      st = { ...st, installed: true, distro: 'debian' };
    },
    exec: async ({ cmd }) => {
      listeners.out?.({ id: 'terminal', data: `ran: ${cmd}\n` });
      return { output: /apt-get install/.test(cmd) ? '@@SETUP_OK\n' : `ran: ${cmd}\n`, exit: 0 };
    },
    kill: async () => {},
    uninstall: async () => (st = { ...st, installed: false }),
    addListener: async (name, fn) => {
      listeners[name] = fn;
      return { remove() {} };
    },
  };
};

test('Linux terminal: install Debian, run a command, see its output', async ({ app }) => {
  await app.addInitScript(fakeShell);
  await dockerHub(app);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-terminal').click());
  await expect(app.locator('#term-install-btn')).toBeVisible();
  await app.click('#term-install-btn');
  await expect(app.locator('#term-in')).toBeVisible();
  await app.fill('#term-in', 'echo hi');
  await app.click('#term-run');
  await expect(app.locator('#term-out')).toContainText('$ echo hi');
  await expect(app.locator('#term-out')).toContainText('ran: echo hi');
  // the image Docker Hub named, its SHA-256 and the sign-in for the first request only
  expect(await app.evaluate(() => globalThis.__installs)).toEqual([{ url: 'https://registry-1.docker.io/v2/library/debian/blobs/sha256:' + 'c'.repeat(64), sha256: 'c'.repeat(64), size: 30000000, auth: 'Bearer tok' }]);
});

test('an Alpine from before can be switched to Debian (decision 190)', async ({ app }) => {
  await app.addInitScript(fakeShell, { installed: true, distro: 'alpine' });
  await dockerHub(app);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  app.on('dialog', (d) => d.accept());
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-terminal').click());
  await expect(app.locator('#term-status')).toContainText('Ready (Alpine)');
  await app.locator('#term-switch').click();
  await expect(app.locator('#term-switch')).toBeHidden({ timeout: 10000 });
  expect(await app.evaluate(() => globalThis.__installs.length)).toBe(1);
});

test('a failed install says why, and the reason stays on screen and in the error log (decision 190)', async ({ app }) => {
  await app.addInitScript(fakeShell);
  await app.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }));
  await app.route('https://auth.docker.io/**', (r) => r.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-terminal').click());
  await app.click('#term-install-btn');
  await expect(app.locator('#term-status')).toContainText("Install failed: Could not find Debian's image – GitHub: the image list answered 404; Docker Hub: Docker Hub's download limit");
  await app.waitForTimeout(600);
  await expect(app.locator('#term-status')).toContainText('Install failed'); // not written over
  await expect(app.locator('#term-install-btn')).toBeVisible();
  expect(await app.evaluate(() => localStorage.getItem('ocm.errlog') || '')).toMatch(/Install failed: Could not find Debian/);
});
