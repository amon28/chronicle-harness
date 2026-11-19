import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if m.get("id") is None: continue
    if m["method"] == "initialize": r = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "echo"}}
    elif m["method"] == "tools/list": r = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
    else: r = {"content": [{"type": "text", "text": "echo: " + m["params"]["arguments"].get("text", "")}]}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
