// repo_map: a compact outline of the code in the workspace (files → top-level definitions with line numbers),
// like Aider's repo map but without a parser: a few regexes per language catch classes, functions, methods,
// exported constants, types and headings. Good enough to know where to read.

const LANGS = [
  [/\.(m?js|cjs|jsx|ts|tsx)$/i, [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^\s{2,4}(?:static\s+)?(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
  ]],
  [/\.py$/i, [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/, /^([A-Z][A-Z0-9_]+)\s*=/]],
  [/\.go$/i, [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/]],
  [/\.rs$/i, [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/]],
  [/\.(java|kt|kts|cs|swift|scala)$/i, [/^\s*(?:public|private|protected|internal|open|data|sealed|abstract|static|final|\s)*(?:class|interface|enum|object|record|struct)\s+([A-Za-z_]\w*)/, /^\s*(?:public|private|protected|internal|override|static|final|suspend|\s)*(?:fun|func|void|[A-Za-z_<>[\]]+)\s+([a-z_]\w*)\s*\(/]],
  [/\.(c|h|cc|cpp|hpp)$/i, [/^[A-Za-z_][\w\s*&:<>]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, /^\s*(?:typedef\s+)?(?:struct|class|enum)\s+([A-Za-z_]\w*)/]],
  [/\.(rb)$/i, [/^\s*def\s+([A-Za-z_][\w?!]*)/, /^\s*(?:class|module)\s+([A-Z]\w*)/]],
  [/\.(php)$/i, [/^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/, /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/]],
  [/\.(sh|bash)$/i, [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/]],
  [/\.(md|markdown)$/i, [/^(#{1,3}\s+.+)$/]],
  [/\.(css|scss)$/i, [/^([.#][A-Za-z][\w-]*)[^{]*\{/]],
  [/\.(html?)$/i, [/<(?:h1|h2|title)[^>]*>([^<]{1,60})</i, /\bid="([\w-]+)"/]],
];
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.out|__pycache__|\.venv|venv|target|vendor|\.next|coverage)(\/|$)|\.min\.(js|css)$|\.(lock)$|package-lock\.json$/;

/** → { text, files } — files: how many were outlined. textOf(path) → string or null. */
export function repoMap(paths, textOf, { maxFiles = 200, maxPerFile = 40, maxChars = 24000 } = {}) {
  const out = [];
  let files = 0;
  let others = 0;
  const sorted = [...paths].filter((p) => !SKIP.test(p)).sort();
  for (const p of sorted) {
    const lang = LANGS.find(([rx]) => rx.test(p));
    if (!lang) {
      others++;
      continue;
    }
    if (files >= maxFiles) {
      others++;
      continue;
    }
    const text = textOf(p);
    if (text == null) continue;
    files++;
    const lines = text.split('\n');
    const defs = [];
    const html = /\.html?$/i.test(p);
    let inScript = false;
    for (let i = 0; i < lines.length && defs.length < maxPerFile; i++) {
      const line = lines[i];
      if (html) {
        // inside <script> or <style> the HTML patterns only find strings that look like tags
        if (/<(script|style)\b/i.test(line) && !/<\/(script|style)>/i.test(line)) inScript = true;
        else if (/<\/(script|style)>/i.test(line)) inScript = false;
        else if (inScript) continue;
      }
      if (line.length > 400) continue;
      for (const rx of lang[1]) {
        const m = rx.exec(line);
        if (m) {
          // the signature only: no opening brace, no docstring or comment that starts on the same line
          const sig = line.trim().replace(/\s*\{\s*$/, '').replace(/(:)\s*(?:'''|\"\"\"|#).*$/, '$1').slice(0, 110);
          defs.push(`  ${String(i + 1).padStart(5)}│ ${/^#/.test(m[1]) ? m[1] : sig}`);
          break;
        }
      }
    }
    out.push(`${p} (${lines.length} lines)` + (defs.length ? '\n' + defs.join('\n') : ''));
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n… cut at ${maxChars} characters – call repo_map with path for one folder`;
  if (!files) text = 'No source files found' + (sorted.length ? ` (${sorted.length} other files).` : ' – the workspace is empty.');
  else if (others) text += `\n(${others} other files not outlined: data, assets, or over the file limit.)`;
  // it is a line matcher, not a parser: say so, so the outline is read as a guide and not as the truth
  if (files) text += '\n(Found by matching lines, not by parsing: a definition can be missing or a line listed that is not one. Read the file before relying on a signature.)';
  return { text, files };
}
