// Long-press an item, then drag it to another place in its list or grid (touch and mouse).
// A quick tap or a scroll never starts a drag. Calls onDone(newOrderOfItemElements) after a drop that moved something.
//
// While a drag is going on the page is locked (every scrollable parent gets overflow:hidden, so the browser cannot scroll
// under your finger), the list scrolls by itself when you hold the item near its edge, and the other items slide
// aside instead of jumping.
export function makeSortable(box, { item, onDone, delay = 380 }) {
  let drag = null;
  let swallowClick = false;
  const items = () => [...box.querySelectorAll(item)];

  /** The elements that could scroll the page under a finger: the list itself and its scrollable parents. */
  const scrollers = () => {
    const out = [];
    for (let n = box; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const canX = /(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1;
      const canY = /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1;
      if (canX || canY) out.push({ el: n, canX, canY });
    }
    return out;
  };
  const lock = (list) => list.forEach((s) => ((s.prev = [s.el.style.overflow, s.el.style.overscrollBehavior]), (s.el.style.overflow = 'hidden'), (s.el.style.overscrollBehavior = 'contain')));
  const unlock = (list) => list.forEach((s) => ((s.el.style.overflow = s.prev?.[0] ?? ''), (s.el.style.overscrollBehavior = s.prev?.[1] ?? '')));

  /** Slide the siblings from where they were to where they are now. */
  const flip = (before) => {
    for (const it of items()) {
      const a = before.get(it);
      if (!a || it === drag?.el) continue;
      const b = it.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      it.style.transition = 'none';
      it.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        it.style.transition = 'transform 160ms ease';
        it.style.transform = '';
        setTimeout(() => (it.style.transition = ''), 200);
      });
    }
  };

  const edgeScroll = () => {
    if (!drag?.active) return;
    const { x, y } = drag;
    for (const s of drag.scrollers) {
      const r = s.el.getBoundingClientRect();
      const band = 56;
      const speed = (d) => Math.round(4 + (1 - Math.max(0, Math.min(1, d / band))) * 14);
      if (s.canX) {
        if (x < r.left + band) s.el.scrollLeft -= speed(x - r.left);
        else if (x > r.right - band) s.el.scrollLeft += speed(r.right - x);
      }
      if (s.canY) {
        if (y < r.top + band) s.el.scrollTop -= speed(y - r.top);
        else if (y > r.bottom - band) s.el.scrollTop += speed(r.bottom - y);
      }
    }
    place(); // also while the finger rests (after the neighbours settled, or while the list scrolls under it)
    drag.raf = requestAnimationFrame(edgeScroll);
  };

  const place = () => {
    if (!drag?.active) return;
    // right after a swap the neighbours are still sliding (their on-screen boxes are mid-move): wait until they have settled
    if (performance.now() < drag.settleAt) return;
    // the item under the pointer decides the new place
    const target = items().find((it) => {
      if (it === drag.el) return false;
      const r = it.getBoundingClientRect();
      return drag.x >= r.left && drag.x <= r.right && drag.y >= r.top && drag.y <= r.bottom;
    });
    if (!target) return;
    const list = items();
    const before = new Map(list.map((it) => [it, it.getBoundingClientRect()]));
    if (list.indexOf(drag.el) < list.indexOf(target)) target.after(drag.el);
    else target.before(drag.el);
    drag.moved = true;
    drag.settleAt = performance.now() + 190;
    flip(before);
  };

  box.addEventListener('pointerdown', (e) => {
    if (box.classList.contains('no-drag')) return; // a sorted or searched list: there is no "your order" to change
    if (e.button > 0 || drag) return;
    const el = e.target.closest(item);
    if (!el || !box.contains(el)) return;
    const st = { el, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId, active: false, timer: null, moved: false, ghost: null, dx: 0, dy: 0, scrollers: [], raf: 0, settleAt: 0 };
    drag = st;
    st.timer = setTimeout(() => {
      st.active = true;
      st.scrollers = scrollers();
      lock(st.scrollers);
      el.classList.add('sorting');
      navigator.vibrate?.(15);
      const r = el.getBoundingClientRect();
      st.dx = st.sx - r.left;
      st.dy = st.sy - r.top;
      // a floating copy follows the finger; the real item (dimmed) marks where it will land
      const g = el.cloneNode(true);
      g.classList.add('sort-ghost');
      g.style.width = r.width + 'px';
      g.style.height = r.height + 'px';
      g.style.left = r.left + 'px';
      g.style.top = r.top + 'px';
      document.body.append(g);
      st.ghost = g;
      st.raf = requestAnimationFrame(edgeScroll);
    }, delay);
  });

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 9) {
          clearTimeout(drag.timer); // the finger moved first: this is a scroll, not a drag
          drag = null;
        }
        return;
      }
      e.preventDefault();
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.ghost.style.transform = `translate(${e.clientX - drag.sx}px, ${e.clientY - drag.sy}px) scale(1.04)`;
      place();
    },
    { passive: false },
  );

  // the browser must not scroll under the finger while an item is held (needs a non-passive listener)
  const stopScroll = (e) => drag?.active && e.cancelable && e.preventDefault();
  box.addEventListener('touchmove', stopScroll, { passive: false });
  document.addEventListener('touchmove', stopScroll, { passive: false });

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    clearTimeout(drag.timer);
    cancelAnimationFrame(drag.raf);
    const st = drag;
    drag = null;
    if (!st.active) return;
    unlock(st.scrollers);
    st.el.classList.remove('sorting');
    st.ghost?.remove();
    swallowClick = true; // the tap that ends a drag is not a click on the item
    setTimeout(() => (swallowClick = false), 60);
    if (st.moved && e?.type !== 'pointercancel') onDone?.(items());
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  box.addEventListener('click', (e) => swallowClick && (e.stopPropagation(), e.preventDefault()), true);
  box.addEventListener('contextmenu', (e) => e.target.closest(item) && e.preventDefault()); // Android long-press menu
}
