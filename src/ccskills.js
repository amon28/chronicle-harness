// Chronicle's agent skills as Claude Code skills (decision 166): every enabled skill of Settings › Skills (packs and
// imported Claude plugins are skills there too) is written into the Linux Claude Code runs in, as
// ~/.claude/skills/<name>/SKILL.md (YAML frontmatter `name` + `description`, then the instructions) with the skill's
// own files next to it (scripts/ executable). Claude Code watches that folder, so a change shows up in a running
// session too.
//
// Only folders Chronicle wrote are ever changed or removed: each carries a `.chronicle-skill` marker (the skill's
// hash), and the list of names Chronicle owns is kept outside ~/.claude (in the Claude Code state folder). A folder
// of the same name the user made themselves is left alone (and that skill is not written).
//
// Pure: the commands are text, run by the caller in the Claude Code shell; tests run them with a real sh.
import { SKILL_NAME } from './skills.js';
import { sha256Hex } from './hash.js';

export const SKILLS_DIR = '/root/.claude/skills';
export const MARKER = '.chronicle-skill';
const MAX_CMD = 400000; // bytes of file text per write command (the shell reads the command from a pipe, no ARG_MAX)
const MAX_DESC = 1024;

const b64 = (s) => {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** A skill file's path inside its folder, or null when it cannot be written safely (absolute, .., our marker…). */
export function safeSkillPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /[\0\n\r]/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  if (parts.length === 1 && (/^skill\.md$/i.test(s) || s === MARKER)) return null; // ours
  return s;
}

/** The SKILL.md Claude Code reads: frontmatter on the first line, description quoted (a JSON string is valid YAML). */
export function skillMd(k) {
  const desc = String(k.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC) || k.name;
  return [
    '---',
    `name: ${k.name}`,
    `description: ${JSON.stringify(desc)}`,
    '---',
    '',
    `<!-- Written by Chronicle from its skill "${k.name}" – edit it in Chronicle (Settings › Skills); changes here are replaced. Chronicle's own tools named below (browser, phone_read, memory…) are the mcp__chronicle__* tools in Claude Code. -->`,
    '',
    String(k.instructions || '').trim(),
    '',
  ].join('\n');
}

/** One skill → { name, files: [{ path, text, exec }], hash } (null when it is off or has no valid name). */
export async function ccSkill(k) {
  if (!k || k.enabled === false || !SKILL_NAME.test(k.name || '') || !String(k.instructions || '').trim()) return null;
  const files = [{ path: 'SKILL.md', text: skillMd(k), exec: false }];
  for (const [p, c] of Object.entries(k.files || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = safeSkillPath(p);
    if (!path || typeof c !== 'string') continue;
    files.push({ path, text: c, exec: /^scripts\/[^/]+$/.test(path) });
  }
  const hash = (await sha256Hex(JSON.stringify(files))).slice(0, 32);
  return { name: k.name, files, hash };
}

/** The enabled skills, ready to write; `signature` changes whenever any of them (or the set) does. */
export async function ccSkills(skills) {
  const seen = new Set();
  const list = [];
  for (const k of skills || []) {
    const s = await ccSkill(k);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    list.push(s);
  }
  return { list, signature: list.map((s) => s.name + '=' + s.hash).join(',') };
}

/**
 * Step 1, in Linux: remove the folders of skills Chronicle wrote that are gone or off (only with our marker), say
 * for each wanted skill whether it is the same, needed, or the user's own folder, and write the new owner list.
 * Prints "@@REMOVED n", "@@SAME n", "@@NEED n", "@@USER n", then "@@PLANNED".
 */
export function skillsPlanCmd(list, { dir, skills = SKILLS_DIR } = {}) {
  if (!dir) throw new Error('the state folder is needed');
  for (const s of list) if (!SKILL_NAME.test(s.name) || !/^[0-9a-f]{8,64}$/.test(s.hash)) throw new Error('bad skill ' + s.name);
  const want = list.map((s) => s.name).join(' ');
  return [
    '# ocm-claude skills',
    `D=${q(dir)}; K=${q(skills)}; mkdir -p "$K" "$D"`,
    `want=' ${want} '`,
    // ours that are no longer wanted: only a folder with our marker goes
    'if [ -f "$D/skills.manifest" ]; then while read -r n; do [ -n "$n" ] || continue; case "$want" in *" $n "*) ;; *) if [ -f "$K/$n/' + MARKER + '" ]; then rm -rf "$K/$n" && echo "@@REMOVED $n"; fi;; esac; done < "$D/skills.manifest"; fi',
    'own=""',
    'chk() { if [ -e "$K/$1" ] && [ ! -f "$K/$1/' + MARKER + '" ]; then echo "@@USER $1"; return; fi; own="$own$1\n"; if [ "$(cat "$K/$1/' + MARKER + '" 2>/dev/null)" = "$2" ]; then echo "@@SAME $1"; else echo "@@NEED $1"; fi; }',
    ...list.map((s) => `chk ${s.name} ${s.hash}`),
    'printf "$own" > "$D/skills.manifest.tmp" && mv "$D/skills.manifest.tmp" "$D/skills.manifest"',
    'echo "@@PLANNED"',
  ].join('\n');
}

/** The plan's answer → { need: [names], same, user, removed, ok } */
export function parsePlan(out) {
  const r = { need: [], same: [], user: [], removed: [], ok: /@@PLANNED/.test(String(out || '')) };
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(NEED|SAME|USER|REMOVED) (\S+)$/.exec(line.trim());
    if (m) r[m[1].toLowerCase() === 'need' ? 'need' : m[1].toLowerCase()].push(m[2]);
  }
  return r;
}

