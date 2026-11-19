import { test, expect } from './helpers.js';

// The app's real screenshot code against a stand-in for the Android browser that behaves like it: the page runs in an
// iframe of the phone's size, a full capture makes it as tall as the page first (as BrowserPlugin.screenshot does –
// vh and resize handlers react exactly as on the phone), and the picture is a real screenshot of it. The tester's
// pages, checked by pixel: a full-page picture must end with the page's last block.

const W = 390;
const H = 844;
const PAGES = {
  // 100vh hero, then a 1200px dark block
  vh2: `<style>body{margin:0}.hero{height:100vh;background:#4a7}.block{height:1200px;background:#a00}</style><div class="hero">hero</div><div class="block"></div>`,
  // a hero sized from JavaScript (innerHeight) and resized with the window, then a red footer
  jshero: `<style>body{margin:0}</style><div style="height:600px;background:#123">top</div><div id="hero" style="background:#567">JS HERO</div><div style="background:#a00;height:60px">FOOTER</div><script>const size=()=>hero.style.height=innerHeight+"px";size();addEventListener("resize",size)</script>`,
  // a block that is twice the window, kept so on resize
  jsgrow: `<style>body{margin:0}</style><div id="b" style="background:#357"></div><div style="background:#a00;height:60px">FOOTER</div><script>const s=()=>b.style.height=(innerHeight*2)+"px";s();addEventListener("resize",s)</script>`,
  // min-height:100vh section, a block, a footer
  minvh: `<style>body{margin:0}section{min-height:100vh;background:#4a7}</style><section>s</section><div style="height:900px;background:#246"></div><div style="background:#a00;height:60px">FOOTER</div>`,
  // content that arrives 400 ms after load
  late: `<style>body{margin:0}</style><div id="x" style="background:#246"></div><div style="background:#a00;height:60px">FOOTER</div><script>setTimeout(()=>x.style.height="1500px",400)</script>`,
  // shorter than the screen
  short: `<style>body{margin:0;background:#fff}</style><div style="height:140px;background:#a00">short</div>`,
};

async function setup(app) {
  await app.exposeFunction('__ocmShotFrame', async () => (await app.locator('#fake-native').screenshot({ type: 'png' })).toString('base64'));
  await app.evaluate(({ W, H }) => {
    const f = document.createElement('iframe');
    f.id = 'fake-native';
    Object.assign(f.style, { position: 'absolute', left: '0', top: '0', width: W + 'px', height: H + 'px', border: '0', zIndex: 99999, background: '#fff' });
    document.body.append(f);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.__ocmBrowser = {
      open: async ({ html }) => {
        f.style.height = H + 'px';
        f.srcdoc = '<!doctype html><meta name="viewport" content="width=device-width">' + html;
        await new Promise((r) => (f.onload = r));
      },
      // like evaluateJavascript: the result comes back as JSON
      eval: async ({ js }) => {
        let v;
        try {
          v = f.contentWindow.eval(js);
        } catch {
          v = null;
        }
        return { value: v === undefined ? 'null' : JSON.stringify(v) };
      },
      // like BrowserPlugin.screenshot: a full capture makes the view as tall as the page said (clip, up to 4 screens)
      // Like this phone's WebView (round 3 of the device review): the drawing starts at the top of the document
      // whatever the scroll position, and nothing is painted below the window – so a tall picture needs the window
      // stretched, and a scrolled page cannot be drawn where it is scrolled to.
      screenshot: async ({ full = false, clip = 0, vw = 0 } = {}) => {
        const win = f.contentWindow;
        const sy = win.scrollY;
        let h = H;
        if (full) h = Math.min(Math.max(H, Math.round(clip * (vw ? W / vw : 1))), H * 4);
        if (sy) win.scrollTo(0, 0);
        if (h !== H) {
          f.style.height = h + 'px';
          await sleep(250);
        }
        const base64 = await window.__ocmShotFrame();
        if (h !== H) f.style.height = H + 'px';
        if (sy) win.scrollTo(0, sy);
        // what the phone reports: the picture's real size, px per CSS px, and the CSS width the window shows
        const d = devicePixelRatio;
        return { base64, width: Math.round(W * d), height: Math.round(h * d), pxPerCss: d, viewCssWidth: W, tall: h > H, blank: false, color: '#ffffff', blackTail: 0, cut: 0, method: h > H ? 'resized' : sy ? 'viewport-unscrolled' : 'viewport' };
      },
      close: async () => {},
    };
    // what a picture shows: its height, and the colour of its last row
    globalThis.__picture = async (b64) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = (y) => [...g.getImageData(Math.floor(bmp.width / 2), y, 1, 1).data.slice(0, 3)];
      // in CSS px: the screenshot is at the test browser's pixel density
      return { width: W, height: Math.round((bmp.height * W) / bmp.width), last: px(bmp.height - Math.round((10 * bmp.width) / W)) }; // 10 CSS px above the bottom: inside the last block, clear of JPEG edge blur
    };
    // the page's true height at the phone's window size
    globalThis.__trueHeight = () => f.contentDocument.documentElement.scrollHeight;
  }, { W, H });
}

