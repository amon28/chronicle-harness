# A tiny ACP agent for tests: initialize, session/new (with configOptions shaped like claude-agent-acp's: a mode,
# a model select with two models and an effort select), session/set_config_option, session/close, session/prompt
# with a streamed answer and a tool call that asks for permission first (a prompt whose last line starts with "echo "
# is only echoed back, with the session's model and effort), and the adapter's local
# "/usage" answer (its formatUsageResponse markdown).
# MCP (decision 166): session/new's mcpServers are kept; a prompt whose last line is "mcp <tool> [json args]" connects
# to the "chronicle" http server the way Claude Code's MCP client does (initialize, notifications/initialized,
# tools/list, tools/call), in a thread, and echoes what came back; "mcp-info" lists the servers and _meta it got.
# session/cancel (decision 167) ends a turn that waits on its permission question with stopReason "cancelled".
import json, os, sys, threading, urllib.request, urllib.error
# FAKE_ACP_STORE (decision 234): like Claude Code, sessions are kept on disk – a restarted agent can session/resume them
STORE = os.environ.get("FAKE_ACP_STORE", "")
def stored():
    try:
        with open(STORE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}
def store(sid, s):
    if STORE:
        d = stored()
        d[sid] = {k: s[k] for k in ("model", "effort", "sp", "spmode", "cwd")}
        with open(STORE, "w") as f:
            json.dump(d, f)
out_lock = threading.Lock()
def send(o):
    with out_lock:
        print(json.dumps(o), flush=True)
pending = {}
sessions = {}
MODELS = [{"value": "default", "name": "Default (recommended)", "description": "Opus 4.8 · Most capable"}, {"value": "sonnet", "name": "Sonnet", "description": "Sonnet 4.6 · Everyday tasks"}]
LEVELS = {"default": ["low", "medium", "high", "xhigh"], "sonnet": ["low", "medium", "high"]}
USAGE = ("## Usage\n\n> Claude max subscription usage\n\n### Limits\n\n**5-hour limit** — **32%** · Resets Nov 14, 3:00 PM UTC\n\n`██████░░░░░░░░░░░░░░`\n\n"
         "**Weekly · all models** — **61%** · Resets Nov 18, 9:00 AM UTC\n\n`████████████░░░░░░░░`\n\n**Weekly · Opus** — **12%** · Resets Nov 18, 9:00 AM UTC\n\n`██░░░░░░░░░░░░░░░░░░`\n\n"
         "---\n\n### This session\n\n| Cost | API time | Active |\n|:--|:--|:--|\n| $0.00 | 0s | 1s |")
