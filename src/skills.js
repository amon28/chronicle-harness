import { applyEdits } from './codeedit.js';
// Skills: reusable instruction packages (a SKILL.md with a name + description, plus optional reference files).
// The model sees only each skill's name and description; when a task matches, it calls use_skill to load the full
// instructions (and the skill's files land in /workspace/skills/<name>/).
import { wsPut } from './sandbox.js';
import { sha256Hex } from './hash.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;
const MAX_FILE = 200000;
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

import modsGuide from '../docs/MODS.md?raw';
import harnessGuide from '../docs/HARNESS.md?raw';
import playbook from '../docs/PLAYBOOK.md?raw';

/** Skills that ship with the app (added once; you can edit or delete them). */
export const BUILTIN_SKILLS = [{ name: 'chronicle-mods', description: 'How to write Chronicle mods: the file format, permissions and the mod API (tools, slash commands, prompt hooks, storage, fetch). Use when asked to make, change or debug a mod.', instructions: modsGuide },
  { name: 'chronicle-harness', description: "How Chronicle's own tools really behave on the phone: the hidden browser WebView (frames, real taps and activation, the page's private clipboard, capped element lists, screenshots), preview_page, shell jobs, results saved to .out/ and the background. Use when a tool result surprises you, before working around it.", instructions: harnessGuide },
  { name: 'chronicle-playbook', description: 'Which Chronicle tool to use for which job, and how they combine: research, files, shell and jobs, helpers, schedules, recipes, phone actions, and how to save skills, tools, memories and agents so the next task is easier. Read it at the start of any task with more than a few steps, or when unsure how to approach something.', instructions: playbook }];

/** A small stable hash (the built-in text a skill was made from, to tell whether the user changed it). */
const textHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};
export function addBuiltinSkills(settings) {
  const seen = new Set(settings.seenBuiltinSkills || []);
  let changed = false;
  for (const b of BUILTIN_SKILLS) {
    const hash = textHash(b.instructions);
    if (seen.has(b.name)) {
      // a newer app ships a newer text: refresh the copy, unless the user edited it
      const k = (settings.agentSkills || []).find((x) => x.name === b.name && x.source === 'builtin');
      if (k && k.builtinHash !== hash && k.builtinHash && textHash(k.instructions) === k.builtinHash) {
        Object.assign(k, { instructions: b.instructions, description: b.description, builtinHash: hash, updatedAt: Date.now() });
        changed = true;
      } else if (k && !k.builtinHash && k.instructions === b.instructions) {
        k.builtinHash = hash;
        changed = true;
      }
      continue;
    }
    seen.add(b.name);
    settings.agentSkills ||= [];
    if (!settings.agentSkills.some((k) => k.name === b.name)) settings.agentSkills.push({ ...newSkill({ name: b.name, description: b.description, instructions: b.instructions, files: {}, source: 'builtin' }), builtinHash: hash });
    changed = true;
  }
  settings.seenBuiltinSkills = [...seen];
  return changed;
}

export const slugName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 49);

