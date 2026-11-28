import { describe, it, expect } from 'vitest';
import { speechText, spokenMath } from '../../src/speech.js';

// Decision 275: read-aloud took "< n and j >" for an HTML tag, dropped <int> and every "_", and read $…$ as source.
describe('read-aloud keeps code words and comparisons', () => {
  it('a < and > in a sentence are not a tag', () => {
    expect(speechText('It loops while i < n and j > 0, so it stops.')).toBe('It loops while i less than n and j greater than 0, so it stops.');
    expect(speechText('Stop when a <= b.')).toBe('Stop when a less than or equal to b.');
  });
  it('generics stay, real tags go', () => {
    expect(speechText('Use vector<int> here.')).toBe('Use vector<int> here.');
    expect(speechText('Some <b>bold</b> text.')).toBe('Some bold text.');
  });
  it('snake_case is read as words, _emphasis_ loses its marks', () => {
    expect(speechText('Set max_len to 5. This is _important_.')).toBe('Set max len to 5. This is important.');
  });
});

describe('formulas are read simply', () => {
  it('log, fractions, powers and subscripts', () => {
    expect(spokenMath('O(n \\log n)')).toBe('O(n log n)');
    expect(spokenMath('\\frac{a}{b}')).toBe('(a over b)');
    expect(spokenMath('x^2 + y^3')).toBe('x squared plus y cubed');
    expect(spokenMath('a_i = 2^{n}')).toBe('a sub i equals 2 to the power n');
  });
  it('a complex one is "(formula)"', () => {
    expect(spokenMath('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}')).toBe('(formula)');
    expect(spokenMath('\\mathfrak{g} \\otimes V')).toBe('(formula)');
  });
  it('in a reply: $…$ and $$…$$, but prices stay', () => {
    expect(speechText('The cost is $O(n \\log n)$ and $x^2$.')).toBe('The cost is O(n log n) and x squared.');
    expect(speechText('Then $$\\frac{1}{2}$$ follows.')).toBe('Then (1 over 2) follows.');
    expect(speechText('It costs $5 and $10.')).toBe('It costs $5 and $10.');
  });
});
