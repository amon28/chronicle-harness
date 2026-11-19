// Agent tools for a phone folder the user has linked: look around, bring files into the workspace,
// save files back. Everything stays inside that one folder.
import { listFolder, readPhoneFile, writePhoneFile, removePhoneFile, phoneExists, exportLinuxFile, canExportLinux } from './phonefolder.js';
import { statPath, errorText } from './linuxfiles.js';
import { statEntry, workDir, phoneDir } from './shellfs.js';
import { wsPut, wsList, looksText, bytesToText, cleanPath } from './sandbox.js';
import { sha256Hex, shortHash } from './hash.js';

const MAX_IMPORT_FILES = 300;
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const fmtKB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export function phoneDefs() {
  return [
    fn('phone_folder', 'Ask the user to point you at a folder on their phone (opens Android\'s folder picker) or check which one is linked to this chat. Call it with action "link" when the user says to go to / use a folder and none is linked yet, or when they want a different one.', { action: { type: 'string', enum: ['status', 'link'], description: 'status = which folder is linked; link = ask the user to choose one' } }, ['action']),
    fn('phone_list', 'List files and folders inside the linked phone folder. Paths are relative to it.', { path: { type: 'string', description: 'Sub-folder, default the top level' }, recursive: { type: 'boolean', description: 'Include everything below (up to 1000 entries)' } }),
    fn('phone_read', 'Read a text file from the linked phone folder (use phone_import for images and other files).', { path: { type: 'string' }, max_chars: { type: 'integer', description: 'Default 12000' } }, ['path']),
    fn('phone_import', 'Copy a file or a whole folder from the linked phone folder into /workspace so you can use read_file, view_images and run_python on it. Returns the workspace paths.', { path: { type: 'string', description: 'File or folder in the phone folder; empty = the whole linked folder' }, to: { type: 'string', description: 'Workspace folder to copy into: a file keeps its name (to "imported" → imported/<name>), a folder\'s contents go into it. For a single file, a to ending in the same extension as the file (e.g. "docs/notes.md") is the new file name instead. Default: the same relative path as on the phone' } }),
    fn(
      'phone_write',
      'Create or overwrite a file in the linked phone folder. Give either content (text), from_workspace (a file already in /workspace, e.g. a chart you made) or from_shell (a file in the Linux shell, any size – a recording, a build: it is copied straight from the shell\'s disk, never through memory; use this for anything over a few MB). In review mode it is staged for the user to accept (from_shell: the user is asked right away); in auto mode it is saved at once; in read-only mode it is refused.',
      { path: { type: 'string' }, content: { type: 'string' }, from_workspace: { type: 'string' }, from_shell: { type: 'string', description: 'an absolute path in the Linux shell, e.g. /root/rplay/out.mp4 or /workspace/out.mp4' } },
      ['path'],
    ),
    fn('phone_delete', 'Delete a file, or an empty folder, in the linked phone folder (staged for review, or applied at once in auto mode; refused in read-only mode). A folder with anything in it is refused: delete its files first.', { path: { type: 'string' } }, ['path']),
  ];
}

export function phonePrompt(folder, mode = 'ask', lastReview = '') {
  if (!folder) return '- No phone folder is linked. If the user wants you to work with a folder on their phone, call phone_folder with action "link" – they pick it, then you can use the phone_* tools.';
  const how =
    mode === 'readonly'
      ? 'The folder is READ-ONLY in this chat: phone_write and phone_delete are refused. Do the work in /workspace and tell the user what you would save.'
      : mode === 'auto'
        ? 'Changes you make with phone_write / phone_delete are applied immediately (the user can undo them afterwards).'
        : 'Changes you make with phone_write / phone_delete are NOT applied yet: they are staged, and the user reviews and accepts or rejects each one when your turn ends. phone_read / phone_list already show your staged changes. Make all your changes in one go, then stop and say what you changed.';
  return `- A phone folder is linked: "${folder.name}". Use phone_list / phone_read to look at it, phone_import to bring files into /workspace (needed before view_images or run_python), and phone_write to save results back (a file in the Linux shell, any size: phone_write from_shell – never read it into the workspace first). Paths are relative to that folder. ${how}${lastReview ? `\n  Last review by the user: ${lastReview}` : ''}`;
}

