/**
 * Roleplay replies mark actions with *asterisks* and speech with "quotes". Models sometimes forget one of a pair:
 * `*She smiles "Hi."` or `She waves.*`. This closes (or opens) the odd one, paragraph by paragraph, so the colours
 * and the read-aloud filters keep working. Code blocks and list bullets are left alone.
 */
const isSpace = (c) => c === undefined || /\s/.test(c);

/** The positions of the single-asterisk markers in a paragraph (not **bold**, not "* " bullets, not " * "). */
function singles(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '*') continue;
    let j = i;
    while (p[j] === '*') j++;
    const run = j - i;
    const prev = p[i - 1];
    const next = p[j];
    if (run === 1 || run === 3) {
      const bullet = isSpace(next) && (i === 0 || p[i - 1] === '\n' || /^[ \t]*$/.test(p.slice(p.lastIndexOf('\n', i - 1) + 1, i)));
      const lone = isSpace(prev) && isSpace(next);
      if (!bullet && !lone) out.push({ at: run === 3 ? i + 2 : i, opens: !isSpace(next), closes: !isSpace(prev) });
    }
    i = j - 1;
  }
  return out;
}

function fixAsterisks(p) {
  const s = singles(p);
  if (s.length % 2 === 0) return p;
  // pair them up from the left; the first one that cannot be an opener is a closer whose opener is missing
  const first = s[0];
  if (first.closes && !first.opens) {
    const lead = p.match(/^\s*/)[0];
    return lead + '*' + p.slice(lead.length);
  }
  // the last one opened something and never closed it: close before the speech that follows, else at the end
  const last = s[s.length - 1];
  const rest = p.slice(last.at + 1);
  const q = rest.search(/["“]/);
  if (q > 0 && rest.slice(0, q).trim()) {
    const cut = last.at + 1 + rest.slice(0, q).replace(/\s+$/, '').length;
    return p.slice(0, cut) + '*' + p.slice(cut);
  }
  const body = p.replace(/\s+$/, '');
  return body + '*' + p.slice(body.length);
}

function fixBold(p) {
  const n = (p.match(/\*+/g) || []).filter((r) => r.length >= 2).length; // ** and *** both carry a bold marker
  if (n % 2 === 0) return p;
  const body = p.replace(/\s+$/, '');
  return body + '**' + p.slice(body.length);
}

function fixQuotes(p) {
  // straight quotes
  const idx = [];
  for (let i = 0; i < p.length; i++) if (p[i] === '"') idx.push(i);
  if (idx.length % 2) {
    const f = idx[0];
    const closer = !isSpace(p[f - 1]) && (isSpace(p[f + 1]) || /[*.,!?]/.test(p[f + 1] || ''));
    if (closer && idx.length === 1) {
      // `Hello there." *she waves*` – the speech started without its opening quote: after a leading action, else at the start
      const lead = p.match(/^\s*(\*[^*\n]+\*\s*)?/)[0];
      p = p.slice(0, lead.length) + '"' + p.slice(lead.length);
    } else {
      const last = idx[idx.length - 1];
      const rest = p.slice(last + 1);
      const a = rest.search(/\s\*\S/); // an action starts after the speech: close before it
      if (a > 0) p = p.slice(0, last + 1 + a) + '"' + p.slice(last + 1 + a);
      else {
        const body = p.replace(/\s+$/, '');
        p = body + '"' + p.slice(body.length);
      }
    }
  }
  // curly quotes
  const o = (p.match(/“/g) || []).length;
  const c = (p.match(/”/g) || []).length;
  if (o > c) {
    const body = p.replace(/\s+$/, '');
    p = body + '”' + p.slice(body.length);
  } else if (c > o) {
    const lead = p.match(/^\s*/)[0];
    p = lead + '“' + p.slice(lead.length);
  }
  return p;
}

/** Close the odd *action* and "speech" marks of a reply. */
export function fixMarks(text) {
  const s = String(text || '');
  if (!/[*"“”]/.test(s)) return s;
  // code blocks and the choices block stay as they are
  const parts = s.split(/(```[\s\S]*?(?:```|$)|<choices>[\s\S]*?(?:<\/choices>|$))/);
  return parts
    .map((part, i) =>
      i % 2
        ? part
        : part
            .split(/(\n\s*\n)/)
            .map((p, k) => (k % 2 || !p.trim() ? p : fixQuotes(fixBold(fixAsterisks(p)))))
            .join(''),
    )
    .join('');
}
