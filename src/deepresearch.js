/**
 * deep_research: one call that does what a careful researcher does – plan several searches, read the best pages,
 * take notes from each with the helper model, look for what is still missing, search again, then write a report with
 * numbered sources. The steps run in the app (searches and page reads side by side), so the main chat only pays for
 * the question and the finished report. The full report is also saved in the workspace.
 */
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const deepResearchDefs = () => [
  fn(
    'deep_research',
    'Research a question thoroughly in one call: several searches from different angles, the best pages read in full, notes taken from each, gaps searched again, and a report with numbered sources. Use it for questions that need many sources (comparisons, "what is the state of…", choosing between options, anything where one search is not enough). It takes a minute or more; for a quick fact use web_search. Returns the report (also saved in /workspace/research/); check its claims against the sources it lists before relying on a detail.',
    {
      question: { type: 'string', description: 'What to find out, with the context that matters (dates, region, what the answer is for)' },
      depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'quick: 3 searches, 4 pages. standard (default): 5 searches, 8 pages, one follow-up round. deep: 8 searches, 14 pages, two follow-up rounds.' },
      focus: { type: 'string', description: 'Optional: what the report must cover or leave out, or the format you want (table, pros/cons…)' },
    },
    ['question'],
  ),
];
export const deepResearchPrompt = () => '- For a question that needs many sources (a comparison, a survey, "what is the best…"), call deep_research once instead of many web_search calls: it searches from several angles, reads the pages, and returns a report with numbered sources.';

const DEPTH = { quick: { queries: 3, pages: 4, rounds: 0 }, standard: { queries: 5, pages: 8, rounds: 1 }, deep: { queries: 8, pages: 14, rounds: 2 } };

/** The JSON array in a model's answer (it may wrap it in a fence or words). */
export function parseList(text, max = 10) {
  const t = String(text || '');
  const m = t.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const a = JSON.parse(m[0]);
      if (Array.isArray(a)) return a.map((x) => String(typeof x === 'string' ? x : x?.query || x?.q || '').trim()).filter(Boolean).slice(0, max);
    } catch {
      /* fall through to lines */
    }
  }
  return t
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter((l) => l && l.length < 200 && !/^(here|sure|queries)/i.test(l))
    .slice(0, max);
}

