import { describe, it, expect } from 'vitest';
import { escapeStrayTags, looksLikeCode, markdownHtml } from '../../src/markdown.js';

// Decision 275: <int>, <iostream>, <T> and HashMap<String, List<Integer>> outside code were taken for HTML tags by
// marked and removed by DOMPurify; a | inside $…$ split a table cell; a pasted compiler error was not fenced.
describe('angle brackets that are not HTML stay in the reply', () => {
  it('generics, templates and includes are escaped', () => {
    const html = markdownHtml('Use vector<int> and #include <iostream>, or <T> and HashMap<String, List<Integer>>.');
    expect(html).toContain('vector&lt;int&gt;');
    expect(html).toContain('&lt;iostream&gt;');
    expect(html).toContain('&lt;T&gt;');
    expect(html).toContain('HashMap&lt;String, List&lt;Integer&gt;&gt;');
  });
  it('real HTML still works, and code is left as written', () => {
    const html = markdownHtml('Some <b>bold</b>, <kbd>Ctrl</kbd> and <details><summary>More</summary>x</details> and `vector<int>`');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<code>vector&lt;int&gt;</code>');
    expect(escapeStrayTags('```cpp\n#include <iostream>\n```')).toBe('```cpp\n#include <iostream>\n```');
    expect(escapeStrayTags('    std::vector<int> v;')).toBe('    std::vector<int> v;');
  });
  it('a tag name right after a word is a generic unless it is closed', () => {
    expect(escapeStrayTags('List<b> here')).toBe('List&lt;b> here');
    expect(escapeStrayTags('word<b>bold</b>')).toBe('word<b>bold</b>');
  });
  it('a made-up tag that is opened and closed is left as before', () => {
    expect(escapeStrayTags('<scene>Rain falls.</scene> and <T>')).toBe('<scene>Rain falls.</scene> and &lt;T>');
  });
  it('autolinks and formulas are untouched', () => {
    expect(markdownHtml('see <https://example.com>')).toContain('<a href="https://example.com">');
    expect(escapeStrayTags('if $a<b>c$ then')).toBe('if $a<b>c$ then');
  });
});

describe('maths in tables and bare environments', () => {
  it('a | inside $…$ does not split the cell', () => {
    const html = markdownHtml('| p | x |\n|---|---|\n| $P(a|b)$ | 1 |');
    expect(html).toContain('data-tex="P(a|b)"');
    expect(html.match(/<td>/g)).toHaveLength(2);
  });
  it('a bare \\begin{align}…\\end{align} is display maths', () => {
    const html = markdownHtml('Here:\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n\nafter');
    expect(html).toMatch(/<div class="math math-block" data-tex="\\begin\{align\}/);
    expect(html).toContain('<p>after</p>');
  });
});

describe('a pasted error is fenced even when short', () => {
  it.each([
    'main.cpp:12:5: error: expected ‘;’ before ‘}’ token',
    'Exception in thread "main" java.lang.NullPointerException\n    at Main.main(Main.java:5)',
    'Traceback (most recent call last):\n  File "a.py", line 1',
    'error[E0382]: borrow of moved value: `v`',
    "NameError: name 'x' is not defined",
  ])('%s', (t) => expect(looksLikeCode(t)).toBe(true));
  it('ordinary text is not', () => {
    expect(looksLikeCode('I get an error when I run it, what does it mean?')).toBe(false);
    expect(looksLikeCode('Error: the meeting moved to Friday')).toBe(false);
  });
});
