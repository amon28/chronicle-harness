import { describe, it, expect } from 'vitest';
import { fixMarks } from '../../src/rpmarks.js';

describe('fixMarks', () => {
  const same = (t) => expect(fixMarks(t)).toBe(t);
  it('leaves balanced text alone', () => {
    same('*She smiles.* "Hello there." *She waves.*');
    same('**Bold** and *italic* and "quote".');
    same('* a bullet\n* another bullet');
    same('2 * 3 = 6');
    same('```\n*x = "1\n```');
    same('***very* bold**');
  });
  it('closes an action that was left open', () => {
    expect(fixMarks('*She smiles and waves.')).toBe('*She smiles and waves.*');
    expect(fixMarks('*She smiles. "Hi there."')).toBe('*She smiles.* "Hi there."');
    expect(fixMarks('*She smiles.* "Hi." *She waves')).toBe('*She smiles.* "Hi." *She waves*');
  });
  it('opens an action that was only closed', () => {
    expect(fixMarks('She smiles and waves.*')).toBe('*She smiles and waves.*');
    expect(fixMarks('She waves.* "Hi." *She smiles.*')).toBe('*She waves.* "Hi." *She smiles.*');
  });
  it('fixes each paragraph by itself', () => {
    expect(fixMarks('*She looks up.\n\nShe sighs.*')).toBe('*She looks up.*\n\n*She sighs.*');
    expect(fixMarks('*ok*\n\n*open\n\n"fine"')).toBe('*ok*\n\n*open*\n\n"fine"');
  });
  it('closes or opens speech', () => {
    expect(fixMarks('"Hello there.')).toBe('"Hello there."');
    expect(fixMarks('"Hello there. *She waves.*')).toBe('"Hello there." *She waves.*');
    expect(fixMarks('Hello there." *She waves.*')).toBe('"Hello there." *She waves.*');
    expect(fixMarks('*She nods.* Hello there."')).toBe('*She nods.* "Hello there."');
    expect(fixMarks('“Hello there.')).toBe('“Hello there.”');
    expect(fixMarks('"One." "Two')).toBe('"One." "Two"');
  });
  it('closes bold and keeps the choices block', () => {
    expect(fixMarks('**Warning')).toBe('**Warning**');
    same('*ok*\n\n<choices>\n1. *Run\n</choices>');
  });
});