/** "1. Title\n   https://…\n   text" style results (or anything with URLs) → [{ url, title }] in order, no duplicates. */
export function pickUrls(resultTexts, seen = new Set(), max = 8) {
  const out = [];
  // round-robin over the searches, so every angle gets its best page before any gets its second
  const lists = resultTexts.map((t) => {
    const found = [];
    const lines = String(t || '').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/https?:\/\/[^\s)>\]"']+/g)) {
        const url = m[0].replace(/[.,;]+$/, '');
        const title = (lines[i - 1] || '').replace(/^\s*(?:\d+[.)]|[-*#]+)\s*/, '').trim().slice(0, 120);
        found.push({ url, title: /^https?:/.test(title) ? '' : title });
      }
    });
    return found;
  });
  for (let i = 0; out.length < max && lists.some((l) => l.length > i); i++) {
    for (const l of lists) {
      const x = l[i];
      if (!x || out.length >= max) continue;
      const key = x.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
      const host = key.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      if (seen.has(key) || /\.(png|jpe?g|gif|mp4|zip)$/i.test(key)) continue;
      // at most 2 pages per site: more of the same site is rarely more evidence
      if ([...seen].filter((k) => k.includes('//' + host) || k.includes('//www.' + host)).length >= 2) continue;
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'research';

/**
 * ctx.delegate(prompt, signal, { mode: 'none' }) → { text } (the helper model); callTool(name, args) → { ok, result };
 * ctx.onStatus, ctx.signal, ctx.saveReport(path, text).
 */
// What kind of source a page is. The note-taker (which reads the page) says it; the address only fills in when it does
// not, for the few cases an address settles. Strong sources: official (the organisation, maker or authority itself) and
// primary (original data, research, standards, release notes, the code). The rest is useful but second-hand.
export const KINDS = ['official', 'primary', 'reference', 'news', 'community', 'commercial'];
const STRONG = new Set(['official', 'primary']);
export function kindFromUrl(url) {
  let h = '';
  let path = '';
  try {
    const u = new URL(url);
    h = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (/(^|\.)(gov|mil)(\.[a-z]{2})?$|(^|\.)europa\.eu$|(^|\.)who\.int$/.test(h)) return 'official';
  if (/(^|\.)(arxiv\.org|doi\.org|ncbi\.nlm\.nih\.gov|pubmed\.|ietf\.org|w3\.org|rfc-editor\.org)$/.test(h) || /\.pdf$/.test(path)) return 'primary';
  if (/(^|\.)(github\.com|gitlab\.com)$/.test(h)) return 'primary';
  if (/(^|\.)(wikipedia\.org|britannica\.com|developer\.mozilla\.org)$/.test(h)) return 'reference';
  if (/(^|\.)(reddit\.com|stackoverflow\.com|stackexchange\.com|quora\.com|medium\.com|news\.ycombinator\.com|substack\.com|discord\.com|x\.com|twitter\.com)$/.test(h)) return 'community';
  return 'other';
}
/** The note-taker's first line "KIND: x" → { kind, text without it } (the address decides when the line is missing). */
export function splitKind(note, url) {
  const m = /^\s*KIND:\s*([a-z]+)\s*\n?/i.exec(note || '');
  const said = m && KINDS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : '';
  return { kind: said || kindFromUrl(url), text: (m ? note.slice(m[0].length) : note || '').trim() };
}
/** "2 official, 1 primary, 3 community" and whether a strong source is among them. */
export function coverage(notes) {
  const count = {};
  for (const n of notes) count[n.kind] = (count[n.kind] || 0) + 1;
  const line = [...KINDS, 'other'].filter((k) => count[k]).map((k) => `${count[k]} ${k}`).join(', ');
  return { line, strong: notes.some((n) => STRONG.has(n.kind)), count };
}

export async function runDeepResearch(args, ctx, callTool) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required');
  if (!ctx.delegate) return { ok: false, result: 'deep_research needs the helper model (Settings › Tools & agent › Use a helper model).', display: { error: 'unavailable' } };
  const d = DEPTH[args.depth] || DEPTH.standard;
  const focus = String(args.focus || '').trim();
  const ask = async (prompt) => (await ctx.delegate(prompt, ctx.signal, { mode: 'none' })).text || '';
  const today = new Date().toISOString().slice(0, 10);
  const stopped = () => ctx.signal?.aborted;
  const notes = []; // { n, url, title, text }
  const seen = new Set();
  const asked = [];
  const failed = [];

  const round = async (queries, pages) => {
    asked.push(...queries);
    ctx.onStatus?.(`Searching (${queries.length} angles)…`);
    const results = await Promise.all(queries.map((q) => callTool('web_search', { query: q, num_results: 6 }).then((r) => (r.ok ? r.result : ''), () => '')));
    if (stopped()) return;
    const urls = pickUrls(results, seen, pages);
    if (!urls.length) return;
    let done = 0;
    ctx.onStatus?.(`Reading ${urls.length} pages…`);
    await Promise.all(
      urls.map(async (u) => {
        try {
          const page = await callTool('fetch_url', { urls: [u.url], max_chars: 9000 });
          const text = page.ok ? String(page.result || '') : '';
          if (text.length < 300) return failed.push(u.url);
          const note = await ask(
            `You are taking research notes. Question: ${question}${focus ? `\nFocus: ${focus}` : ''}\n\nFirst line: KIND: one of official (the organisation, maker or authority the question is about, speaking for itself), primary (original data, research paper, standard, release notes, the code itself), reference (encyclopedia, documentation hub), news (journalism), community (forum, Q&A, personal blog, social media), commercial (selling or reviewing for sale, affiliate). Then, from the page below, write down ONLY what helps answer the question: concrete facts, numbers, dates, names, direct short quotes, and the page's own caveats. Say when the page is dated, an opinion, or selling something. At most 180 words, as bullets. If the page has nothing useful, answer exactly: NOTHING\n\nPage: ${u.url}\n---\n${text.slice(0, 9000)}`,
          );
          if (note.trim() && !/^\s*(KIND:[^\n]*\n\s*)?NOTHING\b/i.test(note)) {
            const { kind, text: body } = splitKind(note, u.url);
            if (body) notes.push({ url: u.url, title: u.title, kind, text: body.slice(0, 1600) });
          }
        } catch {
          failed.push(u.url);
        } finally {
          ctx.onStatus?.(`Reading pages… ${++done}/${urls.length}`);
        }
      }),
    );
  };

  ctx.onStatus?.('Planning the searches…');
  const plan = parseList(
    await ask(
      `Today is ${today}. Plan a web research for this question:\n${question}${focus ? `\nFocus: ${focus}` : ''}\n\nWrite ${d.queries} search queries that together cover it from different angles (the basics, the newest developments, numbers or benchmarks, criticism or downsides, primary sources). Each one a real search-engine query, specific, no duplicates. Answer with a JSON array of strings only.`,
    ),
    d.queries,
  );
  await round(plan.length ? plan : [question], d.pages);

  for (let r = 0; r < d.rounds && !stopped() && notes.length; r++) {
    ctx.onStatus?.('Looking for what is still missing…');
    const more = parseList(
      await ask(
        `Question: ${question}${focus ? `\nFocus: ${focus}` : ''}\n\nNotes so far:\n${notes.map((n, i) => `[${i + 1}] ${n.text}`).join('\n\n').slice(0, 14000)}\n\nSearches already done: ${asked.join(' | ')}\n\nWhat is still missing, contradictory or only claimed by one source? Write up to ${Math.ceil(d.queries / 2)} NEW search queries that would settle it. If the notes already answer the question well, answer []. JSON array of strings only.`,
      ),
      Math.ceil(d.queries / 2),
    );
    if (!more.length) break;
    await round(more, Math.ceil(d.pages / 2));
  }
  // not finished while there is no strong source, or too few useful ones: one more round aimed at exactly that
  let cov = coverage(notes);
  let extra = '';
  if (!stopped() && (!cov.strong || notes.length < 3)) {
    ctx.onStatus?.(!cov.strong ? 'Looking for official or primary sources…' : 'Looking for more sources…');
    const want = !cov.strong
      ? 'None of the sources so far is official (the organisation, maker or authority itself) or primary (original data, papers, standards, release notes, the code). Write searches that find exactly those for this question – the official site or documentation, the paper, the dataset, the announcement.'
      : 'Too few useful sources were found. Write broader or differently-worded searches.';
    const more = parseList(await ask(`Question: ${question}${focus ? `\nFocus: ${focus}` : ''}\n\n${want}\nSearches already done: ${asked.join(' | ')}\nUp to 3 NEW queries, JSON array of strings only.`), 3);
    if (more.length) {
      await round(more, Math.max(3, Math.ceil(d.pages / 2)));
      const before = cov;
      cov = coverage(notes);
      extra = !before.strong && cov.strong ? ' An extra round found official or primary sources.' : !cov.strong ? ' An extra round looked for official or primary sources and found none.' : '';
    }
  }
  if (stopped()) return { ok: false, result: 'Stopped.', display: { error: 'stopped' } };
  if (!notes.length) return { ok: false, result: `No readable sources were found for this question (searched: ${asked.join(' | ') || 'nothing'}). Try web_search with other words, or the browser tool for pages that need JavaScript or a sign-in.`, display: { error: 'no sources', path: question.slice(0, 60) } };

  notes.forEach((n, i) => (n.n = i + 1));
  ctx.onStatus?.(`Writing the report from ${notes.length} sources…`);
  const report = (
    await ask(
      `Write a research report that answers this question, using ONLY the notes below.\nQuestion: ${question}${focus ? `\nFocus / format: ${focus}` : ''}\nToday: ${today}\nSources by kind: ${cov.line}${cov.strong ? '' : ' – NO official or primary source was found'}.\n\nRules:\n- Start with the answer in 2–4 sentences.\n- Then the detail, in sections with short headings; use a table when comparing things.\n- Put the source number after every claim, like [3] or [1][4]. Never cite a number that is not in the notes.\n- Prefer official and primary sources. When a claim rests only on community or commercial sources, say so in the sentence.${cov.strong ? '' : '\n- Say near the top that no official or primary source was found, so the answer rests on second-hand sources.'}\n- Say where sources disagree, what is uncertain, and what the notes could not answer.\n- No sources list at the end (it is added for you). No filler.\n\nNotes:\n${notes.map((n) => `[${n.n}] (${n.kind}) ${n.url}\n${n.text}`).join('\n\n')}`,
    )
  ).trim();
  // the list holds the sources the notes came from – the ones the report could cite – each with its kind
  const sources = notes.map((n) => `[${n.n}] ${n.title ? n.title + ' – ' : ''}${n.url} (${n.kind})`).join('\n');
  const full = `# ${question}\n\n${report}\n\n## Sources\n${sources}\n\n---\nResearched ${today}: ${asked.length} searches, ${notes.length} sources read (${cov.line})${failed.length ? `, ${failed.length} pages could not be read` : ''}.${extra}`;
  let saved = '';
  try {
    saved = ctx.saveReport ? ctx.saveReport(`research/${slug(question)}.md`, full) : '';
  } catch {
    /* no workspace */
  }
  return {
    ok: true,
    result: `${full}${saved ? `\n\nSaved as /workspace/${saved}.` : ''}\n\nThe report was written by the helper model from its notes: check a detail against its source before relying on it.`,
    display: { path: question.slice(0, 80), count: notes.length, urls: notes.map((n) => n.url), files: saved ? [saved] : [], output: report.slice(0, 4000) },
  };
}
