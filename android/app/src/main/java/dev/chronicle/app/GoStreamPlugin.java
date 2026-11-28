package dev.chronicle.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Streams HTTP responses (Server-Sent Events) from native code so the WebView
 * isn't blocked by CORS and receives tokens as they arrive.
 *
 * JS: GoStream.start({ id, url, headers, body }) then listen for
 *   "chunk" {id, data}, "done" {id}, "error" {id, status?, body?, message?}
 * GoStream.cancel({ id }) aborts a request.
 */
@CapacitorPlugin(name = "GoStream")
public class GoStreamPlugin extends Plugin {
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> active = new ConcurrentHashMap<>();

    @PluginMethod
    public void start(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        final String body = call.getString("body");
        final JSObject headers = call.getObject("headers", new JSObject());
        if (id == null || url == null) {
            call.reject("id and url are required");
            return;
        }
        final boolean guard = call.getBoolean("guard", false); // public-web reads: never reach private networks, not even through a redirect
        // the exact local addresses this chat was allowed (decision 271) – only for a request that STARTS at one of them:
        // a public page that redirects there is still refused
        final java.util.Set<String> lan = new java.util.HashSet<>();
        try {
            com.getcapacitor.JSArray arr = call.getArray("lanAllow");
            if (arr != null) for (int i = 0; i < arr.length(); i++) lan.add(arr.getString(i));
        } catch (Exception ignored) {
        }
        String h0;
        try {
            h0 = new URL(url).getHost();
        } catch (Exception e) {
            h0 = "";
        }
        final java.util.Set<String> allow = lan.contains(h0) ? lan : java.util.Collections.emptySet();
        call.resolve();
        pool.execute(() -> run(id, url, headers, body, guard, 0, allow));
    }

