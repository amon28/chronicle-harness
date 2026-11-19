// Screenshots of a web page, in a phone-sized and/or desktop-sized window, so the assistant can see a page's layout
// (like Playwright's page.screenshot). A real headless Chrome renders the page: Microlink first (an optional key lifts
// its free daily limit), thum.io as a fallback. The page address is sent to that service.
import { fetchBytes, httpGet } from './api.js';
import { unsafe } from './websearch.js';

export const VIEWS = {
  mobile: { label: 'mobile (390 px wide phone)', w: 390, h: 844, dsf: 2 },
  desktop: { label: 'desktop (1280 px wide)', w: 1280, h: 800, dsf: 1 },
};
const MAX_BYTES = 12 * 1024 * 1024;

/** Tests can install globalThis.__ocmScreenshot = async (url, { view, fullPage }) => { bytes, width, height } */
export async function takeScreenshot(url, { view = 'mobile', fullPage = false, waitMs = 1500, key = '' } = {}) {
  const why = unsafe(url);
  if (why) throw new Error(`Won't open that address (${why})`);
  if (globalThis.__ocmScreenshot) return { via: 'test', ...(await globalThis.__ocmScreenshot(url, { view, fullPage })) };
  const v = VIEWS[view] || VIEWS.mobile;
  const errors = [];
  try {
    return await viaMicrolink(url, v, fullPage, waitMs, key);
  } catch (e) {
    errors.push(`Microlink: ${e.message}`);
  }
  try {
    return await viaThum(url, v, fullPage);
  } catch (e) {
    errors.push(`thum.io: ${e.message}`);
  }
  throw new Error(`Could not take a screenshot (${errors.join(' · ')})`);
}

async function viaMicrolink(url, v, fullPage, waitMs, key) {
  const q = new URLSearchParams({
    url,
    screenshot: 'true',
    meta: 'false',
    type: 'jpeg',
    'viewport.width': String(v.w),
    'viewport.height': String(v.h),
    'viewport.deviceScaleFactor': String(v.dsf),
    'viewport.isMobile': String(v.w < 600),
    'viewport.hasTouch': String(v.w < 600),
    fullPage: String(!!fullPage),
    waitUntil: 'networkidle2',
    waitForTimeout: String(Math.min(8000, waitMs)),
  });
  const r = await httpGet(`https://api.microlink.io/?${q}`, key ? { 'x-api-key': key } : {}, 60000);
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    throw new Error(`HTTP ${r.status}`);
  }
  if (j.status !== 'success' || !j.data?.screenshot?.url) {
    throw new Error(j.code === 'ERATE' ? 'its free daily limit is used up (add a Microlink key in Settings › Tools & agent, or try again tomorrow)' : j.message || j.code || `HTTP ${r.status}`);
  }
  const s = j.data.screenshot;
  if (s.size > MAX_BYTES) throw new Error('screenshot too large');
  return { via: 'microlink', bytes: await fetchBytes(s.url, { timeoutMs: 45000 }), width: s.width, height: s.height, mime: 'image/jpeg' };
}

async function viaThum(url, v, fullPage) {
  const opt = `viewportWidth/${v.w}/width/${v.w * v.dsf}${fullPage ? '/fullpage' : `/crop/${v.h * v.dsf}`}/noanimate`;
  const bytes = await fetchBytes(`https://image.thum.io/get/${opt}/${url}`, { timeoutMs: 60000 });
  if (bytes.length < 500) throw new Error('empty image');
  return { via: 'thum.io', bytes, width: v.w, height: v.h, mime: 'image/png' };
}