const RED = [170, 0, 0];
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 12);

for (const [name, html] of Object.entries(PAGES)) {
  test(`full-page capture of "${name}" is the whole page, ending with its last block`, async ({ app }) => {
    await setup(app);
    await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), html);
    await app.waitForTimeout(600); // late content
    const trueH = await app.evaluate(() => globalThis.__trueHeight());
    const r = await app.evaluate(async () => {
      const c = await globalThis.__ocmCapture('capture-test', true);
      return { ...(await globalThis.__picture(c.shot.base64)), message: c.message };
    });
    const pageH = Math.max(trueH, H);
    if (name === 'short') {
      expect(r.height).toBeLessThanOrEqual(H); // one screen at most
    } else {
      expect(r.height, `picture ${r.height}px for a page of ${pageH}px (${r.message})`).toBeGreaterThanOrEqual(Math.min(pageH, H * 4) - 2);
      expect(near(r.last, RED), `the last row is ${r.last}, not the red footer`).toBe(true);
    }
    // and the page is left as it was
    expect(await app.evaluate(() => globalThis.__trueHeight())).toBe(trueH);
  });
}

// The tester's ruler: bands of colour every 400 px. A full picture must show every band in order – a picture made of
// copies of the top of the page (what joining "screens" did on the phone) shows the first band again and again.
test('full-page picture of a long page shows every part of it once, in order (ruler)', async ({ app }) => {
  await setup(app);
  const cols = ['#a00', '#0a0', '#00a', '#aa0', '#0aa', '#a0a', '#555', '#a50'];
  const html = '<style>body{margin:0}</style>' + cols.map((c) => `<div style="height:400px;background:${c}"></div>`).join('');
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), html);
  const r = await app.evaluate(async () => {
    const c = await globalThis.__ocmCapture('capture-test', true);
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + c.shot.base64)).blob());
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const k = bmp.width / 390;
    const bands = [];
    for (let i = 0; i * 400 + 200 < bmp.height / k; i++) bands.push([...g.getImageData(10, Math.round((i * 400 + 200) * k), 1, 1).data.slice(0, 3)]);
    return { bands, message: c.message };
  });
  const hex = (c) => [1, 2, 3].map((i) => parseInt(c[i], 16) * 17);
  // 4 screens of 844 = 3376 px: the first 8 bands, each once, in order
  expect(r.bands.length).toBe(8);
  r.bands.forEach((b, i) => expect(near(b, hex(cols[i])), `band ${i} is ${b}, expected ${cols[i]}`).toBe(true));
  expect(r.message).toMatch(/window stretched to the page's height while the page was held/);
  expect(r.message).not.toMatch(/joined|scrolling/);
});

// The tester's hashscroll: a page that scrolled itself. This phone draws it from the top: the result must say so
// instead of passing the top off as the scrolled screen.
test('a screenshot of a scrolled page says when the picture shows the top instead', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>body{margin:0}</style><div style="height:3000px;background:linear-gradient(#fff,#000)"></div>' }));
  await app.evaluate(() => document.getElementById('fake-native').contentWindow.scrollTo(0, 1500));
  const msg = await app.evaluate(async () => (await globalThis.__ocmCapture('capture-test', false)).message);
  expect(msg).toMatch(/could only draw it from the top/);
});

