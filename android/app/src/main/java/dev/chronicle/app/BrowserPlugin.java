package dev.chronicle.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;

/**
 * A real page the assistant can drive (open, read, click, type, screenshot). It runs in a WebView that sits off-screen,
 * is never shown to the user, and only loads http(s) pages. The page logic itself is JavaScript run through eval().
 */
@CapacitorPlugin(name = "Browser")
public class BrowserPlugin extends Plugin {
    private final Handler ui = new Handler(Looper.getMainLooper());

    /** One browser per chat: each has its own WebView, page and screen state. Cookies (sign-ins) are shared by Android. */
    private static class Sess {
        long pumpUntil;
        boolean pumping;
        Bitmap pump;
        WebView web;
        FrameLayout holder;
        PluginCall pendingOpen;
        volatile long lastUsed;
        PluginCall pendingShow;
        LinearLayout overlay;
        /**
         * Every window of this browser, the page first: a window the page opens (window.open, a target=_blank link,
         * a "Sign in with Google" popup) is a tab of its own, linked to its opener (window.opener), hidden or on screen.
         * web is the one in use (decision 211).
         */
        final java.util.List<WebView> tabs = new java.util.ArrayList<>();
        /** What the page last did with its tabs (opened, closed itself), and how many such events so far. */
        volatile String tabEvent;
        volatile int tabSeq;
        /** Answers the assistant gave for requests (action route): address pattern → response; and offline mode. */
        final java.util.List<Route> routes = new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile boolean offline;
        /** HTTP sign-in (401 Basic/Digest) the assistant gave for one host: answered once per host and realm. */
        volatile String httpHost, httpUser, httpPass;
        final java.util.Set<String> httpTried = new java.util.HashSet<>();
        /** A site asked for an HTTP sign-in while hidden and nobody could answer it (host – realm), until status reports it. */
        volatile String authAsked;
        boolean viewing;
        /** The user touched the page while it was on their screen (watching): the assistant is told it may have changed. */
        boolean userTouched;
        /** A finger gesture on the watched page is under way: it counts as use only when it ends on the page (ACTION_UP). */
        boolean userGesture;
        /** When the user last touched the page on screen: the assistant's own taps wait until they stop. */
        volatile long userTouchAt;
        /** A tap the assistant makes (not the user's finger). */
        boolean synthTouch;
        /** The user's finger is down on the page right now (a long press sends no further events to go by). */
        volatile boolean userDown;

        /**
         * The page's size as it is drawn now: its hidden place (widthPx × heightPx) or, while it is on the user's
         * screen, the room it has there – a picture taken with the hidden size was cut off or had an empty strip.
         */
        int w() {
            return overlay != null && web != null && web.getParent() == overlay && web.getWidth() > 0 ? web.getWidth() : widthPx;
        }

        int h() {
            return overlay != null && web != null && web.getParent() == overlay && web.getHeight() > 0 ? web.getHeight() : heightPx;
        }
        int widthPx = 0;
        int heightPx = 0;
        /** The chat's /workspace on disk, served at https://workspace.localhost/ while set. */
        volatile String siteRoot;
        /** A script put at the top of every served HTML page (error and console capture from the first line). */
        volatile String inject;
        /** The assistant opened a server on this phone (127.0.0.1 / localhost) itself: loopback is allowed, the LAN never. */
        volatile boolean loopback;
        volatile String mainError;
        volatile int httpStatus;
        /** The <label>.workspace.localhost this session's pages were last served from (to route service-worker requests). */
        volatile String siteHostSeen;
        /** The page opened its file picker while the assistant was driving it (what it accepts), until status reports it. */
        volatile String chooserAsked;
        /** The last file the server sent as a download (url, mime, file name), until status reports it. */
        volatile JSObject download;
    }

    /** A request answered by the assistant instead of the network (Playwright's route + fulfill). */
    static class Route {
        String pattern;
        java.util.regex.Pattern glob;
        int status = 200;
        String body = "";
        String type = "text/plain";
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        int hits;

        boolean matches(String url) {
            return glob != null ? glob.matcher(url).matches() : url.contains(pattern);
        }
    }