def config(s):
    out = [{"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{"value": "default", "name": "Default"}, {"value": "plan", "name": "Plan"}]},
           {"id": "model", "name": "Model", "description": "AI model to use", "category": "model", "type": "select", "currentValue": s["model"], "options": MODELS}]
    lv = LEVELS.get(s["model"], [])
    if lv:
        out.append({"id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": s["effort"], "options": [{"value": "default", "name": "Default"}] + [{"value": l, "name": l.title()} for l in lv]})
    return out
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback: never through a proxy
def mcp_post(server, msg):
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    for e in server.get("headers") or []:
        h[e["name"]] = e["value"]
    req = urllib.request.Request(server["url"], data=json.dumps(msg).encode(), headers=h, method="POST")
    try:
        with direct.open(req, timeout=600) as r:
            body = r.read()
            if "text/event-stream" in (r.headers.get("Content-Type") or ""):
                # a streamed answer (a tool call): "still working" lines, progress notes, then the answer – as a real
                # MCP client reads it; the progress notes seen are kept for the test to report
                msgs = [json.loads(l[5:].strip()) for l in body.decode().split("\n") if l.startswith("data:")]
                answer = [m for m in msgs if "id" in m]
                notes = [m for m in msgs if m.get("method") == "notifications/progress"]
                out = answer[-1] if answer else None
                if out is not None and notes:
                    out = dict(out)
                    out["_progress"] = len(notes)
                return r.status, out
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, None
def mcp_run(pid, sid, line):
    try:
        parts = line.split(" ", 2)
        tool = parts[1] if len(parts) > 1 else "location"
        args = json.loads(parts[2]) if len(parts) > 2 else {}
        server = next((x for x in sessions[sid]["mcp"] if x.get("name") == "chronicle"), None)
        if not server:
            chunk(sid, "no chronicle MCP server")
        else:
            st, init = mcp_post(server, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake", "version": "1"}}})
            st2, _ = mcp_post(server, {"jsonrpc": "2.0", "method": "notifications/initialized"})
            _, lst = mcp_post(server, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            names = [t["name"] for t in (lst or {}).get("result", {}).get("tools", [])]
            chunk(sid, "MCP " + init["result"]["serverInfo"]["name"] + " (init " + str(st) + ", notify " + str(st2) + "), tools: " + ",".join(names) + " | ")
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "m1", "title": "mcp__chronicle__" + tool, "kind": "other", "status": "in_progress"}}})
            _, res = mcp_post(server, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": tool, "arguments": args}})
            r = (res or {}).get("result") or {}
            text = " ".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
            imgs = sum(1 for c in r.get("content", []) if c.get("type") == "image")
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "m1", "status": "failed" if r.get("isError") else "completed"}}})
            chunk(sid, tool + (" ERROR" if r.get("isError") or (res or {}).get("error") else "") + " -> " + (text or json.dumps((res or {}).get("error")))[:300] + (" [images: %d]" % imgs if imgs else ""))
    except Exception as e:
        chunk(sid, "MCP failed: " + repr(e))
    send({"jsonrpc": "2.0", "id": pid, "result": {"stopReason": "end_turn"}})
