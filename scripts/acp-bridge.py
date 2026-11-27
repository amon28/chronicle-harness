#!/usr/bin/env python3
"""
acp-bridge: lets Chronicle on your phone drive an ACP agent on this computer (Agent Client Protocol – e.g. Claude Code
through its ACP adapter claude-agent-acp (npm @agentclientprotocol/claude-agent-acp; older names:
@zed-industries/claude-agent-acp, @zed-industries/claude-code-acp), Gemini CLI with --experimental-acp, Goose, OpenCode's
acp command).

    python3 acp-bridge.py --port 8765 -- npx -y @agentclientprotocol/claude-agent-acp

It starts the agent, prints the address and a secret to enter in Chronicle (Settings › Agent › PC agents), and serves
the agent's stdio over HTTP:
  POST /send            one JSON-RPC message for the agent
  GET  /events?since=N  the agent's messages numbered N and up (waits up to 25 s when there are none yet)
  GET  /health
  POST /mcp/<chat>      an MCP server (Streamable HTTP, JSON answers) for the agent itself: Chronicle passes it in
                        session/new mcpServers with its own token; tools/list and tools/call go to Chronicle as
                        "bridge/mcp" events and come back on POST /mcp-reply
Every request needs "Authorization: Bearer <secret>" (/mcp: "Bearer <mcp token>", a second secret made up here or
given with --mcp-token; Chronicle reads it from /health). Use it on your own network or over Tailscale/WireGuard: anyone
with the address and the secret can make the agent act on this computer.

Chronicle's own Linux uses it too (Settings › Agent › Claude Code in Linux): --host 127.0.0.1 --port 0 (a free port,
written to --port-file) and --secret-stdin (the secret comes on stdin, so it is in no command line, log or file).
A secret you give (--secret, --secret-stdin, ACP_BRIDGE_SECRET) is never printed; only one it makes up is.
"""
import io, json, os, secrets, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

args = sys.argv[1:]
port, host, secret, cwd, port_file = 8765, "0.0.0.0", os.environ.get("ACP_BRIDGE_SECRET") or "", None, None
mcp_token = ""
while args and args[0] != "--":
    k = args.pop(0)
    if k == "--secret-stdin":
        secret = sys.stdin.readline().strip()
        continue
    v = args.pop(0) if args else ""
    if k == "--port":
        port = int(v)
    elif k == "--host":
        host = v
    elif k == "--secret":
        secret = v
    elif k == "--cwd":
        cwd = v
    elif k == "--port-file":
        port_file = v
    elif k == "--mcp-token":
        mcp_token = v
given = bool(secret)
secret = secret or secrets.token_urlsafe(18)
mcp_token = mcp_token or secrets.token_urlsafe(24)
if args and args[0] == "--":
    args.pop(0)
if not args:
    sys.exit("usage: acp-bridge.py [--port 8765] [--host 0.0.0.0] [--secret S | --secret-stdin] [--port-file F] [--cwd DIR] -- <agent command>")

child = subprocess.Popen(args if len(args) > 1 else ["/bin/sh", "-c", args[0]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=cwd, bufsize=0, env={k: v for k, v in os.environ.items() if k != "ACP_BRIDGE_SECRET"})
cond = threading.Condition()
log = []  # the agent's messages; log[i] has number first + i
first = [0]
acked = [0]  # the furthest cursor any client has read: events before it are never asked for again
wlock = threading.Lock()
RUN = secrets.token_hex(6)  # this run of the bridge: a client that sees another run knows the bridge restarted


def add(msg):
    with cond:
        log.append(msg)
        if len(log) > 20000:
            del log[:10000]
            first[0] += 10000
        cond.notify_all()


def reader():
    # buffered: the pipe is unbuffered (bufsize=0, for stdin), and a raw readline reads one byte per system call –
    # hundreds per streamed chunk, each one trapped by proot on the phone
    out = io.BufferedReader(child.stdout, 1 << 16)
    for line in iter(out.readline, b""):
        line = line.strip()
        if not line:
            continue
        try:
            add(json.loads(line))
        except Exception:
            sys.stderr.write("acp-bridge: not JSON from the agent: %r\n" % line[:200])
    add({"jsonrpc": "2.0", "method": "bridge/exit", "params": {"code": child.wait()}})


threading.Thread(target=reader, daemon=True).start()

# ---- the agent's own MCP server: tools/list and tools/call are answered by Chronicle (the app polls /events) ----
MCP_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MCP_WAIT = {"tools/list": 60, "tools/call": 30 * 60}
KEEPALIVE = float(os.environ.get("ACP_BRIDGE_KEEPALIVE") or 15)  # s between "still working" on a streamed tool call  # a call may run minutes (the browser, a photo, a question to the user)
mcp_cond = threading.Condition()
mcp_waiting = {}  # rid -> {"claimed": bool, "reply": message or None}
mcp_next = [1]


def mcp_forward(chat, msg):
    """Hand one MCP request to the app as an event and wait for its answer (or time out)."""
    with mcp_cond:
        rid = mcp_next[0]
        mcp_next[0] += 1
        mcp_waiting[rid] = {"claimed": False, "reply": None}
    add({"jsonrpc": "2.0", "method": "bridge/mcp", "params": {"rid": rid, "chat": chat, "message": msg}})
    wait = float(os.environ.get("ACP_BRIDGE_MCP_WAIT") or MCP_WAIT.get(msg.get("method"), 60))  # the variable: for tests
    with mcp_cond:
        mcp_cond.wait_for(lambda: mcp_waiting[rid]["reply"] is not None, timeout=wait)
        reply = mcp_waiting.pop(rid)["reply"]
    if reply is None:
        return {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32001, "message": "Chronicle did not answer within %g s (is the app open?)" % wait}}
    reply = dict(reply)
    reply["jsonrpc"] = "2.0"
    reply["id"] = msg.get("id")  # always the caller's id, whatever the app sent
    return reply