/** "---\nname: x\ndescription: y\n---\nbody" → { name, description, body } */
export function parseSkillMd(text) {
  const m = String(text || '').replace(/^﻿/, '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = String(text || '');
  if (m) {
    body = m[2];
    let key = null;
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (kv) {
        key = kv[1].toLowerCase();
        meta[key] = kv[2].replace(/^["']|["']$/g, '').trim();
      } else if (key && /^\s+\S/.test(line)) meta[key] += ' ' + line.trim(); // folded continuation
    }
  }
  return { name: slugName(meta.name || ''), description: (meta.description || '').trim(), body: body.trim() };
}

export const skillToMd = (k) => `---\nname: ${k.name}\ndescription: ${String(k.description || '').replace(/\n/g, ' ')}\n---\n\n${k.instructions.trim()}\n`;

export function newSkill({ name, description, instructions, files = {}, source = 'user' }) {
  return { id: 'sk2_' + Math.random().toString(36).slice(2, 10), name, description, instructions, files, enabled: true, source, createdAt: Date.now(), updatedAt: Date.now() };
}

/** Validate and store (or update, when the name exists). Returns { skill, created }. */
export function upsertSkill(list, { name, description, instructions, files }, source = 'agent') {
  const n = slugName(name);
  if (!SKILL_NAME.test(n)) throw new Error('name must be lowercase words joined by hyphens, 2–49 characters (e.g. meeting-notes)');
  if (!String(description || '').trim()) throw new Error('description is required – say what the skill does and when to use it');
  if (!String(instructions || '').trim()) throw new Error('instructions are required');
  const fileMap = {};
  for (const f of Array.isArray(files) ? files : []) {
    const p = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '');
    if (p && typeof f.content === 'string' && p.toLowerCase() !== 'skill.md') fileMap[p] = f.content.slice(0, MAX_FILE);
  }
  const existing = list.find((k) => k.name === n);
  if (existing) {
    Object.assign(existing, { description: String(description).trim().slice(0, 600), instructions: String(instructions).trim(), updatedAt: Date.now() });
    if (Object.keys(fileMap).length) existing.files = { ...(existing.files || {}), ...fileMap };
    return { skill: existing, created: false };
  }
  const skill = newSkill({ name: n, description: String(description).trim().slice(0, 600), instructions: String(instructions).trim(), files: fileMap, source });
  list.push(skill);
  return { skill, created: true };
}

/**
 * edit_skill: change part of a saved skill – exact edits in its instructions or a reference file, new/removed files,
 * a new description or name, on/off, or delete it. Everything not named stays as it is.
 */
export function editSkill(list, args) {
  const k = list.find((x) => x.name === slugName(args.name));
  if (!k) throw new Error(`No skill called "${args.name}". Saved skills: ${list.map((x) => x.name).join(', ') || 'none'}`);
  if (args.delete === true) {
    list.splice(list.indexOf(k), 1);
    return { skill: k, changed: ['deleted'], deleted: true };
  }
  const changed = [];
  const next = { ...k, files: { ...(k.files || {}) } };
  if (args.rename != null) {
    const n = slugName(args.rename);
    if (!SKILL_NAME.test(n)) throw new Error('rename must be lowercase words joined by hyphens (e.g. meeting-notes)');
    if (n !== k.name && list.some((x) => x.name === n)) throw new Error(`There is already a skill called "${n}"`);
    next.name = n;
    changed.push(`renamed to ${n}`);
  }
  if (args.description != null) {
    next.description = String(args.description).trim().slice(0, 600);
    changed.push('description');
  }
  if (args.instructions != null) {
    next.instructions = String(args.instructions).trim();
    changed.push('instructions (rewritten)');
  }
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const byFile = new Map();
  for (const e of edits) {
    const f = e.file ? String(e.file).replace(/^\/+/, '') : '';
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(e);
  }
  for (const [f, es] of byFile) {
    if (!f || f.toLowerCase() === 'skill.md') {
      const r = applyEdits(String(next.instructions || ''), es, 'the instructions');
      next.instructions = r.text;
      changed.push(`instructions (${r.replaced} edit${r.replaced === 1 ? '' : 's'})`);
    } else {
      if (next.files[f] == null) throw new Error(`The skill has no file ${f}. Its files: ${Object.keys(next.files).join(', ') || 'none'}`);
      const r = applyEdits(String(next.files[f]), es, f);
      next.files[f] = r.text.slice(0, MAX_FILE);
      changed.push(`${f} (${r.replaced} edit${r.replaced === 1 ? '' : 's'})`);
    }
  }
  for (const f of Array.isArray(args.files) ? args.files : []) {
    const p = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '');
    if (!p || typeof f.content !== 'string' || p.toLowerCase() === 'skill.md') continue;
    changed.push(`${next.files[p] == null ? 'added' : 'replaced'} ${p}`);
    next.files[p] = f.content.slice(0, MAX_FILE);
  }
  for (const r of Array.isArray(args.remove_files) ? args.remove_files : []) {
    const p = String(r).replace(/^\/+/, '');
    if (next.files[p] == null) throw new Error(`The skill has no file ${p}`);
    delete next.files[p];
    changed.push(`removed ${p}`);
  }
  if (typeof args.enabled === 'boolean' && args.enabled !== (k.enabled !== false)) {
    next.enabled = args.enabled;
    changed.push(args.enabled ? 'switched on' : 'switched off');
  }
  if (!changed.length) throw new Error('Nothing to change: give edits, description, instructions, files, remove_files, rename, enabled or delete');
  if (!String(next.instructions || '').trim()) throw new Error('A skill cannot end up without instructions');
  Object.assign(k, next, { updatedAt: Date.now() });
  return { skill: k, changed, deleted: false };
}