// finding 4: a page shorter than the screen comes back cut to its content, with full_page as without
for (const full of [false, true]) {
  test(`a short page is cut where its content ends (full_page ${full})`, async ({ app }) => {
    await setup(app);
    await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>body{margin:0}</style><div style="height:200px;background:#a00">short</div>' }));
    const r = await app.evaluate((full) => globalThis.__ocmCaptureCut('capture-test', full), full);
    expect(r.cssHeight, JSON.stringify(r)).toBeLessThan(300);
    expect(r.cssHeight).toBeGreaterThan(150);
    // the tester's short.html: text straight in a 200px body, the page's background on html – no elements to measure
    await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>html,body{margin:0;background:#2a7;color:#fff;font:24px monospace} body{height:200px;padding:10px;box-sizing:border-box}</style>short page, 200px tall.<br>viewport is 800. full_page should not pad.' }));
    const t = await app.evaluate((full) => globalThis.__ocmCaptureCut('capture-test', full), full);
    expect(t.cssHeight, JSON.stringify(t)).toBeLessThan(300);
    expect(t.cssHeight).toBeGreaterThan(150);
  });
}

// round 4, finding 5: a page wider than the window (m900: a 900 px block, then a dark block; 1400 tall). The whole height
// must be in the picture, and the result must say that the right side is cut.
test('a page wider than the window: the whole height is there, and the cut right side is reported (m900)', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>html,body{margin:0;background:#000}#w{width:900px;height:900px;background:#0a0}</style><div id="w">900px wide</div><div style="height:500px;background:#a00">BELOW</div>' }));
  const r = await app.evaluate(async () => {
    const c = await globalThis.__ocmCapture('capture-test', true);
    return { ...(await globalThis.__picture(c.shot.base64)), message: c.message };
  });
  expect(r.height).toBeGreaterThanOrEqual(1398);
  expect(near(r.last, RED)).toBe(true);
  expect(r.message).toMatch(/the page is 900 CSS px wide but the window shows 390/);
});

// round 4, finding 4: h200's red marker is absolutely positioned against the window (body is not positioned), so it IS
// drawn at the bottom of the screen: the picture keeps the whole screen. With body positioned it sits at 200 and the
// picture is cut there.
test('a short page is cut at its content – and kept whole when something is drawn at the bottom of the window (h200)', async ({ app }) => {
  await setup(app);
  const page = (pos) => `<style>html,body{margin:0;background:#2a7}body{height:200px;${pos}}#mark{position:absolute;bottom:0;left:0;background:#f00;width:100%;height:4px}</style><div>page is 200px tall</div><div id="mark"></div>`;
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), page(''));
  expect((await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true))).cssHeight).toBeGreaterThan(800);
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), page('position:relative'));
  const r = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(r.cssHeight).toBeGreaterThan(150);
  expect(r.cssHeight).toBeLessThan(300);
});

// round 5, finding 4: cut exactly where the content ends – no margin below it (s200: 200 px block + 400 px tail = 600)
test('a short page is cut exactly at its content (s200)', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>html{background:#000}body{margin:0;background:#000}#box{position:relative;height:200px;background:#0a0}#mark{position:absolute;bottom:0;left:0;right:0;height:6px;background:#f00}#tail{height:400px;background:#003}</style><div id="box"><div id="mark"></div></div><div id="tail"></div>' }));
  for (const full of [false, true]) {
    const r = await app.evaluate((full) => globalThis.__ocmCaptureCut('capture-test', full), full);
    expect(Math.abs(r.cssHeight - 600), JSON.stringify(r)).toBeLessThanOrEqual(1);
  }
});

// round 5, finding 7: a page wider than the window – no scrollbar drawn across the picture at the window's bottom
test('a full-page picture of a wide page has no scrollbar in it (sb1)', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>html,body{margin:0;background:#000}#w{width:1400px;height:1600px;background:#000}</style><div id="w"></div>' }));
  const rows = await app.evaluate(async () => {
    const c = await globalThis.__ocmCapture('capture-test', true);
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + c.shot.base64)).blob());
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0);
    // the brightest pixel anywhere in the picture: the page is all black
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    return { max, h: bmp.height };
  });
  expect(rows.max, 'something lighter than the black page was drawn (a scrollbar?)').toBeLessThan(40);
});

