/**
 * Rewriting text in place: "correct this reply" (apply an instruction to a reply, changing only what it
 * asks) and "polish my draft" (tidy what you typed before sending it).
 */

export const CORRECT_SYSTEM = `You are an editor. You get a piece of text and an instruction. Apply the instruction to the text and change nothing else: keep the voice, tense, formatting (Markdown, *actions*, "quotes"), names and length unless the instruction says otherwise. Reply with the revised text only – no preamble, no notes, no quotes around it.`;

export const POLISH_SYSTEM = `You polish a chat message before it is sent. Fix spelling, grammar and punctuation, and make it read smoothly, but keep the writer's meaning, voice, person (I/you), tone and roughly the same length. Keep any *actions*, "dialogue", Markdown, code and @mentions as they are. Do not answer the message or add anything new. Reply with the polished message only.`;

export function buildCorrect(text, instruction) {
  return `Instruction: ${String(instruction || '').trim()}\n\nText:\n<<<\n${String(text || '')}\n>>>`;
}

export function buildPolish(draft, { context = '', style = '' } = {}) {
  return `${context ? `The conversation so far ends with:\n${context}\n\n` : ''}${style ? `Style: ${style}\n\n` : ''}Message to polish:\n<<<\n${String(draft || '')}\n>>>`;
}

/** Strip what models add around a rewrite: a fence or the <<< >>> markers, "Here is…" lines, wrapping quotes. */
export function cleanRewrite(out, original = '') {
  let t = String(out || '').trim();
  t = t.replace(/^<<<\s*\n?/, '').replace(/\n?\s*>>>$/, '');
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence && !/^```/.test(String(original).trim())) t = fence[1];
  t = t.replace(/^(here(?:'s| is) (?:the )?(?:revised|corrected|polished|edited|updated)[^\n]*:)\s*\n+/i, '');
  if (/^".*"$/s.test(t) && !/^".*"$/s.test(String(original).trim()) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
  return t.trim();
}
