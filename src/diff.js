// A small line diff (longest common subsequence) for comparing two versions of a prompt.
/** → [{ t: ' ' | '+' | '-', s }] */
export function lineDiff(a, b) {
  const A = String(a || '').split('\n');
  const B = String(b || '').split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 2_000_000) return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))]; // too big to compare line by line
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) (out.push({ t: ' ', s: A[i] }), i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: A[i++] });
    else out.push({ t: '+', s: B[j++] });
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

export const diffStats = (ops) => ({ added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length });

/** Collapse long unchanged stretches: keeps `ctx` lines around changes. */
export function collapseDiff(ops, ctx = 2) {
  const keep = ops.map((o) => o.t !== ' ');
  const near = keep.map((_, i) => keep.slice(Math.max(0, i - ctx), i + ctx + 1).some(Boolean));
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (near[i]) {
      if (skipped) out.push({ t: '…', s: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ t: '…', s: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}

/** A word-level diff for prose (spaces kept as their own pieces): → [{ t: ' ' | '+' | '-', s }], neighbours merged. */
export function wordDiff(a, b) {
  const A = String(a || '').split(/(\s+)/).filter(Boolean);
  const B = String(b || '').split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 4_000_000) return [{ t: '-', s: A.join('') }, { t: '+', s: B.join('') }];
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (t, s) => (out.length && out[out.length - 1].t === t ? (out[out.length - 1].s += s) : out.push({ t, s }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) (push(' ', A[i]), i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) push('-', A[i++]);
    else push('+', B[j++]);
  }
  while (i < n) push('-', A[i++]);
  while (j < m) push('+', B[j++]);
  return out;
}
