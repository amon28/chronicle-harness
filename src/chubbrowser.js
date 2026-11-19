// Browse chub.ai inside the app. On Android a native screen shows the site; when you download a character
// card (PNG / JSON) the app imports it at once while the screen stays open.
import { Capacitor, registerPlugin } from '@capacitor/core';

const native = Capacitor.isNativePlatform() ? registerPlugin('ChubBrowser') : null;

export const canBrowseChub = () => !!native || !!globalThis.__ocmChubBrowserTest;

export const SITES = { chub: 'Chub', botbooru: 'BotBooru', chararc: 'Character Archive' };

/**
 * Open the site. Each download (or "Import this page") goes to onItem({ name, base64 } | { link }) while the screen
 * stays open; what onItem returns is shown in the screen's message bar. → { items } – anything that could not be
 * handed over live (handed back when the screen closed).
 */
export async function browseSite(site = 'chub', onItem = null) {
  // tests: deliver(item) plays a download while the screen is open; the message bar's texts go to __ocmChubStatus
  if (globalThis.__ocmChubBrowserTest) return globalThis.__ocmChubBrowserTest(site, onItem && (async (it) => (globalThis.__ocmChubStatus ||= []).push(await onItem(it))));
  if (!native) throw new Error('The character-site browser is part of the Android app');
  let queue = Promise.resolve();
  const handle = onItem
    ? await native.addListener('item', (it) => {
        // one at a time, in the order they came
        queue = queue.then(async () => {
          const text = await onItem(it).catch((e) => `Couldn't import it: ${e?.message || e}`);
          if (text) await native.status({ text }).catch(() => {});
        });
      })
    : null;
  try {
    const r = await native.open({ site, live: !!onItem });
    await queue;
    return r;
  } finally {
    handle?.remove();
  }
}

export const bytesFromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
