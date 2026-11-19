// Story map: how a chat branched. Pure helpers; the screen is in app/storymap-ui.js.

/** The chat tree around `cur`: the root it came from, and everything forked from it, as nested nodes. */
export function forkTree(convs, cur) {
  const byId = new Map(convs.map((c) => [c.id, c]));
  if (!byId.has(cur.id)) byId.set(cur.id, cur);
  let root = byId.get(cur.id);
  const seen = new Set([root.id]);
  while (root.forkOf && byId.has(root.forkOf.id) && !seen.has(root.forkOf.id)) {
    root = byId.get(root.forkOf.id);
    seen.add(root.id);
  }
  const kids = new Map();
  for (const c of byId.values()) if (c.forkOf?.id && byId.has(c.forkOf.id)) kids.set(c.forkOf.id, [...(kids.get(c.forkOf.id) || []), c]);
  const build = (c, depth, guard) => ({
    id: c.id,
    title: c.title || 'Chat',
    at: c.forkOf?.at ?? null,
    messages: c.messages?.length || 0,
    current: c.id === cur.id,
    depth,
    children: depth > 12 ? [] : (kids.get(c.id) || []).filter((k) => !guard.has(k.id)).sort((a, b) => (a.forkOf.at ?? 0) - (b.forkOf.at ?? 0) || (a.createdAt || 0) - (b.createdAt || 0)).map((k) => build(k, depth + 1, new Set([...guard, k.id]))),
  });
  return build(root, 0, new Set([root.id]));
}

/** Flatten a tree into rows for display. */
export function flattenTree(node, out = []) {
  out.push(node);
  node.children.forEach((c) => flattenTree(c, out));
  return out;
}

const snip = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 90);
/** How many places with other versions hide inside the messages kept with a version (its "tail"). */
const hiddenForks = (tail) => (tail || []).reduce((n, m) => n + (m.versions?.length > 1 || m.alts?.length > 1 ? 1 : 0) + (m.versions || []).reduce((k, v) => k + hiddenForks(v.tail), 0) + (m.alts || []).reduce((k, a) => k + hiddenForks(a.tail), 0), 0);

/**
 * The places in this chat where the story forked inside the chat itself: a reply you retried (kind 'retry', its
 * swipes) or a message of yours you edited and sent again (kind 'edit'). Each lists its versions with what followed.
 * → [{ index, kind, role, count, shown, snippet, options: [{ n, current, snippet, after, forks }] }]
 */
export function alternates(conv) {
  const out = [];
  const msgs = conv.messages || [];
  msgs.forEach((m, index) => {
    const here = msgs.length - index - 1;
    const add = (kind, list, cur) => {
      if (!(list?.length > 1)) return;
      out.push({
        index,
        kind,
        role: m.role,
        count: list.length,
        shown: cur + 1,
        snippet: snip(m.content),
        options: list.map((v, n) => ({ n, current: n === cur, snippet: snip(n === cur ? m.content : typeof v === 'string' ? v : v?.content), after: n === cur ? here : v?.tail?.length || 0, forks: n === cur ? 0 : hiddenForks(v?.tail) })),
      });
    };
    add('edit', m.versions, m.vIndex ?? (m.versions?.length || 1) - 1);
    add('retry', m.alts, m.altIndex ?? 0);
  });
  return out;
}
