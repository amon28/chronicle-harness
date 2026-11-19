// The chat's files as folders: a long flat list of 58 paths becomes a few folders you open when you need them.

/** files: [{ path, size, mtime }] → { name, path, dirs: [node], files: [file], count, size, mtime } (sorted) */
export function buildTree(files, sort = 'name') {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0, size: 0, mtime: 0 };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    const chain = [root];
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], count: 0, size: 0, mtime: 0 });
      node = node.dirs.get(parts[i]);
      chain.push(node);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] || f.path });
    for (const n of chain) {
      n.count++;
      n.size += f.size || 0;
      n.mtime = Math.max(n.mtime, f.mtime || 0);
    }
  }
  const order = sorter(sort);
  const finish = (n) => ({ ...n, dirs: [...n.dirs.values()].map(finish).sort(order), files: n.files.sort(order) });
  return finish(root);
}

/** name: a→z (folders and files alike); newest: last changed first; size: biggest first */
export function sorter(sort) {
  if (sort === 'newest') return (a, b) => (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name);
  if (sort === 'size') return (a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name);
  return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** Files whose path holds every word of the query (any order, any case). */
export function filterFiles(files, query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return files;
  return files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w)));
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" – or '' when the time is not known. */
export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