/** A path to change in the linked folder: ".." is refused (cleanPath would quietly drop it and change another file). */
const writePath = (raw) => {
  if (String(raw ?? '').replace(/\\/g, '/').split('/').includes('..')) throw new Error(`".." is not allowed in path (${raw}): paths are relative to the linked folder, and nothing outside it can be changed. Use a path inside the folder, e.g. ${cleanPath(raw) || 'name.txt'}.`);
  return cleanPath(raw);
};

const needFolder = (ctx) => {
  const f = ctx.phone?.folder?.();
  if (!f) throw new Error('No phone folder is linked yet. Call phone_folder with action "link" so the user can pick one.');
  return f;
};

const MAX_UNDO_BYTES = 5 * 1024 * 1024;
const staged = (ctx) => ctx.phone?.stage || new Map();
const mode = (ctx) => ctx.phone?.mode?.() || 'ask';

/** A file's bytes as the assistant should see them: its own staged changes first, then the phone. */
async function readOverlay(ctx, f, p, max) {
  const st = staged(ctx).get(p);
  if (st) {
    if (st.kind === 'delete') throw new Error(`No such file: ${p} (you staged it for deletion)`);
    return st.after;
  }
  return readPhoneFile(f, p, max);
}
async function existsOverlay(ctx, f, p) {
  const st = staged(ctx).get(p);
  if (st) return st.kind === 'delete' ? { exists: false, isDir: false, size: 0 } : { exists: true, isDir: false, size: st.after.byteLength };
  return phoneExists(f, p);
}
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const extOf = (name) => (/\.([^./]+)$/.exec(name)?.[1] || '').toLowerCase();
/** phone_import of one file: does `to` name the new file (same extension, or the same name), or a folder to copy into? */
const namesFile = (to, name) => {
  const last = to.split('/').pop();
  return last === name || (!!extOf(name) && extOf(last) === extOf(name));
};

/**
 * Put bytes into the linked folder following this chat's mode. Used by phone_write and by the shell
 * bridge, so a file written by a command in the Linux box follows exactly the same rule (staged in
 * review mode, refused when read-only) as one written by the tool.
 * Returns { ok, mode, staged, existed, proof, why }.
 */
export async function saveToPhone(ctx, f, p, bytes) {
  const m = mode(ctx);
  if (m === 'readonly') return { ok: false, mode: m, staged: false, why: 'read-only' };
  const ex = await existsOverlay(ctx, f, p);
  if (m === 'ask') {
    const was = staged(ctx).get(p);
    // the kind says what is on the PHONE, not what the staged changes look like: a file staged for deletion and then
    // written again is still there (a replacement - "new" would be undone by deleting the user's original), and a
    // file staged as new and written again is still not there
    const onPhone = was ? was.kind !== 'new' : ex.exists;
    staged(ctx).set(p, { kind: onPhone ? 'replace' : 'new', after: bytes, ...(was?.before !== undefined ? { before: was.before } : {}) });
    return { ok: true, mode: m, staged: true, existed: ex.exists, proof: 'sha256:' + shortHash(await sha256Hex(bytes)) + ' staged' };
  }
  const before = ex.exists && ex.size <= MAX_UNDO_BYTES ? await readPhoneFile(f, p, MAX_UNDO_BYTES).catch(() => null) : null;
  await writePhoneFile(f, p, bytes);
  ctx.phone.log?.push({ path: p, kind: ex.exists ? 'replace' : 'new', before });
  // proof: read the file back and compare - a write that cannot be read back says so instead of claiming success
  let proof = 'sha256:' + shortHash(await sha256Hex(bytes)) + ' unverified (no read-back)';
  let verified = false;
  try {
    const back = await readPhoneFile(f, p, Math.max(bytes.byteLength + 1024, MAX_READ_BYTES));
    verified = (await sha256Hex(back)) === (await sha256Hex(bytes));
    proof = 'sha256:' + shortHash(await sha256Hex(back)) + (verified ? ' read-back' : ' READ-BACK DIFFERS');
  } catch {
    /* the folder may be write-only; the byte count is still reported */
  }
  return { ok: verified || proof.includes('unverified'), mode: m, staged: false, existed: ex.exists, proof, verified };
}

