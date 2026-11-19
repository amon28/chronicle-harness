// "The conversation is too long for this model" – in the many ways providers say it. When a request is refused for
// its length, the real limit is usually in the message: it is learned, and the request is rebuilt to fit and sent again
// once, instead of the reply simply failing. (Custom endpoints often do not report their context size at all, and the
// app then assumes 32K.)

const SAYS_TOO_LONG = [
  /maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /context window/i,
  /prompt is too long/i,
  /input (?:is )?too long/i,
  /too many (?:input )?tokens/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  /exceeds? the (?:model'?s? )?(?:maximum )?(?:context|token limit|input limit)/i,
  /input length (?:\d+ )?exceeds?/i,
  /(?:input|prompt) tokens? (?:\(\d+\) )?(?:exceed|is greater than|>)/i,
  /request too large/i,
  /input length and `?max_tokens`? exceed context limit/i, // Anthropic, when the reply space does not fit
  /token count \(?[\d,]+\)? exceeds/i, // Google
];

const n = (s) => Number(String(s).replace(/[,_\s]/g, ''));
// a rate limit counts tokens too ("tokens per minute", 429, "please wait"): it is not the conversation's length
const RATE_LIMIT = /\b429\b|per min|\bTPM\b|\bRPM\b|rate[ _-]?limit|please (?:wait|try again)|quota|too many requests/i;

/**
 * → null when the error is not about length; else { limit, requested } – each a number of tokens when the message
 * says it, else 0.
 */
export function parseContextError(text) {
  const t = String(text || '');
  if (RATE_LIMIT.test(t) || !SAYS_TOO_LONG.some((rx) => rx.test(t))) return null;
  let limit = 0;
  let requested = 0;
  let completion = 0;
  // "190000 + 64000 > 200000": the input, the reply space asked for, the limit
  const sum = /([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/.exec(t);
  if (sum) return { limit: n(sum[3]), requested: n(sum[1]), completion: n(sum[2]) };
  const comp = /([\d,]+) (?:tokens )?in the completion/i.exec(t) || /max_tokens[^\d]{0,20}([\d,]+)/i.exec(t);
  if (comp) completion = n(comp[1]);
  const L = [
    /maximum context length (?:is|of) ([\d,]+)/i, // OpenAI-style
    /maximum number of tokens allowed \(([\d,]+)\)/i, // Google
    /([\d,]+) tokens? > ([\d,]+) maximum/i, // Anthropic "prompt is too long: 210000 tokens > 200000 maximum"
    /context window (?:of|is) ([\d,]+)/i,
    /(?:limit|maximum) (?:of|is) ([\d,]+) tokens/i,
    /exceeds? (?:the )?(?:maximum |max )?(?:of )?([\d,]+) tokens/i,
    /max(?:imum)?[_ ]?(?:model[_ ])?(?:len|length|tokens|context)[^\d]{0,12}([\d,]+)/i,
  ];
  for (const rx of L) {
    const m = rx.exec(t);
    if (!m) continue;
    if (m[2]) {
      requested = n(m[1]);
      limit = n(m[2]);
    } else limit = n(m[1]);
    break;
  }
  const R = [/resulted in ([\d,]+) tokens/i, /token count \(([\d,]+)\)/i, /(?:requested|you requested|your (?:prompt|input|request)[^\d]{0,30}) ([\d,]+) tokens/i, /prompt is too long: ([\d,]+)/i, /input length ([\d,]+)/i, /(?:input|prompt) tokens? \(?([\d,]+)\)?/i];
  if (!requested) for (const rx of R) {
    const m = rx.exec(t);
    if (m) {
      requested = n(m[1]);
      break;
    }
  }
  // a "limit" smaller than a few hundred tokens is not a context size (an output cap, a version number…)
  if (limit && limit < 512) limit = 0;
  if (completion >= limit) completion = 0;
  return { limit, requested, ...(completion ? { completion } : {}) };
}

/** How many tokens to fit the rebuilt request into: under the learned limit, or well under what was refused. */
export function fitAfterContextError(err, estimate) {
  // the reply needs room too: what was asked for it comes off (vLLM, Anthropic say how much)
  if (err.limit) return Math.max(1024, Math.floor(err.limit * 0.85) - (err.completion || 0));
  if (err.requested) return Math.floor(err.requested * 0.7);
  return Math.floor((estimate || 32000) * 0.6);
}
