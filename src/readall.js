// Reads a whole document from a page that only keeps the screens near the viewport in the DOM (Notion and similar).
// Scrolls screen by screen, waits for each screen to settle, and merges by BLOCK ID (or, on pages without block ids, by
// exact text overlap). Repeated headings in the source are kept; only the overlap between two screens is removed.
// `run(expr)` evaluates an expression in the page and returns the parsed value.

/** Longest suffix of `buf` (searched in its last 4000 chars) equal to a prefix of `next`, ≥ 20 chars; → text to append. */
export function overlapAppend(buf, next) {
  if (!buf) return next;
  const tail = buf.slice(-4000);
  for (let k = Math.min(tail.length, next.length); k >= 20; k--) {
    if (tail.endsWith(next.slice(0, k))) return next.slice(k);
  }
  return `\n${next}`;
}

export async function readAll(run, { say = () => {}, sleep, maxScreens = 200 } = {}) {
  const y0 = (await run('window.__ocmB.chunk()'))?.y || 0;
  await run("window.__ocmB.scroll('top')");
  await sleep(400);
  const order = [];
  const map = new Map();
  let raw = '';
  const screens = [];
  const gaps = [];
  let sawBottom = false;
  let stuck = 0;
  let lastY = -1;

  // sample the screen once its height and position stop changing (a virtual list is still mounting before that)
  const sample = async () => {
    let prev = null;
    let c = null;
    for (let t = 0; t < 7; t++) {
      c = await run('window.__ocmB.chunk()');
      if (prev && c.h === prev.h && c.y === prev.y && c.n === prev.n) break;
      prev = c;
      await sleep(120);
    }
    return c;
  };
  const merge = (c, i) => {
    let added = 0;
    let gap = false;
    if (c.hasBlocks) {
      const items = c.items;
      const j = items.findIndex(([id]) => map.has(id));
      if (j < 0 && order.length) {
        gap = true;
        for (const [id, t] of items) if (!map.has(id)) (map.set(id, t), order.push(id), added++);
      } else {
        let anchor = j < 0 ? -1 : order.indexOf(items[j][0]);
        for (let k = j < 0 ? 0 : j - 1; k >= 0 && j >= 0; k--) {
          const [id, t] = items[k];
          if (map.has(id)) break;
          map.set(id, t);
          order.splice(anchor, 0, id); // blocks above the first known one
          added++;
          anchor = order.indexOf(id);
        }
        let at = j < 0 ? order.length - 1 : order.indexOf(items[j][0]);
        for (let k = j < 0 ? 0 : j + 1; k < items.length; k++) {
          const [id, t] = items[k];
          if (map.has(id)) {
            at = order.indexOf(id);
            continue;
          }
          map.set(id, t);
          order.splice(at + 1, 0, id);
          at++;
          added++;
        }
      }
    } else {
      const before = raw.length;
      raw += overlapAppend(raw, c.raw || '');
      added = raw.length - before;
    }
    return { added, gap };
  };

  let step = 0;
  for (let i = 0; i < maxScreens; i++) {
    const c = await sample();
    step = Math.max(150, Math.round((c.view || 600) * 0.7));
    const m1 = merge(c, i);
    let { added, gap } = m1;
    if (gap && i > 0) {
      // jumped past what was mounted: go back up half a screen and look again
      await run(`window.__ocmB.scroll('down',null,${-Math.round(step * 0.7)})`);
      await sleep(350);
      const c2 = await sample();
      const r2 = merge(c2, i);
      added += r2.added;
      gap = r2.gap && !c2.items.some(([id]) => map.has(id));
      if (gap) gaps.push(Math.round(c.y));
    }
    screens.push({ i, y: Math.round(c.y), blocks: c.items?.length || 0, added });
    if (i % 8 === 7) say(`Reading the whole page… (${order.length || raw.length} ${order.length ? 'blocks' : 'characters'})`);
    if (c.atBottom) {
      if (sawBottom && added === 0) break;
      sawBottom = true;
    } else sawBottom = false;
    stuck = c.y === lastY ? stuck + 1 : 0;
    lastY = c.y;
    if (stuck >= 3) break;
    await run(`window.__ocmB.scroll('down',null,${step})`);
    await sleep(150);
  }
  await run(`window.__ocmB.scroll('down',${y0 | 0})`);
  const text = order.length ? order.map((id) => map.get(id)).filter(Boolean).join('\n') : raw;
  return { text, complete: sawBottom && stuck < 3 && gaps.length === 0, screens, gaps, blocks: order.length };
}
