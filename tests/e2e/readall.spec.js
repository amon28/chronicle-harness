import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';
import { readAll, overlapAppend } from '../../src/readall.js';

// A Notion-like page: a scrolling div that only keeps blocks near the viewport mounted, with nested blocks,
// headings that repeat on purpose, and a height that grows as blocks mount.
const PAGE = `<style>body{margin:0}#sc{height:700px;overflow:auto}.b{height:90px;box-sizing:border-box;padding:6px}</style><div id=sc><div id=sp></div></div>
<script>
const N=200, H=90, blocks=[];
for(let i=0;i<N;i++){const t=i%40===0?'Items & Armor':i%40===1?'Blocks':'Line '+i+' unique text for block '+i;blocks.push({id:'id'+i,t});}
const sp=document.getElementById('sp'),sc=document.getElementById('sc');
function draw(){const first=Math.max(0,Math.floor(sc.scrollTop/H)-6),last=Math.min(N,first+22);
 let h='<div style="height:'+(first*H)+'px"></div>';
 for(let i=first;i<last;i++){const b=blocks[i];h+='<div class=b data-block-id="'+b.id+'"><div>'+b.t+'</div>'+(i%7===0?'<div class=b data-block-id="n'+i+'">child of '+i+'</div>':'')+'</div>';}
 sp.innerHTML=h+'<div style="height:'+((N-last)*H)+'px"></div>';}
sc.addEventListener('scroll',draw);draw();
</script>`;

test('read full on a virtualised page: complete, repeatable, keeps repeated headings, no hole', async ({ page }) => {
  test.setTimeout(150000);
  await page.route('https://notion.test/', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('https://notion.test/');
  await page.evaluate(PAGE_SCRIPT);
  const run = async (e) => {
    const v = await page.evaluate((x) => (0, eval)(x), e);
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = await readAll(run, { sleep });
  const b = await readAll(run, { sleep });
  expect(a.complete).toBe(true);
  expect(a.gaps).toEqual([]);
  expect(a.text).toBe(b.text); // repeatable
  expect(a.text).toContain('Line 2 unique text for block 2');
  expect(a.text).toContain('Line 199 unique text for block 199');
  for (let i = 2; i < 200; i++) if (i % 40 > 1) expect(a.text).toContain(`Line ${i} unique text for block ${i}`); // no hole anywhere
  expect(a.text.split('Items & Armor').length - 1).toBe(5); // the heading really repeats 5 times and all are kept
  expect(a.text.split('child of 7\n').length - 1).toBe(1); // nested blocks are not duplicated into their parents
});

test('text overlap merge removes only the seam', () => {
  const a = 'x'.repeat(30) + 'Items & Armor\nbody one of the section';
  expect(overlapAppend(a, 'Items & Armor\nbody one of the section\nbody two')).toBe('\nbody two');
  expect(overlapAppend('abc', 'totally different text here, long enough')).toBe('\ntotally different text here, long enough');
});