const fmtSize = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : fmtKB(n));
/** phone_write from_shell: the file streamed from the Linux disk into the folder (no size limit, no copy in memory). */
async function shellToPhone(ctx, f, p, from) {
  if (mode(ctx) === 'readonly') return { ok: false, result: 'This chat has the phone folder in read-only mode, so nothing was saved. Tell the user where the file is in Linux (they can save it from 📁 Files › 🐧 Linux › Download).', display: { path: p, error: 'read-only' } };
  if (!canExportLinux()) return { ok: false, result: 'Copying from the Linux shell to the phone needs the Android app.', display: { path: p, error: 'unavailable' } };
  const abs = from.trim().replace(/^~(?=\/|$)/, '/root');
  if (!abs.startsWith('/')) return { ok: false, result: `from_shell needs an absolute path (e.g. /root/rec/out.mp4 or /workspace/out.mp4), not "${from}" – run pwd or realpath in the shell to get it.`, display: { path: p, error: 'relative path' } };
  // /workspace and the copy of /phone are bound in from the app's storage: read from there, not from the root filesystem
  const conv = ctx.convId || 'main';
  const bound = /^\/(workspace|phone)\/(.+)$/.exec(abs.replace(/\/+/g, '/'));
  let st;
  if (bound) {
    const dir = bound[1] === 'workspace' ? workDir(conv) : phoneDir(conv);
    const rest = bound[2].split('/').filter((x) => x && x !== '.');
    if (rest.includes('..')) return { ok: false, result: `Not saved: ".." is not allowed in from_shell (${from}).`, display: { path: p, error: 'bad path' } };
    const e = await statEntry(dir, rest.join('/')).catch(() => null);
    if (!e) return { ok: false, result: `Not saved: no file ${abs} in this chat's shell.`, display: { path: p, error: 'missing' } };
    st = { real: abs, size: e.size, guest: `${dir}/${rest.join('/')}`, base: 'shell' };
  } else {
    st = await statPath(abs);
    if (st.error) return { ok: false, result: `Not saved: ${errorText(st.error)} (${from})`, display: { path: p, error: st.error } };
    if (st.dir) return { ok: false, result: `${from} is a folder – save the files in it one by one, or make a zip/tar of it first.`, display: { path: p, error: 'folder' } };
    st.guest = st.real;
  }
  const size = fmtSize(st.size);
  // review mode: a file this size is not kept in the app to be reviewed later – the user says yes or no now
  if (mode(ctx) === 'ask') {
    if (!ctx.ask) return { ok: false, result: "Saving needs the user's OK, which is not available here.", display: { path: p, error: 'unavailable' } };
    ctx.onStatus?.('waiting for your OK…');
    const yes = 'Save it';
    const ans = await ctx.ask(`Save ${st.real.split('/').pop()} (${size}) from Linux into “${f.name}” as ${p}?`, [yes, 'Not now'], ctx.signal);
    if (ans !== yes) return { ok: false, result: `The user said no (${ans}). Nothing was saved.`, display: { path: p, error: 'declined' } };
  }
  const ex = await existsOverlay(ctx, f, p).catch(() => ({ exists: false }));
  let last = 0;
  try {
    const r = await exportLinuxFile(st.guest, { folder: f, path: p, ...(st.base ? { base: st.base } : {}) }, (done, total) => {
      const pc = Math.round((done / Math.max(1, total)) * 100);
      if (pc !== last) ctx.onStatus?.(`saving ${pc}% of ${size}…`);
      last = pc;
    });
    ctx.phone.log?.push({ path: p, kind: ex.exists ? 'replace' : 'new', before: null }); // undo removes a new one; a replaced one this size is not kept
    const full = r.bytes === st.size;
    return {
      ok: full,
      result: full ? `Saved ${p} to the phone folder (${size}, copied straight from ${st.real}).` : `Only ${fmtSize(r.bytes)} of ${size} were written – treat ${p} as NOT saved (the file may still have been growing; wait until it is finished).`,
      display: { path: p, ...(full ? {} : { error: 'incomplete' }) },
      meta: { surface: 'phone-folder', bytes: r.bytes, proof: full ? 'size matches' : 'size differs' },
    };
  } catch (e) {
    return { ok: false, result: `Not saved: ${e?.message || e}`, display: { path: p, error: String(e?.message || e).slice(0, 60) } };
  }
}

