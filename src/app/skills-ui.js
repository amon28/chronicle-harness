// Settings › Tools & agent › 📚 Skills: list, edit, create, import and export skills; start a chat with the Skill Creator.
import { saveSettings } from '../store.js';
import { builtinFor } from '../personas.js';
import { looksText, bytesToText } from '../sandbox.js';
import { newSkill, skillFromFiles, skillToMd, slugName, SKILL_NAME } from '../skills.js';
import { uninstallPack } from '../packs.js';
import { importPluginZip } from './packs-ui.js';
import { newChat, openSheet, setMode } from './chatlist.js';
import { $, appMode, el, state, toast } from './core.js';
import { shareBytes } from './extras.js';
import { setChatPersona } from './render.js';

const list = () => (state.settings.agentSkills ||= []);
const save = () => saveSettings(state.settings);

function render() {
  const box = $('#askill-list');
  box.innerHTML = '';
  const sk = list();
  $('#askill-count').textContent = sk.length ? `${sk.length} skill${sk.length === 1 ? '' : 's'} · the assistant sees each name and description, and loads the full instructions when a task matches` : 'No skills yet. Make one with the Skill Creator, create one by hand, or import a SKILL.md / .zip.';
  // the skills of one pack or Claude plugin are one group (switched on/off and removed together), each still listed
  const groups = new Map();
  for (const k of [...sk].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!k.pack) box.append(item(k));
    else groups.set(k.pack, [...(groups.get(k.pack) || []), k]);
  }
  for (const [id, ks] of [...groups].sort((a, b) => packName(a[0]).localeCompare(packName(b[0])))) box.append(group(id, ks));
}

const packOf = (id) => (state.settings.packs || []).find((p) => p.id === id);
const packName = (id) => packOf(id)?.name || id;
function group(id, ks) {
  const p = packOf(id);
  const name = packName(id);
  const d = el('details', 'skill-group');
  d.open = true;
  const sum = el('summary');
  const on = el('input');
  on.type = 'checkbox';
  const n = ks.filter((k) => k.enabled !== false).length;
  on.checked = n > 0;
  on.indeterminate = n > 0 && n < ks.length;
  on.setAttribute('aria-label', `Switch all of ${name} on or off`);
  on.onclick = (e) => e.stopPropagation();
  on.onchange = () => {
    for (const k of ks) k.enabled = on.checked;
    save();
    render();
  };
  sum.append(on, el('span', 'skill-group-title', `${name} – ${ks.length} skill${ks.length === 1 ? '' : 's'}`), el('span', 'persona-desc', [p?.kind === 'claude-plugin' ? '🧩 Claude plugin' : '📦 pack', p?.version, p?.author].filter(Boolean).join(' · ')));
  d.append(sum);
  for (const k of ks) d.append(item(k));
  const row = el('div', 'row gap-sm wrap');
  const rm = el('button', 'danger-btn small', `Remove ${name}`);
  rm.onclick = () => {
    if (!confirm(`Remove “${name}” and everything it installed (its skills, snippets, personas and MCP servers)?`)) return;
    const c = uninstallPack(state.settings, id);
    save();
    render();
    toast(`Removed ${name} (${c} item${c === 1 ? '' : 's'})`);
  };
  row.append(rm);
  d.append(row);
  return d;
}

function item(k) {
  const d = el('details', 'skill-item');
  const sum = el('summary');
  const on = el('input');
  on.type = 'checkbox';
  on.checked = k.enabled !== false;
  on.onclick = (e) => e.stopPropagation();
  on.onchange = () => ((k.enabled = on.checked), save());
  sum.append(on, el('span', 'slash-cmd', k.name), el('span', 'persona-desc', k.description));
  d.append(sum);
  const desc = el('input', 'field');
  desc.value = k.description;
  desc.maxLength = 600;
  const ins = el('textarea', 'field');
  ins.rows = 12;
  ins.value = k.instructions;
  const files = el('div', 'hint');
  const fileNames = Object.keys(k.files || {});
  files.textContent = fileNames.length ? `Files: ${fileNames.join(', ')}` : 'No extra files.';
  const row = el('div', 'row gap-sm wrap');
  const sv = el('button', 'primary-btn small', 'Save');
  sv.onclick = () => {
    if (!desc.value.trim() || !ins.value.trim()) return toast('A skill needs a description and instructions');
    Object.assign(k, { description: desc.value.trim(), instructions: ins.value.trim(), updatedAt: Date.now() });
    save();
    toast('Saved');
    render();
  };
  const ex = el('button', 'ghost-btn small', '⤴ Export');
  ex.onclick = async () => {
    try {
      if (!fileNames.length) return await shareBytes(`${k.name}.SKILL.md`, new TextEncoder().encode(skillToMd(k)));
      const { zipSync } = await import('fflate');
      const enc = (s) => new TextEncoder().encode(s);
      const z = { [`${k.name}/SKILL.md`]: enc(skillToMd(k)) };
      for (const [p, c] of Object.entries(k.files)) z[`${k.name}/${p}`] = enc(c);
      await shareBytes(`${k.name}.zip`, zipSync(z));
    } catch (e) {
      if (!/cancel/i.test(e.message || '')) toast('Could not export: ' + e.message);
    }
  };
  const del = el('button', 'danger-btn small', 'Delete');
  del.onclick = () => {
    if (!confirm(`Delete the skill “${k.name}”?`)) return;
    state.settings.agentSkills = list().filter((x) => x !== k);
    save();
    render();
  };
  row.append(sv, ex, del);
  d.append(el('div', 'label', 'Description'), desc, el('div', 'label', 'Instructions'), ins, files, row);
  return d;
}