/**
 * Step 2: the needed skills written, each into a fresh folder next to the state folder and then moved in place
 * (Claude Code never sees half a skill), the marker last. Split into commands of at most ~400 KB of text; a
 * skill bigger than that gets a command of its own. Each command prints "@@WROTE n" per skill.
 */
export function skillsWriteCmds(items, { dir, skills = SKILLS_DIR } = {}) {
  const cmds = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (!cur.length) return;
    cmds.push(['# ocm-claude skills-write', `D=${q(dir)}; K=${q(skills)}; mkdir -p "$K" "$D/skills-tmp"`, ...cur].join('\n'));
    cur = [];
    size = 0;
  };
  for (const s of items) {
    if (!SKILL_NAME.test(s.name)) continue;
    const lines = [`T="$D/skills-tmp/${s.name}"; rm -rf "$T"; mkdir -p "$T"`];
    let bytes = 0;
    for (const f of s.files) {
      const sub = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (sub) lines.push(`mkdir -p "$T"/${q(sub)}`);
      const data = b64(f.text);
      bytes += data.length;
      lines.push(`printf '%s' '${data}' | base64 -d > "$T"/${q(f.path)}${f.exec ? ` && chmod 755 "$T"/${q(f.path)}` : ''}`);
    }
    lines.push(`printf '%s\\n' '${s.hash}' > "$T/${MARKER}"`);
    // a folder the user made after the plan is still never replaced
    lines.push(`if [ -e "$K/${s.name}" ] && [ ! -f "$K/${s.name}/${MARKER}" ]; then rm -rf "$T"; echo "@@USER ${s.name}"; else rm -rf "$K/${s.name}" && mv "$T" "$K/${s.name}" && echo "@@WROTE ${s.name}"; fi`);
    if (size && size + bytes > MAX_CMD) flush();
    cur.push(...lines);
    size += bytes;
  }
  flush();
  return cmds;
}

/**
 * Sync: plan, then write what changed. exec(cmd) → { output }. → { wrote, removed, user, same }
 * Throws when the plan did not run (no Linux, the shell refused).
 */
export async function syncCcSkills(skills, { exec, dir, skillsDir = SKILLS_DIR, prepared = null } = {}) {
  const { list } = prepared || (await ccSkills(skills));
  const plan = parsePlan((await exec(skillsPlanCmd(list, { dir, skills: skillsDir })))?.output);
  if (!plan.ok) throw new Error('the skills could not be listed in Linux');
  const need = list.filter((s) => plan.need.includes(s.name));
  const wrote = [];
  const user = [...plan.user];
  for (const cmd of skillsWriteCmds(need, { dir, skills: skillsDir })) {
    const out = String((await exec(cmd))?.output || '');
    for (const m of out.matchAll(/^@@(WROTE|USER) (\S+)$/gm)) (m[1] === 'WROTE' ? wrote : user).push(m[2]);
  }
  // need: so the caller can tell a full write from a partial one
  return { wrote, need: need.map((s) => s.name), removed: plan.removed, user, same: plan.same };
}