    /** The answer for this request when the assistant set one (a route), or offline mode refuses it; null = go on. */
    private static android.webkit.WebResourceResponse routed(Sess s, WebResourceRequest r) {
        String u = r.getUrl().toString();
        for (Route rt : s.routes) {
            if (!rt.matches(u)) continue;
            rt.hits++;
            java.util.Map<String, String> hd = new java.util.HashMap<>(rt.headers);
            hd.put("Access-Control-Allow-Origin", "*");
            hd.put("Cache-Control", "no-store");
            String reason = rt.status >= 400 ? "Error" : "OK";
            return new android.webkit.WebResourceResponse(rt.type, "utf-8", rt.status, reason, hd, new java.io.ByteArrayInputStream(rt.body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        if (s.offline) return new android.webkit.WebResourceResponse("text/plain", "utf-8", 503, "Offline", new java.util.HashMap<>(), new java.io.ByteArrayInputStream("offline (set by the assistant)".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        return null;
    }

    static final String SITE_HOST = "workspace.localhost";

    /** workspace.localhost or a chat's own <label>.workspace.localhost (one origin, so one storage, per chat). */
    static boolean isSiteHost(String host) {
        return host != null && (SITE_HOST.equalsIgnoreCase(host) || host.toLowerCase(java.util.Locale.ROOT).endsWith("." + SITE_HOST));
    }

    private final java.util.Map<String, Sess> sessions = new java.util.concurrent.ConcurrentHashMap<>(); // plugin, UI and service-worker threads
    static final int MAX_SESSIONS = 4;

    private Sess sess(PluginCall call) {
        String id = call.getString("id", "main");
        Sess x = sessions.get(id);
        if (x == null && !"open".equals(call.getMethodName())) {
            // only opening a page makes (and makes room for) a session: an eval, a tap or a download for a chat whose
            // page is gone must not close another chat's page – it gets an empty one ("No page is open")
            return new Sess();
        }
        if (x == null) {
            // at most a few WebViews: each is a whole browser in memory – the one used longest ago goes
            if (sessions.size() >= MAX_SESSIONS) {
                java.util.Map.Entry<String, Sess> old = null;
                for (java.util.Map.Entry<String, Sess> e : sessions.entrySet())
                    if (e.getValue().pendingShow == null && (old == null || e.getValue().lastUsed < old.getValue().lastUsed)) old = e;
                if (old != null) {
                    final Sess gone = old.getValue();
                    sessions.remove(old.getKey());
                    getActivity().runOnUiThread(() -> destroySess(gone));
                }
            }
            x = new Sess();
            sessions.put(id, x);
        }
        x.lastUsed = android.os.SystemClock.uptimeMillis();
        return x;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void ensure(final Sess s, int wDp, int hDp, boolean mobile) {
        Activity a = getActivity();
        float d = a.getResources().getDisplayMetrics().density;
        s.widthPx = Math.round(wDp * d);
        s.heightPx = Math.round(hDp * d);
        if (s.web == null) {
            s.web = makeWeb(s, a);
            s.tabs.add(s.web);
            s.holder = new FrameLayout(a);
            ViewGroup root = a.findViewById(android.R.id.content);
            s.holder.addView(s.web, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
            s.holder.setTranslationX(-20000f); // off-screen, but still laid out so it can be drawn
            root.addView(s.holder, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
        } else {
            sizeWeb(s, s.heightPx);
        }
        String ua = s.web.getSettings().getUserAgentString();
        if (!mobile) ua = ua.replace("Mobile Safari", "Safari").replaceAll("; wv", "").replaceAll("Linux; Android [^)]*", "X11; Linux x86_64");
        s.web.getSettings().setUserAgentString(ua);
        s.web.getSettings().setUseWideViewPort(!mobile);
    }

    /** A browser window with everything the assistant's page has: its settings, protections, dialogs and file picker. */
    @SuppressLint("SetJavaScriptEnabled")
    private WebView makeWeb(final Sess s, Activity a) {
        final WebView w = new WebView(a);
        WebSettings ws = w.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setMediaPlaybackRequiresUserGesture(true);
        // windows the page opens (decision 207): a sign-in popup must stay linked to the page that opened it
        // (window.opener), or the sign-in has nowhere to go back to and the user is left on a white page
        ws.setSupportMultipleWindows(true);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
        try {
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        } catch (Exception ignored) {
        }
        w.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        // the user's own finger on the page (it is on their screen): noted, never blocked
        w.setOnTouchListener((v, ev) -> {
            if (s.overlay != null && !s.synthTouch) {
                int act = ev.getActionMasked();
                if (act == android.view.MotionEvent.ACTION_DOWN) s.userDown = true;
                else if (act == android.view.MotionEvent.ACTION_UP || act == android.view.MotionEvent.ACTION_CANCEL) s.userDown = false;
                s.userTouchAt = android.os.SystemClock.uptimeMillis();
                // use = a tap or a scroll the page received to its end. A gesture the system took away (the back
                // swipe from the screen edge that closes this view arrives as DOWN … CANCEL) is not use of the page
                if (act == android.view.MotionEvent.ACTION_DOWN) s.userGesture = s.viewing;
                else if (act == android.view.MotionEvent.ACTION_CANCEL) s.userGesture = false;
                else if (act == android.view.MotionEvent.ACTION_UP && s.userGesture && s.viewing) s.userTouched = true;
            }
            return false;
        });
        w.setDownloadListener((url, ua, disposition, mime, length) -> {
            JSObject dl = new JSObject();
            dl.put("url", url);
            dl.put("mime", mime);
            dl.put("size", length);
            try {
                dl.put("name", android.webkit.URLUtil.guessFileName(url, disposition, mime));
            } catch (Exception ignored) {
            }
            s.download = dl;
        });
        w.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView v, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                return openWindow(s, resultMsg);
            }

            // the page closed its own window (a sign-in popup that finished): back to the tab that opened it
            @Override
            public void onCloseWindow(WebView v) {
                if (s.tabs.size() > 1 && s.tabs.contains(v)) closeTab(s, v, "closed itself");
            }

            // A page's own alert / confirm / "leave this page?" box blocks its scripts until someone answers. The
            // assistant's page is hidden, so nobody would: the tool would wait for ever. Answered at once there
            // (the page script, once injected, handles and records dialogs itself); on the user's screen
            // (watching, handoff) Android's normal box is shown.
            @Override
            public boolean onJsAlert(WebView v, String url, String message, android.webkit.JsResult r) {
                if (s.overlay != null) return false;
                r.confirm();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, android.webkit.JsResult r) {
                if (s.overlay != null) return false;
                r.confirm();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String url, String message, String def, android.webkit.JsPromptResult r) {
                if (s.overlay != null) return false;
                r.confirm(def == null ? "" : def);
                return true;
            }

            @Override
            public boolean onJsBeforeUnload(WebView v, String url, String message, android.webkit.JsResult r) {
                if (s.overlay != null) return false;
                r.confirm();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<android.net.Uri[]> cb, FileChooserParams p) {
                String[] types = p.getAcceptTypes();
                String accept = types == null ? "" : android.text.TextUtils.join(",", types);
                if (s.overlay == null || pickLauncher == null) {
                    // the assistant is driving: it attaches workspace files with action "upload" instead
                    s.chooserAsked = accept.isEmpty() ? "any file" : accept;
                    cb.onReceiveValue(null);
                    return true;
                }
                // the page is on the user's screen (handoff): they pick from the phone
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = cb;
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
                i.addCategory(android.content.Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                if (types != null && types.length > 0 && !types[0].isEmpty()) {
                    java.util.List<String> mimes = new java.util.ArrayList<>();
                    for (String t : types) for (String one : t.split(",")) {
                        String x = one.trim();
                        if (x.startsWith(".")) {
                            String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(x.substring(1).toLowerCase(java.util.Locale.ROOT));
                            if (m != null) mimes.add(m);
                        } else if (!x.isEmpty()) mimes.add(x);
                    }
                    if (!mimes.isEmpty()) i.putExtra(android.content.Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    pickLauncher.launch(android.content.Intent.createChooser(i, "Choose a file for the page"));
                } catch (Exception e) {
                    pickCallback = null;
                    cb.onReceiveValue(null);
                }
                return true;
            }
        });
        w.setWebViewClient(new WebViewClient() {
            // the page's renderer crashed or was killed for memory: without this the whole app is closed with it
            @Override
            public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                s.mainError = "the page crashed (out of memory or a renderer crash) – open it again";
                sessions.values().remove(s);
                destroySess(s);
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (!(u.startsWith("http://") || u.startsWith("https://"))) return true;
                String host = r.getUrl().getHost();
                if (isSiteHost(host) && s.siteRoot != null) return false; // a link inside the served workspace
                if (s.loopback && isLoopback(host)) return false;
                return isPrivateHost(host); // the assistant's browser never goes to your LAN
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                // a page the assistant wrote is handed over as a data: URL, which has no host: it is not "private", let it load
                String scheme = r.getUrl().getScheme();
                if ("data".equals(scheme) || "about".equals(scheme)) return null;
                android.webkit.WebResourceResponse fake = routed(s, r);
                if (fake != null) return fake;
                String host = r.getUrl().getHost();
                // the chat's own files, from one origin, so links, redirects and storage work like on a real site
                if (isSiteHost(host)) {
                    s.siteHostSeen = host;
                    if (!swInstalled) new android.os.Handler(android.os.Looper.getMainLooper()).post(BrowserPlugin.this::installSwClient);
                    if (s.siteRoot != null) return serveSite(s, r.getUrl(), r.isForMainFrame());
                    return plain(404, "The workspace is not being served (open the page again)");
                }
                if (s.loopback && isLoopback(host)) return null;
                // the page may load things from the internet, but never from your network or this phone
                if (isPrivateHost(host) && !"preview.invalid".equals(host)) {
                    return new android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new java.util.HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                if (v == s.web) s.mainError = null;
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, android.webkit.WebResourceResponse resp) {
                if (r.isForMainFrame() && v == s.web) s.httpStatus = resp.getStatusCode();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (v == s.web) finishOpen(s, null);
            }

            // a site behind an HTTP sign-in (401): the user name and password the assistant gave for that host,
            // once per host and realm (a wrong one is not sent again and again); otherwise it is refused, as before
            @Override
            public void onReceivedHttpAuthRequest(WebView v, android.webkit.HttpAuthHandler h, String host, String realm) {
                String want = s.httpHost, u = s.httpUser, pw = s.httpPass;
                if (u != null && want != null && want.equalsIgnoreCase(host) && s.httpTried.add(host + "\n" + realm)) h.proceed(u, pw == null ? "" : pw);
                else if (s.overlay != null && v.getParent() == s.overlay) askAuth(h, host, realm); // on the user's screen: they type it
                else {
                    s.authAsked = host + (realm == null || realm.isEmpty() ? "" : " – \"" + realm + "\"");
                    h.cancel();
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && v == s.web) {
                    s.mainError = String.valueOf(e.getDescription());
                    finishOpen(s, s.mainError);
                }
            }
        });
        if (s.web != null) w.getSettings().setUserAgentString(s.web.getSettings().getUserAgentString());
        return w;
    }

    static boolean isLoopback(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        return h.equals("localhost") || h.startsWith("127.") || h.equals("::1");
    }

    private static android.webkit.WebResourceResponse plain(int code, String text) {
        java.util.Map<String, String> hd = new java.util.HashMap<>();
        hd.put("Cache-Control", "no-store");
        String body = "<!doctype html><meta charset=utf-8><title>" + code + "</title><pre>" + text.replace("&", "&amp;").replace("<", "&lt;") + "</pre>";
        return new android.webkit.WebResourceResponse("text/html", "utf-8", code, code == 404 ? "Not Found" : "Forbidden", hd, new java.io.ByteArrayInputStream(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    static String mimeOf(String name) {
        String n = name.toLowerCase();
        String ext = n.contains(".") ? n.substring(n.lastIndexOf('.') + 1) : "";
        switch (ext) {
            case "html": case "htm": return "text/html";
            case "css": return "text/css";
            case "js": case "mjs": return "text/javascript";
            case "json": case "map": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "avif": return "image/avif";
            case "ico": return "image/x-icon";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            case "txt": case "md": return "text/plain";
            case "csv": return "text/csv";
            case "xml": return "application/xml";
            case "wasm": return "application/wasm";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            case "mp3": return "audio/mpeg";
            case "wav": return "audio/wav";
            case "ogg": return "audio/ogg";
            case "pdf": return "application/pdf";
            default: return "application/octet-stream";
        }
    }

    /** One file of the served workspace: never outside the root, a folder means its index.html, nothing is cached. */
    private android.webkit.ValueCallback<android.net.Uri[]> pickCallback;
    private androidx.activity.result.ActivityResultLauncher<android.content.Intent> pickLauncher;

    @Override
    public void load() {
        super.load();
        try {
            // the system file picker for a page's <input type=file> while the user has the page on screen
            pickLauncher = getActivity().registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), res -> {
                android.webkit.ValueCallback<android.net.Uri[]> cb = pickCallback;
                pickCallback = null;
                if (cb == null) return;
                android.net.Uri[] uris = null;
                android.content.Intent d = res.getData();
                if (res.getResultCode() == Activity.RESULT_OK && d != null) {
                    if (d.getClipData() != null) {
                        uris = new android.net.Uri[d.getClipData().getItemCount()];
                        for (int k = 0; k < uris.length; k++) uris[k] = d.getClipData().getItemAt(k).getUri();
                    } else if (d.getData() != null) uris = new android.net.Uri[] { d.getData() };
                }
                cb.onReceiveValue(uris);
            });
        } catch (Exception e) {
            pickLauncher = null; // too late to register: the page's picker is cancelled, the assistant can still upload
        }
        // Capacitor sets its own service-worker client after the plugins load: ours goes in once start-up is done
        new android.os.Handler(android.os.Looper.getMainLooper()).post(this::installSwClient);
    }

    private volatile boolean swInstalled;

    private void installSwClient() {
        // a page's service worker fetches its script and everything it intercepts outside the WebView's client, so
        // without this the workspace origin cannot have one (a PWA could not register). Requests for a workspace host
        // go to the session serving it; everything else to Capacitor's own handler, as before.
        if (android.os.Build.VERSION.SDK_INT >= 24) {
            try {
                android.webkit.ServiceWorkerController.getInstance().setServiceWorkerClient(new android.webkit.ServiceWorkerClient() {
                    @Override
                    public android.webkit.WebResourceResponse shouldInterceptRequest(WebResourceRequest r) {
                        String host = r.getUrl().getHost();
                        if (isSiteHost(host)) {
                            Sess pick = null;
                            try {
                                for (Sess x : new java.util.ArrayList<>(sessions.values())) {
                                    if (x.siteRoot == null) continue;
                                    if (host.equalsIgnoreCase(x.siteHostSeen)) { pick = x; break; }
                                    if (pick == null) pick = x;
                                }
                            } catch (Exception ignored) {
                            }
                            android.webkit.WebResourceResponse fake = pick != null ? routed(pick, r) : null;
                            if (fake != null) return fake;
                            return pick != null ? serveSite(pick, r.getUrl(), false) : plain(404, "The workspace is not being served");
                        }
                        if (isPrivateHost(host) && !"localhost".equalsIgnoreCase(host)) {
                            return new android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new java.util.HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
                        }
                        try {
                            return getBridge().getLocalServer().shouldInterceptRequest(r);
                        } catch (Exception e) {
                            return null;
                        }
                    }
                });
                swInstalled = true;
            } catch (Exception ignored) {
            }
        }
    }

    private android.webkit.WebResourceResponse serveSite(Sess s, android.net.Uri uri, boolean main) {
        try {
            java.io.File root = new java.io.File(s.siteRoot).getCanonicalFile();
            String p = uri.getPath();
            if (p == null || p.isEmpty()) p = "/";
            java.io.File f = new java.io.File(root, p).getCanonicalFile();
            if (!(f.equals(root) || f.getPath().startsWith(root.getPath() + java.io.File.separator))) {
                if (main) s.httpStatus = 403;
                return plain(403, "Outside /workspace: " + p);
            }
            if (f.isDirectory()) f = new java.io.File(f, "index.html");
            if (!f.isFile() && main && !f.getName().contains(".")) {
                for (java.io.File d = f.getParentFile(); d != null && (d.equals(root) || d.getPath().startsWith(root.getPath() + java.io.File.separator)); d = d.getParentFile()) {
                    java.io.File ix = new java.io.File(d, "index.html");
                    if (ix.isFile()) { f = ix; break; }
                    if (d.equals(root)) break;
                }
            }
            if (!f.isFile()) {
                if (main) s.httpStatus = 404;
                return plain(404, "Not found in /workspace: " + p);
            }
            String mime = mimeOf(f.getName());
            java.util.Map<String, String> hd = new java.util.HashMap<>();
            hd.put("Cache-Control", "no-store");
            java.io.InputStream in;
            String inj = s.inject;
            if (mime.equals("text/html") && inj != null && !inj.isEmpty()) {
                byte[] raw = java.nio.file.Files.readAllBytes(f.toPath());
                String html = new String(raw, java.nio.charset.StandardCharsets.UTF_8);
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("<head[^>]*>", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
                html = m.find() ? html.substring(0, m.end()) + inj + html.substring(m.end()) : inj + html;
                in = new java.io.ByteArrayInputStream(html.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } else {
                in = new java.io.FileInputStream(f);
            }
            if (main) s.httpStatus = 200;
            return new android.webkit.WebResourceResponse(mime, mime.startsWith("text/") ? "utf-8" : null, 200, "OK", hd, in);
        } catch (Exception e) {
            if (main) s.httpStatus = 500;
            return plain(404, "Could not read " + uri.getPath() + ": " + e.getMessage());
        }
    }

    private static boolean isPrivateHost(String host) {
        if (host == null) return true;
        String h = host.toLowerCase();
        if (h.equals("localhost") || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || (!h.contains(".") && !h.contains(":"))) return true;
        return h.matches("^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.|172\\.(1[6-9]|2\\d|3[01])\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.).*") || h.equals("::1") || h.startsWith("[");
    }

    private void finishOpen(Sess s, String error) {
        PluginCall c = s.pendingOpen;
        if (c == null) return;
        s.pendingOpen = null;
        if (s.web == null) {
            c.reject("The page was closed");
            return;
        }
        if (error != null) {
            c.reject("Could not open the page: " + error);
            return;
        }
        JSObject r = new JSObject();
        r.put("url", s.web.getUrl());
        r.put("title", s.web.getTitle());
        c.resolve(r);
    }

    @PluginMethod
    public void open(final PluginCall call) {
        final Sess s = sess(call);
        final String url = call.getString("url", "");
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("Only http(s) addresses can be opened");
            return;
        }
        final int w = call.getInt("width", 390);
        final int h = call.getInt("height", 844);
        final boolean mobile = call.getBoolean("mobile", true);
        // a page of the chat's workspace: serve that folder; a server the assistant started here: allow loopback
        s.siteRoot = call.getString("root", null);
        s.inject = call.getString("inject", null);
        s.loopback = call.getBoolean("loopback", false);
        getActivity().runOnUiThread(() -> {
            try {
                ensure(s, w, h, mobile);
                if (s.pendingOpen != null) s.pendingOpen.reject("Interrupted by another page");
                s.pendingOpen = call;
                s.mainError = null;
                s.httpStatus = 0;
                s.userTouched = false; // the assistant replaced the page: what the user did on the old one is not about this one
                JSObject hdrs = call.getObject("headers", null);
                java.util.Map<String, String> hm = new java.util.HashMap<>();
                if (hdrs != null) {
                    java.util.Iterator<String> it = hdrs.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        hm.put(k, hdrs.optString(k, ""));
                    }
                }
                if (hm.isEmpty()) s.web.loadUrl(url);
                else s.web.loadUrl(url, hm); // the page's own address only: its later requests go without them
                awake(s);
                ui.postDelayed(() -> {
                    if (s.pendingOpen == call) finishOpen(s, null); // slow page: carry on with what is there
                }, 25000);
            } catch (Exception e) {
                call.reject("Could not open the page: the WebView failed (" + e + ")"); // never a bare or null message
            }
        });
    }

    /** Draws an HTML string (a page the assistant wrote) – it never reaches your network: requests to private hosts are refused. */
    @PluginMethod
    public void renderHtml(final PluginCall call) {
        final Sess s = sess(call);
        final String html = call.getString("html", "");
        final int w = call.getInt("width", 390);
        final int h = call.getInt("height", 844);
        final boolean mobile = call.getBoolean("mobile", true);
        getActivity().runOnUiThread(() -> {
            try {
                ensure(s, w, h, mobile);
                if (s.pendingOpen != null) s.pendingOpen.reject("Interrupted by another page");
                s.pendingOpen = call;
                s.web.loadDataWithBaseURL("https://preview.invalid/", html, "text/html", "utf-8", null);
                awake(s);
                ui.postDelayed(() -> {
                    if (s.pendingOpen == call) finishOpen(s, null);
                }, 15000);
            } catch (Exception e) {
                call.reject("Could not open the page: the WebView failed to draw it (" + e + ")");
            }
        });
    }

    @PluginMethod
    public void eval(final PluginCall call) {
        final Sess s = sess(call);
        final String js = call.getString("js", "");
        getActivity().runOnUiThread(() -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            awake(s);
            s.web.evaluateJavascript(js, value -> {
                JSObject r = new JSObject();
                r.put("value", value == null ? "null" : value);
                call.resolve(r);
            });
        });
    }

    /** What the main page really is: its address, title, a load error and the HTTP status of the page itself. */
    /**
     * The page as a PDF, the way Chromium prints it (real text, links, @media print styles), plus small pictures of
     * the first pages and the last one so the result can be checked. paper: a4 (default) or letter; landscape.
     */
    @PluginMethod
    public void pdf(final PluginCall call) {
        final Sess s = sess(call);
        final String paper = call.getString("paper", "a4");
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        final int previews = Math.max(0, Math.min(4, call.getInt("previews", 3)));
        getActivity().runOnUiThread(() -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            awake(s);
            android.print.PrintAttributes.MediaSize size = "letter".equalsIgnoreCase(paper) ? android.print.PrintAttributes.MediaSize.NA_LETTER : android.print.PrintAttributes.MediaSize.ISO_A4;
            if (landscape) size = size.asLandscape();
            final android.print.PrintAttributes attrs = new android.print.PrintAttributes.Builder()
                .setMediaSize(size)
                .setResolution(new android.print.PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                .setMinMargins(android.print.PrintAttributes.Margins.NO_MARGINS)
                .setColorMode(android.print.PrintAttributes.COLOR_MODE_COLOR)
                .build();
            final boolean[] answered = { false };
            final Runnable timeout = () -> {
                if (answered[0]) return;
                answered[0] = true;
                call.reject("Making the PDF took over 60 seconds");
            };
            ui.postDelayed(timeout, 60000);
            final java.io.File out = new java.io.File(getContext().getCacheDir(), "browser-" + System.nanoTime() + ".pdf");
            pdfPass(s, attrs, out, -1, call, answered, timeout, () -> new Thread(() -> {
                int count = pdfPages(out);
                int keep = count;
                while (keep > 1 && pdfBlank(out, keep - 1)) keep--;
                if (keep == count || answered[0]) {
                    pdfDone(call, out, previews, 0, answered, timeout);
                    return;
                }
                final int k = keep, dropped = count - keep;
                final java.io.File out2 = new java.io.File(getContext().getCacheDir(), "browser-" + System.nanoTime() + ".pdf");
                ui.post(() -> {
                    if (s.web == null) {
                        pdfDone(call, out, previews, 0, answered, timeout);
                        return;
                    }
                    pdfPass(s, attrs, out2, k - 1, call, answered, timeout, () -> new Thread(() -> {
                        //noinspection ResultOfMethodCallIgnored
                        out.delete();
                        pdfDone(call, out2, previews, dropped, answered, timeout);
                    }).start());
                });
            }).start());
        });
    }

    /** One print of the page into out (all pages, or 0..last). Runs on the UI thread; then() on success. */
    private void pdfPass(Sess s, android.print.PrintAttributes attrs, java.io.File out, int last, PluginCall call, boolean[] answered, Runnable timeout, Runnable then) {
        final android.print.PrintDocumentAdapter ad = s.web.createPrintDocumentAdapter("page");
        android.print.PdfWriterHelper.Done done = new android.print.PdfWriterHelper.Done() {
            @Override
            public void ok(int pagesSaid) {
                if (!answered[0]) then.run();
            }

            @Override
            public void fail(String why) {
                if (answered[0]) return;
                answered[0] = true;
                ui.removeCallbacks(timeout);
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject("Could not make the PDF: " + why);
            }
        };
        if (last < 0) android.print.PdfWriterHelper.write(ad, attrs, out, done);
        else android.print.PdfWriterHelper.write(ad, attrs, out, 0, last, done);
    }

    private static int pdfPages(java.io.File f) {
        try (android.os.ParcelFileDescriptor fd = android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
             android.graphics.pdf.PdfRenderer pr = new android.graphics.pdf.PdfRenderer(fd)) {
            return pr.getPageCount();
        } catch (Exception e) {
            return 0;
        }
    }

    /** Is page i (0-based) empty: nothing but white once drawn small? */
    private static boolean pdfBlank(java.io.File f, int i) {
        try (android.os.ParcelFileDescriptor fd = android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
             android.graphics.pdf.PdfRenderer pr = new android.graphics.pdf.PdfRenderer(fd);
             android.graphics.pdf.PdfRenderer.Page pg = pr.openPage(i)) {
            int w = 150, h = Math.round(150f * pg.getHeight() / Math.max(1, pg.getWidth()));
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            b.eraseColor(android.graphics.Color.WHITE);
            pg.render(b, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            int[] px = new int[w * h];
            b.getPixels(px, 0, w, 0, 0, w, h);
            b.recycle();
            int ink = 0;
            for (int p : px) {
                if (((p >> 16) & 255) < 240 || ((p >> 8) & 255) < 240 || (p & 255) < 240) ink++;
            }
            return ink < 3;
        } catch (Exception e) {
            return false;
        }
    }

    /** Hands the finished PDF back: its bytes, page count and pictures of the first pages and the last. */
    private void pdfDone(PluginCall call, java.io.File out, int previews, int dropped, boolean[] answered, Runnable timeout) {
        if (answered[0]) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            return;
        }
        answered[0] = true;
        ui.removeCallbacks(timeout);
        try {
            JSObject r = new JSObject();
            r.put("bytes", out.length());
            com.getcapacitor.JSArray pics = new com.getcapacitor.JSArray();
            int count = 0;
            try (android.os.ParcelFileDescriptor fd = android.os.ParcelFileDescriptor.open(out, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
                 android.graphics.pdf.PdfRenderer pr = new android.graphics.pdf.PdfRenderer(fd)) {
                count = pr.getPageCount();
                java.util.LinkedHashSet<Integer> want = new java.util.LinkedHashSet<>();
                for (int i = 0; i < Math.min(previews, count); i++) want.add(i);
                if (previews > 0 && count > 0) want.add(count - 1);
                for (int i : want) {
                    try (android.graphics.pdf.PdfRenderer.Page pg = pr.openPage(i)) {
                        int w = 600, h = Math.round(600f * pg.getHeight() / Math.max(1, pg.getWidth()));
                        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                        b.eraseColor(android.graphics.Color.WHITE);
                        pg.render(b, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        java.io.ByteArrayOutputStream jo = new java.io.ByteArrayOutputStream();
                        b.compress(Bitmap.CompressFormat.JPEG, 80, jo);
                        b.recycle();
                        JSObject pic = new JSObject();
                        pic.put("page", i + 1);
                        pic.put("base64", android.util.Base64.encodeToString(jo.toByteArray(), android.util.Base64.NO_WRAP));
                        pics.put(pic);
                    }
                }
            } catch (Exception ignored) {
                // no previews: the PDF itself is still returned
            }
            r.put("pages", count);
            r.put("dropped", dropped);
            r.put("previews", pics);
            BigBytes.fileInto(getContext(), out, r); // the PDF itself: inline when small, by path when big
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the PDF: " + e.getMessage());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
    }

    /**
     * Fetch a file with the browser's own session: the cookies the WebView holds for each address on the way (so a
     * site the user signed in to answers as it does in the page), its user agent, redirects followed by hand so every
     * hop gets its own cookies. Returns the bytes as base64 with the status, type, name and final address.
     */
    @PluginMethod
    public void fetchFile(final PluginCall call) {
        final Sess s = sess(call);
        final String start = call.getString("url", "");
        final String referer = call.getString("referer", "");
        final int max = call.getInt("max", 25 * 1024 * 1024);
        if (!(start.startsWith("http://") || start.startsWith("https://"))) {
            call.reject("Only http(s) addresses can be downloaded");
            return;
        }
        getActivity().runOnUiThread(() -> {
            String ua0 = null;
            try {
                if (s.web != null) ua0 = s.web.getSettings().getUserAgentString();
            } catch (Exception ignored) {
            }
            final String ua = ua0;
            new Thread(() -> {
                java.net.HttpURLConnection c = null;
                try {
                    android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                    String url = start;
                    int code = 0;
                    for (int hop = 0; hop < 8; hop++) {
                        java.net.URL u = new java.net.URL(url);
                        // every hop, the first too: resolved, and refused when it points into a private network (a public
                        // name can point at 10.x, a redirect at 172.16.x or fc00::) – cookies are sent with it
                        String bad = privateTarget(u, s.loopback);
                        if (bad != null) {
                            call.reject("The download " + (hop > 0 ? "was redirected to" : "points at") + " a private address (" + bad + ")");
                            return;
                        }
                        c = (java.net.HttpURLConnection) u.openConnection();
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(20000);
                        c.setReadTimeout(60000);
                        if (ua != null) c.setRequestProperty("User-Agent", ua);
                        c.setRequestProperty("Accept", "*/*");
                        if (!referer.isEmpty()) c.setRequestProperty("Referer", referer);
                        String ck = cm.getCookie(url);
                        if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck);
                        code = c.getResponseCode();
                        java.util.List<String> set = c.getHeaderFields().get("Set-Cookie");
                        if (set != null) for (String v : set) cm.setCookie(url, v);
                        if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                            url = new java.net.URL(u, c.getHeaderField("Location")).toString();
                            c.disconnect();
                            c = null;
                            continue;
                        }
                        break;
                    }
                    if (c == null) {
                        call.reject("Too many redirects");
                        return;
                    }
                    java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    BigBytes out = new BigBytes(getContext());
                    boolean cut = false;
                    if (in != null) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            if (out.size() + n > max) {
                                cut = true;
                                break;
                            }
                            out.write(buf, 0, n);
                        }
                        in.close();
                    }
                    JSObject r = new JSObject();
                    r.put("status", code);
                    r.put("url", url);
                    String mime = c.getContentType();
                    r.put("mime", mime == null ? "" : mime);
                    try {
                        r.put("name", android.webkit.URLUtil.guessFileName(url, c.getHeaderField("Content-Disposition"), mime == null ? null : mime.split(";")[0].trim()));
                    } catch (Exception ignored) {
                    }
                    r.put("tooBig", cut);
                    if (cut) r.put("base64", "");
                    else out.into(r); // { base64 } or, for a big file, { path }
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("Download failed: " + e);
                } finally {
                    if (c != null) c.disconnect();
                }
            }).start();
        });
    }

    @PluginMethod
    public void status(final PluginCall call) {
        // asking must not create a page (it would count towards the limit of open pages)
        final Sess found = sessions.get(call.getString("id", "main"));
        final Sess s = found != null ? found : new Sess();
        getActivity().runOnUiThread(() -> {
            JSObject r = new JSObject();
            r.put("url", s.web == null ? "" : s.web.getUrl());
            r.put("title", s.web == null ? "" : s.web.getTitle());
            r.put("error", s.mainError);
            r.put("httpStatus", s.httpStatus);
            r.put("progress", s.web == null ? 0 : s.web.getProgress());
            r.put("tabs", s.tabs.size());
            r.put("tab", s.tabs.indexOf(s.web));
            r.put("tabSeq", s.tabSeq);
            if (s.authAsked != null) {
                r.put("auth", s.authAsked);
                s.authAsked = null;
            }
            if (s.tabEvent != null) r.put("tabEvent", s.tabEvent);
            if (s.download != null) {
                r.put("download", s.download);
                s.download = null;
            }
            if (s.chooserAsked != null) {
                r.put("chooser", s.chooserAsked);
                s.chooserAsked = null;
            }
            call.resolve(r);
        });
    }

    /**
     * A frame is "flat" only when EVERY pixel is the same colour: a line of small text on a big page is a few hundred
     * pixels, which any sampling grid can miss. Row by row, so the check costs one int[] of a row, not the frame.
     * Returns how many pixels differ from the centre one (0 = flat), counting up to `enough`.
     */
    static int inked(Bitmap bmp, int enough) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        if (w < 2 || h < 2) return 0;
        int first = bmp.getPixel(w / 2, h / 2);
        int[] row = new int[w];
        int n = 0;
        for (int y = 0; y < h; y++) {
            bmp.getPixels(row, 0, w, 0, y, w, 1);
            for (int x = 0; x < w; x++) {
                if (row[x] != first && ++n >= enough) return n;
            }
        }
        return n;
    }

    /**
     * The app may be in the background: the agent keeps working while you use another app. Android then stops laying
     * out and drawing this window, so the hidden page would have no size, no animation frames and nothing to capture.
     * Here the page is laid out by hand, told its window is visible, and drawn off-screen for a few seconds so its
     * frames (requestAnimationFrame, a click's re-render) keep coming.
     */
    private void awake(final Sess s) {
        if (s.web == null) return;
        // on screen (you are watching, or a handoff): Android lays it out and draws it. Laying it out by hand at the
        // hidden size here put it at the top of the watch screen, over the Close bar – a blank page you could not
        // close, after a moment of the page.
        if (s.overlay != null || s.web.getParent() != s.holder) return;
        boolean hidden = getActivity().getWindow().getDecorView().getWindowVisibility() != View.VISIBLE;
        if (s.web.getWidth() != s.widthPx || s.web.getHeight() != s.heightPx) {
            s.holder.measure(View.MeasureSpec.makeMeasureSpec(s.widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(s.heightPx, View.MeasureSpec.EXACTLY));
            s.holder.layout(0, 0, s.widthPx, s.heightPx);
            s.web.measure(View.MeasureSpec.makeMeasureSpec(s.widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(s.heightPx, View.MeasureSpec.EXACTLY));
            s.web.layout(0, 0, s.widthPx, s.heightPx);
        }
        if (hidden) {
            s.web.dispatchWindowVisibilityChanged(View.VISIBLE);
            s.web.onResume();
        }
        // the page sits off screen, so Android never draws it, and a WebView that is not drawn gets no frames: its
        // animations and transitions stand still and requestAnimationFrame never fires. Drawing it into a tiny bitmap
        // gives it frames – in front as well as in the background – for a few seconds after every action.
        s.pumpUntil = android.os.SystemClock.uptimeMillis() + 5000;
        if (s.pumping) return;
        s.pumping = true;
        ui.post(new Runnable() {
            @Override
            public void run() {
                // on the user's screen Android draws it itself: drawing it again here 30 times a second (with the whole
                // document, in software) left the screen too busy to take a tap – the page and Close did not answer
                if (s.web == null || s.overlay != null || android.os.SystemClock.uptimeMillis() > s.pumpUntil) {
                    s.pumping = false;
                    return;
                }
                try {
                    if (s.pump == null || s.pump.getWidth() != s.widthPx) s.pump = Bitmap.createBitmap(s.widthPx, 8, Bitmap.Config.ARGB_8888);
                    Canvas c = new Canvas(s.pump);
                    c.clipRect(0, 0, s.widthPx, 8);
                    s.web.draw(c);
                } catch (Throwable ignored) {
                }
                ui.postDelayed(this, 32);
            }
        });
    }

    /**
     * A real tap: a touch the page cannot tell from a finger (isTrusted, and it gives the page user activation, so
     * clipboard writes, fullscreen, popups and audio work). x, y are CSS pixels of the viewport; vw is innerWidth.
     */
    @PluginMethod
    public void tap(final PluginCall call) {
        final Sess s = sess(call);
        final double x = call.getDouble("x", 0.0);
        final double y = call.getDouble("y", 0.0);
        final double vw = call.getDouble("vw", 0.0);
        final int count = Math.max(1, Math.min(2, call.getInt("count", 1)));
        getActivity().runOnUiThread(() -> whenUserIdle(s, android.os.SystemClock.uptimeMillis() + 15000, () -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            awake(s);
            final float k = vw > 0 ? (float) (s.web.getWidth() / vw) : s.web.getResources().getDisplayMetrics().density;
            final float px = (float) (x * k), py = (float) (y * k);
            if (px < 0 || py < 0 || px > s.web.getWidth() || py > s.web.getHeight()) {
                call.reject("That point is outside the page view (" + Math.round(px) + "," + Math.round(py) + " in a " + s.web.getWidth() + "×" + s.web.getHeight() + " view)");
                return;
            }
            if ("hover".equals(call.getString("kind", "tap"))) {
                // a mouse pointer moving onto the point: Chromium sets :hover and sends pointerover/mouseover
                long t0 = android.os.SystemClock.uptimeMillis();
                for (int a : new int[] { android.view.MotionEvent.ACTION_HOVER_ENTER, android.view.MotionEvent.ACTION_HOVER_MOVE }) {
                    android.view.MotionEvent.PointerProperties pp = new android.view.MotionEvent.PointerProperties();
                    pp.id = 0;
                    pp.toolType = android.view.MotionEvent.TOOL_TYPE_MOUSE;
                    android.view.MotionEvent.PointerCoords pc = new android.view.MotionEvent.PointerCoords();
                    pc.x = px;
                    pc.y = py;
                    android.view.MotionEvent ev = android.view.MotionEvent.obtain(t0, android.os.SystemClock.uptimeMillis(), a, 1, new android.view.MotionEvent.PointerProperties[] { pp }, new android.view.MotionEvent.PointerCoords[] { pc }, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_MOUSE, 0);
                    s.web.dispatchGenericMotionEvent(ev);
                    ev.recycle();
                }
                JSObject r = new JSObject();
                r.put("ok", true);
                call.resolve(r);
                return;
            }
            tapAt(s, px, py, count, () -> {
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("x", px);
                r.put("y", py);
                call.resolve(r);
            });
        }));
    }

    /** The assistant's tap waits while the user's finger is on the page on screen (they are closing a popup…), up to a limit. */
    private void whenUserIdle(final Sess s, final long until, final Runnable go) {
        if (s.overlay != null && (s.userDown || android.os.SystemClock.uptimeMillis() - s.userTouchAt < 1500) && android.os.SystemClock.uptimeMillis() < until) {
            ui.postDelayed(() -> whenUserIdle(s, until, go), 300);
            return;
        }
        go.run();
    }

    private void tapAt(final Sess s, final float px, final float py, final int left, final Runnable done) {
        final long t0 = android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent down = android.view.MotionEvent.obtain(t0, t0, android.view.MotionEvent.ACTION_DOWN, px, py, 0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        s.synthTouch = true;
        try {
            s.web.dispatchTouchEvent(down);
        } finally {
            s.synthTouch = false;
        }
        down.recycle();
        ui.postDelayed(() -> {
            if (s.web == null) {
                done.run();
                return;
            }
            long t1 = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent up = android.view.MotionEvent.obtain(t0, t1, android.view.MotionEvent.ACTION_UP, px, py, 0);
            up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            s.synthTouch = true;
            try {
                s.web.dispatchTouchEvent(up);
            } finally {
                s.synthTouch = false;
            }
            up.recycle();
            if (left > 1) ui.postDelayed(() -> tapAt(s, px, py, left - 1, done), 90);
            else ui.postDelayed(done, 60);
        }, 45);
    }

    @PluginMethod
    public void screenshot(final PluginCall call) {
        final Sess s = sess(call);
        final boolean full = call.getBoolean("full", false);
        // clip: the document's height in CSS px as the page reports it (scrollHeight): a full capture is that tall
        final double clipCss = call.getDouble("clip", 0.0);
        // kick: the last frame came back flat – make the WebView draw itself again (it can hold no picture yet when it
        // has never been on screen), then capture a moment later
        final boolean kick = call.getBoolean("kick", false);
        getActivity().runOnUiThread(() -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            awake(s);
            final int vh = s.h(); // the window as it is drawn now (on the user's screen: the room it has there)
            int h = vh;
            int want = 0;
            if (full) {
                float d = s.web.getResources().getDisplayMetrics().density;
                double vw = call.getDouble("vw", 0.0);
                // CSS px → view px at the scale the WebView really draws at. Not width / innerWidth: a page wider than
                // the window reports a wider innerWidth but is drawn at the normal scale (cut at the right edge), so
                // that ratio made the picture too short and lost the bottom of wide pages.
                float sc = drawScale(s);
                double k = sc > 0 ? sc : (vw > 0 ? s.w() / vw : d);
                int content = clipCss > 0 ? (int) Math.round(clipCss * k) : Math.round(s.web.getContentHeight() * (sc > 0 ? sc : d));
                want = content;
                h = Math.min(Math.max(vh, content), vh * 4);
            }
            final int fh = h, fwant = want;
            if (kick && s.overlay == null) { // (on screen it draws anyway, and must stay fast)
                s.web.setLayerType(View.LAYER_TYPE_NONE, null);
                s.web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            }
            // A tall picture, or the screen of a scrolled page: first the whole document drawn at the normal window
            // size. This WebView draws from the top of the document whatever the scroll position (with whole-document
            // drawing on), so nothing needs resizing: what the page measures never changes, and a scrolled screen is
            // cut out of the drawing. Only if it does not paint below the window is the window stretched instead.
            final int sy = s.web.getScrollY();
            if ((full && h > vh) || (!full && sy > 0)) {
                afterPaint(s, kick ? 350 : 32, () -> captureDoc(s, call, full, fh, fwant, sy, kick));
                return;
            }
            resizeAndCapture(s, call, fh, fwant, kick, "viewport");
        });
    }

    /** Run when what the page shows now has reached the view, plus a moment (or after a second whatever happens). */
    private void afterPaint(final Sess s, final int delay, final Runnable then) {
        final boolean[] fired = { false };
        final Runnable go = () -> {
            if (fired[0]) return;
            fired[0] = true;
            ui.postDelayed(then, delay);
        };
        try {
            s.web.postVisualStateCallback(System.nanoTime(), new WebView.VisualStateCallback() {
                @Override
                public void onComplete(long requestId) {
                    go.run();
                }
            });
        } catch (Throwable t) {
            go.run();
        }
        ui.postDelayed(go, 1200);
    }

    /**
     * The page into a picture without the view's own scrollbars: Android draws them as part of the view, pinned to the
     * window's edges, so a full-page picture of a page wider than the window had a grey bar across it at the height of
     * the window. They are switched off for the drawing and back on after (you see them while watching).
     */
    static void drawPage(Sess s, Canvas c) {
        boolean h = s.web.isHorizontalScrollBarEnabled(), v = s.web.isVerticalScrollBarEnabled();
        s.web.setHorizontalScrollBarEnabled(false);
        s.web.setVerticalScrollBarEnabled(false);
        try {
            s.web.draw(c);
        } finally {
            s.web.setHorizontalScrollBarEnabled(h);
            s.web.setVerticalScrollBarEnabled(v);
        }
    }

    /** The picture's px per view px: a wide (desktop) page at most 2 px per CSS px, a phone-width one as it is. */
    static float outScale(Sess s) {
        float dens = s.web.getResources().getDisplayMetrics().density;
        return dens > 2f && s.w() / dens > 600 ? 2f / dens : 1f;
    }

    /** View px per CSS px as the page is drawn (density × the page's zoom), or 0 when the WebView cannot say. */
    @SuppressWarnings("deprecation")
    static float drawScale(Sess s) {
        try {
            float k = s.web.getScale();
            return k > 0.05f && k < 50f ? k : 0f;
        } catch (Throwable t) {
            return 0f;
        }
    }

    /** Everything of one page gone: its screen, a pending open, the WebView, the frame-pump bitmap. UI thread. */
    private void destroySess(Sess s) {
        if (s.pendingShow != null || s.overlay != null) endShow(s, false);
        if (s.pendingOpen != null) {
            s.pendingOpen.reject("The page was closed");
            s.pendingOpen = null;
        }
        if (s.web != null) {
            try {
                s.holder.removeAllViews();
                ((ViewGroup) s.holder.getParent()).removeView(s.holder);
            } catch (Exception ignored) {
            }
            if (!s.tabs.contains(s.web)) s.tabs.add(s.web);
            for (WebView t : s.tabs) {
                try {
                    t.stopLoading();
                    t.destroy();
                } catch (Exception ignored) {
                }
            }
            s.tabs.clear();
            s.web = null;
            s.holder = null;
        }
        if (s.pump != null) {
            s.pump.recycle();
            s.pump = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        // the app is closing: no WebView is left behind
        for (Sess s : new java.util.ArrayList<>(sessions.values())) destroySess(s);
        sessions.clear();
        shots.shutdown();
        super.handleOnDestroy();
    }

    /** The address a URL resolves to, when it is on a private network (null when it is public). Loopback only when allowed. */
    static String privateTarget(java.net.URL u, boolean loopbackOk) {
        try {
            for (java.net.InetAddress a : java.net.InetAddress.getAllByName(u.getHost())) {
                byte[] b = a.getAddress();
                boolean cgnat = b.length == 4 && (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
                boolean zero = b.length == 4 && b[0] == 0;
                boolean ula = b.length == 16 && (b[0] & 0xfe) == 0xfc;
                if (a.isLoopbackAddress() && loopbackOk) continue;
                if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || cgnat || zero || ula) return a.getHostAddress();
            }
            return null;
        } catch (Exception e) {
            return "unresolvable host";
        }
    }

    /** Most of the rows from `from` down were painted (a fresh bitmap is transparent where nothing was drawn). */
    static boolean paintedBelow(Bitmap bmp, int from) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        if (h <= from) return true;
        int seen = 0, empty = 0;
        for (int i = 0; i < 48; i++) {
            int y = from + (int) ((long) (h - from - 1) * i / 47);
            for (int j = 0; j < 12; j++) {
                int x = (int) ((long) (w - 1) * j / 11);
                seen++;
                if ((bmp.getPixel(x, y) >>> 24) == 0) empty++;
            }
        }
        return empty * 50 < seen; // under 2% unpainted
    }

    private void captureDoc(final Sess s, final PluginCall call, final boolean full, final int h, final int want, final int sy, final boolean kick) {
        if (s.web == null) {
            call.reject("No page is open");
            return;
        }
        final int vw = s.w(), vh = s.h();
        int tall = full ? h : sy + vh;
        if (tall <= vh * 8) {
            try {
                // drawn straight at the size it is sent at: a tall desktop page at the phone's full density was
                // hundreds of MB before it was scaled down
                float k = outScale(s);
                Bitmap big = Bitmap.createBitmap(Math.round(vw * k), Math.max(1, Math.round(tall * k)), Bitmap.Config.ARGB_8888);
                Canvas cv = new Canvas(big);
                cv.scale(k, k);
                drawPage(s, cv);
                if (paintedBelow(big, Math.round(vh * k))) {
                    Bitmap out = big;
                    if (!full) {
                        out = Bitmap.createBitmap(big, 0, Math.round(sy * k), big.getWidth(), Math.min(big.getHeight() - Math.round(sy * k), Math.round(vh * k)));
                        big.recycle();
                    }
                    deliver(s, call, out, full ? h : vh, want, full ? "document" : "document-scrolled");
                    return;
                }
                big.recycle();
            } catch (Throwable ignored) {
                // too big for memory, or the WebView refused: the other way
            }
        }
        if (full) resizeAndCapture(s, call, h, want, kick, "resized");
        else capture(s, call, vh, 0, "viewport-unscrolled");
    }

    /** The old way: the view as tall as the page (a full capture), then drawn. */
    private void resizeAndCapture(final Sess s, final PluginCall call, final int h, final int want, final boolean kick, final String method) {
        {
            if (h != s.heightPx) {
                // the view (and its holder) as tall as the page, so the whole document is laid out and drawn
                if (sizeWeb(s, h)) {
                    s.web.measure(View.MeasureSpec.makeMeasureSpec(s.widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
                    s.web.layout(0, 0, s.widthPx, h);
                }
            }
            s.web.requestLayout();
            s.web.invalidate();
            // wait until what the page shows NOW has reached the view (a click's result, the resized layout), then one
            // more frame, before drawing; a page that never answers is drawn after a second anyway
            afterPaint(s, kick ? 350 : (h != s.h() ? 250 : 32), () -> capture(s, call, h, want, method));
        }
    }

    /** Rows at the bottom that are pure black: the part of a tall capture the WebView never painted. */
    static int blackTail(Bitmap bmp) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        int[] row = new int[w];
        int n = 0;
        for (int y = h - 1; y >= 0; y--) {
            bmp.getPixels(row, 0, w, 0, y, w, 1);
            for (int x = 0; x < w; x++) if ((row[x] & 0xffffff) != 0) return n;
            n++;
        }
        return n;
    }

    private void capture(final Sess s, final PluginCall call, final int h, final int want, final String method) {
        if (s.web == null) {
            call.reject("No page is open");
            return;
        }
        Bitmap bmp;
        try {
            bmp = Bitmap.createBitmap(s.w(), h, Bitmap.Config.ARGB_8888);
            drawPage(s, new Canvas(bmp));
        } catch (Throwable t) {
            call.reject("Screenshot failed: " + t);
            return;
        } finally {
            if (h != s.heightPx && sizeWeb(s, s.heightPx)) {
                // back to the normal viewport
                s.web.measure(View.MeasureSpec.makeMeasureSpec(s.widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(s.heightPx, View.MeasureSpec.EXACTLY));
                s.web.layout(0, 0, s.widthPx, s.heightPx);
            }
        }
        deliver(s, call, bmp, h, want, method);
    }

    /** Pictures are checked, scaled and turned into JPEG here, one at a time – not on the UI thread, which must stay free for the user's finger. */
    private final java.util.concurrent.ExecutorService shots = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** A drawn picture to the caller: blank check, unpainted black bottom cut off, wide pages scaled, JPEG. */
    private void deliver(final Sess s, final PluginCall call, final Bitmap drawn, final int h, final int want, final String method) {
        // what only the view can say is read here, on the UI thread; the rest (every pixel is looked at, a multi-megapixel
        // JPEG is made, then base64) took hundreds of ms of it per screenshot – while the user watched, taps were late
        final int viewW = s.w(), viewH = s.h();
        final float outK = outScale(s), sc = drawScale(s);
        final Runnable work = () -> {
            Bitmap bmp = drawn;
            try {
                int ink = inked(bmp, 64);
                boolean blank = ink == 0;
                int c0 = bmp.getPixel(bmp.getWidth() / 2, bmp.getHeight() / 2);
                // a tall frame whose bottom is pure black while its top is not: that part was never painted. It is cut
                // off and reported (how many px), never sent as a picture of the page.
                int tail = 0;
                // the picture may already be drawn at its output size (captureDoc): measure in its own px
                float pre = (float) bmp.getWidth() / viewW;
                int hp = bmp.getHeight(), screenP = Math.round(viewH * pre);
                if (!blank && hp > screenP) {
                    int t = blackTail(bmp);
                    int top = bmp.getPixel(bmp.getWidth() / 2, 1) & 0xffffff;
                    if (t >= screenP / 8 && t < hp && top != 0) {
                        tail = Math.round(t / pre); // in view px, like the rest below
                        Bitmap cut = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), hp - t);
                        bmp.recycle();
                        bmp = cut;
                    }
                }
                // a wide (desktop) page: at most 2 px per CSS px. The phone's own density (3.25 here) made a 1280-wide
                // page 4160 px – 10 megapixels – and the copy the model sees had to be shrunk so far that text blurred.
                float scaleOut = pre; // the picture's px per view px (what blackTail is counted in)
                if (pre > 0.999f && outK < 1f) {
                    scaleOut = outK;
                    Bitmap small = Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * outK), Math.max(1, Math.round(bmp.getHeight() * outK)), true);
                    bmp.recycle();
                    bmp = small;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 82, out);
                JSObject r = new JSObject();
                r.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                r.put("width", bmp.getWidth());
                r.put("height", bmp.getHeight());
                r.put("blank", blank);
                r.put("ink", ink);
                r.put("color", String.format("#%06x", c0 & 0xffffff));
                r.put("tall", h > viewH);
                r.put("blackTail", Math.round(tail * scaleOut));
                r.put("cut", want > h ? want - h : 0);
                r.put("method", method);
                // how to read the picture: px per CSS px, and how many CSS px wide the window shows
                if (sc > 0) {
                    r.put("pxPerCss", sc * scaleOut);
                    r.put("viewCssWidth", Math.round(viewW / sc));
                }
                bmp.recycle();
                call.resolve(r);
            } catch (Throwable t) {
                call.reject("Screenshot failed: " + t);
            }
        };
        try {
            shots.execute(work);
        } catch (Exception e) {
            work.run(); // the app is closing: here and now
        }
    }

    private int sysDim(String name) {
        int id = getActivity().getResources().getIdentifier(name, "dimen", "android");
        return id > 0 ? getActivity().getResources().getDimensionPixelSize(id) : 0;
    }

    /** Puts the page on screen so YOU can use it (sign in, solve a captcha…). Resolves { done } when you tap Done or Cancel. */
    @PluginMethod
    public void show(final PluginCall call) {
        final Sess s = sess(call);
        final String message = call.getString("message", "The assistant needs your help on this page.");
        getActivity().runOnUiThread(() -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            if (s.overlay != null && s.pendingShow == null) endShow(s, false); // a leftover screen
            if (s.pendingShow != null && s.viewing) endShow(s, false); // the assistant needs you: replace the watch-only view
            if (s.pendingShow != null) {
                call.reject("Already showing");
                return;
            }
            s.viewing = Boolean.TRUE.equals(call.getBoolean("view", false));
            s.pendingShow = call;
            Activity a = getActivity();
            ViewGroup root = a.findViewById(android.R.id.content);
            s.overlay = new LinearLayout(a);
            s.overlay.setOrientation(LinearLayout.VERTICAL);
            s.overlay.setBackgroundColor(0xFF111827);
            s.overlay.setPadding(0, sysDim("status_bar_height"), 0, sysDim("navigation_bar_height"));
            LinearLayout bar = new LinearLayout(a);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
            bar.setBackgroundColor(0xFF1F2937);
            int p = Math.round(8 * a.getResources().getDisplayMetrics().density);
            bar.setPadding(p * 2, p, p, p);
            TextView msg = new TextView(a);
            msg.setText(message);
            msg.setTextColor(0xFFFFFFFF);
            msg.setTextSize(14);
            msg.setMaxLines(3);
            bar.addView(msg, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button cancel = new Button(a);
            cancel.setText("Cancel");
            final LinearLayout mine = s.overlay;
            cancel.setOnClickListener(v -> endScreen(s, mine, false));
            Button done = new Button(a);
            done.setText("Done");
            done.setOnClickListener(v -> endScreen(s, mine, true));
            if (s.viewing) {
                cancel.setText("Close");
                bar.addView(cancel); // watch-only: no Done, the assistant carries on meanwhile
            } else {
                bar.addView(cancel);
                bar.addView(done);
            }
            s.overlay.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            s.holder.removeView(s.web);
            s.overlay.addView(s.web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            root.addView(s.overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            s.overlay.bringToFront();
            // on screen it is drawn the normal, fast way (the hidden page is drawn in software, for captures):
            // scrolling, popups and buttons answer the finger at once
            s.userTouched = false;
            s.userGesture = false;
            s.userDown = false;
            s.web.setLayerType(View.LAYER_TYPE_NONE, null);
            s.web.requestFocus();
        });
    }

    static final int MAX_TABS = 6;

    /**
     * A window the page opens (window.open, a target=_blank link): a tab of its own, linked to the page that opened it
     * (window.opener), and the one in use from now on – hidden as well as on the user's screen, where it takes the
     * page's place. A "Sign in with Google" popup hands its result back to the page and closes itself (window.close);
     * the opener is in use again. The assistant lists, switches and closes tabs with action tabs. (decisions 207, 211)
     */
    private boolean openWindow(final Sess s, android.os.Message resultMsg) {
        final Activity a = getActivity();
        if (a == null || s.web == null || s.holder == null) return false;
        if (s.tabs.size() >= MAX_TABS) return inPlace(s, a, resultMsg);
        final WebView p = makeWeb(s, a);
        s.holder.addView(p, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
        p.setVisibility(View.INVISIBLE);
        s.tabs.add(p);
        s.tabEvent = "opened";
        s.tabSeq++;
        activate(s, p);
        WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
        t.setWebView(p);
        resultMsg.sendToTarget();
        return true;
    }

    /** Too many tabs: the first address the new window goes to is opened in the tab in use instead (the old way). */
    private boolean inPlace(final Sess s, Activity a, android.os.Message resultMsg) {
        final WebView p = new WebView(a);
        p.getSettings().setJavaScriptEnabled(true);
        p.setWebViewClient(new android.webkit.WebViewClient() {
            boolean taken;

            private boolean take(String url) {
                if (taken) return true;
                taken = true;
                if (url != null && s.web != null && (url.startsWith("http://") || url.startsWith("https://"))) s.web.loadUrl(url);
                ui.post(() -> {
                    try {
                        p.destroy();
                    } catch (Exception ignored) {
                    }
                });
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return take(r.getUrl().toString());
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return plain(204, ""); // it never loads anything itself
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                if (url != null && !url.equals("about:blank")) take(url);
            }
        });
        s.tabEvent = "opened in place (" + MAX_TABS + " tabs are open)";
        s.tabSeq++;
        WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
        t.setWebView(p);
        resultMsg.sendToTarget();
        return true;
    }

    /** Put this tab in use: on the user's screen it takes the place of the one shown; hidden, it is the one drawn. */
    private void activate(Sess s, WebView w) {
        WebView old = s.web;
        if (old == w || w == null) return;
        boolean onScreen = s.overlay != null && old != null && old.getParent() == s.overlay;
        if (onScreen) {
            int at = s.overlay.indexOfChild(old);
            ViewGroup.LayoutParams lp = old.getLayoutParams();
            s.overlay.removeView(old);
            old.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            old.setVisibility(View.INVISIBLE);
            s.holder.addView(old, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
            if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
            w.setVisibility(View.VISIBLE);
            w.setLayerType(View.LAYER_TYPE_NONE, null);
            s.overlay.addView(w, at, lp);
            w.requestFocus();
        } else {
            if (old != null) old.setVisibility(View.INVISIBLE);
            if (w.getParent() == null) s.holder.addView(w, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
            w.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            w.setVisibility(View.VISIBLE);
        }
        s.web = w;
        awake(s);
    }

    /** A tab goes (the page closed it, or the assistant did): when it was in use, the one before it is in use again. */
    private void closeTab(Sess s, WebView w, String why) {
        int i = s.tabs.indexOf(w);
        if (i < 0 || s.tabs.size() <= 1) return;
        if (w == s.web) activate(s, s.tabs.get(i > 0 ? i - 1 : 1));
        s.tabs.remove(w);
        if (why != null) {
            s.tabEvent = why;
            s.tabSeq++;
        }
        try {
            if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
            w.stopLoading();
            w.destroy();
        } catch (Exception ignored) {
        }
    }

    private JSObject tabList(Sess s) {
        JSObject r = new JSObject();
        com.getcapacitor.JSArray list = new com.getcapacitor.JSArray();
        for (int i = 0; i < s.tabs.size(); i++) {
            WebView t = s.tabs.get(i);
            JSObject o = new JSObject();
            o.put("index", i);
            o.put("url", t.getUrl());
            o.put("title", t.getTitle());
            o.put("active", t == s.web);
            list.put(o);
        }
        r.put("tabs", list);
        r.put("active", s.tabs.indexOf(s.web));
        return r;
    }

    /** The tabs of this browser: index, address, title, which is in use. */
    @PluginMethod
    public void tabs(final PluginCall call) {
        final Sess found = sessions.get(call.getString("id", "main"));
        getActivity().runOnUiThread(() -> {
            if (found == null || found.web == null) {
                call.reject("No page is open");
                return;
            }
            call.resolve(tabList(found));
        });
    }

    /** Use another tab (index from tabs). */
    @PluginMethod
    public void switchTab(final PluginCall call) {
        final Sess found = sessions.get(call.getString("id", "main"));
        final int i = call.getInt("index", -1);
        getActivity().runOnUiThread(() -> {
            if (found == null || found.web == null) {
                call.reject("No page is open");
                return;
            }
            if (i < 0 || i >= found.tabs.size()) {
                call.reject("There is no tab " + i + " (" + found.tabs.size() + " open)");
                return;
            }
            activate(found, found.tabs.get(i));
            call.resolve(tabList(found));
        });
    }

    /** Close a tab (index from tabs; the one in use when left out). The last tab is closed with close. */
    @PluginMethod
    public void closeTab(final PluginCall call) {
        final Sess found = sessions.get(call.getString("id", "main"));
        getActivity().runOnUiThread(() -> {
            if (found == null || found.web == null) {
                call.reject("No page is open");
                return;
            }
            int i = call.getInt("index", found.tabs.indexOf(found.web));
            if (i < 0 || i >= found.tabs.size()) {
                call.reject("There is no tab " + i + " (" + found.tabs.size() + " open)");
                return;
            }
            if (found.tabs.size() <= 1) {
                call.reject("That is the only tab – use action close to close the browser");
                return;
            }
            closeTab(found, found.tabs.get(i), null); // the assistant did it: nothing to report
            call.resolve(tabList(found));
        });
    }

    private static int keyCode(String k) {
        switch (k) {
            case "Enter": return android.view.KeyEvent.KEYCODE_ENTER;
            case "Tab": return android.view.KeyEvent.KEYCODE_TAB;
            case "Escape": return android.view.KeyEvent.KEYCODE_ESCAPE;
            case "Backspace": return android.view.KeyEvent.KEYCODE_DEL;
            case "Delete": return android.view.KeyEvent.KEYCODE_FORWARD_DEL;
            case "ArrowUp": return android.view.KeyEvent.KEYCODE_DPAD_UP;
            case "ArrowDown": return android.view.KeyEvent.KEYCODE_DPAD_DOWN;
            case "ArrowLeft": return android.view.KeyEvent.KEYCODE_DPAD_LEFT;
            case "ArrowRight": return android.view.KeyEvent.KEYCODE_DPAD_RIGHT;
            case "Home": return android.view.KeyEvent.KEYCODE_MOVE_HOME;
            case "End": return android.view.KeyEvent.KEYCODE_MOVE_END;
            case "PageUp": return android.view.KeyEvent.KEYCODE_PAGE_UP;
            case "PageDown": return android.view.KeyEvent.KEYCODE_PAGE_DOWN;
            case " ": case "Space": return android.view.KeyEvent.KEYCODE_SPACE;
            case "Insert": return android.view.KeyEvent.KEYCODE_INSERT;
            default:
                if (k.length() == 1) {
                    char c = Character.toUpperCase(k.charAt(0));
                    if (c >= 'A' && c <= 'Z') return android.view.KeyEvent.KEYCODE_A + (c - 'A');
                    if (c >= '0' && c <= '9') return android.view.KeyEvent.KEYCODE_0 + (c - '0');
                }
                if (k.matches("F([1-9]|1[0-2])")) return android.view.KeyEvent.KEYCODE_F1 + Integer.parseInt(k.substring(1)) - 1;
                return 0;
        }
    }

    /**
     * A real key press (down and up) on the page, like a hardware keyboard: Tab moves the focus, arrows move the caret,
     * Backspace deletes – what a key event made by script cannot do. mods: shift, ctrl, alt, meta. → { ok } or rejects
     * an unknown key.
     */
    @PluginMethod
    public void key(final PluginCall call) {
        final Sess s = sess(call);
        final String k = call.getString("key", "");
        final int code = keyCode(k);
        int m = 0;
        if (Boolean.TRUE.equals(call.getBoolean("shift", false))) m |= android.view.KeyEvent.META_SHIFT_ON | android.view.KeyEvent.META_SHIFT_LEFT_ON;
        if (Boolean.TRUE.equals(call.getBoolean("ctrl", false))) m |= android.view.KeyEvent.META_CTRL_ON | android.view.KeyEvent.META_CTRL_LEFT_ON;
        if (Boolean.TRUE.equals(call.getBoolean("alt", false))) m |= android.view.KeyEvent.META_ALT_ON | android.view.KeyEvent.META_ALT_LEFT_ON;
        if (Boolean.TRUE.equals(call.getBoolean("meta", false))) m |= android.view.KeyEvent.META_META_ON | android.view.KeyEvent.META_META_LEFT_ON;
        final int meta = m;
        getActivity().runOnUiThread(() -> whenUserIdle(s, android.os.SystemClock.uptimeMillis() + 15000, () -> {
            if (s.web == null) {
                call.reject("No page is open");
                return;
            }
            if (code == 0) {
                call.reject("No real key for " + k);
                return;
            }
            awake(s);
            long t0 = android.os.SystemClock.uptimeMillis();
            s.web.dispatchKeyEvent(new android.view.KeyEvent(t0, t0, android.view.KeyEvent.ACTION_DOWN, code, 0, meta, android.view.KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, android.view.InputDevice.SOURCE_KEYBOARD));
            s.web.dispatchKeyEvent(new android.view.KeyEvent(t0, android.os.SystemClock.uptimeMillis(), android.view.KeyEvent.ACTION_UP, code, 0, meta, android.view.KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, android.view.InputDevice.SOURCE_KEYBOARD));
            ui.postDelayed(() -> {
                JSObject r = new JSObject();
                r.put("ok", true);
                call.resolve(r);
            }, 60);
        }));
    }

    /**
     * Requests answered by the assistant (Playwright route + fulfill): routes [{pattern, status, body, type, headers}]
     * replace the list (an empty one clears it); a pattern is part of the address, or a glob with * (whole address).
     * offline: every request fails as if the phone were offline (navigator.onLine is false too). → the routes with
     * how often each answered.
     */
    @PluginMethod
    public void route(final PluginCall call) {
        final Sess s = sess(call);
        try {
            com.getcapacitor.JSArray list = call.getArray("routes", null);
            if (list != null) {
                java.util.List<Route> next = new java.util.ArrayList<>();
                for (int i = 0; i < list.length() && i < 50; i++) {
                    org.json.JSONObject o = list.getJSONObject(i);
                    Route rt = new Route();
                    rt.pattern = o.optString("pattern", "");
                    if (rt.pattern.isEmpty()) continue;
                    if (rt.pattern.contains("*")) {
                        String[] parts = rt.pattern.split("\\*", -1);
                        StringBuilder re = new StringBuilder();
                        for (int k = 0; k < parts.length; k++) {
                            if (k > 0) re.append(".*");
                            re.append(java.util.regex.Pattern.quote(parts[k]));
                        }
                        rt.glob = java.util.regex.Pattern.compile(re.toString());
                    }
                    rt.status = Math.max(100, Math.min(599, o.optInt("status", 200)));
                    rt.body = o.optString("body", "");
                    rt.type = o.optString("type", "text/plain");
                    org.json.JSONObject h = o.optJSONObject("headers");
                    if (h != null) {
                        java.util.Iterator<String> it = h.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            rt.headers.put(k, h.optString(k, ""));
                        }
                    }
                    next.add(rt);
                }
                s.routes.clear();
                s.routes.addAll(next);
            }
        } catch (Exception e) {
            call.reject("Bad routes: " + e.getMessage());
            return;
        }
        final Boolean off = call.getBoolean("offline", null);
        getActivity().runOnUiThread(() -> {
            if (off != null) {
                s.offline = off;
                for (WebView t : s.tabs) {
                    try {
                        t.setNetworkAvailable(!off);
                    } catch (Exception ignored) {
                    }
                }
            }
            JSObject r = new JSObject();
            com.getcapacitor.JSArray out = new com.getcapacitor.JSArray();
            for (Route rt : s.routes) {
                JSObject o = new JSObject();
                o.put("pattern", rt.pattern);
                o.put("status", rt.status);
                o.put("hits", rt.hits);
                out.put(o);
            }
            r.put("routes", out);
            r.put("offline", s.offline);
            call.resolve(r);
        });
    }

    /**
     * All cookies Android keeps for an address – HttpOnly sign-in cookies too, which page scripts cannot see (names and
     * values only: Android does not give their other attributes). With set: [ "name=value; Path=/; …" ] they are set.
     */
    @PluginMethod
    public void cookieJar(final PluginCall call) {
        final String url = call.getString("url", "");
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("cookieJar needs an http(s) url");
            return;
        }
        getActivity().runOnUiThread(() -> {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            try {
                com.getcapacitor.JSArray set = call.getArray("set", null);
                if (set != null) {
                    for (int i = 0; i < set.length() && i < 200; i++) cm.setCookie(url, set.getString(i));
                    cm.flush();
                }
            } catch (Exception e) {
                call.reject("Could not set the cookies: " + e.getMessage());
                return;
            }
            JSObject r = new JSObject();
            String c = cm.getCookie(url);
            r.put("cookies", c == null ? "" : c);
            call.resolve(r);
        });
    }

    /** The browser's own sign-in box for a site behind an HTTP sign-in (401), while the user has the page on screen. */
    private void askAuth(final android.webkit.HttpAuthHandler h, String host, String realm) {
        Activity a = getActivity();
        if (a == null) {
            h.cancel();
            return;
        }
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = Math.round(16 * a.getResources().getDisplayMetrics().density);
        box.setPadding(p, p / 2, p, 0);
        final android.widget.EditText user = new android.widget.EditText(a);
        user.setHint("User name");
        user.setSingleLine(true);
        final android.widget.EditText pass = new android.widget.EditText(a);
        pass.setHint("Password");
        pass.setSingleLine(true);
        pass.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user);
        box.addView(pass);
        final boolean[] answered = { false };
        new android.app.AlertDialog.Builder(a)
            .setTitle("Sign in to " + host)
            .setMessage(realm == null || realm.isEmpty() ? "This site asks for a user name and password." : "The site says: " + realm)
            .setView(box)
            .setPositiveButton("Sign in", (d, w) -> {
                answered[0] = true;
                h.proceed(user.getText().toString(), pass.getText().toString());
            })
            .setNegativeButton("Cancel", (d, w) -> {
                answered[0] = true;
                h.cancel();
            })
            .setOnDismissListener((d) -> {
                if (!answered[0]) h.cancel();
            })
            .show();
    }

    /** The user name and password for a site behind an HTTP sign-in (401), for that host only; none to forget them. */
    @PluginMethod
    public void httpCredentials(final PluginCall call) {
        final Sess s = sess(call);
        String host = call.getString("host", null);
        String user = call.getString("user", null);
        s.httpTried.clear();
        s.httpHost = host == null || host.isEmpty() || user == null ? null : host;
        s.httpUser = s.httpHost == null ? null : user;
        s.httpPass = s.httpHost == null ? null : call.getString("password", "");
        call.resolve();
    }

    /**
     * Give the page its hidden, phone-sized place (or a taller one for a full-page capture). While the user has the
     * page on screen it lives in the overlay, a different kind of layout: it is left as it is there (FrameLayout
     * parameters on it would break that screen – blank page, dead Close button). → false when nothing was changed.
     */
    private boolean sizeWeb(Sess s, int h) {
        if (s.web == null || s.holder == null) return false;
        if (s.overlay != null || s.web.getParent() != s.holder) return false;
        s.web.setLayoutParams(new FrameLayout.LayoutParams(s.widthPx, h));
        s.holder.setLayoutParams(new FrameLayout.LayoutParams(s.widthPx, h));
        return true;
    }

    /** A button on a watch / handoff screen: that screen goes, even if the session has moved on to another one. */
    private void endScreen(Sess s, LinearLayout mine, boolean done) {
        if (s.overlay == mine) {
            endShow(s, done);
            return;
        }
        try {
            if (s.web != null && s.web.getParent() == mine) {
                mine.removeView(s.web);
                if (s.holder != null) s.holder.addView(s.web, new FrameLayout.LayoutParams(s.widthPx, s.heightPx));
            }
        } catch (Exception ignored) {
        }
        try {
            if (mine.getParent() != null) ((ViewGroup) mine.getParent()).removeView(mine);
        } catch (Exception ignored) {
        }
    }

    private void endShow(Sess s, boolean done) {
        PluginCall c = s.pendingShow;
        s.pendingShow = null;
        s.viewing = false;
        s.userDown = false;
        // every step by itself: whatever state the page is in, the screen must go away
        LinearLayout ov = s.overlay;
        s.overlay = null;
        try {
            if (ov != null && s.web != null && s.web.getParent() == ov) ov.removeView(s.web);
        } catch (Exception ignored) {
        }
        try {
            if (ov != null && ov.getParent() != null) ((ViewGroup) ov.getParent()).removeView(ov);
        } catch (Exception ignored) {
        }
        try {
            if (s.web != null && s.holder != null && s.web.getParent() == null) s.holder.addView(s.web, new FrameLayout.LayoutParams(s.widthPx, s.heightPx)); // back to its hidden, phone-sized place
        } catch (Exception ignored) {
        }
        try {
            if (s.web != null) s.web.setLayerType(View.LAYER_TYPE_SOFTWARE, null); // hidden again: drawn for captures
        } catch (Exception ignored) {
        }
        boolean touched = s.userTouched;
        s.userTouched = false;
        if (c != null) {
            JSObject r = new JSObject();
            r.put("touched", touched);
            r.put("done", done);
            r.put("url", s.web != null ? s.web.getUrl() : "");
            c.resolve(r);
        }
    }

    /** The back button: close whatever page is on screen (watching, or a handoff = Cancel). → { hidden: true } if one was. */
    @PluginMethod
    public void hideView(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean any = false;
            for (Sess x : new java.util.ArrayList<>(sessions.values())) {
                if (x.overlay != null || x.pendingShow != null) {
                    endShow(x, false);
                    any = true;
                }
            }
            JSObject r = new JSObject();
            r.put("hidden", any);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void close(final PluginCall call) {
        // closing must not create a page (at the limit that pushed out another chat's page just to close nothing)
        final Sess s = sessions.get(call.getString("id", "main"));
        if (s == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            destroySess(s);
            sessions.values().remove(s);
            call.resolve();
        });
    }
}
