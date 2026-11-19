// @file mentions, like Claude Code: "@src/app.js" in your message attaches that workspace file's text to the message.

const AT = /(?:^|\s)@([\w./-]*[\w-]\.[\w]+|[\w./-]+\/[\w./-]*)(?=$|[\s,;:!?)])/g;
const MAX_FILE = 20000;
const MAX_FILES = 6;

/** Paths after @ in the text that exist in the workspace (in order, no repeats). */
export function mentionedFiles(text, files) {
  const out = [];
  for (const m of String(text || '').matchAll(AT)) {
    const p = m[1].replace(/^\/?workspace\//, '').replace(/^\//, '').replace(/[.]+$/, '');
    if (files[p] && !out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_FILES);
}

/** [{ path, text }] snapshots for the message (text only, cut long ones). */
export function snapshotFiles(paths, files, decode) {
  return paths.map((p) => {
    const t = decode(files[p].data);
    return t == null ? { path: p, text: '(binary file – use the tools to read it)' } : { path: p, text: t.length > MAX_FILE ? t.slice(0, MAX_FILE) + `\n… [${t.length - MAX_FILE} more characters – read_file for the rest]` : t };
  });
}

/** How the snapshots are shown to the model, under the message. */
export const atFilesBlock = (snaps) => (snaps || []).map((f) => `[@${f.path} – the file as it was when this message was sent]\n\`\`\`\n${f.text}\n\`\`\``).join('\n\n');
