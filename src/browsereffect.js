// What a browser action changed, in one line, plus two checks on a page snapshot (the object window.__ocmB.snapshot
// returns: {url, title, elements[], text, textFrom, overlay, dialogs}). Pure: no browser, no state.

/** An element line without its "[n]" number, which changes after every action. */
const bare = (l) => String(l).replace(/^\[\d+\]\s*/, '').trim();
const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const counts = (els) => {
  const m = new Map();
  for (const l of els || []) {
    const k = bare(l);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};

/** One line saying what changed between two snapshots of the same tab. */
export function effectOf(prev, next) {
  if (!prev || !next) return '';
  const out = [];
  if (prev.url !== next.url) out.push(`address changed ${short(String(prev.url || ''), 60)} → ${short(String(next.url || ''), 60)}`);
  if ((prev.title || '') !== (next.title || '')) out.push(`title changed ${JSON.stringify(short(prev.title || '', 40))} → ${JSON.stringify(short(next.title || '', 40))}`);
  const a = counts(prev.elements);
  const b = counts(next.elements);
  const added = [];
  let gone = 0;
  for (const [k, n] of b) for (let i = a.get(k) || 0; i < n; i++) added.push(k);
  for (const [k, n] of a) gone += Math.max(0, n - (b.get(k) || 0));
  if (added.length) out.push(`${added.length} new element${added.length === 1 ? '' : 's'} (${added.slice(0, 3).map((k) => short(k, 40)).join(', ')}${added.length > 3 ? ', …' : ''})`);
  if (gone) out.push(`${gone} gone`);
  if (next.overlay && !prev.overlay) out.push('a popup appeared');
  else if (!next.overlay && prev.overlay) out.push('the popup went away');
  if (next.dialogs?.length) out.push(`${next.dialogs.length} alert/confirm box${next.dialogs.length === 1 ? '' : 'es'} shown`);
  if (!out.length && (prev.text || '') !== (next.text || '')) out.push('the page text changed');
  return `Effect: ${out.length ? out.join('; ') : 'nothing visible changed'}`;
}

/** Is the page text the same as in the last result (same address, same text, both from its start)? */
export function sameText(prev, next) {
  if (!prev || !next) return false;
  return prev.url === next.url && (prev.textFrom | 0) === (next.textFrom | 0) && String(prev.text ?? '') === String(next.text ?? '') && String(next.text ?? '') !== '';
}

const HOSTS = /(hcaptcha\.com|challenges\.cloudflare\.com|recaptcha|turnstile|geetest|funcaptcha|arkoselabs)/i;
const WORDS = /(just a moment|verify (that )?you are (a )?human|are you a robot|attention required|checking your browser|security check)/i;

/** null, or a short reason when the page is a CAPTCHA or bot-check. */
export function challengeOf(next) {
  if (!next) return null;
  for (const l of next.elements || []) {
    if (/^\[frame\]/.test(String(l)) && HOSTS.test(l)) return `a ${String(l).match(HOSTS)[1]} frame is on the page`;
  }
  if (WORDS.test(next.title || '')) return `the page title is "${short(next.title, 60)}"`;
  const t = String(next.text || '').slice(0, 1500);
  const m = WORDS.exec(t);
  if (m) return `the page says "${m[1]}"`;
  return null;
}
