// Reconcile two views of one tree - a reconciler, not a copy.
//
// "Copy what is new" cannot tell a file that was deleted from a file that was never there, so it
// leaves every file the other side ever held. On this app that is not untidiness: a tool writes a
// session id, a cookie jar or an AES key, deletes it, and the shell keeps a root-owned copy on the
// phone for ever. So each path keeps what both sides last agreed on, and the three cases are told
// apart: changed, deleted, new.
//
// It also refuses to lose data. A transfer that failed half way must never look like an edit: an
// empty copy never replaces content, a short read is not trusted, and when neither side has an
// agreement the newer file wins *and says so* instead of guessing silently.

import { sha256Hex } from './hash.js';

/** Is this side's entry different from what that side last agreed to? */
export function changed(entry, agreed) {
  if (!agreed) return true;
  // the mode is part of the file: a chmod with the same bytes is still a change. Only compared when
  // both sides know the mode, so a state written before they did cannot re-copy everything.
  if (typeof entry.mode === 'number' && typeof agreed.mode === 'number' && (entry.mode & 0o777) !== (agreed.mode & 0o777)) return true;
  if (typeof entry.exec === 'boolean' && typeof agreed.exec === 'boolean' && entry.exec !== agreed.exec) return true;
  if (entry.hash && agreed.hash) return entry.hash !== agreed.hash;
  return entry.size !== agreed.size || (entry.mtime || 0) !== (agreed.mtime || 0);
}

const same = (entry, agreed) => !changed(entry, agreed);

/**
 * "dir/file.txt" -> "dir/file.conflict-other.txt": the edit that is not the file any more (the extension kept, so it
 * still opens as what it is). "other", not a side's name: which side lost says nothing about who wrote it (decision
 * 183 – Claude Code, the user and a helper's shell all write on the same side). taken(name) → a second conflict on the
 * same file gets ".conflict-other-2", so the first copy is not written over.
 */
export function conflictName(p, taken = () => false) {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  const at = (tag) => (dot > slash + 1 ? `${p.slice(0, dot)}.${tag}${p.slice(dot)}` : `${p}.${tag}`);
  let n = 1;
  let name = at('conflict-other');
  while (taken(name) && n < 99) name = at(`conflict-other-${++n}`);
  return name;
}

/**
 * a, b: { list(): Map<path, {size, mtime?, hash?, mode?, exec?}>, read(path), write(path, bytes) -> new entry, remove(path), stat?(path) -> entry|null,
 *         current?(path) -> the entry as it is right now (asked before a delete),
 *         atomic?: true when a file on this side is never half-written (so an empty one is not a failed write) }
 *   A listing may carry .incomplete (a non-empty reason: it did not see the whole tree). Absence from an
 *   incomplete listing proves nothing, so it never turns into a delete on the other side.
 * state: path -> { a?: entry, b?: entry, skipped?: true }  (persisted and passed back by the caller)
 * opts: { fileBytes, totalBytes, prefer: 'a'|'b', ignore?: (path) => bool }
 * -> { up, down, deletedA, deletedB, bytes, skipped: [], deleted: [], conflicts: [], held: [], revived: [], failed: [{path, error}], overwritten: [{path, lost: 'a'|'b'}], incomplete: {a, b} }
 */
