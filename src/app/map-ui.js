// The ```map block in a reply, drawn: a small map you can drag and zoom, numbered pins, and under it the list of
// places with distance, "open now" when the hours can be read, and buttons that hand over to the phone's own apps.
// Nothing from the model is inserted as HTML – its text is only read as a file path or as JSON and checked first.
import { richBlocks } from '../markdown.js';
import { fitView, fmtDist, haversine, mapBlockSource, openNow, openText, panned, parseMapDoc, project, tilesFor, MIN_ZOOM, MAX_ZOOM, TILE } from '../mapblock.js';
import { createTileLoader, idbTileStore } from '../maptiles.js';
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, osmConfig } from '../osm.js';
import { el, hooks, state, toast } from './core.js';
import { loadWs } from './extras.js';

const HEIGHT = 220;
const store = idbTileStore();
const loaders = new Map(); // one loader per tile address
const loaderFor = (template) => {
  if (!loaders.has(template)) loaders.set(template, createTileLoader({ template, store }));
  return loaders.get(template);
};
/** Settings › Tools: forget the kept map tiles. */
hooks.clearMapTiles = () => store.clear();

// decoded tiles, so dragging redraws without waiting (a few dozen small pictures)
const bitmaps = new Map();
function keepBitmap(k, bmp) {
  bitmaps.set(k, bmp);
  if (bitmaps.size > 80) {
    const old = bitmaps.keys().next().value;
    bitmaps.get(old)?.close?.();
    bitmaps.delete(old);
  }
}

