// A tiny stand-in for the OpenCode Go API (OpenAI-style SSE streaming) used by the end-to-end tests.
// The app talks to it via the "proxy URL" setting. Every request body is recorded; tests read them
// back from GET /__requests (and clear them with POST /__reset).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 8788);
const models = readFileSync(new URL('./fixtures/models.json', import.meta.url));
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
let requests = [];
const seen = new Map(); // per-scenario counters
let n = 0;
let limitedUntil = 0;
const oauthCodes = new Map();
const bridges = new Map();
process.on('exit', () => bridges.forEach((p) => p.kill()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A bridge started for an earlier test on the same port: stopped, and waited for until it has exited. */
async function stopBridge(key) {
  const old = bridges.get(key);
  bridges.delete(key);
  if (!old || old.exitCode !== null || old.signalCode !== null) return;
  const gone = new Promise((r) => old.once('exit', r));
  old.kill();
  await Promise.race([gone, wait(3000)]);
}
/** Until something accepts connections on the port (the bridge is up), at most 10 s. */
async function listening(port) {
  const net = await import('node:net');
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const c = net.connect(port, '127.0.0.1', () => (c.end(), r(true)));
      c.on('error', () => r(false));
    });
    if (ok) return;
    await wait(100);
  }
}
// a tool the request offers: in full, or by name in load_tools' list (held back until loaded – a model may call it
// directly, which the app allows; decision 175)
const offered = (jb, name) => (jb.tools || []).some((t) => t.function.name === name || (t.function.name === 'load_tools' && String(t.function.description || '').includes(`- ${name}:`)));

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const json = (code, obj) => {
        res.writeHead(code, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // --- GitHub's device flow and API (Settings › Connections › GitHub)
      if (req.url === '/gh/login/device/code') {
        if (!/client_id=(Ov23test|Iv1test)/.test(body)) return json(200, { error: 'device_flow_disabled' });
        globalThis.__ghPolls = 0;
        globalThis.__ghApp = /client_id=Iv1test/.test(body); // a GitHub App: expiring tokens and installations
        return json(200, { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: `http://localhost:${PORT}/gh/login/device`, interval: 1, expires_in: 60 });
      }
      if (req.url === '/gh/login/oauth/access_token') {
        // pending once, then the token – as when the user approves a moment later
        if (/grant_type=refresh_token/.test(body)) return json(200, /refresh_token=ghr_mock/.test(body) ? { access_token: 'ghu_mockrenewed1234567890', refresh_token: 'ghr_mock2', expires_in: 28800, refresh_token_expires_in: 15897600 } : { error: 'bad_refresh_token' });
        if (globalThis.__ghApp) return json(200, globalThis.__ghPolls++ < 1 ? { error: 'authorization_pending' } : { access_token: 'ghu_mocktoken1234567890', refresh_token: 'ghr_mock', expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' });
        return json(200, globalThis.__ghPolls++ < 1 ? { error: 'authorization_pending' } : { access_token: 'gho_mocktoken1234567890', token_type: 'bearer', scope: 'repo,read:user,user:email' });
      }
      if (req.url === '/ghapi/user') {
        if (!/Bearer (gho_mocktoken1234567890|ghu_mock\w+|github_pat_mock\w+)/.test(req.headers.authorization || '')) return json(401, { message: 'Bad credentials' });
        res.writeHead(200, { ...cors, 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:user, user:email' });
        return res.end(JSON.stringify({ login: 'tester', id: 42, name: 'Test Er', email: null }));
      }
      if (req.url.startsWith('/ghapi/user/installations/77/repositories')) return json(200, { total_count: 2, repositories: [{ full_name: 'acme/game' }, { full_name: 'acme/site' }] });
      if (req.url.startsWith('/ghapi/user/installations')) return json(200, { total_count: 1, installations: [{ id: 77, account: { login: 'acme' } }] });
      if (req.url === '/ghapi/user/emails') return json(200, [{ email: 'tester@example.com', primary: true, verified: true }]);
      if (req.url.startsWith('/ghapi/user/repos')) return json(200, [{ full_name: 'tester/demo' }]);
      if (req.url === '/gh/login/device') {
        res.writeHead(200, { ...cors, 'content-type': 'text/html' });
        return res.end('<p>Enter the code</p>');
      }
      // --- an MCP server that needs OAuth sign-in (discovery, registration, PKCE, tokens)
      const B = `http://localhost:${PORT}`;
      if (req.url === '/.well-known/oauth-protected-resource/mcp-auth') return json(200, { resource: B + '/mcp-auth', authorization_servers: [B + '/as'] });
      if (req.url === '/.well-known/oauth-authorization-server/as') return json(200, { issuer: B + '/as', authorization_endpoint: B + '/as/authorize', token_endpoint: B + '/as/token', registration_endpoint: B + '/as/register', code_challenge_methods_supported: ['S256'] });
      if (req.url === '/as/register') return json(201, { client_id: 'mock-client' });
      if (req.url.startsWith('/as/authorize')) {
        const q = new URL(req.url, B).searchParams;
        oauthCodes.set('c1', q.get('code_challenge'));
        return json(200, { redirect: `${q.get('redirect_uri')}?code=c1&state=${q.get('state')}` });
      }
      if (req.url === '/as/token') {
        const p = new URLSearchParams(body);
        const ch = createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (p.get('grant_type') !== 'authorization_code' || oauthCodes.get(p.get('code')) !== ch) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'mcp-at', refresh_token: 'mcp-rt', expires_in: 3600 });
      }
      // an MCP server whose tools carry labels and a picture (decision 201)
      if (req.url === '/mcp-pics') {
        const rq = JSON.parse(body || '{}');
        if (rq.id == null) return json(202, {});
        if (rq.method === 'initialize') return json(200, { jsonrpc: '2.0', id: rq.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pics-mock' } } });
        if (rq.method === 'tools/list')
          return json(200, { jsonrpc: '2.0', id: rq.id, result: { tools: [
            { name: 'snap', description: 'A picture of the dashboard', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
            { name: 'wipe', description: 'Delete everything', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
          ] } });
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        return json(200, { jsonrpc: '2.0', id: rq.id, result: { content: [{ type: 'text', text: 'Dashboard:' }, { type: 'image', data: PNG, mimeType: 'image/png' }] } });
      }
      if (req.url === '/mcp-auth') {
        if (req.headers.authorization !== 'Bearer mcp-at') {
          res.writeHead(401, { ...cors, 'WWW-Authenticate': `Bearer resource_metadata="${B}/.well-known/oauth-protected-resource/mcp-auth"`, 'Access-Control-Expose-Headers': 'WWW-Authenticate' });
          return res.end();
        }
        const rq = JSON.parse(body || '{}');
        if (rq.id == null) return json(202, {});
        if (rq.method === 'initialize') return json(200, { jsonrpc: '2.0', id: rq.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'auth-mock' } } });
        if (rq.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: rq.id, result: { tools: [{ name: 'whoami', description: 'Who is signed in', inputSchema: { type: 'object', properties: {} } }] } });
        return json(200, { jsonrpc: '2.0', id: rq.id, result: { content: [{ type: 'text', text: 'signed in' }] } });
      }
      // a PC agent: the real acp-bridge with a fake ACP agent behind it
      if (req.url.startsWith('/__spawn-acp')) {
        const q = new URL(req.url, 'http://x').searchParams;
        await stopBridge('acp' + q.get('port')); // the old one must let go of the port first, or the new one cannot listen
        // store: the fake agent keeps its sessions in this file, as Claude Code keeps them on disk (decision 234)
        const env = q.get('store') ? { ...process.env, FAKE_ACP_STORE: q.get('store') } : process.env;
        const p = spawn('python3', [fileURLToPath(new URL('../../scripts/acp-bridge.py', import.meta.url)), '--host', '127.0.0.1', '--port', q.get('port'), '--secret', q.get('secret'), '--', 'python3', fileURLToPath(new URL('./fixtures/fake_acp_agent.py', import.meta.url))], { stdio: 'ignore', env });
        bridges.set('acp' + q.get('port'), p);
        await listening(Number(q.get('port')));
        return json(200, { ok: true });
      }
      // the fake shell asks for a stdio MCP server: start the real mcp-bridge here, with a tiny echo server behind it
      if (req.url.startsWith('/__spawn-bridge')) {
        const q = new URL(req.url, 'http://x').searchParams;
        await stopBridge(q.get('port'));
        const p = spawn('python3', [fileURLToPath(new URL('../../src/toolkit/mcp-bridge', import.meta.url)), '--port', q.get('port'), '--secret', q.get('secret'), '--', 'python3', fileURLToPath(new URL('./fixtures/echo_mcp.py', import.meta.url))], { stdio: 'ignore' });
        bridges.set(q.get('port'), p);
        return json(200, { ok: true });
      }
      if (req.url === '/__requests') return json(200, requests);
      if (req.url === '/__reset') {
        requests = [];
        seen.clear();
        n = 0;
        limitedUntil = 0;
        return json(200, { ok: true });
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        return res.end(models);
      }
      if (req.url === '/usage' && limitedUntil > Date.now()) return json(200, { usage: { rolling: { status: 'rate-limited', percent: 100, resetsAt: limitedUntil }, weekly: { status: 'ok', percent: 55 }, monthly: { status: 'ok', percent: 30 } } });
      if (req.url === '/usage') return json(200, { usage: { rolling: { status: 'ok', percent: 12 }, weekly: { status: 'ok', percent: 55 }, monthly: { status: 'ok', percent: 30 } } });
      // --- Anthropic's Messages API (decision 164): the official SDK points its baseURL at /anthropic
      if (req.url.startsWith('/anthropic/v1/')) {
        const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (key !== 'sk-ant-good') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        if (req.url.startsWith('/anthropic/v1/models')) {
          const cap = (on) => ({ supported: on });
          const caps = { effort: { supported: true, low: cap(true), medium: cap(true), high: cap(true), xhigh: cap(true), max: cap(true) }, thinking: { supported: true, types: { adaptive: cap(true), enabled: cap(false), disabled: cap(false), between_tools: cap(false) } }, image_input: cap(true) };
          const m = (id, display_name) => ({ id, display_name, type: 'model', created_at: '2026-10-01T00:00:00Z', lifecycle: 'active', max_input_tokens: 1000000, max_tokens: 128000, capabilities: caps });
          return json(200, { data: [m('claude-sonnet-5-5', 'Claude Sonnet 5.5'), m('claude-opus-5-5', 'Claude Opus 5.5')], has_more: false, first_id: 'claude-sonnet-5-5', last_id: 'claude-opus-5-5' });
        }
        let ab = {};
        try {
          ab = JSON.parse(body || '{}');
        } catch {
          /* not JSON */
        }
        requests.push({ ...ab, _anthropic: true, _beta: req.headers['anthropic-beta'] || null });
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
        const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        let idx = 0;
        const usage = { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: requests.filter((r) => r._anthropic).length > 1 ? 1500 : 0, cache_creation_input_tokens: 300 };
        ev({ type: 'message_start', message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: ab.model, content: [], stop_reason: null, stop_sequence: null, usage } });
        const think = (t) => {
          ev({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
          ev({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: t } });
          ev({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'sig-' + idx } });
          ev({ type: 'content_block_stop', index: idx++ });
        };
        const text = (t) => {
          ev({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
          for (const part of t.match(/.{1,6}/gs)) ev({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: part } });
          ev({ type: 'content_block_stop', index: idx++ });
        };
        const finish = (stop_reason) => {
          ev({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 42 } });
          ev({ type: 'message_stop' });
          res.end();
        };
        const am = ab.messages || [];
        const lastBlocks = am.at(-1)?.content || [];
        const result = lastBlocks.find?.((b) => b.type === 'tool_result');
        const said = lastBlocks.filter?.((b) => b.type === 'text').map((b) => b.text).join(' ') || '';
        if (result) {
          think('The file is written.');
          text(`Claude saw the result: ${String(typeof result.content === 'string' ? result.content : JSON.stringify(result.content)).slice(0, 60)}`);
          return finish('end_turn');
        }
        if (/ANTHTOOL/.test(said) && (ab.tools || []).some((t) => t.name === 'write_file')) {
          think('I should write the file.');
          text('Writing it now.');
          ev({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: 'toolu_mock1', name: 'write_file', input: {} } });
          ev({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: '{"path":"claude.txt",' } });
          ev({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: '"content":"written by Claude"}' } });
          ev({ type: 'content_block_stop', index: idx++ });
          return finish('tool_use');
        }
        think('A friendly greeting fits.');
        text(`Hello from ${ab.model}! You said: ${said.slice(0, 40)}`);
        return finish('end_turn');
      }
      if (req.headers.authorization !== 'Bearer good') return json(401, { type: 'error', error: { type: 'AuthError', message: 'Invalid API key' } });

      let jb = {};
      try {
        jb = JSON.parse(body || '{}');
      } catch {
        /* not JSON */
      }
      requests.push(jb);
      // --- flaky provider: Cloudflare 520 (Chub's "unknown origin error") – once, or always – and an empty reply
      const lt = String((jb.messages || []).at(-1)?.content || '');
      const nth = (key) => (seen.set(key, (seen.get(key) || 0) + 1), seen.get(key));
      if (/CF520/.test(lt) && (/ALWAYS/.test(lt) || nth('cf') === 1)) {
        res.writeHead(520, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/', title: 'Error 520: Web server is returning an unknown error', status: 520, error_code: 520, cloudflare_error: true, retryable: true, retry_after: 60, zone: 'inference.chub.ai' }));
      }
      // a model with a 5000-token window that says so when a request is too long (OpenAI's wording)
      if (/TOOLONG/.test(lt) && body.length > 20000) {
        return json(400, { error: { message: `This model's maximum context length is 5000 tokens. However, your messages resulted in ${Math.round(body.length / 4)} tokens. Please reduce the length of the messages.`, type: 'invalid_request_error', code: 'context_length_exceeded' } });
      }
      // resume (decision 199): a tool step, then the next request fails once; a resumed reply goes on from the step
      const userTextR = (jb.messages || []).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ');
      if (/RESUMEME/.test(userTextR) && (jb.messages || []).some((m) => m.role === 'tool') && nth('resume') === 1) return json(400, { error: { message: 'Bad request: the test provider refused this one' } });
      if (/LIMITME/.test(lt) && nth('limit') === 1) {
        limitedUntil = Date.now() + 1000;
        return json(429, { error: { type: 'rate_limit_error', message: 'Usage limit reached for the 5-hour window' } });
      }
      if (/FALLBACKTEST/.test(lt) && jb.model === 'glm-5.3') {
        res.writeHead(429, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'server_error', message: 'Upstream request failed: [overloaded] the server is overloaded; retry shortly' } }));
      }
      if (/OVERLOAD429/.test(lt) && (/ALWAYS/.test(lt) || nth('ovl') === 1)) {
        res.writeHead(429, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'server_error', message: 'Upstream request failed: [overloaded] the server is overloaded; retry shortly' } }));
      }
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      if (/EMPTYREPLY/.test(lt) && nth('empty') === 1) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const done = () => {
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const say = (text) => {
        send({ choices: [{ delta: { content: text } }] });
        done();
      };
      // --- agent scenario: "check the images" → view_images → answer from what came back
      const msgs = jb.messages || [];
      const last = msgs.at(-1) || {};
      const sys = typeof msgs[0]?.content === 'string' ? msgs[0].content : '';
      const lastText = typeof last.content === 'string' ? last.content : (last.content || []).map((p) => p.text || '').join(' ');
      // /btw: a side question answers from the chat it was sent (no tools); the done check: the model owns up
      if (/^\[A quick side question from the user/.test(lastText)) return say(`BTW answer (${(jb.tools || []).length ? 'with tools' : 'no tools'}, ${msgs.length} messages): ${lastText.split('\n\n').pop()}`);
      // a model stuck repeating itself (decision 201): the same sentence 40 times, in small pieces
      if (/CHANTME/.test(lastText)) {
        send({ choices: [{ delta: { content: 'Let me look. ' } }] });
        for (let i = 0; i < 40; i++) send({ choices: [{ delta: { content: 'I will check the file once more to be sure about it. ' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        return done();
      }
      // the step limit: one tool call per step while tools are offered; the wrap-up request (no tools, tool turns as text)
      if (/^\[Chronicle: you have used all \d+ tool steps/.test(lastText)) return say(`WRAPPED (${(jb.tools || []).length ? 'with tools' : 'no tools'}, ${msgs.some((x) => x.role === 'tool' || x.tool_calls) ? 'tool turns' : 'as text'}): listed the files; next: read them.`);
      if (msgs.some((x) => x.role === 'user' && /RESUMEME/.test(JSON.stringify(x.content || '')))) {
        const results = msgs.filter((x) => x.role === 'tool').length;
        if (!results && offered(jb, 'list_files')) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_rs1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say(`Went on with ${results} tool result${results === 1 ? '' : 's'} from before.`);
      }
      if (msgs.some((x) => x.role === 'user' && /STEPLIMIT/.test(JSON.stringify(x.content || ''))) && offered(jb, 'list_files')) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sl' + msgs.length, type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/^\[Done check – from the app/.test(lastText)) return say(`Unchecked: I did not run ${/these files: ([^,]+?)(,| and| –|$)/.exec(lastText)?.[1] || 'it'}.`);
      if (msgs.some((x) => x.role === 'user' && /BROWSESHOT2/.test(JSON.stringify(x.content || ''))) && offered(jb, 'browser')) {
        const tools = msgs.slice(msgs.map((x) => x.role === 'user' && /BROWSESHOT2/.test(JSON.stringify(x.content || ''))).lastIndexOf(true)).filter((x) => x.role === 'tool');
        const call = (name, args) => {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s2' + tools.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return call('browser', { action: 'open', url: 'https://example.test/page' });
        if (tools.length === 1 || tools.length === 2) return call('browser', { action: 'screenshot', full_page: true });
        if (tools.length === 3) return call('list_files', { path: 'output/screenshots' });
      }
      // a scripted turn: "DOCALLS [["tool",{args}],…]" in your newest message (SUBCALLS in a helper's task) makes exactly
      // those calls once, then the answer lists what came back
      {
        const lu = msgs.filter((x) => x.role === 'user' && typeof x.content === 'string' && /(DOCALLS|SUBCALLS) \[/.test(x.content)).at(-1);
        const stillLast = lu && msgs.filter((x) => x.role === 'user').at(-1) === lu;
        const mm = stillLast && (/DOCALLS (\[.*\])\s*$/m.exec(lu.content) || /SUBCALLS (\[.*\])\s*$/m.exec(lu.content));
        if (mm && (jb.tools || []).length) {
          const results = msgs.slice(msgs.indexOf(lu)).filter((x) => x.role === 'tool');
          if (!results.length) {
            const list = JSON.parse(mm[1]);
            send({ choices: [{ delta: { reasoning_content: 'Which calls? These.' } }] });
            send({ choices: [{ delta: { tool_calls: list.map((c, i) => ({ index: i, id: 'call_dc' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) } })) } }] });
            send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
            return done();
          }
          return say('RESULTS: ' + results.map((t) => String(t.content).split('\n')[0]).join(' | '));
        }
      }
      if (/^Describe each of these/.test(lastText)) return say('Image 1 – photos/blue.png: a solid blue square.\nImage 2 – photos/red.png: a solid red square.');
      if (last.role === 'user' && lastText.startsWith('[Images from view_images')) return say(`I looked at ${last.content.filter((p) => p.type === 'image_url').length} images directly.`);
      if (last.role === 'tool' && /^Descriptions of|Description by/.test(last.content)) return say('From the descriptions: one red and one blue square.');
      if (sys.startsWith('You turn a roleplay character')) return say('You *are* Seraphina. Every thought, reaction, and response comes from inside you.\n\n**Identity & Voice**\n- Gentle guardian of the glade.');
      // --- cut-off scenarios: a reply that stops on the length limit, one that is cut by the connection
      if (String(last.content).includes('last message from exactly where it stopped')) return say(' and here is the rest of it.');
      if (String(last.content).includes('The user sent nothing – carry on')) return say('And so the story went on.');
      // a quiet scheduled check: nothing the first time, news the second
      if (/QUIETCHECK/.test(lastText)) return say(nth('quiet') === 1 ? 'NOTHING_NEW' : 'The price dropped to 10.');
      if (/FILELINKS/.test(lastText)) return say('Saved `output/my notes.md` (see `output/my notes.md:4`). Run `npm run dev`; `output/my` is not a file; plain output/my notes.md stays text.');
      if (/TOOLONG/.test(lastText)) return say(`It fits now (${msgs.length} messages).`);
      if (/QUOTEDREPLY/.test(lastText)) return say('*She smiles.* "Welcome home," she says. *She waits.* "Sit down."');
      if (/LONGREPLY/.test(lastText)) {
        send({ choices: [{ delta: { content: 'The first part of a long reply' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'length' }] });
        return done();
      }
      if (/DROPPED/.test(lastText)) {
        send({ choices: [{ delta: { content: 'A reply that stops when the connection dr' } }] });
        return res.end(); // no finish_reason, no [DONE]
      }
      if (sys.includes('inside <choices></choices>') && !/Step inside/.test(JSON.stringify(msgs.slice(1)))) return say('*The door creaks open.*\n\n<choices>\n1. Step inside\n2. *Run* away\n</choices>');
      if (sys.startsWith('You are an editor. You get a piece of text')) return say(String(msgs[1]?.content || '').match(/<<<\n([\s\S]*)\n>>>/)?.[1].replace(/bold/g, 'italic') || '');
      if (sys.startsWith('You polish a chat message')) return say(String(msgs[1]?.content || '').match(/<<<\n([\s\S]*)\n>>>/)?.[1].replace(/\bteh\b/g, 'the').replace(/^./, (c) => c.toUpperCase()) || '');
      if (sys.startsWith('You edit one field of a roleplay character card')) return say('EDITED: ' + String(msgs[1]?.content || '').match(/Instruction: (.*)/)?.[1]);
      if (/RICHHTML/.test(lastText)) return say('<div style="color: rgb(255, 0, 0); position: fixed"><style>.t { font-weight: 700 } body { background: red }</style><span class="t">Styled</span><script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2"></div>');
      if (sys.startsWith('You find lore worth saving')) return say(JSON.stringify({ entries: [{ name: 'Glade', keys: ['glade', 'clearing'], content: 'A moonlit clearing where Alex woke up.' }, { name: 'Old Oak', keys: ['oak'], content: 'A huge oak at the centre of the glade.' }] }));
      if (sys.startsWith('You tidy a list of saved memories')) {
        const rows = String(msgs[1]?.content || '').split('\n').map((l) => l.match(/^(m_\w+): (.*)$/)).filter(Boolean);
        const tea = rows.filter((r) => /tea/i.test(r[2]));
        const junk = rows.find((r) => /junk/i.test(r[2]));
        return say(JSON.stringify({ merge: tea.length > 1 ? [{ ids: tea.map((r) => r[1]), text: 'Likes tea in the evening.' }] : [], remove: junk ? [{ id: junk[1], why: 'trivial' }] : [] }));
      }
      if (sys.startsWith('You shorten saved memories')) {
        const ids = [...String(msgs[1]?.content || '').matchAll(/^(m_\w+)/gm)].map((m) => m[1]);
        return say(JSON.stringify({ items: ids.map((id) => ({ id, text: 'Alex likes tea.' })) }));
      }
      if (sys.includes('personal memory of past chats')) return say(JSON.stringify({ notes: ['I talked with Alex about apples.'] }));
      if (sys.startsWith('## Your role (from the project') || sys.includes('YOU ARE THE TESTER AGENT')) return say('tester agent here: all green');
      if (sys.startsWith('You keep the scene state')) return say('Time & date: dusk, day 1\nLocation: the old mill\nWeather: light rain\nWhat each character wears: Seraphina – green cloak\nMood of each character: Seraphina – calm\nNotable items: a lantern\nCurrent goal: find shelter');
      if (sys.startsWith('You keep the "story memory"')) return say(`## Key events\n- Alex woke up in the glade and asked where he was. (update ${nth('story')})\n## Current situation\n- Night in the glade.`);
      // group moderator: whoever is named in the latest line, else the main character, else the first member
      if (sys.startsWith('You moderate a group chat')) {
        const roster = [...sys.matchAll(/^- (.+?)( \(MAIN CHARACTER\)| \(SCENARIO \/ NARRATOR\))?: /gm)].map((m) => ({ name: m[1], main: !!m[2] }));
        const lastLine = lastText.trim().split('\n').pop();
        const named = roster.filter((r) => lastLine.toLowerCase().includes(r.name.split(' ').pop().toLowerCase()));
        const pick = named.length ? named : [roster.find((r) => r.main) || roster[0]];
        return say(JSON.stringify({ speakers: pick.map((r) => r.name) }));
      }
      // say who is speaking, so tests can check who replied
      const guestOf = sys.match(/The user brought you \((.+?)\) into/);
      const groupMe = sys.match(/You are (.+?) in a group chat/);
      if (guestOf) return say(`Guest ${guestOf[1]} here.`);
      if (groupMe) return say(`${groupMe[1]} speaking.`);
      if (offered(jb, 'view_images') && /check the images/i.test(lastText)) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v', type: 'function', function: { name: 'view_images', arguments: '{"folder":"photos"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/LONGTHINK/.test(lastText)) {
        for (let i = 0; i < 160; i++) {
          send({ choices: [{ delta: { reasoning_content: `Thinking line ${i}\n` } }] });
          await wait(30);
        }
      }
      // several tool steps, then a long answer written slowly: for the scroll position when the reply finishes
      if (/STEPSTHENTEXT/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || ''))) {
        const n = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool').length;
        if (n < 6) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_st' + n, type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        for (let i = 0; i < 40; i++) {
          send({ choices: [{ delta: { content: `Answer paragraph ${i}. ` + 'Some text that wraps over a few lines on a phone screen. '.repeat(3) + '\n\n' } }] });
          await wait(40);
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        return done();
      }
      if (/SLOWTOOL/.test(lastText) && !msgs.some((x) => x.role === 'tool')) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'write_file', arguments: '{"path":"slow.txt","content":"' } }] } }] });
        for (let i = 0; i < 60; i++) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'line ' + i + ' of a slowly written file\\n' } }] } }] });
          await wait(40);
        }
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      // the shell returns a job handle, then shell_job reports how it ended
      // (the turn prompt is the last *user* message: after a tool result, lastText is the result)
      const userText = JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '');
      if (/SHELLJOB/.test(userText) && offered(jb, 'shell_job')) {
        const toolMsgs = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const last = toolMsgs.at(-1)?.content || '';
        const job = /job_[a-z0-9]+/.exec(last)?.[0];
        if (!toolMsgs.length) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sj', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'sleep 45; echo ok' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        if (toolMsgs.length === 1 && job) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sj2', type: 'function', function: { name: 'shell_job', arguments: JSON.stringify({ action: 'wait', job_id: job, wait_s: 5 }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say('Job checked: ' + (/DONE exit=0/.test(last) ? 'finished cleanly' : 'not finished'));
      }
      if (/DOCTORME/.test(userText) && offered(jb, 'doctor') && !msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).some((x) => x.role === 'tool')) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_doc', type: 'function', function: { name: 'doctor', arguments: JSON.stringify({ surfaces: ['shell', 'python'], network: false }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/USESKILL/.test(lastText) && offered(jb, 'use_skill') && !msgs.some((x) => x.role === 'tool')) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'use_skill', arguments: '{"name":"meeting-notes"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/SHOTPAGE/.test(lastText) && offered(jb, 'screenshot_page') && !msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).some((x) => x.role === 'tool')) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_p', type: 'function', function: { name: 'screenshot_page', arguments: '{"url":"https://example.com/","view":"both"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      const noToolYet = !msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).some((x) => x.role === 'tool');
      if (/ASKME/.test(lastText) && offered(jb, 'ask_user') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Which layout do you want?","options":["Grid","List"]}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/PHONEW/.test(lastText) && offered(jb, 'phone_write') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_p1', type: 'function', function: { name: 'phone_write', arguments: JSON.stringify({ path: 'a.txt', content: 'hello v2' }) } },
          { index: 1, id: 'call_p2', type: 'function', function: { name: 'phone_write', arguments: JSON.stringify({ path: 'new/c.txt', content: 'brand new' }) } },
        ] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/DELEGATEME/.test(lastText) && offered(jb, 'delegate') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_d', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ task: 'HELPERJOB summarise notes.txt in one line', files: ['notes.txt'] }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/INTENTME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'android_intent')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        if (!tools.length) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_int', type: 'function', function: { name: 'android_intent', arguments: JSON.stringify({ kind: 'timer', seconds: 600, title: 'Pasta' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say('Intent: ' + tools[0].content.split('\n')[0]);
      }
      // places → the model answers with the ```map block the tool handed it
      if (/PLACESME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'places')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        if (!tools.length) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_places', type: 'function', function: { name: 'places', arguments: JSON.stringify({ category: 'pharmacy' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        const block = /```map\n[^\n]+\n```/.exec(tools[0].content)?.[0];
        return say(block ? `The nearest one is ${/^1\. ([^–]+) –/m.exec(tools[0].content)?.[1]?.trim()}.\n\n${block}\n` : 'Places: ' + tools[0].content.split('\n')[0]);
      }
      if (/MAPBADME/.test(lastText)) return say('Broken:\n\n```map\n{"places":[{"name":"Nowhere","lat":"north","lon":2}]}\n```\n\nand inline:\n\n```map\n{"title":"One cafe","places":[{"name":"Cafe <b>Bold</b>","lat":48.8566,"lon":2.3522,"phone":"+33 1 23 45 67 89","url":"https://cafe.example/"}]}\n```\n');
      if (/CALENDARME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'calendar')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        if (!tools.length) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cal', type: 'function', function: { name: 'calendar', arguments: JSON.stringify({ action: 'add', title: 'Dentist', start: '2026-11-20T15:00', reminder_minutes: 30 }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say('Calendar: ' + tools[0].content.split('\n')[0]);
      }
      if (/VIEWPIX/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'view_images')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        if (!tools.length) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_vp', type: 'function', function: { name: 'view_images', arguments: JSON.stringify({ paths: ['icon.png'], background: 'all' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say('Viewed: ' + tools[0].content.split('\n')[0]);
      }
      if (/UPLOADME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'browser')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const call = (name, args) => {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_up' + tools.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return call('write_file', { path: 'cv.txt', content: 'my cv' });
        if (tools.length === 1) return call('browser', { action: 'open', url: 'https://example.test/upload' });
        if (tools.length === 2) return call('browser', { action: 'upload', paths: ['cv.txt'] });
        return say('Upload: ' + tools.at(-1).content.split('\n')[0]);
      }
      if (/BROWSEME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'browser')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const lastTool = tools.at(-1)?.content || '';
        const call = (args) => {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b' + tools.length, type: 'function', function: { name: 'browser', arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return call({ action: 'open', url: 'https://example.test/form' });
        if (tools.length === 1) return call({ action: 'type', id: Number(/\[(\d+)\] input\(text\) "Your name"/.exec(lastTool)?.[1]), text: 'Ada' });
        if (tools.length === 2) return call({ action: 'click', id: Number(/\[(\d+)\] button "Greet"/.exec(lastTool)?.[1]) });
      }
      // the assistant adds an MCP server (decision 213); the next step says whether its tools are offered already
      if (/MAKEMCP/.test(userText) && (offered(jb, 'manage_mcp') || !noToolYet)) {
        if (noToolYet) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mcp', type: 'function', function: { name: 'manage_mcp', arguments: JSON.stringify({ action: 'add', url: `http://localhost:${PORT}/mcp-pics`, name: 'pics' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        send({ choices: [{ delta: { content: offered(jb, 'mcp_pics_snap') ? 'MCP-OFFERED' : 'MCP-NOT-OFFERED' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        return done();
      }
      if (/MAKESNIP/.test(lastText) && offered(jb, 'shortcuts') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sn', type: 'function', function: { name: 'shortcuts', arguments: JSON.stringify({ action: 'save_snippet', cmd: 'standup', title: 'Standup', text: 'Write my standup from these notes: {{text}}' }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/UPDATEPM/.test(lastText) && offered(jb, 'save_persona') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_u', type: 'function', function: { name: 'save_persona', arguments: JSON.stringify({ name: 'Persona Maker', prompt: 'You are the improved Persona Maker.' }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/MAKECHAR/.test(lastText) && offered(jb, 'save_character') && noToolYet) {
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Mira', description: 'A tall archivist with ink-stained fingers who guards the old library.', personality: 'dry, patient', scenario: 'The library at closing time.', first_mes: '*looks up* We are closed.', mes_example: '<START>\n{{user}}: Hi\n{{char}}: Quiet, please.', character_book: { entries: [{ keys: ['library'], content: 'The old library has a sealed east wing.', comment: 'Library', enabled: true, insertion_order: 100 }] } } };
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_c', type: 'function', function: { name: 'save_character', arguments: JSON.stringify({ card, ...(/WITHPIC/.test(lastText) ? { image: 1 } : {}) }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/ASKMULTI/.test(lastText) && offered(jb, 'ask_user') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_q', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Which layout?', options: ['Grid', 'List'] }, { question: 'Which colours?', options: ['Dark', 'Light'] }, { question: 'Any title?' }] }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/FETCHBLOCK/.test(lastText) && offered(jb, 'fetch_url') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_df', type: 'function', function: { name: 'fetch_url', arguments: '{"urls":["https://example-bank.com/login"]}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/MKPROJ|USEAGENT/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'write_file')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const calls = (list) => {
          send({ choices: [{ delta: { tool_calls: list.map((c, i) => ({ index: i, id: 'call_mp' + tools.length + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        const useAgent = /USEAGENT/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || ''));
        if (tools.length === 0 && !useAgent)
          return calls([
            ['write_file', { path: '.chronicle/commands/hello.md', content: '---\ndescription: Greet someone\n---\nSay hello to $ARGUMENTS.' }],
            ['write_file', { path: '.chronicle/agents/tester.md', content: '---\nname: tester\ndescription: Runs the tests\ntools: none\n---\nYOU ARE THE TESTER AGENT.' }],
          ]);
        if (tools.length === 0 && useAgent) return calls([['delegate', { task: 'run the tests', agent: 'tester' }]]);
        return say('done: ' + tools.map((t) => t.content.split('\n')[0]).join(' | '));
      }
      if (/LOADTOOLS/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && (jb.tools || []).length) {
        const names = jb.tools.map((t) => t.function.name);
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        if (tools.length === 0) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_lt0', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: ['tool_t5'] }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say(`now: ${names.filter((n) => n.startsWith('tool_')).join(',')} | load_tools offered: ${names.includes('load_tools')}`);
      }
      // a script that calls a tool the user set to Never: it must be refused inside the script too
      if (/SCRIPTPERM/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'run_script')) {
        if (!msgs.some((x) => x.role === 'tool')) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sp', type: 'function', function: { name: 'run_script', arguments: JSON.stringify({ code: 'const r = await tools.repo_map({}); print("ok=" + r.ok + " " + r.result.slice(0, 120));' }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        }
        return say('Done with the script.');
      }
      if (/PATCHME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'apply_patch')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const calls = (list) => {
          send({ choices: [{ delta: { tool_calls: list.map((c, i) => ({ index: i, id: 'call_pt' + tools.length + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return calls([['write_file', { path: 'app.py', content: 'def a():\n    return 1\n\ndef b():\n    return 2\n' }]]);
        if (tools.length === 1)
          return calls([
            ['apply_patch', { patch: '*** Begin Patch\n*** Update File: app.py\n@@\n def a():\n-    return 1\n+    return 10\n*** Add File: notes.md\n+# Notes\n+patched\n*** End Patch' }],
            ['read_file', { path: 'app.py' }],
            ['read_file', { path: 'notes.md' }],
            ['repo_map', {}],
          ]);
        return say('Done: ' + tools.slice(1).map((t) => t.content.split('\n')[0]).join(' | '));
      }
      if (/PREVIEWME/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'preview_page')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const calls = (list) => {
          send({ choices: [{ delta: { tool_calls: list.map((c, i) => ({ index: i, id: 'call_pv' + tools.length + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return calls([['write_file', { path: 'site/index.html', content: '<!doctype html><html><head><title>Hi</title><link rel="stylesheet" href="style.css"></head><body><h1>Hello</h1><img src="logo.svg"><script src="app.js"></script></body></html>' }], ['write_file', { path: 'site/style.css', content: 'h1 { color: tomato; background: url(bg.png) }' }], ['write_file', { path: 'site/app.js', content: 'document.title = "ready"; console.error("oops from the page");' }]]);
        if (tools.length === 3) return calls([['preview_page', { path: 'site/index.html', view: 'mobile' }]]);
      }
      if (/BROWSEHAND/.test(JSON.stringify(msgs.filter((x) => x.role === 'user').at(-1)?.content || '')) && offered(jb, 'browser')) {
        const tools = msgs.slice(msgs.map((x) => x.role).lastIndexOf('user')).filter((x) => x.role === 'tool');
        const call = (args) => {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_h' + tools.length, type: 'function', function: { name: 'browser', arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return done();
        };
        if (tools.length === 0) return call({ action: 'open', url: 'https://example.test/login' });
        if (tools.length === 1) return call({ action: 'handoff', message: 'Please sign in, then tap Done' });
      }
      if (/TWOERRORS/.test(lastText) && offered(jb, 'read_file') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e1', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing-one.txt"}' } }, { index: 1, id: 'call_e2', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing-two.txt"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/PLANME/.test(lastText) && offered(jb, 'todo_write') && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_t', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ items: [{ text: 'Look at the site', status: 'done' }, { text: 'Write the page', status: 'in_progress' }, { text: 'Test on a phone', status: 'pending' }] }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      const modTool = (jb.tools || []).find((t) => /^mod_dice__roll_dice$/.test(t.function.name));
      if (/MODTOOL/.test(lastText) && modTool && noToolYet) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_m', type: 'function', function: { name: modTool.function.name, arguments: '{"dice":"2d6+3"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      if (/SAVEMOD/.test(lastText) && offered(jb, 'save_mod') && noToolYet) {
        const code = "mod.command({ name: 'hello', description: 'Say hello', run: async (t) => ({ toast: 'hello ' + t }) });";
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'save_mod', arguments: JSON.stringify({ id: 'hello-mod', name: 'Hello mod', version: '1.0.0', description: 'Adds /hello', permissions: ['commands'], code }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      for (const w of ['Let me ', 'think.']) {
        send({ choices: [{ delta: { reasoning_content: w } }] });
        await wait(40);
      }
      let text = `Reply #${++n}. Here is **bold** and code:\n\n\`\`\`js\nconsole.log("hi")\n\`\`\`\n\n- one\n- two\n`;
      if (body.includes('You name chat conversations')) text = '"Test Chat Title"';
      else if (body.includes('Keep your own long-term memory')) {
        const lastUser = String(msgs.at(-1)?.content || '').match(/USER: ([^\n]*)/)?.[1] || '';
        const nm = lastUser.match(/my name is (\w+)/i);
        text = JSON.stringify({ add: nm ? [`I learned his name is ${nm[1]}.`] : [], update: [], remove: [] });
      }
      for (let i = 0; i < text.length; i += 8) {
        send({ choices: [{ delta: { content: text.slice(i, i + 8) } }] });
        await wait(15);
      }
      send({ choices: [], usage: { prompt_tokens: Math.round(body.length / 4), completion_tokens: 40 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  })
  .listen(PORT, () => console.log(`mock API on :${PORT}`));