export async function reconcile(a, b, state, { fileBytes = 32 * 1024 * 1024, totalBytes = 128 * 1024 * 1024, prefer = 'a', ignore = null } = {}) {
  const A = await a.list();
  const B = await b.list();
  const out = { up: 0, down: 0, deletedA: 0, deletedB: 0, bytes: 0, skipped: [], deleted: [], conflicts: [], why: [], cleared: [], undeletable: [], failed: [], overwritten: [], merged: [], empty: [], held: [], revived: [], incomplete: { a: A.incomplete || '', b: B.incomplete || '' }, excluded: [...(A.excluded || []), ...(B.excluded || [])] };

  // A delete is only a delete when the name is gone afterwards: a side that can say whether the path
  // still exists (has) is asked, so "deleted on both sides" can no longer be printed over a survivor.
  const removeChecked = async (side, p) => {
    try {
      await side.remove(p);
      if (side.has && (await side.has(p))) throw new Error('still there');
      return true;
    } catch {
      out.undeletable.push(p);
      return false;
    }
  };

  const appendMerge = async (p, ea, eb, st) => {
    const n = st.a?.size;
    const baseHash = st.a?.hash || st.b?.hash;
    if (!baseHash || n == null || st.b?.size !== n || !(ea.size > n && eb.size > n) || ea.size + eb.size > 4 * 1024 * 1024) return false;
    try {
      const ba = await a.read(p);
      const bb = await b.read(p);
      if (ba.byteLength !== ea.size || bb.byteLength !== eb.size) return false;
      for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return false;
      const tailA = ba.subarray(n);
      const tailB = bb.subarray(n);
      if (tailA.includes(0) || tailB.includes(0) || (await sha256Hex(ba.subarray(0, n))) !== baseHash) return false; // text only, on the agreed base
      const [first, second] = (ea.mtime || 0) <= (eb.mtime || 0) ? [tailA, tailB] : [tailB, tailA];
      const merged = new Uint8Array(n + first.length + second.length);
      merged.set(ba.subarray(0, n));
      merged.set(first, n);
      merged.set(second, n + first.length);
      const hash = await sha256Hex(merged);
      const t = Date.now();
      const afterA = await a.write(p, merged, { ...ea, mtime: t });
      const afterB = await b.write(p, merged, { ...eb, mtime: t });
      state[p] = { a: afterA || { size: merged.byteLength, mtime: t, hash }, b: afterB || { size: merged.byteLength, mtime: t, hash }, skipped: false };
      out.merged.push(p);
      out.bytes += merged.byteLength;
      return true;
    } catch {
      return false; // could not: the conflict copy below keeps both
    }
  };

  // the newer, longer copy starts with every byte of the other one: it is that copy, appended to. Copied over it.
  const grewFrom = async (p, ea, eb) => {
    const [big, bigE, small, smallE, dir] = ea.size > eb.size ? [a, ea, b, eb, 'up'] : [b, eb, a, ea, 'down'];
    if (bigE.size === smallE.size || (bigE.mtime || 0) < (smallE.mtime || 0) || bigE.size > 4 * 1024 * 1024) return false;
    try {
      const bb = await big.read(p);
      const sb = await small.read(p);
      if (bb.byteLength !== bigE.size || sb.byteLength !== smallE.size) return false;
      for (let i = 0; i < sb.byteLength; i++) if (bb[i] !== sb[i]) return false;
    } catch {
      return false;
    }
    await copy(p, big, small, bigE, dir);
    return true;
  };

  const raced = new Set(); // written on the target side after it was listed: decided again with what is there now
  let again = false; // the second look: a race there is said and left for the next sync
  const copy = async (p, from, to, entry, direction) => {
    const target = direction === 'up' ? 'b' : 'a';
    const source = direction === 'up' ? 'a' : 'b';
    const known = state[p] || {};
    // the listing is a moment old: a write on the target side since then (a helper's shell writing the file while the
    // app's copy goes in) is newer than what this copy was decided on – it is never written over blind
    const listed = (direction === 'up' ? B : A).get(p);
    const look = to.current || to.stat;
    if (look) {
      const now = await look(p).catch(() => undefined);
      if (now !== undefined && (!!now !== !!listed || (now && listed && changed(now, listed)))) {
        if (!again) raced.add(p);
        else (out.conflicts.push(p), out.why.push({ path: p, kind: 'racing' }));
        return;
      }
    }
    if (entry.size > fileBytes || out.bytes + entry.size > totalBytes) {
      // remember it as refused at this identity: an unchanged file costs nothing next time
      state[p] = { ...known, [source]: entry, skipped: true };
      out.skipped.push(p);
      // An empty file under the same name on the other side is not a copy, it is a name with nothing
      // behind it: a script gating on [ -e ] would proceed, and it would "disagree" with the real file
      // on every later call. Remove it, and forget that side, so the refusal is said once and the
      // path is one side's file only (which a delete then clears like any other).
      const there = (direction === 'up' ? B : A).get(p);
      if (there && there.size === 0) {
        if (await removeChecked(to, p)) {
          state[p] = { [source]: entry, skipped: true };
          out.cleared.push(p);
        }
        out.conflicts = out.conflicts.filter((c) => c !== p); // the refusal already says it
      }
      return;
    }
    const bytes = await from.read(p);
    if (bytes.byteLength > entry.size && bytes.byteLength <= fileBytes) {
      // it grew between listing it and reading it (a log, a heartbeat appended to every second): what was read is
      // the newer state – it crosses as read, without a warning; the next sync takes whatever came after
      const { hash: _stale, ...rest } = entry;
      entry = { ...rest, size: bytes.byteLength };
    } else if (bytes.byteLength !== entry.size) {
      // it shrank or was replaced between listing and reading: try again next time, touch nothing
      out.conflicts.push(p);
      out.why.push({ path: p, kind: 'racing' });
      return;
    }
    // carry what the listing cannot see (the permission bits live on the file, not in the name or
    // size). A listing that already reports them is preferred: one fewer call, and no chance of
    // reading a mode that changed in between.
    const mode = typeof entry.mode === 'number' ? entry.mode & 0o777 : undefined;
    const exec = mode !== undefined ? (mode & 0o111) !== 0 : typeof entry.exec === 'boolean' ? entry.exec : from.exec ? await from.exec(p).catch(() => false) : undefined;
    const meta = {};
    if (exec !== undefined) meta.exec = exec;
    if (mode !== undefined) meta.mode = mode;
    const after = await to.write(p, bytes, { ...entry, ...meta });
    if (after && after.size !== bytes.byteLength) {
      await to.remove(p);
      throw new Error('a short write on ' + p + ': ' + after.size + ' of ' + bytes.byteLength + ' bytes');
    }
    // an empty file is legal, but it is also what every failed write looks like: say it crossed, and
    // who wrote it, so a placeholder can be traced to where it was made instead of guessed at
    if (bytes.byteLength === 0) out.empty.push({ path: p, from: entry.by || (direction === 'up' ? 'the app' : 'the shell') });
    state[p] = { ...known, [source]: entry, [target]: after || entry, skipped: false };
    out.bytes += bytes.byteLength;
    out[direction]++;
  };

  // Deletes first. A name is a file or a folder, never both: when one side replaced the folder docs/ with a file
  // docs (or a file with a folder), the new one cannot be written until the old one is gone. So the paths that only
  // one side still has, and that both agreed on before, go first.
  const all = [...new Set([...A.keys(), ...B.keys(), ...Object.keys(state || {})])];
  const goes = (p) => A.has(p) !== B.has(p) && !!(state[p]?.a && state[p]?.b);
  const paths = [...all.filter(goes), ...all.filter((p) => !goes(p))];

  const one = async (p) => {
    // a directory one side does not mirror: neither copied nor deleted, on either side
    if (ignore && ignore(p)) {
      delete state[p];
      return;
    }
    let ea = A.get(p);
    let eb = B.get(p);
    const st = state[p] || {};
    // a listing that stopped early (a cap, an unreadable directory) did not say this path is gone: ask for it by name
    if (!eb && out.incomplete.b && b.stat && (ea || st.b)) eb = (await b.stat(p).catch(() => null)) || undefined;
    if (!ea && out.incomplete.a && a.stat && (eb || st.a)) ea = (await a.stat(p).catch(() => null)) || undefined;

    if (!ea && !eb) {
      if (!out.incomplete.a && !out.incomplete.b) delete state[p];
      return;
    }

    if (ea && eb) {
      const aSame = same(ea, st.a);
      const bSame = same(eb, st.b);
      if (aSame && bSame) return;

      // 1. an empty copy is a failed transfer, not an edit: put the content back.
      // Except on a side that replaces a file whole or not at all (atomic: the app's memory): there an empty file
      // that changed since both sides agreed, while the other did not, was made empty on purpose - it is an edit.
      const emptied = (side, mineSame, otherSame) => !!(side.atomic && st.a && st.b && !mineSame && otherSame);
      if (ea.size === 0 && eb.size > 0 && emptied(a, aSame, bSame)) {
        await copy(p, a, b, ea, 'up');
        return;
      }
      if (eb.size === 0 && ea.size > 0 && emptied(b, bSame, aSame)) {
        await copy(p, b, a, eb, 'down');
        return;
      }
      // never agreed on yet: an empty copy is "nothing there yet" (a file just created, a log not written to so far),
      // not a disagreement – the content crosses, and there is nothing to warn about
      const fresh = !st.a || !st.b;
      // an empty copy that is still the empty file both sides agreed on (created, then appended to on the other side)
      // is not news either: only a copy that BECAME empty since – a failed write – is said
      if (ea.size === 0 && eb.size > 0) {
        if (!fresh && !aSame) (out.conflicts.push(p), out.why.push({ path: p, kind: 'emptied', lost: 'a' }));
        await copy(p, b, a, eb, 'down');
        return;
      }
      if (eb.size === 0 && ea.size > 0) {
        if (!fresh && !bSame) (out.conflicts.push(p), out.why.push({ path: p, kind: 'emptied', lost: 'b' }));
        await copy(p, a, b, ea, 'up');
        return;
      }
      // a file that only grew (a log, a heartbeat): the newer copy is the older one with more at the end – it is
      // taken, quietly, since nothing in the other copy is lost
      if (fresh && (await grewFrom(p, ea, eb))) return;
      // 2. no agreement on this path yet and both sides have content: the newer one wins, out loud
      if (fresh) {
        out.conflicts.push(p);
        const aNew = ea.mtime || 0;
        const bNew = eb.mtime || 0;
        const aWins = aNew > bNew || (aNew === bNew && prefer === 'a');
        out.why.push({ path: p, kind: 'first', lost: aWins ? 'b' : 'a', lostBytes: aWins ? eb.size : ea.size });
        await (aWins ? copy(p, a, b, ea, 'up') : copy(p, b, a, eb, 'down'));
        return;
      }
      // 3. a real edit: the caller decides which surface is the newer one
      if (!aSame && bSame) await copy(p, a, b, ea, 'up');
      else if (aSame && !bSame) await copy(p, b, a, eb, 'down');
      else {
        // changed on BOTH sides since they agreed: one edit is about to be replaced. Which one is the caller's rule;
        // that it happened is never silent - an acknowledged write that no longer exists has to be said.
        // the losing side's version is not thrown away (decision 182): it is kept beside the file as
        // <name>.conflict-other.<ext> on that side, and crosses to the other side with the next sync like any new file
        // …unless both sides only added to the end of the version they agreed on (two appends to a log, decision 183):
        // then both additions are kept in one file, the older first – nothing is lost and there is nothing to merge
        if (await appendMerge(p, ea, eb, st)) return;
        // the newer write wins when both dates are real clock times (both sides are on the phone's clock); otherwise
        // the caller's rule. An older copy arriving after a newer local write never replaces it.
        const aT = ea.mtime || 0;
        const bT = eb.mtime || 0;
        const aWins = aT > 1e12 && bT > 1e12 && aT !== bT ? aT > bT : prefer === 'a';
        const loser = aWins ? b : a;
        const keptAs = conflictName(p, (n) => A.has(n) || B.has(n));
        let kept = '';
        try {
          const bytes = await loser.read(p);
          await loser.write(keptAs, bytes, { ...(aWins ? eb : ea) });
          kept = keptAs;
        } catch {
          /* could not keep it: said as before, without a copy */
        }
        out.overwritten.push({ path: p, lost: aWins ? 'b' : 'a', ...(kept ? { kept } : {}) });
        await (aWins ? copy(p, a, b, ea, 'up') : copy(p, b, a, eb, 'down'));
      }
      return;
    }

    // one side only: new here, or deleted there
    const onA = !!ea;
    const entry = ea || eb;
    const agreed = onA ? st.a : st.b;
    if (agreed && st.skipped && same(entry, agreed)) return; // refused before and unchanged: no tax, no noise
    // the other side had a real file here and deleted it, and this side only ever held an empty name
    // for it (a refused copy's placeholder): the delete reaches the name, it does not need a pair
    const placeholder = entry.size === 0 && (onA ? st.b : st.a) && st.skipped;
    if ((st.a && st.b) || placeholder) {
      // both sides agreed on this path before, and only one still has it: it was deleted there - but only
      // a COMPLETE listing can say "not there". From one that stopped early this is "not seen": keep
      // both the file and the agreement, and decide when the listing is whole again.
      if (onA ? out.incomplete.b : out.incomplete.a) {
        out.held.push(p);
        return;
      }
      // changed here after the agreement and deleted there: the edit is newer than the delete, so it is
      // not lost - it goes back to the side that deleted it, and that is said
      if (!placeholder && !same(entry, agreed)) {
        delete state[p];
        out.revived.push(p);
        await copy(p, onA ? a : b, onA ? b : a, entry, onA ? 'up' : 'down');
        return;
      }
      // The listing is a moment old. A side that can say what it holds NOW (current) is asked before its file is
      // deleted: a write that landed after the listing (write_file while a job's files are collected) is newer than
      // the delete on the other side, and is kept like any file changed after the agreement.
      const side = onA ? a : b;
      const now = side.current ? await side.current(p) : entry;
      if (now && (changed(now, entry) || (now.mtime || 0) !== (entry.mtime || 0))) { // written again, even with the same bytes
        delete state[p];
        out.revived.push(p);
        await copy(p, side, onA ? b : a, now, onA ? 'up' : 'down');
        return;
      }
      if (!(await removeChecked(side, p))) return; // said out loud, and tried again next time
      delete state[p];
      out[onA ? 'deletedA' : 'deletedB']++;
      out.deleted.push(p);
      return;
    }
    // only one side ever had it (or the copy was refused): it is new here, not deleted there
    await copy(p, onA ? a : b, onA ? b : a, entry, onA ? 'up' : 'down');
  };

  for (const p of paths) {
    try {
      await one(p);
    } catch (e) {
      // one file that cannot cross (a name the other side cannot hold, a write that failed) must not stop every
      // file after it: it is said, its agreement is left as it was, and it is tried again next time
      out.failed.push({ path: p, error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  // a path whose target was written while this sync ran: looked at again, both sides as they are now
  if (raced.size) {
    again = true;
    for (const p of raced) {
      try {
        for (const [side, M] of [[a, A], [b, B]]) {
          const look = side.current || side.stat;
          if (!look) continue;
          const e = await look(p);
          if (e) M.set(p, e);
          else M.delete(p);
        }
        // what the first look said about it is replaced by what this one says
        out.conflicts = out.conflicts.filter((c) => c !== p);
        out.why = out.why.filter((x) => x.path !== p);
        out.overwritten = out.overwritten.filter((x) => x.path !== p);
        await one(p);
      } catch (e) {
        out.failed.push({ path: p, error: String((e && e.message) || e).slice(0, 160) });
      }
    }
  }
  return out;
}