const live = new Set(); // maps on screen: redrawn when the theme changes
new MutationObserver(() => {
  for (const m of [...live]) (m.root.isConnected ? m.draw() : live.delete(m));
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

const intents = () => hooks.intents || null;
const canHandOver = () => !!intents()?.start;

function errorBox(wrap, why) {
  wrap.querySelector(':scope > .map-error')?.remove();
  wrap.append(el('div', 'map-error', `This map could not be read: ${why}.`));
}

/** One of the buttons under a place: natively an intent (the tap is the OK), in a browser a plain link. */
function action(label, intent, href, fallback) {
  if (canHandOver()) {
    const b = el('button', 'map-act', label);
    b.type = 'button';
    b.onclick = async () => {
      try {
        await intents().start({ ...intent, title: label });
      } catch (e) {
        if (fallback) {
          try {
            return void (await intents().start({ ...fallback, title: label }));
          } catch {
            /* say so below */
          }
        }
        toast(/no app/i.test(String(e?.message || e)) ? 'No app on this phone can open that' : `Could not open it: ${String(e?.message || e).slice(0, 80)}`);
      }
    };
    return b;
  }
  const a = el('a', 'map-act', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function buildMap(doc, settings) {
  const root = el('div', 'map-card no-icons');
  if (doc.title) root.append(el('div', 'map-title', doc.title));
  const view = el('div', 'map-view');
  const canvas = el('canvas', 'map-tiles');
  view.append(canvas);
  const loader = loaderFor(osmConfig(settings).tiles);

  const points = [...(doc.me ? [doc.me] : []), ...doc.places.map((p) => [p.lat, p.lon]), ...(doc.line || [])];
  let w = 0;
  let cur = null; // { lat, lon, zoom }
  const fitted = () => {
    const f = fitView(points, w || 320, HEIGHT);
    return { lat: doc.center ? doc.center[0] : f.lat, lon: doc.center ? doc.center[1] : f.lon, zoom: doc.zoom ?? f.zoom };
  };

  // pins, the "you are here" dot
  const pins = doc.places.map((p, i) => {
    const b = el('button', 'map-pin', String(i + 1));
    b.type = 'button';
    b.setAttribute('aria-label', `${i + 1}: ${p.name}`);
    b.title = p.name;
    b.onclick = () => pick(i, false);
    view.append(b);
    return b;
  });
  const meDot = doc.me ? el('div', 'map-me') : null;
  if (meDot) {
    meDot.title = 'You';
    view.append(meDot);
  }

  const zoomBox = el('div', 'map-zoom');
  const zb = (text, label, fn) => {
    const b = el('button', 'map-zoom-btn', text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.onclick = fn;
    zoomBox.append(b);
  };
  zb('+', 'Zoom in', () => zoomTo(cur.zoom + 1));
  zb('−', 'Zoom out', () => zoomTo(cur.zoom - 1));
  zb('◎', 'Show all places', () => {
    cur = fitted();
    draw(true);
  });
  const attr = el('a', 'map-attr', OSM_ATTRIBUTION);
  attr.href = OSM_COPYRIGHT_URL;
  attr.target = '_blank';
  attr.rel = 'noopener noreferrer';
  const note = el('div', 'map-offline');
  note.hidden = true;
  view.append(zoomBox, attr, note);

  let fetchTimer = null;
  function draw(fetchNow = false) {
    if (!root.isConnected) return;
    const cw = Math.round(view.clientWidth);
    if (!cw) return; // not laid out yet: the ResizeObserver calls again
    if (cw !== w || !cur) {
      w = cw;
      cur ||= fitted();
    }
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    const css = getComputedStyle(view);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css.getPropertyValue('--map-bg').trim() || '#e9e9e6';
    g.fillRect(0, 0, w, HEIGHT);
    // the plain grid under everything: what shows where there is no tile (offline, paused, still loading)
    g.strokeStyle = css.getPropertyValue('--map-grid').trim() || '#d4d4d0';
    g.lineWidth = 1;
    const off = tilesFor(cur, w, HEIGHT, 1)[0]; // the grid moves with the map
    const ox = off ? ((off.left % 64) + 64) % 64 : 0;
    const oy = off ? ((off.top % 64) + 64) % 64 : 0;
    g.beginPath();
    for (let x = ox; x < w; x += 64) (g.moveTo(x + 0.5, 0), g.lineTo(x + 0.5, HEIGHT));
    for (let y = oy; y < HEIGHT; y += 64) (g.moveTo(0, y + 0.5), g.lineTo(w, y + 0.5));
    g.stroke();
    const tiles = tilesFor(cur, w, HEIGHT, 12);
    let missing = 0;
    for (const t of tiles) {
      const bmp = bitmaps.get(`${loader.template}|${t.z}/${t.x}/${t.y}`);
      if (bmp) g.drawImage(bmp, t.left, t.top, TILE, TILE);
      else missing++;
    }
    if (doc.line) {
      g.beginPath();
      doc.line.forEach(([la, lo], i) => {
        const p = project(cur, w, HEIGHT, la, lo);
        if (i) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      });
      g.strokeStyle = '#2f6fed';
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.stroke();
    }
    const place = (node, la, lo) => {
      const p = project(cur, w, HEIGHT, la, lo);
      const inside = p.x >= -4 && p.x <= w + 4 && p.y >= -4 && p.y <= HEIGHT + 30;
      node.hidden = !inside;
      if (inside) node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    };
    doc.places.forEach((p, i) => place(pins[i], p.lat, p.lon));
    if (meDot) place(meDot, doc.me[0], doc.me[1]);
    const offline = globalThis.navigator?.onLine === false;
    note.hidden = !(missing && (offline || loader.state.paused));
    if (!note.hidden) note.textContent = offline ? 'Offline – showing saved map tiles' : 'Map tiles are paused for a while (fair-use limit)';
    root.dataset.tiles = String(tiles.length - missing);
    if (!missing) return;
    // ask for what is missing – after a pause while dragging, so a drag across town does not fetch every tile on the way
    clearTimeout(fetchTimer);
    const want = tiles.filter((t) => !bitmaps.has(`${loader.template}|${t.z}/${t.x}/${t.y}`));
    fetchTimer = setTimeout(
      () => {
        for (const t of want) {
          loader
            .load(t.z, t.x, t.y)
            .then(async (r) => {
              if (!r?.bytes) return;
              const bmp = await createImageBitmap(new Blob([r.bytes]));
              keepBitmap(`${loader.template}|${t.z}/${t.x}/${t.y}`, bmp);
              if (root.isConnected) requestAnimationFrame(() => draw());
            })
            .catch(() => {})
            .finally(() => root.isConnected && settle()); // "offline" / "paused" when tiles are still missing
        }
      },
      fetchNow ? 0 : 150,
    );
  }
  function settle() {
    const tiles = tilesFor(cur, w, HEIGHT, 12);
    const missing = tiles.some((t) => !bitmaps.has(`${loader.template}|${t.z}/${t.x}/${t.y}`));
    const offline = globalThis.navigator?.onLine === false;
    note.hidden = !(missing && (offline || loader.state.paused));
    if (!note.hidden) note.textContent = offline ? 'Offline – showing saved map tiles' : 'Map tiles are paused for a while (fair-use limit)';
  }
  function zoomTo(z) {
    cur = { ...cur, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) };
    draw(true);
  }

  // drag to move (one finger; the page does not scroll while the finger started on the map)
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a') || !cur) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: cur };
    try {
      view.setPointerCapture(e.pointerId);
    } catch {
      /* an old WebView: dragging still works while the finger stays on the map */
    }
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cur = panned(drag.from, e.clientX - drag.x, e.clientY - drag.y);
    draw();
  });
  const end = (e) => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);

  // the list
  const list = el('ol', 'map-list');
  const rows = doc.places.map((p, i) => {
    const li = el('li', 'map-row');
    const head = el('div', 'map-row-head');
    const numB = el('button', 'map-num', String(i + 1));
    numB.type = 'button';
    numB.setAttribute('aria-label', `Show ${p.name} on the map`);
    numB.onclick = () => pick(i, true);
    const dist = doc.me ? haversine(doc.me[0], doc.me[1], p.lat, p.lon) : p.dist;
    const st = doc.clock !== false && p.hours ? openNow(p.hours, new Date()) : undefined;
    head.append(numB, el('span', 'map-name', p.name));
    if (dist != null) head.append(el('span', 'map-dist', fmtDist(dist)));
    if (st) head.append(el('span', `map-open ${st.open ? 'yes' : 'no'}`, openText(st).replace(/^./, (c) => c.toUpperCase())));
    li.append(head);
    const sub = [p.kind && p.kind !== p.name ? p.kind : '', p.addr || ''].filter(Boolean).join(' · ');
    if (sub) li.append(el('div', 'map-sub', sub));
    if (p.hours && !st) li.append(el('div', 'map-sub', `Hours: ${p.hours}`));
    if (p.note) li.append(el('div', 'map-sub', p.note));
    const acts = el('div', 'map-acts');
    const ll = `${p.lat},${p.lon}`;
    const geo = { action: 'android.intent.action.VIEW', data: `geo:${ll}?q=${ll}(${encodeURIComponent(p.name)})` };
    acts.append(action('Directions', { action: 'android.intent.action.VIEW', data: `google.navigation:q=${ll}` }, `https://www.openstreetmap.org/directions?to=${encodeURIComponent(ll)}`, geo));
    acts.append(action('Map', geo, `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}`));
    if (p.phone) acts.append(action('Call', { action: 'android.intent.action.DIAL', data: 'tel:' + encodeURIComponent(p.phone) }, 'tel:' + encodeURIComponent(p.phone)));
    if (p.url) acts.append(action('Website', { action: 'android.intent.action.VIEW', data: p.url }, p.url));
    li.append(acts);
    list.append(li);
    return li;
  });
  function pick(i, centre) {
    rows.forEach((r, k) => r.classList.toggle('picked', k === i));
    pins.forEach((b, k) => b.classList.toggle('picked', k === i));
    if (centre && cur) {
      cur = { ...cur, lat: doc.places[i].lat, lon: doc.places[i].lon };
      draw(true);
    } else rows[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  root.append(view, list);
  const foot = el('div', 'map-foot', `${doc.cut ? `${doc.cut} more not shown · ` : ''}Places and map: ${doc.source || OSM_ATTRIBUTION}`);
  root.append(foot);
  const m = { root, draw: () => draw(true) };
  live.add(m);
  // drawn when it has a width (also again when the chat column changes size)
  if (globalThis.ResizeObserver) new ResizeObserver(() => draw(true)).observe(view);
  else requestAnimationFrame(() => draw(true));
  return root;
}

/** markdown.js calls this for every finished ```map block in the chat. */
richBlocks.map = async (wrap, text) => {
  wrap.querySelector(':scope > .map-card')?.remove();
  wrap.querySelector(':scope > .map-error')?.remove();
  wrap.classList.remove('diagram', 'map-block');
  try {
    const src = mapBlockSource(text);
    if (src.error) return errorBox(wrap, src.error);
    let raw = src.json;
    if (src.path) {
      const conv = state.current;
      const ws = conv ? await loadWs(conv.id) : null;
      const f = ws?.files?.[src.path];
      if (!f) return errorBox(wrap, `the map file ${src.path} is not in this chat's files (it may have been deleted)`);
      if (f.data.byteLength > 200000) return errorBox(wrap, `${src.path} is too big for a map file`);
      raw = new TextDecoder().decode(f.data);
    }
    const r = parseMapDoc(raw);
    if (!r.ok) return errorBox(wrap, r.error);
    if (!wrap.isConnected) return;
    wrap.insertBefore(buildMap(r.doc, state.settings), wrap.querySelector('pre'));
    wrap.classList.add('diagram', 'map-block');
  } catch (e) {
    errorBox(wrap, String(e?.message || e).split('\n')[0].slice(0, 120));
  }
};