def chunk(sid, text): send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        caps = {"close": {}, "systemPrompt": {"mode": {"override": {}}}}
        if STORE:
            caps["resume"] = {}
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": False, "sessionCapabilities": caps}, "authMethods": []}})
    elif m.get("method") == "session/resume":
        sid = m["params"]["sessionId"]
        old = stored().get(sid)
        if not old:
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32603, "message": "Session not found"}})
            continue
        sessions[sid] = {**old, "sets": [], "mcp": m["params"].get("mcpServers") or [], "meta": m["params"].get("_meta") or {}, "resumed": True}
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"configOptions": config(sessions[sid])}})
    elif m.get("method") == "session/new":
        sid = "s" + str(len(sessions) + len(stored()) + 1)
        sp = (m["params"].get("systemPrompt") or {})
        sessions[sid] = {"model": "default", "effort": "default", "sets": [], "sp": "".join(b.get("text", "") for b in sp.get("content", [])), "spmode": sp.get("mode", ""), "mcp": m["params"].get("mcpServers") or [], "meta": m["params"].get("_meta") or {}, "cwd": m["params"].get("cwd", "")}
        store(sid, sessions[sid])
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": sid, "configOptions": config(sessions[sid])}})
        # like claude-agent-acp after a session is set up: its slash commands
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "compact", "description": "Clear conversation history but keep a summary in context", "input": {"hint": "<optional custom summarization instructions>"}}, {"name": "review", "description": "Review a pull request"}, {"name": "add-dir", "description": "Add a new working directory", "input": {"hint": "<path>"}}]}}})
    elif m.get("method") == "session/set_config_option":
        p = m["params"]; s = sessions[p["sessionId"]]
        s["model" if p["configId"] == "model" else "effort"] = p["value"]
        if p["configId"] == "model" and s["effort"] not in ["default"] + LEVELS.get(s["model"], []): s["effort"] = "default"
        s["sets"].append(p["configId"] + "=" + p["value"])
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"configOptions": config(s)}})
    elif m.get("method") == "session/close":
        sessions.get(m["params"]["sessionId"], {})["closed"] = True
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
    elif m.get("method") == "session/prompt":
        text = "".join(b.get("text", "") for b in m["params"]["prompt"])
        sid = m["params"]["sessionId"]
        if sessions.get(sid, {}).get("closed"):  # as claude-agent-acp: a closed session is gone
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32603, "message": "Session not found"}})
            continue
        if text.endswith("who are you?"):
            s = sessions[sid]
            chunk(sid, "SP(" + s["spmode"] + "): " + (s["sp"][:90] or "none"))
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        last = text.split("\n")[-1]
        # as claude-agent-acp: Claude Code crashed (decision 184 – not a sign-out), or Claude Code said "run /login"
        if last == "crash me":
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32000, "message": "Claude Agent process died: Claude Code process terminated by signal SIGBUS."}})
            continue
        if last == "signed out":
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32000, "message": "Invalid API key · Please run /login"}})
            continue
        if last.startswith("mcp "):
            threading.Thread(target=mcp_run, args=(m["id"], sid, last), daemon=True).start()
            continue
        if last == "mcp-info":
            s = sessions[sid]
            chunk(sid, "servers: " + ",".join(x.get("name", "") + ":" + x.get("type", "stdio") for x in s["mcp"]) + " | meta: " + json.dumps(s["meta"].get("claudeCode", {}).get("options", {})) + " | cwd: " + s["cwd"] + " | sp: " + s["sp"][-160:])
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        if "background text job" in sessions[sid]["sp"]:
            # Chronicle's background jobs on Claude Code (decision 169): show what the job got
            s = sessions[sid]
            tools = (s["meta"].get("claudeCode") or {}).get("options", {}).get("tools")
            chunk(sid, "CC-JOB(model " + s["model"] + ", tools " + json.dumps(tools) + "): " + text.replace("\n", " ")[:80])
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        if text.split("\n")[-1].startswith("[Message from the Chronicle app, not from the user] Your ask_model job"):
            # Chronicle woke it: an ask_model job it started in the background is over (decision 179)
            chunk(sid, "PING " + text.split("\n")[-1])
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        if text.startswith("/") and text != "/usage":
            # one of its slash commands: say which one it got, as it got it
            chunk(sid, "CMD " + text.split("\n")[-1])
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        if text == "/usage":
            for i in range(0, len(USAGE), 90): chunk(sid, USAGE[i:i + 90])
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        if text.split("\n")[-1].startswith("echo "):
            s = sessions[sid]
            chunk(sid, "Echo from " + sid + " (model " + s["model"] + ", effort " + s["effort"] + ", set: " + (",".join(s["sets"]) or "nothing") + "): ")
            chunk(sid, text.split("\n")[0] + " | prompt lines: " + str(text.count("\n") + 1))
            # like Claude Code after each turn: its own context in use and its window
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "usage_update", "used": 31500, "size": 1000000}}})
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        for w in ["I ", "will ", "edit ", "it. "]:
            chunk(sid, w)
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit main.py", "kind": "edit", "status": "pending"}}})
        send({"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": {"sessionId": sid, "toolCall": {"toolCallId": "t1", "title": "Edit main.py"}, "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}})
        pending[900] = (m["id"], sid, text)
    elif m.get("method") == "session/cancel":
        # Stop (decision 167): a turn waiting on its permission question ends as cancelled
        sid = m["params"]["sessionId"]
        for k, (pid, psid, text) in list(pending.items()):
            if psid == sid:
                pending.pop(k)
                send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed"}}})
                send({"jsonrpc": "2.0", "id": pid, "result": {"stopReason": "cancelled"}})
    elif m.get("id") in pending and "result" in m:
        pid, sid, text = pending.pop(m["id"])
        chose = m["result"].get("outcome", {}).get("optionId", "cancelled")
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" if chose == "allow" else "failed"}}})
        chunk(sid, "Done (" + chose + ") for: " + text)
        send({"jsonrpc": "2.0", "id": pid, "result": {"stopReason": "end_turn"}})
