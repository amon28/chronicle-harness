import { test, expect } from './helpers.js';

// Decision 228: the 📎 and tools menus follow their button when the screen size changes while they are open – tapping
// 📎 closes the keyboard, the message box drops to the bottom, and the menu used to stay stuck mid-screen.
const gap = (app, menu, btn) =>
  app.evaluate(
    ([m, b]) => document.querySelector(b).getBoundingClientRect().top - document.querySelector(m + ' .sheet-card').getBoundingClientRect().bottom,
    [menu, btn],
  );

for (const [menu, btn] of [
  ['#compose-menu', '#attach-btn'],
  ['#tools-menu', '#tools-btn'],
]) {
  test(`${menu} stays just above its button when the keyboard goes away`, async ({ app }) => {
    const full = app.viewportSize();
    await app.setViewportSize({ width: full.width, height: Math.round(full.height * 0.55) }); // the keyboard is up
    await app.click(btn);
    await expect(app.locator(menu)).toHaveClass(/open/);
    await expect.poll(() => gap(app, menu, btn)).toBeGreaterThanOrEqual(4);
    await app.setViewportSize(full); // the keyboard closes: the message box drops to the bottom
    await expect.poll(() => gap(app, menu, btn)).toBeLessThan(20); // right above it, not left mid-screen
    expect(await gap(app, menu, btn)).toBeGreaterThanOrEqual(4);
  });
}
