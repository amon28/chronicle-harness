// The chat's /workspace as a real web origin. The assistant's browser (and preview_page) loads workspace pages
// from https://<chat>.workspace.localhost/ (one origin per chat), served by the native browser straight from the shell's /workspace folder on
// disk – so a page can load its CSS and scripts by path, follow links, redirect (location.replace('dashboard.html')),
// keep localStorage, and the shell's files are the same files. Nothing else on the phone or the network is reached:
// only the browser session that opened the page serves it.
import { syncWork, workDir } from './bridge.js';
import * as fs from './shellfs.js';
import { cleanPath } from './sandbox.js';

export const SITE_HOST = 'workspace.localhost';
export const SITE_ORIGIN = 'https://' + SITE_HOST;

/** Each chat's site is its own origin – https://c1k2j3.workspace.localhost/ – so localStorage, sessionStorage,
 *  cookies and IndexedDB are per chat: a login in one chat's site never shows up in another's, even when both
 *  are open at once. The label is a short stable hash of the chat id (a valid host name whatever the id is). */
export function siteHost(convId) {
  if (!convId) return SITE_HOST;
  let h = 5381;
  for (const ch of String(convId)) h = (Math.imul(h, 33) ^ ch.charCodeAt(0)) >>> 0;
  return 'c' + h.toString(36) + '.' + SITE_HOST;
}
export const siteOrigin = (convId) => 'https://' + siteHost(convId);
const SITE_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*workspace\.localhost(?::\d+)?(\/.*)?$/i;

/**
 * A workspace page the assistant named, in any of the ways it writes one:
 *   /workspace/site/login.html   workspace/site/login.html   site/login.html#demo   https://workspace.localhost/site/
 * → { path, suffix, url } (suffix = ?query#hash kept for the page), or null for a normal web address.
 */
export function workspaceTarget(input, convId) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let rest;
  const m = SITE_URL.exec(raw);
  if (m) rest = m[1] || '/';
  else if (/^file:\/\/\/workspace(\/|$)/i.test(raw)) rest = raw.slice('file:///workspace'.length) || '/';
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null; // a real address
  else if (/^\/workspace(\/|$)/.test(raw)) rest = raw.slice('/workspace'.length) || '/';
  else if (raw.startsWith('/')) return null;
  else if (/^workspace\//.test(raw)) rest = '/' + raw.slice('workspace/'.length);
  else if (/^[^\s?#]+\.(html?|svg|xhtml)([?#].*)?$/i.test(raw) || raw.endsWith('/')) rest = '/' + raw;
  else return null;
  const cut = rest.search(/[?#]/);
  const pathPart = cut >= 0 ? rest.slice(0, cut) : rest;
  const suffix = cut >= 0 ? rest.slice(cut) : '';
  let path = '';
  try {
    path = cleanPath(decodeURIComponent(pathPart)) || '';
  } catch {
    path = cleanPath(pathPart) || '';
  }
  const enc = path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return { path, suffix, url: `${siteOrigin(convId)}/${enc}${pathPart.endsWith('/') && enc ? '/' : ''}${suffix}` };
}

export const isSiteUrl = (u) => SITE_URL.test(String(u || ''));

/** http://127.0.0.1:8099/, http://localhost:3000 – a server the assistant may have started in the shell. */
export function isLoopbackUrl(u) {
  try {
    const x = new URL(String(u));
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || /^127\./.test(h) || h === '::1';
  } catch {
    return false;
  }
}

/** Error and console capture put at the top of every served HTML page, so errors from the first line are seen. */
// WebGL keeps its last frame (preserveDrawingBuffer), so a screenshot can copy it into a picture (decision 206)
export const SITE_PROBE =
  "<script>(function(){try{var g=HTMLCanvasElement.prototype.getContext;if(g.__ocmKeep)return;var f=function(t,o){if(/^(webgl2?|experimental-webgl)$/.test(String(t))){o=Object.assign({},o||{},{preserveDrawingBuffer:true})}return g.call(this,t,o)};f.__ocmKeep=1;HTMLCanvasElement.prototype.getContext=f}catch(e){}})();(function(){if(window.__ocmErr)return;window.__ocmErr=[];window.__ocmLog=window.__ocmLog||[];var P=function(t,m){m=String(m).slice(0,400);if(t!=='log')__ocmErr.push(m);__ocmLog.push({t:t,m:[m]});if(__ocmLog.length>200)__ocmLog.shift()};addEventListener('error',function(e){var el=e.target;if(el&&el!==window&&(el.src||el.href)){P('pageerror','could not load '+String(el.src||el.href).replace(location.origin,''));return}P('pageerror',(e.message||'error')+(e.filename?' ('+String(e.filename).split('/').pop()+':'+e.lineno+')':''))},true);addEventListener('unhandledrejection',function(e){P('pageerror','Unhandled rejection: '+(e.reason&&e.reason.message||e.reason))});var ce=console.error;console.error=function(){P('error','console.error: '+[].slice.call(arguments).join(' '));try{ce.apply(console,arguments)}catch(x){}}})();</script>";

/**
 * Before a workspace page is opened (or reloaded): the app's copy of the workspace and the shell's /workspace are
 * reconciled, then the folder is handed to the browser. → the absolute folder to serve.
 * Tests install globalThis.__ocmServe(w, convId) instead.
 */
export async function serveWorkspace(w, convId) {
  if (globalThis.__ocmServe) return globalThis.__ocmServe(w, convId);
  if (!w) throw new Error('This chat has no workspace to serve');
  const r = await syncWork(w, convId, { prefer: 'a' });
  // a page whose files are not all in the folder is not served: the caller falls back (or says why)
  if (r.failed?.length) throw new Error('could not copy ' + r.failed[0].path + ' into the served folder (' + r.failed[0].error + ')');
  return fs.hostPath(workDir(convId));
}
