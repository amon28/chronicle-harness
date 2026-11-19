// Cloudflare Worker: CORS proxy for OpenCode Go, for using the web/PWA version
// (e.g. on iPhone). The Android app talks to OpenCode Go directly and does not need this.
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
// Edit code → paste this file → Deploy. Put the *.workers.dev URL in the app's Settings.
//
// Your API key is sent by the app on each request and only forwarded; nothing is stored.
// Optionally set ALLOWED_ORIGIN (Settings → Variables) to your PWA's origin to lock it down.

const UPSTREAM = 'https://opencode.ai/inference/go';
const ALLOWED_PATHS = ['/openai/v1/chat/completions', '/v1/models'];

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, x-opencode-session, x-client',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.includes(url.pathname)) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers();
    for (const h of ['authorization', 'content-type', 'accept', 'x-opencode-session']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('user-agent', request.headers.get('x-client') || 'chronicle/1.0');

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
    });
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
