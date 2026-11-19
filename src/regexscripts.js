// Regex scripts, as in SillyTavern: find/replace rules on messages.
// A rule: { id, name, find, replace, on: ['ai'|'user'], stage: 'save'|'display'|'prompt', enabled, personaId? }
//  - save:    the stored message is changed once, when it is written (e.g. strip "*" or fix a recurring typo)
//  - display: only what you see changes (e.g. hide an OOC block); the model still gets the original
//  - prompt:  only what the model gets changes (e.g. shorten old messages); you still see the original
// `find` is a regex written /like this/gi, or plain text (matched literally, every occurrence).

export const newRegexScript = () => ({ id: 'rx_' + Math.random().toString(36).slice(2, 10), name: '', find: '', replace: '', on: ['ai'], stage: 'save', enabled: true });

/** → a RegExp, or null when the pattern is empty or broken */
export function compileFind(find) {
  const f = String(find || '');
  if (!f) return null;
  const m = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(f);
  try {
    if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
    return new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch {
    return null;
  }
}

/** Apply the enabled rules for one author ('ai' | 'user') at one stage. */
export function applyRegexScripts(text, scripts, { who, stage, personaId = null } = {}) {
  let out = String(text ?? '');
  for (const s of scripts || []) {
    if (!s || s.enabled === false) continue;
    if ((s.stage || 'save') !== stage) continue;
    if (!(s.on || ['ai']).includes(who)) continue;
    if (s.personaId && s.personaId !== personaId) continue;
    const rx = compileFind(s.find);
    if (!rx) continue;
    try {
      out = out.replace(rx, String(s.replace ?? '').replace(/\{\{match\}\}/gi, '$$&'));
    } catch {
      /* a rule that throws is skipped */
    }
  }
  return out;
}
