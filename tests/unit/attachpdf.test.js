import { describe, it, expect } from 'vitest';
import { fileToPrompt } from '../../src/files.js';

// Decision 270: a big attached PDF pointed the model at the PDF's raw bytes ("read it with tools"); its text is now a
// .txt beside it, and that is the path given.
describe('a big attached PDF', () => {
  it('points at the text copy, and names the PDF itself', () => {
    const text = '--- Page 1 ---\n' + 'word '.repeat(8000);
    const p = fileToPrompt({ name: 'report.pdf', note: 'PDF, 40 pages', text, inWorkspace: 'report.pdf', textPath: 'report.pdf.txt' }, true);
    expect(p).toMatch(/^<file name="report\.pdf" path="\/workspace\/report\.pdf\.txt" info="PDF, 40 pages \d+ chars – read it with tools – this is its text; the file itself is \/workspace\/report\.pdf">/);
  });
  it('a big text file keeps its own path', () => {
    const p = fileToPrompt({ name: 'log.txt', text: 'x'.repeat(40000), inWorkspace: 'log.txt' }, true);
    expect(p).toMatch(/path="\/workspace\/log\.txt"/);
    expect(p).not.toMatch(/PDF itself/);
  });
});

describe('Word, Excel and PowerPoint files are read (decision 270)', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const { officeToText } = await import('../../src/files.js');
  it('a .docx gives its paragraphs', () => {
    const doc = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Dear Alex,</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Fish &amp; </w:t></w:r><w:r><w:t>chips</w:t></w:r></w:p></w:body></w:document>') });
    expect(officeToText(doc, 'docx')).toEqual({ text: 'Dear Alex,\nFish & chips', note: 'Word document, 2 paragraphs' });
  });
  it('a .xlsx gives each sheet as CSV, shared strings and numbers in their columns', () => {
    const x = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Rent, May</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>950</v></c></row></sheetData></worksheet>'),
    });
    expect(officeToText(x, 'xlsx')).toEqual({ text: '--- Sheet Budget (2 rows) ---\nItem,Cost\n"Rent, May",,950', note: expect.stringMatching(/^Excel workbook, 1 sheet \(as CSV/) });
  });
  it('a .pptx gives its slides in order', () => {
    const p = zipSync({ 'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>'), 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:sld>') });
    expect(officeToText(p, 'pptx').text).toBe('--- Slide 1 ---\nTitle\n\n--- Slide 2 ---\nSecond');
  });
});