test('a body stretched to the screen does not stop the crop; a page of thousands of elements is never cut short', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>body{margin:0;min-height:100vh;background:#123}</style><div style="height:300px;background:#0a0">short</div>' }));
  const a = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(a.cssHeight, JSON.stringify(a)).toBeLessThan(400);
  // 5000 small blocks, 2 px each: 10000 px of content – measuring stopped at the 4000th used to cut it at ~8000
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>body{margin:0}i{display:block;height:2px;background:#246}</style>' + '<i></i>'.repeat(5000) }));
  const b = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(b.cb.big).toBe(1);
  expect(b.cssHeight).toBeGreaterThanOrEqual(844 * 4 - 2); // capped at 4 screens, not cut by the crop
});

// A body taller than the screen is content: body{height:3000px} and one <p> at the top used to be cut at the <p>
// (98 CSS px of a 3016 px page). Stretched to one screen (min-height:100vh), with padding or without, it is not.
test('a tall body counts; a body stretched to one screen, padded or not, does not', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>html,body{margin:0}body{height:3000px;background:#fff}</style><p>body height</p>' }));
  const r = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(r.cssHeight, JSON.stringify(r)).toBeGreaterThanOrEqual(2950);
  for (const sizing of ['content-box', 'border-box']) {
    await app.evaluate((s) => globalThis.__ocmBrowser.open({ html: `<style>*{box-sizing:${s}}html,body{margin:0}body{min-height:100vh;padding:20px;background:#123}</style><div style="height:300px;background:#0a0">short</div>` }), sizing);
    const p = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
    expect(p.cssHeight, `${sizing}: ${JSON.stringify(p)}`).toBeLessThan(400);
  }
});

// Text is content by its lines: text straight in the body after a heading, and text running out of a short box,
// used to be cut at the last element's box (98 CSS px), losing most of the text.
test('text after the last element, or overflowing its box, is not cut off', async ({ app }) => {
  await setup(app);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('<br>');
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), `<style>body{margin:0;font:16px sans-serif}</style><div style="height:40px;background:#a00">head</div>${lines}`);
  const a = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(a.cssHeight, JSON.stringify(a)).toBeGreaterThanOrEqual(380);
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), `<style>body{margin:0;font:16px sans-serif}</style><div style="height:20px">${lines}</div>`);
  const b = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(b.cssHeight, JSON.stringify(b)).toBeGreaterThanOrEqual(340);
});

// A small fixed cookie bar does not keep the whole screen – also when its text is in a child element.
test('a cookie bar with its text in a child does not stop the crop', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => globalThis.__ocmBrowser.open({ html: '<style>body{margin:0}</style><div style="height:150px;background:#a00">x</div><div style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#333;color:#fff"><p style="margin:0">We use cookies</p></div>' }));
  const r = await app.evaluate(() => globalThis.__ocmCaptureCut('capture-test', true));
  expect(r.cssHeight, JSON.stringify(r)).toBeLessThan(250);
});

// Like the phone (decision 206): this WebView's capture (software View.draw) cannot see canvas pixels – the canvases
// come out empty while text and <img> show. The stand-in hides every <canvas> while it takes the picture.
test('canvas pixels reach the picture although the capture cannot see canvases (2D and WebGL), and the page is left as it was', async ({ app }) => {
  await setup(app);
  await app.evaluate(() => {
    const shoot = globalThis.__ocmBrowser.screenshot;
    globalThis.__ocmBrowser.screenshot = async (o) => {
      const d = document.getElementById('fake-native').contentDocument;
      const st = d.createElement('style');
      st.textContent = 'canvas{visibility:hidden!important}';
      d.head.append(st);
      globalThis.__snapsDuring = d.querySelectorAll('img.__ocm-snap').length;
      try {
        return await shoot(o);
      } finally {
        st.remove();
      }
    };
  });
  const html =
    '<style>body{margin:0;background:#fff}canvas{display:block}</style><h1 style="height:60px;margin:0">Title</h1>' +
    '<canvas id="a" width="200" height="200" style="width:200px;height:200px"></canvas><canvas id="b" width="200" height="200" style="width:200px;height:200px"></canvas>' +
    // 2D drawn once; WebGL redrawn every frame without preserveDrawingBuffer (like three.js' render loop)
    "<script>a.getContext('2d').fillStyle='#d00';a.getContext('2d').fillRect(0,0,200,200);var gl=b.getContext('webgl');(function f(){if(gl){gl.clearColor(0,0.7,0,1);gl.clear(gl.COLOR_BUFFER_BIT)}requestAnimationFrame(f)})()</script>";
  await app.evaluate((html) => globalThis.__ocmBrowser.open({ html }), html);
  await app.waitForTimeout(300);
  const r = await app.evaluate(async () => {
    const c = await globalThis.__ocmCapture('capture-test', false);
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + c.shot.base64)).blob());
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const k = bmp.width / 390;
    const at = (x, y) => [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)];
    const d = document.getElementById('fake-native').contentDocument;
    return { two: at(100, 160), gl: at(100, 360), message: c.message, during: globalThis.__snapsDuring, left: d.querySelectorAll('img.__ocm-snap').length };
  });
  expect(r.during).toBe(2); // both canvases were laid over with their pictures while it was taken
  expect(near(r.two, [221, 0, 0]), `2D canvas pixel ${r.two}`).toBe(true);
  expect(r.gl[1]).toBeGreaterThan(150); // the WebGL green
  expect(r.gl[0]).toBeLessThan(40);
  expect(r.message).toMatch(/2 canvases were copied in as pictures/);
  expect(r.left).toBe(0); // and taken away again
});
