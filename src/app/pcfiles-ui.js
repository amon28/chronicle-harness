// 🗂 Files on my PC (decision 223): Settings › Connections. A computer running scripts/pc-files.py, its address and
// secret; the assistant gets the pc_* tools while one is connected and switched on.
import { $, el, hooks, state, toast, uid } from './core.js';
import { saveSettings } from '../store.js';
import { pcHealth, parsePairing } from '../pcfiles.js';
import { canUseCamera, cameraError, takePhoto } from '../camera.js';
import { decodeQr } from '../qrscan.js';

const pcs = () => (state.settings.pcFiles ||= []);
const summary = (p) => [p.url, p.full ? '⚠ FULL CONTROL (any file, runs commands)' : p.folders?.length ? `shares ${p.folders.join(', ')}` : '', p.full ? '' : p.folders ? (p.write ? 'reads and saves' : 'read-only') : 'not checked yet', p.os].filter(Boolean).join(' · ');

async function check(p, status) {
  status.textContent = `Checking ${p.name}…`;
  try {
    const h = await pcHealth(p);
    Object.assign(p, { folders: h.folders, write: h.write, full: h.full, os: h.os, checkedAt: Date.now() });
    saveSettings(state.settings);
    status.textContent = h.full
      ? `✓ ${p.name}${h.host ? ` (${h.host})` : ''} gives FULL CONTROL: the assistant can reach every file and run commands there (you are asked before each command unless a chat is in Auto or Bypass).`
      : `✓ ${p.name}${h.host ? ` (${h.host})` : ''} shares ${h.folders.join(', ') || 'nothing'} – ${h.write ? 'the assistant can read and save there' : 'read-only'}.`;
    return true;
  } catch (e) {
    status.textContent = `✗ ${e?.message || e}`;
    return false;
  }
}

function render() {
  const list = $('#pcf-list');
  if (!list) return;
  list.innerHTML = '';
  if (!pcs().length) list.append(el('p', 'hint pad', 'No computer connected yet.'));
  for (const p of pcs()) {
    const row = el('div', 'persona-item pcf-item');
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', (p.enabled === false ? '⏸ ' : '') + p.name), el('div', 'persona-desc', summary(p)));
    const test = el('button', 'act', 'Test');
    test.onclick = async () => {
      await check(p, $('#pcf-status'));
      render();
    };
    const onoff = el('button', 'act', p.enabled === false ? 'Turn on' : 'Pause');
    onoff.title = p.enabled === false ? 'Let the assistant use this computer again' : 'Keep it, but the assistant does not get it';
    onoff.onclick = () => {
      p.enabled = p.enabled === false;
      saveSettings(state.settings);
      render();
    };
    const rm = el('button', 'act', 'Remove');
    rm.onclick = () => {
      state.settings.pcFiles = pcs().filter((x) => x !== p);
      saveSettings(state.settings);
      render();
    };
    row.append(t, test, onoff, rm);
    list.append(row);
  }
}

/** A computer from a pairing link (the QR code, a pasted link, a chronicle://pc link opened from elsewhere): checked, then kept. */
async function pair(link, { name = '' } = {}) {
  const pp = parsePairing(link);
  if (!pp) return toast('That is not a pc-files.py QR code or link');
  const box = $('#pcf-box');
  if (box && !box.open) box.open = true;
  // the same computer again (a new secret after it was restarted without --autostart): updated, not added twice
  const same = pcs().find((x) => x.url === pp.url);
  const p = same || { id: 'pc_' + uid().slice(0, 8), enabled: true };
  const before = { ...p };
  Object.assign(p, { url: pp.url, secret: pp.secret, name: same?.name || name || pp.name || 'My PC' });
  if (!same && pcs().some((x) => x.name === p.name)) p.name += ` (${pp.url.replace(/^https?:\/\//, '')})`;
  if (!(await check(p, $('#pcf-status')))) {
    if (same) Object.assign(p, before);
    return;
  }
  if (!same) pcs().push(p);
  saveSettings(state.settings);
  render();
  toast(`${same ? 'Updated' : 'Connected'} ${p.name}`);
}
hooks.pcPair = (url) => {
  // a link from outside the app (another app, a web page) could name any computer: asked first
  const pp = parsePairing(url);
  if (!pp) return toast('That chronicle://pc link is not complete');
  if (!confirm(`Connect Chronicle to the computer "${pp.name || pp.url}" at ${pp.url}? Its files (and, if it allows it, commands) become available to the assistant.`)) return;
  document.querySelector('#open-settings')?.click();
  document.querySelector('.set-item[data-page="connect"]')?.click();
  pair(url);
};

$('#pcf-scan').onclick = async () => {
  try {
    const photo = await takePhoto();
    if (!photo) return;
    $('#pcf-status').textContent = 'Reading the QR code…';
    const text = await decodeQr(photo);
    if (!text) return ($('#pcf-status').textContent = 'No QR code found in the photo – hold the phone steady, closer, with the whole code in view, and try again.');
    await pair(text, { name: $('#pcf-name').value.trim() });
  } catch (e) {
    const why = cameraError(e);
    if (why) $('#pcf-status').textContent = why;
  }
};

$('#pcf-add').onclick = async () => {
  if (parsePairing($('#pcf-url').value)) {
    await pair($('#pcf-url').value, { name: $('#pcf-name').value.trim() });
    $('#pcf-url').value = $('#pcf-secret').value = $('#pcf-name').value = '';
    return;
  }
  const url = $('#pcf-url').value.trim().replace(/\/+$/, '');
  const secret = $('#pcf-secret').value.trim();
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) return toast('Enter the address pc-files.py printed (http://…:8766)');
  if (!secret) return toast('Enter the secret pc-files.py printed');
  const p = { id: 'pc_' + uid().slice(0, 8), name: $('#pcf-name').value.trim() || 'My PC', url, secret, enabled: true };
  if (pcs().some((x) => x.name === p.name)) return toast(`There is already a computer called ${p.name} – give this one another name`);
  // checked before it is kept: a wrong address or secret is said now, not in the middle of a chat
  if (!(await check(p, $('#pcf-status')))) return;
  pcs().push(p);
  saveSettings(state.settings);
  $('#pcf-url').value = $('#pcf-secret').value = $('#pcf-name').value = '';
  render();
};
$('#pcf-box').addEventListener('toggle', () => {
  if (!$('#pcf-box').open) return;
  $('#pcf-scan').hidden = !canUseCamera();
  render();
});
