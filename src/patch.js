// apply_patch: the patch format Codex-style models are trained on (also plain unified diffs), applied to the workspace.
//   *** Begin Patch
//   *** Add File: path        (every line starts with +)
//   *** Update File: path     (optionally *** Move to: new/path), then hunks: "@@ …" headers and lines starting ' ', '-', '+'
//   *** Delete File: path
//   *** End Patch
// Hunks are found by their context and removed lines, in order; trailing whitespace may differ. All or nothing.

/** → [{ op: 'add'|'update'|'delete', path, moveTo?, lines?: string[], hunks?: [[{ t, s }]] }] */
export function parsePatch(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  if (/^\*\*\* Begin Patch/m.test(src)) return parseCodex(src);
  if (/^(---|\+\+\+) /m.test(src)) return parseUnified(src);
  throw new Error('Not a patch: start with "*** Begin Patch" (or give a unified diff with ---/+++ lines).');
}

function parseCodex(src) {
  const lines = src.split('\n');
  const ops = [];
  let cur = null;
  let hunk = null;
  for (const line of lines) {
    let m;
    if (/^\*\*\* (Begin|End) Patch/.test(line) || /^\*\*\* End of File/.test(line)) continue;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) ops.push((cur = { op: 'add', path: m[1].trim(), lines: [] }));
    else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) ops.push((cur = { op: 'delete', path: m[1].trim() }));
    else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      ops.push((cur = { op: 'update', path: m[1].trim(), hunks: [] }));
      hunk = null;
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur?.op === 'update') cur.moveTo = m[1].trim();
    else if (cur?.op === 'add') {
      if (line.startsWith('+')) cur.lines.push(line.slice(1));
      else if (line.trim()) throw new Error(`In "Add File: ${cur.path}" every line must start with "+": ${line.slice(0, 60)}`);
    } else if (cur?.op === 'update') {
      if (line.startsWith('@@')) cur.hunks.push((hunk = []));
      else if (/^[ +-]/.test(line) || line === '') {
        if (!hunk) cur.hunks.push((hunk = []));
        hunk.push({ t: line === '' ? ' ' : line[0], s: line.slice(1) });
      } else throw new Error(`Unexpected line in "Update File: ${cur.path}": ${line.slice(0, 60)}`);
    } else if (line.trim()) throw new Error(`Unexpected line outside a file section: ${line.slice(0, 60)}`);
  }
  for (const o of ops) if (o.op === 'update') o.hunks = o.hunks.map(trimBlankTail).filter((h) => h.some((l) => l.t !== ' '));
  if (!ops.length) throw new Error('The patch has no file sections (*** Add File / *** Update File / *** Delete File).');
  return ops;
}

// a blank line right before the next header is usually just spacing, not a context line
const trimBlankTail = (h) => {
  const out = [...h];
  while (out.length && out[out.length - 1].t === ' ' && out[out.length - 1].s === '') out.pop();
  return out;
};

function parseUnified(src) {
  const ops = [];
  let cur = null;
  let hunk = null;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const from = line.slice(4).replace(/\t.*$/, '').trim().replace(/^a\//, '');
      const to = lines[i + 1].slice(4).replace(/\t.*$/, '').trim().replace(/^b\//, '');
      i++;
      if (from === '/dev/null') ops.push((cur = { op: 'add', path: to, lines: [], unified: true }));
      else if (to === '/dev/null') ops.push((cur = { op: 'delete', path: from }));
      else ops.push((cur = { op: 'update', path: from, ...(to !== from ? { moveTo: to } : {}), hunks: [] }));
      hunk = null;
    } else if (line.startsWith('@@')) {
      if (cur?.op === 'update') cur.hunks.push((hunk = []));
    } else if (cur && /^[ +-]/.test(line)) {
      if (cur.op === 'add') {
        if (line.startsWith('+')) cur.lines.push(line.slice(1));
      } else if (cur.op === 'update' && hunk) hunk.push({ t: line[0], s: line.slice(1) });
    } else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
  }
  if (!ops.length) throw new Error('No file sections found in the diff.');
  return ops;
}

const same = (a, b) => a === b || a.trimEnd() === b.trimEnd();

/** Apply hunks to a file's text. Throws with the hunk that did not match. */
export function applyHunks(text, hunks, path = 'the file') {
  const eol = text.endsWith('\n');
  const lines = text.split('\n');
  if (eol) lines.pop();
  let pos = 0;
  hunks.forEach((h, n) => {
    const old = h.filter((l) => l.t !== '+').map((l) => l.s);
    const neu = h.filter((l) => l.t !== '-').map((l) => l.s);
    const find = (from) => {
      for (let i = from; i + old.length <= lines.length; i++) if (old.every((s, k) => same(lines[i + k], s))) return i;
      return -1;
    };
    let at = old.length ? find(pos) : lines.length;
    if (at < 0) at = find(0); // hunks out of order
    if (at < 0) throw new Error(`Hunk ${n + 1} of ${path} does not match the file. These lines were expected:\n${old.slice(0, 12).join('\n')}${old.length > 12 ? '\n…' : ''}\nRead the file again and make the patch from its current text.`);
    lines.splice(at, old.length, ...neu);
    pos = at + neu.length;
  });
  return lines.join('\n') + (eol || !text ? '\n' : '');
}
