import { cleanPath } from '../sandbox.js';

/**
 * A path written in a reply → the chat's file it names: `output/x.md`, `./output/x.md`, `workspace/output/x.md`,
 * `/workspace/output/x.md`, `/chats/<this chat>/output/x.md` (Claude Code's folder), even with a `:12` line after it.
 * files: the chat's workspace files (null when not loaded yet: then, with any, the path is returned for the opener to
 * check). -> the workspace path, or '' when it names no file of this chat.
 */
export function wsPathIn(text, { convId = '', files = null, any = false } = {}) {
  let t = String(text || '').trim();
  // the text is a whole `code` span, so a space can be part of the name (`output/my notes.md`): the file has to be
  // there for it to count – before the file list is loaded, such a span is taken for words (`npm run dev`), not tried
  if (!t || t.length > 300 || /[\n\r\t]/.test(t) || (/ /.test(t) && !files)) return '';
  // the line (and column) first: `notes.md:12` is a file, not a "notes.md:" scheme. What still has a colon after
  // that is not a workspace path: https://…, mailto:…, C:\…
  t = t.replace(/:\d+(:\d+)?$/, '');
  if (t.includes(':')) return '';
  t = t.replace(/^\.\//, '');
  const c = /^\/?chats\/([^/]+)\/(.+)$/.exec(t);
  if (c) {
    if (c[1] !== convId) return ''; // another chat's folder
    t = c[2];
  }
  const p = cleanPath(t);
  if (!p) return '';
  return files ? (files[p] ? p : '') : any ? p : '';
}