def mcp_handle(chat, msg):
    """One JSON-RPC message from the agent's MCP client -> its answer, or None for a notification."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return {"jsonrpc": "2.0", "id": msg.get("id") if isinstance(msg, dict) else None, "error": {"code": -32600, "message": "not a JSON-RPC request"}}
    method = msg["method"]
    if "id" not in msg:
        return None  # notifications/initialized, notifications/cancelled …
    if method == "initialize":
        asked = (msg.get("params") or {}).get("protocolVersion")
        return {"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": asked if asked in MCP_VERSIONS else MCP_VERSIONS[1], "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "chronicle", "version": "1"}, "instructions": "Chronicle's phone tools (calendar, contacts, location, the phone folder, the browser, memory …). Each call goes through the user's own permissions in the Chronicle app."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg["id"], "result": {}}
    if method in ("tools/list", "tools/call"):
        return mcp_forward(chat, msg)
    return {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "%s is not offered" % method}}


def mcp_reply(body):
    """The app's answer to a bridge/mcp event: {rid, claim: true} first (once), then {rid, message}."""
    try:
        rid = int(body.get("rid"))
    except (TypeError, ValueError):
        return 400, {"error": "rid"}
    with mcp_cond:
        w = mcp_waiting.get(rid)
        if w is None:
            return 404, {"error": "no such request (answered, or timed out)"}
        if body.get("claim"):
            if w["claimed"]:
                return 409, {"error": "already taken"}
            w["claimed"] = True
            return 200, {"ok": True}
        msg = body.get("message")
        if not isinstance(msg, dict) or ("result" not in msg and "error" not in msg):
            return 400, {"error": "message needs result or error"}
        w["reply"] = msg
        mcp_cond.notify_all()
    return 200, {"ok": True}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def mcp_authed(self):
        if secrets.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + mcp_token).encode()):
            return True
        self.reply(401, {"error": "bad token"})
        return False

    def mcp_chat(self):
        """/mcp/<chat> -> the chat handle (letters, digits, - and _), else None."""
        p = self.path.split("?")[0]
        if not p.startswith("/mcp/"):
            return None
        c = p[5:]
        return c if 4 <= len(c) <= 64 and all(ch.isalnum() or ch in "-_" for ch in c) else None

    def authed(self):
        if secrets.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + secret).encode()):
            return True
        self.reply(401, {"error": "bad secret"})
        return False

    def mcp_stream(self, chat, msg):
        """tools/call as text/event-stream: progress (or a comment) every KEEPALIVE s while Chronicle works, then the answer."""
        box = {}
        done = threading.Event()

        def run():
            box["out"] = mcp_handle(chat, msg)
            done.set()

        threading.Thread(target=run, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        token = ((msg.get("params") or {}).get("_meta") or {}).get("progressToken")
        tool = str((msg.get("params") or {}).get("name") or "the tool")
        start = time.time()
        n = 0
        try:
            while not done.wait(KEEPALIVE):
                n += 1
                if token is not None:
                    note = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": token, "progress": n, "message": "Chronicle is still working on %s (%d s)" % (tool, time.time() - start)}}
                    self.wfile.write(("event: message\ndata: %s\n\n" % json.dumps(note)).encode())
                else:
                    self.wfile.write(b": still working\n\n")
                self.wfile.flush()
            self.wfile.write(("event: message\ndata: %s\n\n" % json.dumps(box["out"])).encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # the agent went away; Chronicle's answer then finds nobody waiting (and the app logs it)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in (("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Headers", "*"), ("Access-Control-Allow-Methods", "GET, POST, OPTIONS")):
            self.send_header(k, v)
        self.end_headers()

    def do_DELETE(self):
        if self.mcp_chat() is not None and self.mcp_authed():
            return self.reply(405, {"error": "no sessions to end"})
        self.reply(404, {})

    def do_GET(self):
        if self.mcp_chat() is not None:
            # no server-to-client stream (JSON answers only): the Streamable HTTP spec's 405
            if self.mcp_authed():
                self.send_response(405)
                self.send_header("Allow", "POST")
                self.send_header("Content-Length", "0")
                self.end_headers()
            return
        if not self.authed():
            return
        if self.path.startswith("/health"):
            with cond:
                now = first[0] + len(log)
            # next: where a new client starts reading – what is already in the log is another client's past
            return self.reply(200, {"running": child.poll() is None, "mcpToken": mcp_token, "run": RUN, "next": now})
        if not self.path.startswith("/events"):
            return self.reply(404, {})
        try:
            since = int(self.path.split("since=")[1].split("&")[0]) if "since=" in self.path else 0
        except ValueError:
            since = 0
        with cond:
            if since < first[0] or since > first[0] + len(log):
                # a reader this far behind the buffer would silently miss what was trimmed, and one ahead of it is
                # reading another run of the bridge: said, not skipped or waited on
                return self.reply(200, {"reset": True, "next": first[0] + len(log), "run": RUN})
            if first[0] + len(log) <= since:
                cond.wait(25)
            # the trim runs before start is computed: next is built from the trimmed first, so a read is never
            # answered with a cursor past events the reader was never given
            acked[0] = max(acked[0], since)
            if len(log) > 2000 and acked[0] > first[0]:
                # keep a small tail: everything older than what was read is dropped, not kept until the 20000 cap
                drop = min(len(log) - 1000, acked[0] - first[0])
                del log[:drop]
                first[0] += drop
            start = max(0, since - first[0])
            out = log[start:]
        # at most about 1 MB per answer (at least one event): the app reads the rest with the next poll
        size, n = 0, 0
        for m in out:
            size += len(json.dumps(m))
            n += 1
            if size > 1000000:
                break
        out = out[:n]
        self.reply(200, {"next": first[0] + start + n, "events": out, "run": RUN})

    def do_POST(self):
        chat = self.mcp_chat()
        if chat is not None or self.path.split("?")[0] == "/mcp":
            if not self.mcp_authed():
                return
            if chat is None:
                return self.reply(404, {"error": "no chat"})
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"null")
            except Exception:
                return self.reply(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "not JSON"}})
            # a tool call may run minutes (a helper model, the browser, a question to the user): answered as a stream that
            # says it is still working every few seconds – an idle connection is dropped by the agent's HTTP client after
            # about 5 minutes, and the call then "times out" on the agent's side while Chronicle is still working on it
            if isinstance(body, dict) and body.get("method") == "tools/call" and "text/event-stream" in (self.headers.get("Accept") or ""):
                return self.mcp_stream(chat, body)
            out = [r for r in (mcp_handle(chat, m) for m in body) if r is not None] if isinstance(body, list) else mcp_handle(chat, body)
            if out is None or out == []:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self.reply(200, out)
        if not self.authed():
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            msg = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.reply(400, {"error": "not JSON"})
        if self.path.split("?")[0] == "/mcp-reply":
            return self.reply(*mcp_reply(msg if isinstance(msg, dict) else {}))
        if child.poll() is not None:
            return self.reply(503, {"error": "the agent exited"})
        with wlock:
            child.stdin.write((json.dumps(msg) + "\n").encode())
            child.stdin.flush()
        self.reply(202, {"ok": True})


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


srv = ThreadingHTTPServer((host, port), H)
port = srv.server_address[1]  # the real one when --port 0 asked for any free port
if port_file:
    with open(port_file + ".tmp", "w") as f:
        f.write("%d\n" % port)
    os.replace(port_file + ".tmp", port_file)
print("acp-bridge: agent running (pid %d)" % child.pid, flush=True)
shown = lan_ip() if host in ("0.0.0.0", "") else host
print("In Chronicle › Settings › Agent › PC agents, add:\n  address  http://%s:%d\n  secret   %s" % (shown, port, "(the one you gave)" if given else secret), flush=True)
# the agent exited: a few seconds more, so the app reads the bridge/exit event (and says why) before the port closes
threading.Thread(target=lambda: (child.wait(), time.sleep(float(os.environ.get("ACP_BRIDGE_LINGER") or 4)), srv.shutdown()), daemon=True).start()
srv.serve_forever()