export function openSkillsManager() {
  render();
  openSheet('#settings-sheet', false);
  openSheet('#askills-sheet', true);
}
$('#open-askills').onclick = openSkillsManager;

$('#askill-make').onclick = () => {
  if (!state.settings.personas.some((p) => p.id === 'skill-creator')) {
    const b = builtinFor('skill-creator');
    if (b) state.settings.personas.push({ ...b, avatar: { ...b.avatar }, builtin: true });
    save();
  }
  openSheet('#askills-sheet', false);
  if (appMode === 'rp') setMode('chat');
  newChat();
  setChatPersona('skill-creator');
  $('#input').focus();
};

$('#askill-new').onclick = () => {
  const f = $('#askill-form');
  f.hidden = !f.hidden;
  if (!f.hidden) $('#askill-name').focus();
};
$('#askill-create').onclick = () => {
  const name = slugName($('#askill-name').value);
  const description = $('#askill-desc').value.trim();
  const instructions = $('#askill-ins').value.trim();
  if (!SKILL_NAME.test(name)) return toast('Name: lowercase words joined by hyphens, e.g. meeting-notes');
  if (!description || !instructions) return toast('Add a description and instructions');
  if (list().some((k) => k.name === name)) return toast('A skill with that name already exists');
  list().push(newSkill({ name, description, instructions, files: {} }));
  save();
  for (const id of ['askill-name', 'askill-desc', 'askill-ins']) $('#' + id).value = '';
  $('#askill-form').hidden = true;
  render();
  toast(`Created “${name}”`);
};

/** Files → skills: a lone SKILL.md, or a zip holding one or more skill folders. */
async function importFiles(files) {
  let added = 0;
  let handed = 0;
  const problems = [];
  for (const f of files) {
    try {
      const entries = {};
      if (/\.zip$/i.test(f.name)) {
        const { unzipSync } = await import('fflate');
        const all = unzipSync(new Uint8Array(await f.arrayBuffer()));
        // a whole Claude plugin: reviewed and installed as one group in the Packs sheet
        if (Object.keys(all).some((p) => /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(p))) {
          openSheet('#askills-sheet', false);
          importPluginZip(f);
          handed++;
          continue;
        }
        for (const [p, data] of Object.entries(all)) if (data.length && looksText(data) && !/(^|\/)(__MACOSX|\.)/.test(p)) entries[p] = bytesToText(data);
      } else entries['SKILL.md'] = await f.text();
      const roots = Object.keys(entries).filter((p) => /(^|\/)skill\.md$/i.test(p));
      if (!roots.length) throw new Error('no SKILL.md inside');
      for (const md of roots) {
        const base = md.includes('/') ? md.slice(0, md.lastIndexOf('/') + 1) : '';
        const sub = Object.fromEntries(Object.entries(entries).filter(([p]) => p.startsWith(base)));
        const s = skillFromFiles(sub, f.name.replace(/\.(zip|md|txt)$/i, '').replace(/\.skill$/i, ''));
        const existing = list().find((k) => k.name === s.name);
        if (existing) Object.assign(existing, { ...s, updatedAt: Date.now() });
        else list().push(newSkill({ ...s, source: 'import' }));
        added++;
      }
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
    }
  }
  if (added) save();
  render();
  if (!added && handed && !problems.length) return;
  toast(added ? `Imported ${added} skill${added === 1 ? '' : 's'}${problems.length ? ` (${problems.length} failed)` : ''}` : `Could not import – ${problems[0] || 'nothing found'}`, 5000);
}
$('#askill-import').onclick = () => $('#askill-file').click();
$('#askill-plugin').onclick = () => {
  openSheet('#askills-sheet', false);
  $('#settings-packs').click();
};
$('#askill-file').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
};