    /**
     * One request with binary bodies (git's pack files): { url, method, headers, bodyB64 } → { status, headers, bodyB64 }.
     * Buffered, at most 100 MB. Redirects are followed for GET only (git's info/refs).
     */
    @PluginMethod
    public void fetchBytes(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("An http(s) url is required");
            return;
        }
        // guard: a public-web read (fetch_url's PDF, decision 270) – every hop must be public, redirects followed by hand;
        // lanAllow: the chat's allowed local addresses, only when the request starts at one (decision 271)
        final boolean guard = call.getBoolean("guard", false);
        final java.util.Set<String> lan = new java.util.HashSet<>();
        try {
            com.getcapacitor.JSArray arr = call.getArray("lanAllow");
            if (arr != null) for (int i = 0; i < arr.length(); i++) lan.add(arr.getString(i));
        } catch (Exception ignored) {
        }
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL target = new URL(url);
                final java.util.Set<String> allow = lan.contains(target.getHost()) ? lan : java.util.Collections.emptySet();
                String method = call.getString("method", "GET");
                JSObject headers = call.getObject("headers", new JSObject());
                String b64 = call.getString("bodyB64");
                int status;
                for (int hop = 0; ; hop++) {
                    if (guard) requirePublic(target, allow);
                    conn = (HttpURLConnection) target.openConnection();
                    conn.setConnectTimeout(30000);
                    conn.setReadTimeout(120000);
                    conn.setRequestMethod(method);
                    // a guarded read follows redirects by hand, checking every hop; otherwise GET follows them itself
                    conn.setInstanceFollowRedirects(!guard && "GET".equals(method));
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String k = it.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                    if (b64 != null) {
                        byte[] body = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(body.length);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(body);
                        }
                    }
                    status = conn.getResponseCode();
                    String loc = conn.getHeaderField("Location");
                    if (!guard || !"GET".equals(method) || status < 300 || status >= 400 || loc == null) break;
                    if (hop >= 5) throw new Exception("Too many redirects");
                    conn.disconnect();
                    URL next = new URL(target, loc);
                    if (!sameOrigin(target, next)) headers = forOtherOrigin(headers); // no credentials to another origin (decision 273)
                    target = next;
                }
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                BigBytes out = new BigBytes(getContext()); // past a few MB it goes to a file, not into the message
                if (in != null) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        if (out.size() > 100L * 1024 * 1024) throw new Exception("The answer is bigger than 100 MB");
                    }
                    in.close();
                }
                JSObject h = new JSObject();
                for (Map.Entry<String, java.util.List<String>> e : conn.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) h.put(e.getKey().toLowerCase(java.util.Locale.ROOT), e.getValue().get(0));
                }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("headers", h);
                JSObject b = new JSObject();
                out.into(b);
                if (b.has("path")) r.put("bodyPath", b.getString("path"));
                else r.put("bodyB64", b.getString("base64"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        HttpURLConnection c = id == null ? null : active.remove(id);
        if (c != null) {
            pool.execute(c::disconnect);
        }
        call.resolve();
    }

    /**
     * Does this address resolve to a private network? { url } → resolves, or rejects with the reason. A mod's request
     * asks this for each redirect hop before it is sent (decision 273): its host permission is checked in JS, the
     * address the name stands for only here.
     */
    @PluginMethod
    public void checkPublic(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        pool.execute(() -> {
            try {
                requirePublic(new URL(url));
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** Blocks addresses on private networks (loopback, LAN, link-local, carrier-grade NAT, IPv6 unique-local). */
    private static void requirePublic(URL u) throws Exception {
        requirePublic(u, java.util.Collections.emptySet());
    }

    /** …except an address literal in `allow` (a chat's local-network grant): never a name, which could point anywhere. */
    private static void requirePublic(URL u, java.util.Set<String> allow) throws Exception {
        if (allow.contains(u.getHost()) && u.getHost().matches("^[0-9.]+$")) return;
        for (java.net.InetAddress a : java.net.InetAddress.getAllByName(u.getHost())) {
            byte[] b = a.getAddress();
            boolean cgnat = b.length == 4 && (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
            boolean ula = b.length == 16 && (b[0] & 0xfe) == 0xfc;
            if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || cgnat || ula) {
                throw new Exception("That address is on a private network, so it is not opened");
            }
        }
    }

    private void run(String id, String url, JSObject headers, String body, boolean guard, int hops) {
        run(id, url, headers, body, guard, hops, java.util.Collections.emptySet());
    }

    private void run(String id, String url, JSObject headers, String body, boolean guard, int hops, java.util.Set<String> allow) {
        HttpURLConnection conn = null;
        try {
            URL target = new URL(url);
            if (guard) requirePublic(target, allow);
            conn = (HttpURLConnection) target.openConnection();
            if (guard) conn.setInstanceFollowRedirects(false); // followed by hand below, checking every hop
            if (hops == 0) active.put(id, conn);
            else if (active.replace(id, conn) == null) return; // cancelled while being redirected
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(300000);
            conn.setRequestMethod(body != null ? "POST" : "GET");
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                if (k.equalsIgnoreCase("X-Http-Method")) continue;
                conn.setRequestProperty(k, headers.getString(k));
            }
            String method = headers.has("X-Http-Method") ? headers.getString("X-Http-Method") : null;
            if (method != null) {
                conn.setRequestMethod(method);
            }
            if (body != null) {
                conn.setDoOutput(true);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                // Note: no setFixedLengthStreamingMode – with it, HttpURLConnection drops the
                // body of 401 responses, and we want to show the API's error message.
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }

            int status = conn.getResponseCode();
            if (guard && status >= 300 && status < 400 && conn.getHeaderField("Location") != null) {
                if (hops >= 5) throw new Exception("Too many redirects");
                URL nextUrl = new URL(target, conn.getHeaderField("Location"));
                String next = nextUrl.toString();
                conn.disconnect();
                if (!active.containsKey(id)) return; // cancelled
                // a hop to another origin carries no credentials (decision 273): the same headers went to every hop, so
                // a page that redirected elsewhere got the caller's Authorization, Cookie or API key header. Only
                // headers that say nothing about the caller go on (what to accept, the user agent, the body's type).
                if (!sameOrigin(target, nextUrl)) headers = forOtherOrigin(headers);
                // 307 and 308 repeat the request as it was (an API moved to a new address still gets its POST);
                // 301, 302 and 303 turn it into a plain GET, as browsers do
                if (status == 307 || status == 308) {
                    run(id, next, headers, body, guard, hops + 1, allow);
                } else {
                    JSObject plain = new JSObject(headers.toString());
                    plain.remove("X-Http-Method");
                    plain.remove("Content-Type");
                    plain.remove("content-type");
                    run(id, next, plain, null, guard, hops + 1, allow);
                }
                return;
            }
            if (status >= 400) {
                InputStream es = conn.getErrorStream();
                String err = "";
                try {
                    if (es != null) err = readAll(es);
                } catch (Exception ignored) {
                    // keep the status code even if the body can't be read
                }
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("status", status);
                e.put("body", err);
                notifyListeners("error", e);
                return;
            }

            // status + headers first (MCP needs Mcp-Session-Id, etc.)
            JSObject resp = new JSObject();
            resp.put("id", id);
            resp.put("status", status);
            JSObject hdrs = new JSObject();
            for (Map.Entry<String, java.util.List<String>> h : conn.getHeaderFields().entrySet()) {
                if (h.getKey() != null && h.getValue() != null && !h.getValue().isEmpty()) hdrs.put(h.getKey().toLowerCase(), h.getValue().get(0));
            }
            resp.put("headers", hdrs);
            notifyListeners("response", resp);
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder batch = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) {
                    batch.append(line).append('\n');
                    // flush at each SSE event boundary so tokens show up immediately
                    if (line.isEmpty()) emitChunk(id, batch);
                }
                emitChunk(id, batch.append('\n'));
            }
            JSObject d = new JSObject();
            d.put("id", id);
            notifyListeners("done", d);
        } catch (Exception ex) {
            if (!active.containsKey(id)) {
                return; // cancelled
            }
            JSObject e = new JSObject();
            e.put("id", id);
            e.put("message", ex.getClass().getSimpleName() + ": " + ex.getMessage());
            notifyListeners("error", e);
        } finally {
            active.remove(id);
            if (conn != null) conn.disconnect();
        }
    }

    private static int portOf(URL u) {
        return u.getPort() != -1 ? u.getPort() : u.getDefaultPort();
    }

    static boolean sameOrigin(URL a, URL b) {
        return a.getProtocol().equalsIgnoreCase(b.getProtocol()) && a.getHost().equalsIgnoreCase(b.getHost()) && portOf(a) == portOf(b);
    }

    private static final java.util.Set<String> NEUTRAL_HEADERS = new java.util.HashSet<>(java.util.Arrays.asList("user-agent", "accept", "accept-language", "accept-encoding", "content-type", "x-http-method"));

    /** The headers that may follow a redirect to another origin: none that could be a credential. */
    static JSObject forOtherOrigin(JSObject headers) {
        JSObject out = new JSObject();
        for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
            String k = it.next();
            if (NEUTRAL_HEADERS.contains(k.toLowerCase(java.util.Locale.ROOT))) out.put(k, headers.optString(k));
        }
        return out;
    }

    private void emitChunk(String id, StringBuilder batch) {
        if (batch.length() == 0) return;
        JSObject c = new JSObject();
        c.put("id", id);
        c.put("data", batch.toString());
        notifyListeners("chunk", c);
        batch.setLength(0);
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String l;
            while ((l = r.readLine()) != null) sb.append(l).append('\n');
        }
        return sb.toString();
    }
}