export async function runPhoneTool(name, args, ctx) {
  switch (name) {
    case 'phone_folder': {
      if (args.action === 'link') {
        ctx.onStatus?.('waiting for you to pick a folder…');
        const f = await ctx.phone.link();
        if (!f) return { ok: false, result: 'The user did not pick a folder.', display: { error: 'cancelled' } };
        return { ok: true, result: `Linked the phone folder "${f.name}" to this chat. It stays linked in this chat (also after the app restarts) until the user unlinks it; other chats link their own folder.`, display: { path: f.name } };
      }
      const f = ctx.phone?.folder?.();
      return { ok: true, result: f ? `Linked folder: "${f.name}".` : 'No phone folder is linked.', display: { path: f?.name || '–' } };
    }
    case 'phone_list': {
      const f = needFolder(ctx);
      const path = cleanPath(args.path || '');
      let entries = await listFolder(f, path, !!args.recursive);
      // your own staged changes show up (new files appear, deleted ones go)
      for (const [sp, st] of staged(ctx)) {
        const inside = path ? sp.startsWith(path + '/') : true;
        if (!inside || (!args.recursive && dirOf(sp) !== path)) continue;
        entries = entries.filter((e) => e.path !== sp);
        if (st.kind !== 'delete') entries.push({ path: sp, isDir: false, size: st.after.byteLength });
      }
      const text = entries.length ? entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path}\t${fmtKB(e.size)}`)).join('\n') : path ? `Nothing in ${path}` : 'The folder is empty.';
      return { ok: true, result: text, display: { path: path || f.name, count: entries.length } };
    }
    case 'phone_read': {
      const f = needFolder(ctx);
      const p = cleanPath(args.path);
      const bytes = await readOverlay(ctx, f, p, MAX_READ_BYTES);
      if (!looksText(bytes)) return { ok: true, result: `${p} is not a text file (${fmtKB(bytes.byteLength)}). Use phone_import to copy it into the workspace.`, display: { path: p } };
      const text = bytesToText(bytes);
      const max = Math.max(200, Math.min(40000, Number(args.max_chars) || 12000));
      return { ok: true, result: text.slice(0, max) + (text.length > max ? `\n… [${text.length - max} more chars – phone_import it to read the rest]` : ''), display: { path: p, chars: text.length } };
    }
    case 'phone_import': {
      const f = needFolder(ctx);
      const src = cleanPath(args.path || '');
      const to = cleanPath(args.to || src);
      const ex = src ? await existsOverlay(ctx, f, src) : { exists: true, isDir: true };
      if (!ex.exists) throw new Error(`Not found in the phone folder: ${src}`);
      let files;
      if (ex.isDir) files = (await listFolder(f, src, true)).filter((e) => !e.isDir);
      else files = [{ path: src, size: ex.size }];
      if (files.length > MAX_IMPORT_FILES) throw new Error(`That folder has ${files.length} files – import a sub-folder or single files (limit ${MAX_IMPORT_FILES}).`);
      const total = files.reduce((n, e) => n + (e.size || 0), 0);
      if (total > MAX_IMPORT_BYTES) throw new Error(`That is ${fmtKB(total)} in total – too much to copy at once (limit ${fmtKB(MAX_IMPORT_BYTES)}).`);
      const done = [];
      for (const e of files) {
        ctx.onStatus?.(`copying ${e.path.split('/').pop()}… (${done.length + 1}/${files.length})`);
        const bytes = await readOverlay(ctx, f, e.path);
        const rel = ex.isDir ? (src ? e.path.slice(src.length).replace(/^\//, '') : e.path) : e.path.split('/').pop();
        const dest = ex.isDir ? [to, rel].filter(Boolean).join('/') : args.to && to ? (namesFile(to, rel) ? to : `${to}/${rel}`) : e.path;
        done.push(wsPut(ctx.workspace, dest, bytes));
      }
      const show = done.slice(0, 40).join('\n');
      return { ok: true, result: `Copied ${done.length} file${done.length === 1 ? '' : 's'} into /workspace:\n${show}${done.length > 40 ? `\n… and ${done.length - 40} more (use list_files)` : ''}`, display: { files: done.slice(0, 20), count: done.length } };
    }
    case 'phone_write': {
      const f = needFolder(ctx);
      const p = writePath(args.path);
      if (!p) throw new Error('path is required');
      if (args.from_shell) return await shellToPhone(ctx, f, p, String(args.from_shell));
      let bytes;
      if (args.from_workspace) {
        const wp = cleanPath(args.from_workspace);
        const wf = ctx.workspace.files[wp];
        if (!wf) throw new Error(`Not in the workspace: ${wp}`);
        bytes = wf.data;
      } else bytes = new TextEncoder().encode(String(args.content ?? ''));
      const r = await saveToPhone(ctx, f, p, bytes);
      const meta = { surface: 'phone-folder', bytes: bytes.byteLength, proof: r.proof };
      if (!r.ok) {
        return {
          ok: false,
          result: r.why === 'read-only' ? 'This chat has the phone folder in read-only mode, so nothing was saved. Keep the file in /workspace and tell the user.' : `The file was written but does not read back the same – treat it as NOT saved: ${p}`,
          display: { path: p, error: r.why || 'read-back differs' },
          meta,
        };
      }
      if (r.staged) return { ok: true, result: `Staged ${p} (${fmtKB(bytes.byteLength)}) – it is NOT saved yet. The user will review and accept or reject it when your turn ends.`, display: { path: p, staged: true }, meta };
      return { ok: true, result: `Saved ${p} to the phone folder (${fmtKB(bytes.byteLength)}).${r.verified === false ? ' It could not be read back, so the save is unverified.' : ''}`, display: { path: p }, meta };
    }
    case 'phone_delete': {
      const f = needFolder(ctx);
      const p = writePath(args.path);
      if (!p) throw new Error('path is required');
      if (mode(ctx) === 'readonly') return { ok: false, result: 'This chat has the phone folder in read-only mode, so nothing was deleted.', display: { error: 'read-only' } };
      const ex = await existsOverlay(ctx, f, p);
      if (!ex.exists) throw new Error(`No such file: ${p}`);
      if (ex.isDir) {
        // only an empty folder (data safety): what is in it is deleted file by file first, each one reviewable
        const inside = (await listFolder(f, p, false)).length;
        const under = [...staged(ctx)].filter(([sp]) => sp.startsWith(p + '/')).map(([, st]) => st.kind);
        if (inside || under.some((k) => k !== 'delete')) {
          const pending = under.includes('delete');
          throw new Error(`${p}/ is not empty${inside ? ` (${inside} entr${inside === 1 ? 'y' : 'ies'})` : ''} – only an empty folder can be deleted. Delete the files in it first${pending ? '; the deletions you staged are applied only after the user reviews them, so delete the folder after that' : ''}.`);
        }
        if (mode(ctx) === 'ask') {
          staged(ctx).set(p, { kind: 'delete', after: null, dir: true });
          return { ok: true, result: `Staged the deletion of the empty folder ${p}/ – it is NOT deleted yet. The user will review it when your turn ends.`, display: { path: p + '/', staged: true } };
        }
        await removePhoneFile(f, p);
        return { ok: true, result: `Deleted the empty folder ${p}/.`, display: { path: p + '/' } };
      }
      if (mode(ctx) === 'ask') {
        if (staged(ctx).get(p)?.kind === 'new') {
          // it only ever existed as a staged file: there is nothing on the phone to delete
          staged(ctx).delete(p);
          return { ok: true, result: `Dropped ${p}: it was only staged, never saved to the phone.`, display: { path: p, staged: true } };
        }
        staged(ctx).set(p, { kind: 'delete', after: null });
        return { ok: true, result: `Staged the deletion of ${p} – it is NOT deleted yet. The user will review it when your turn ends.`, display: { path: p, staged: true } };
      }
      const before = ex.size <= MAX_UNDO_BYTES ? await readPhoneFile(f, p, MAX_UNDO_BYTES).catch(() => null) : null;
      await removePhoneFile(f, p);
      ctx.phone.log?.push({ path: p, kind: 'delete', before });
      return { ok: true, result: `Deleted ${p}.`, display: { path: p } };
    }
    default:
      return null;
  }
}

/** Workspace files not yet in the phone folder / newer than what's there – for the "Save to folder" button. */
export const workspaceFiles = (w) => wsList(w);