export function skillDefs(skills) {
  const t = [];
  if (skills?.length)
    t.push(
      fn('use_skill', 'Load a skill: its full instructions (and reference files, copied to /workspace/skills/<name>/). Call this BEFORE starting a task that matches a skill\'s description, then follow the instructions.', { name: { type: 'string', description: 'The skill name from the Skills list' } }, ['name']),
    );
  t.push(
    fn(
      'save_skill',
      'Create or update a skill (a reusable instruction package) that is saved in the app and offered in every chat with tools on. Write the description so it says what the skill does AND when to use it. Instructions are Markdown: steps, rules, formats, examples. Optional files are extra reference text (templates, checklists) the skill can point to.',
      {
        name: { type: 'string', description: 'lowercase-with-hyphens, e.g. meeting-notes' },
        description: { type: 'string', description: 'One or two sentences: what it does and when to use it' },
        instructions: { type: 'string', description: 'The full skill instructions in Markdown' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Optional reference files' },
      },
      ['name', 'description', 'instructions'],
    ),
  );
  // changing a saved skill only makes sense once there is one
  if (skills?.length)
    t.push(
      fn(
      'edit_skill',
      'Change part of a saved skill instead of rewriting it with save_skill: exact text edits in its instructions or in one of its reference files (like edit_file), add/replace/remove reference files, a new description or name, switch it on/off, or delete it. Everything you do not name stays as it is. Call use_skill first to see the current text.',
      {
        name: { type: 'string', description: 'The skill to change' },
        edits: { type: 'array', items: { type: 'object', properties: { file: { type: 'string', description: 'A reference file path; leave out for the instructions' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_text', 'new_text'] } },
        description: { type: 'string', description: 'A new description (what it does and when to use it)' },
        instructions: { type: 'string', description: 'Only to rewrite the instructions completely' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Reference files to add or replace whole' },
        remove_files: { type: 'array', items: { type: 'string' } },
        rename: { type: 'string', description: 'A new name (lowercase-with-hyphens)' },
        enabled: { type: 'boolean', description: 'Switch the skill on or off' },
        delete: { type: 'boolean', description: 'Delete the skill entirely' },
      },
      ['name'],
    ),
    );
  return t;
}

export function skillsPrompt(skills) {
  if (!skills?.length) return '- Skills: none are installed yet. If the user asks you to make or save a skill, use save_skill.';
  return [
    '- Skills (instruction packages the user installed). When a task matches a skill, call use_skill with its name first and follow what it says:',
    ...skills.map((k) => {
      const sc = skillScripts(k.files).map((s) => s.name);
      // say which tools a skill carries, so a missing one is visible instead of silently absent
      return `  - ${k.name}: ${k.description}` + (sc.length ? ` (its scripts are installed in the shell's PATH: ${sc.join(', ')})` : '');
    }),
    '  Use save_skill to create a skill, and edit_skill to change part of one (or switch it off, rename or delete it) when the user asks.',
  ].join('\n');
}

// ---------- a skill's scripts/ folder as a toolkit source ----------
// A skill may carry shell scripts in scripts/. They are written executable, described by a manifest the
// shell's toolkit-pull can verify, and the folder is offered to it as one source in /workspace/.toolkit-url
// - so installing a skill is all it takes to have its tools in PATH.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// the app ships these itself; a skill's copy is reference only (pulling it could replace a working one)
const APP_TOOLS = new Set(['job', 'doctor', 'toolkit-pull']);
const TOOLKIT_URL = '.toolkit-url';
const TOOLKIT_URL_HEADER = "# toolkit sources, one per line - the app adds each used skill's scripts/ folder";
const lfOnly = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
const dec = new TextDecoder('utf-8', { fatal: false });

/** A scripts/ entry that may be installed: directly in scripts/, a plain name, not one the app ships. */
const isInstallable = (name) => SCRIPT_NAME.test(name) && !APP_TOOLS.has(name);

/** The source line a skill's scripts/ folder is published under (toolkit-pull turns this into a pull). */
export const skillToolkitUrl = (skillName) => `file:///workspace/skills/${skillName}/scripts`;

/** Add one source line to /workspace/.toolkit-url, creating the file and leaving every other line alone. */
function addToolkitUrl(w, src) {
  const raw = w.files[TOOLKIT_URL]?.data ? dec.decode(w.files[TOOLKIT_URL].data) : '';
  const existing = raw.trim() ? raw : null;
  if (existing && existing.split('\n').some((l) => l.trim() === src)) return false;
  const head = existing ? (existing.endsWith('\n') ? existing : existing + '\n') : `${TOOLKIT_URL_HEADER}\n`;
  wsPut(w, TOOLKIT_URL, `${head}${src}\n`, { exec: false });
  return true;
}

/**
 * Copy a skill's files into /workspace/skills/<name>/, and when it has usable scripts, publish the folder as a
 * toolkit source. Scripts are normalised to LF (the manifest hash is of the bytes on disk) and made executable;
 * everything else lands as a plain reference file. Returns { scripts, placed }.
 */
export async function registerSkillScripts(w, skillName, files) {
  const placed = [];
  const scripts = [];
  const bodies = new Map();
  for (const [p, c] of Object.entries(files || {})) {
    const m = /^scripts\/([^/]+)$/.exec(p);
    const name = m ? m[1] : '';
    if (name && isInstallable(name)) {
      const text = lfOnly(c);
      bodies.set(name, text);
      scripts.push(name);
      placed.push(wsPut(w, `skills/${skillName}/${p}`, text, { exec: true }));
    } else {
      placed.push(wsPut(w, `skills/${skillName}/${p}`, c));
    }
  }
  if (!scripts.length) return { scripts, placed };
  scripts.sort();
  const lines = [`# toolkit source for the skill ${skillName} (written by the app) - do not edit`];
  for (const name of scripts) lines.push(`${await sha256Hex(bodies.get(name))}  ${name}`);
  placed.push(wsPut(w, `skills/${skillName}/scripts/.toolkit`, lines.join('\n') + '\n'));
  addToolkitUrl(w, skillToolkitUrl(skillName));
  return { scripts, placed };
}

/** A skill's installable scripts: [{ name, text }] (LF, sorted), from its files map. */
export function skillScripts(files) {
  const out = [];
  for (const [p, c] of Object.entries(files || {})) {
    const m = /^scripts\/([^/]+)$/.exec(p);
    if (m && isInstallable(m[1])) out.push({ name: m[1], text: lfOnly(c) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const sameText = (f, text) => !!f?.data && f.exec === true && dec.decode(f.data) === text;

/**
 * Every enabled skill's scripts/ in this workspace, before a shell command - not only after use_skill.
 * A skill installed in the app is a tool the shell should have; waiting for the model to "load" it first
 * meant the scripts never arrived in a chat that went straight to the shell, and the only copy of the
 * real tool stayed wherever it was written by hand. Writes only what differs, so an unchanged skill
 * costs a comparison, not a crossing.
 * Returns { scripts: [{ skill, name, hash }], changed: [names], signature }.
 */
export async function syncSkillScripts(w, skills) {
  const scripts = [];
  const changed = [];
  for (const k of skills || []) {
    if (!k || k.enabled === false || !SKILL_NAME.test(k.name || '')) continue;
    const list = skillScripts(k.files);
    if (!list.length) continue;
    const lines = [`# toolkit source for the skill ${k.name} (written by the app) - do not edit`];
    for (const s of list) {
      const path = `skills/${k.name}/scripts/${s.name}`;
      if (!sameText(w.files[path], s.text)) {
        wsPut(w, path, s.text, { exec: true });
        changed.push(s.name);
      }
      const hash = await sha256Hex(s.text);
      lines.push(`${hash}  ${s.name}`);
      scripts.push({ skill: k.name, name: s.name, hash });
    }
    const manifest = lines.join('\n') + '\n';
    const mPath = `skills/${k.name}/scripts/.toolkit`;
    if (!w.files[mPath]?.data || dec.decode(w.files[mPath].data) !== manifest) wsPut(w, mPath, manifest);
    addToolkitUrl(w, skillToolkitUrl(k.name));
  }
  const signature = scripts.map((s) => s.skill + '/' + s.name + '=' + s.hash).join(',');
  return { scripts, changed, signature };
}

export async function runSkillTool(name, args, ctx) {
  if (name === 'use_skill') {
    const n = slugName(args.name);
    const k = (ctx.settings.agentSkills || []).find((x) => x.name === n && x.enabled !== false);
    if (!k) throw new Error(`No skill called "${args.name}". Available: ${(ctx.settings.agentSkills || []).filter((x) => x.enabled !== false).map((x) => x.name).join(', ') || 'none'}`);
    const { scripts, placed } = await registerSkillScripts(ctx.workspace, k.name, k.files);
    const tail = placed.length ? `\n\n[Reference files copied to the workspace – read them with read_file: ${placed.join(', ')}]` : '';
    const via = scripts.length ? `\n\n[Scripts registered as a toolkit source: ${scripts.join(', ')} - run toolkit-pull in the shell to install them into PATH]` : '';
    return { ok: true, result: `Skill "${k.name}":\n\n${k.instructions}${tail}${via}`, display: { path: k.name, files: placed, scripts } };
  }
  if (name === 'edit_skill') {
    const list = (ctx.settings.agentSkills ||= []);
    const r = editSkill(list, args);
    ctx.onSkillsChanged?.();
    return { ok: true, result: r.deleted ? `Deleted the skill "${r.skill.name}".` : `Changed the skill "${r.skill.name}": ${r.changed.join(', ')}. Everything else is as it was.`, display: { path: r.skill.name } };
  }
  if (name === 'save_skill') {
    const list = (ctx.settings.agentSkills ||= []);
    const { skill, created } = upsertSkill(list, args, 'agent');
    ctx.onSkillsChanged?.();
    return { ok: true, result: `${created ? 'Saved' : 'Updated'} the skill "${skill.name}". It is now listed in every chat with tools on${skill.files && Object.keys(skill.files).length ? ` (with ${Object.keys(skill.files).length} reference file(s))` : ''}.`, display: { path: skill.name } };
  }
  return null;
}

/** An imported SKILL.md (text) or a folder/zip of files → a skill. entries: { path: string text } */
export function skillFromFiles(entries, fallbackName = '') {
  const paths = Object.keys(entries);
  const mdPath = paths.filter((p) => /(^|\/)skill\.md$/i.test(p)).sort((a, b) => a.length - b.length)[0];
  if (!mdPath) throw new Error('No SKILL.md found');
  const { name, description, body } = parseSkillMd(entries[mdPath]);
  const base = mdPath.includes('/') ? mdPath.slice(0, mdPath.lastIndexOf('/') + 1) : '';
  const files = {};
  for (const p of paths) if (p !== mdPath && p.startsWith(base)) files[p.slice(base.length)] = entries[p].slice(0, MAX_FILE);
  const n = name || slugName(fallbackName) || slugName(base.replace(/\/$/, '').split('/').pop());
  if (!SKILL_NAME.test(n)) throw new Error('The skill needs a name: add "name: my-skill" to the top of SKILL.md');
  return { name: n, description: description || body.split('\n').find((l) => l.trim())?.slice(0, 200) || n, instructions: body, files };
}
