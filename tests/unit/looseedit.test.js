import { describe, it, expect } from 'vitest';
import { applyEdits, looseLineMatch } from '../../src/codeedit.js';

const FILE = 'function a() {\n    if (x) {\n        return 1;\n    }\n}\n';

describe('edit_file with only the spacing different (decision 201)', () => {
  it('one place that matches once spacing is ignored: applied with the file’s indentation, and said', () => {
    const r = applyEdits(FILE, [{ old_text: 'if (x) {\n    return 1;\n}', new_text: 'if (x) {\n    return 2;\n}' }], 'a.js', { loose: true });
    expect(r.text).toBe('function a() {\n    if (x) {\n        return 2;\n    }\n}\n');
    expect(r.notes[0]).toMatch(/lines 2–4 only with different spacing/);
  });
  it('trailing spaces and doubled spaces count as the same; Windows line endings stay', () => {
    const crlf = 'a  =  1;  \r\nb = 2;\r\n';
    const r = applyEdits(crlf, [{ old_text: 'a = 1;', new_text: 'a = 3;' }], 'x.js', { loose: true });
    expect(r.text).toBe('a = 3;\r\nb = 2;\r\n');
  });
  it('zero or several such places still refuse; without loose (personas, skills) nothing changes', () => {
    const twice = '  x = 1;\n    x = 1;\n';
    expect(() => applyEdits(twice, [{ old_text: 'x  = 1;', new_text: 'x = 2;' }], 'b.js', { loose: true })).toThrow(/not found/);
    expect(looseLineMatch(twice, 'x  = 1;', 'x = 2;')).toBeNull();
    expect(() => applyEdits(FILE, [{ old_text: 'if (x) {\n    return 1;\n}', new_text: 'y' }], 'a.js')).toThrow(/different spacing\/indentation – copy it exactly/);
  });
  it('an exact match is still used as it is', () => {
    const r = applyEdits(FILE, [{ old_text: 'return 1;', new_text: 'return 5;' }], 'a.js', { loose: true });
    expect(r.notes).toEqual([]);
    expect(r.text).toContain('        return 5;');
  });
});
