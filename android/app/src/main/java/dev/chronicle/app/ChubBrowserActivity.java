package dev.chronicle.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A browser for chub.ai inside the app. When you download a character card (PNG / JSON) the file is
 * captured and handed to the app, which imports it while you keep browsing – no file manager in between, and
 * the screen stays open. A "Import this page" button is the fallback: it hands the character's page link
 * instead. What happened is shown in the screen's own message bar (not Android's toast, which would also pop
 * up over the app). Only when the app cannot take items live are they handed back when the screen closes.
 */
public class ChubBrowserActivity extends Activity {
    static final String PREFS = "chub_browser";
    private static final Pattern CHUB_PAGE = Pattern.compile("^https://(?:www\\.)?chub\\.ai/characters/[^/?#]+/[^/?#]+");
    private static final Pattern BOTBOORU_PAGE = Pattern.compile("^https://(?:www\\.)?botbooru\\.com/post/\\d+");
    private static final Pattern NEVER = Pattern.compile("(?!)"); // Character Archive: rely on its own download buttons
    private String site = "chub"; // which site this screen is for: "chub" or "botbooru"
    private static final long MAX_BYTES = 40L * 1024 * 1024;

    private WebView web;
    private TextView title;
    private TextView importPage;
    private ProgressBar bar;
    private final ArrayList<String> files = new ArrayList<>();
    private final ArrayList<String> links = new ArrayList<>();
    private boolean finished = false;
    private TextView banner;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable hideBanner = () -> { if (banner != null) banner.animate().alpha(0f).setDuration(200).withEndAction(() -> banner.setVisibility(View.GONE)); };
    /** The screen that is open (one at a time), so the plugin can show the app's answer in its message bar. */
    static volatile ChubBrowserActivity current;

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView button(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(15);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(12), dp(8), dp(12), dp(8));
        t.setBackgroundColor(Color.TRANSPARENT);
        return t;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Apps that target Android 16 get predictive back: onBackPressed() is no longer called, the system just closes
        // the screen. Register the new callback so Back goes back a page first, and only leaves on the first page.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBackOrLeave);
        }
        String want = getIntent().getStringExtra("site");
        if ("botbooru".equals(want) || "chararc".equals(want)) site = want;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0b0b0c"));
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets i = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(Color.parseColor("#17181a"));
        TextView close = button("✕");
        close.setOnClickListener(v -> finishWithResult());
        title = new TextView(this);
        title.setTextColor(Color.parseColor("#c9ccd1"));
        title.setTextSize(14);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setPadding(0, 0, dp(6), 0);
        title.setText(site.equals("botbooru") ? "BotBooru" : site.equals("chararc") ? "Character Archive" : "Chub");
        importPage = button("⤵ Import this page");
        importPage.setVisibility(View.GONE);
        importPage.setOnClickListener(v -> {
            String u = web.getUrl();
            if (u == null) return;
            if (ChubBrowserPlugin.deliverLink(u)) toast("Importing this character…");
            else {
                links.add(u);
                finishWithResult();
            }
        });
        top.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        top.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(importPage, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));
        root.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        // the page, with the message bar floating over its bottom (styled like the app's own messages)
        android.widget.FrameLayout stage = new android.widget.FrameLayout(this);
        stage.addView(web, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        banner = new TextView(this);
        banner.setTextColor(Color.parseColor("#0b0b0c"));
        banner.setTextSize(14);
        banner.setGravity(Gravity.CENTER);
        banner.setPadding(dp(16), dp(10), dp(16), dp(10));
        banner.setMaxLines(3);
        banner.setEllipsize(TextUtils.TruncateAt.END);
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setColor(Color.parseColor("#ececee"));
        pill.setCornerRadius(dp(20));
        banner.setBackground(pill);
        banner.setElevation(dp(6));
        banner.setVisibility(View.GONE);
        android.widget.FrameLayout.LayoutParams bl = new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        bl.setMargins(dp(16), 0, dp(16), dp(24));
        stage.addView(banner, bl);
        root.addView(stage, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        current = this;

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setLoadWithOverviewMode(true);
        // look like Chrome rather than an embedded WebView ("; wv") so sites don't treat it as a bot
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        userAgent = s.getUserAgentString();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        final Calls bridge = new Calls() {
            @JavascriptInterface
            public void onBlob(String dataUrl, String mime) {
                try {
                    int comma = dataUrl.indexOf(',');
                    byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
                    String m = mime != null && !mime.isEmpty() ? mime : dataUrl.substring(5, dataUrl.indexOf(';'));
                    saveBytes(bytes, URLUtil.guessFileName("download", null, m));
                } catch (Exception e) {
                    toast("Couldn't read that download");
                }
            }
            @JavascriptInterface
            public void onFile(String dataUrl, String mime, String name) {
                try {
                    int comma = dataUrl.indexOf(',');
                    byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
                    String m = mime != null && !mime.isEmpty() ? mime : "application/octet-stream";
                    saveBytes(bytes, name != null && !name.isEmpty() ? name : URLUtil.guessFileName("download", null, m));
                } catch (Exception e) {
                    toast("Couldn't read that download");
                }
            }

            @JavascriptInterface
            public void armDownload() {
                armedAt = System.currentTimeMillis();
            }

            @JavascriptInterface
            public void onFail(String why) {
                toast("Download failed: " + why);
            }
        };
        // The bridge answers only pages of this screen's own site, in any frame: an ad or embed from elsewhere cannot
        // hand it files. With a WebView that has message listeners (almost all), Android itself checks the origin and
        // the page talks to it through OcmPort (the SHIM turns that back into OcmBridge.*). Older ones: the main frame's
        // address is checked on each call.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "OcmPort", origins(), (view, msg, origin, mainFrame, reply) -> {
                final String data = msg.getData();
                if (data == null) return;
                new Thread(() -> {
                    try {
                        org.json.JSONObject o = new org.json.JSONObject(data);
                        String k = o.optString("k");
                        if ("blob".equals(k)) bridge.onBlob(o.optString("d"), o.optString("m"));
                        else if ("file".equals(k)) bridge.onFile(o.optString("d"), o.optString("m"), o.optString("n"));
                        else if ("arm".equals(k)) bridge.armDownload();
                        else if ("fail".equals(k)) bridge.onFail(o.optString("w"));
                    } catch (Exception ignored) {
                    }
                }).start();
            });
        } else {
            web.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void onBlob(String d, String m) {
                    if (pageIsMine()) bridge.onBlob(d, m);
                }
                @JavascriptInterface
                public void onFile(String d, String m, String n) {
                    if (pageIsMine()) bridge.onFile(d, m, n);
                }
                @JavascriptInterface
                public void armDownload() {
                    if (pageIsMine()) bridge.armDownload();
                }
                @JavascriptInterface
                public void onFail(String w) {
                    if (pageIsMine()) bridge.onFail(w);
                }
            }, "OcmBridge");
        }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                bar.setProgress(p);
                bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onReceivedTitle(WebView view, String t) {
                if (t != null) title.setText(t);
                updateImportButton(view.getUrl());
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.equals("blob")) {
                    // window.open(blob:…) / a link to an in-page file: the WebView would only show it, so read it from the page instead
                    readBlob(u.toString(), "");
                    return true;
                }
                if (scheme.equals("data") || scheme.equals("about")) return false;
                boolean mine = site.equals("botbooru")
                        ? (host.equals("botbooru.com") || host.endsWith(".botbooru.com"))
                        : site.equals("chararc")
                        ? (host.equals("chararc.bernkastel.pictures") || host.endsWith(".bernkastel.pictures"))
                        : (host.equals("chub.ai") || host.endsWith(".chub.ai") || host.endsWith(".charhub.io") || host.equals("characterhub.org") || host.endsWith(".characterhub.org"));
                // a card image link (Chub's PNG button is a plain link to avatars.charhub.io/.../chara_card_v2.png): the
                // WebView would just show the picture, so fetch it as a download instead
                String path = u.getPath() == null ? "" : u.getPath();
                if (scheme.startsWith("http") && mine && path.toLowerCase(Locale.ROOT).endsWith(".png") && path.toLowerCase(Locale.ROOT).contains("chara_card")) {
                    String[] seg = path.split("/");
                    String nm = seg.length >= 3 ? seg[seg.length - 2] + ".png" : "card.png";
                    final String referer = view.getUrl();
                    final String ua = view.getSettings().getUserAgentString();
                    final String dl = u.toString();
                    new Thread(() -> download(dl, ua, referer, nm)).start();
                    return true;
                }
                if (scheme.startsWith("http") && mine) return false;
                // any other site opens in the phone's browser, so this screen stays on the character site – a web address,
                // from a tap: a page cannot launch other apps' deep links on its own
                if (!scheme.startsWith("http") || !req.hasGesture()) return true;
                try {
                    Intent v = new Intent(Intent.ACTION_VIEW, u);
                    v.addCategory(Intent.CATEGORY_BROWSABLE);
                    v.setSelector(null);
                    startActivity(v);
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                notePage(url);
                updateImportButton(url);
                view.evaluateJavascript(SHIM + (site.equals("chub") ? CHUB_HOOK : DOWNLOAD_HOOK), null);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                notePage(url);
                view.evaluateJavascript(SHIM + (site.equals("chub") ? CHUB_HOOK : DOWNLOAD_HOOK), null);
                updateImportButton(url);
            }

            // the page's own requests (fetch/XHR/images): a card image fetched by the page's JavaScript is saved as well
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String path = u.getPath() == null ? "" : u.getPath().toLowerCase(Locale.ROOT);
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                if (site.equals("chub") && "GET".equalsIgnoreCase(req.getMethod()) && !req.isForMainFrame() && path.endsWith("/chara_card_v2.png") && (host.endsWith(".charhub.io") || host.endsWith(".chub.ai") || host.endsWith(".characterhub.org"))) {
                    String[] seg = u.getPath().split("/");
                    final String nm = seg.length >= 3 ? seg[seg.length - 2] + ".png" : "card.png";
                    final String ua = userAgent; // (shouldInterceptRequest runs off the UI thread: never touch the WebView here)
                    final String referer = "https://chub.ai/";
                    final String dl = u.toString();
                    // only when the user asked for it: they just tapped a Download / PNG control (opening a character page also loads its picture)
                    if (System.currentTimeMillis() - armedAt < 6000) new Thread(() -> download(dl, ua, referer, nm)).start();
                }
                return null;
            }

            // these sites are single-page apps: opening a character from a list changes the address without loading a page
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                notePage(url);
                updateImportButton(url);
            }
        });

        // remember when the user last touched the page, so only requests that follow a tap count as "download"
        web.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == android.view.MotionEvent.ACTION_UP) lastTap = System.currentTimeMillis();
            return false;
        });

        web.setDownloadListener((url, ua, disposition, mime, length) -> {
            if (url.startsWith("blob:")) {
                readBlob(url, mime);
            } else if (url.startsWith("data:")) {
                int comma = url.indexOf(',');
                try {
                    byte[] b = url.contains(";base64") ? Base64.decode(url.substring(comma + 1), Base64.DEFAULT) : Uri.decode(url.substring(comma + 1)).getBytes("UTF-8");
                    saveBytes(b, URLUtil.guessFileName("download", disposition, mime));
                } catch (Exception e) {
                    toast("Couldn't read that download");
                }
            } else {
                final String name = URLUtil.guessFileName(url, disposition, mime);
                final String referer = web.getUrl();
                new Thread(() -> download(url, ua, referer, name)).start();
            }
        });

        String start = getIntent().getStringExtra("url");
        if (start == null || start.isEmpty()) start = getSharedPreferences(PREFS, MODE_PRIVATE).getString("last_" + site, site.equals("botbooru") ? "https://botbooru.com/" : site.equals("chararc") ? "https://chararc.bernkastel.pictures/" : "https://chub.ai/search");
        web.loadUrl(start);
    }


    /** Sites like Character Archive save files with an unattached <a download> click (file-saver). The WebView drops those, so catch them in the page and read the file there. */
    // Chub: only a tap on a "Download" / "PNG" control counts as asking for the card file (just opening a character
    // also loads its picture, and that must not import anything)
    private static final String CHUB_HOOK = "(function(){if(window.__ocmChubArm)return;window.__ocmChubArm=1;"
            + "document.addEventListener('click',function(e){var n=e.target;"
            + "for(var i=0;n&&i<6;i++,n=n.parentElement){var s=((n.innerText||'')+' '+(n.getAttribute&&((n.getAttribute('aria-label')||'')+' '+(n.getAttribute('title')||'')))).trim();"
            + "if(s.length<=40&&/png|download/i.test(s)){if(window.OcmBridge&&OcmBridge.armDownload)OcmBridge.armDownload();return;}}},true);})();";

    private static final String DOWNLOAD_HOOK = "(function(){if(window.__ocmHook)return;window.__ocmHook=1;"
            + "function grab(a){var href=a.href;if(!href)return false;"
            + "fetch(href,{credentials:'include'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob();})"
            + ".then(function(b){var fr=new FileReader();fr.onloadend=function(){OcmBridge.onFile(fr.result,b.type||'',a.getAttribute('download')||'');};fr.readAsDataURL(b);})"
            + ".catch(function(e){OcmBridge.onFail(String(e&&e.message||e));});return true;}"
            + "function mine(a){return a&&a.tagName==='A'&&a.hasAttribute('download')&&/^(https?|blob):/.test(a.href);}"
            + "var d=EventTarget.prototype.dispatchEvent;EventTarget.prototype.dispatchEvent=function(ev){if(ev&&ev.type==='click'&&mine(this)&&grab(this))return true;return d.call(this,ev);};"
            + "var c=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(mine(this)&&grab(this))return;return c.call(this);};"
            + "document.addEventListener('click',function(ev){var a=ev.target&&ev.target.closest?ev.target.closest('a'):null;if(mine(a)){ev.preventDefault();ev.stopPropagation();grab(a);}},true);"
            + "var o=window.open;window.open=function(u){try{var a=document.createElement('a');a.href=u;if(/\\/api\\/.*(download|image|def)/.test(a.href)){a.setAttribute('download','');grab(a);return null;}}catch(e){}return o.apply(this,arguments);};"
            + "})();";

    /** Turns the origin-checked OcmPort into the OcmBridge calls the hooks make. Runs before each hook. */
    private static final String SHIM = "(function(){var p=window.OcmPort;if(!p||window.__ocmShim)return;window.__ocmShim=1;"
            + "function s(o){p.postMessage(JSON.stringify(o));}"
            + "window.OcmBridge={onBlob:function(d,m){s({k:'blob',d:d,m:m});},onFile:function(d,m,n){s({k:'file',d:d,m:m,n:n});},"
            + "armDownload:function(){s({k:'arm'});},onFail:function(w){s({k:'fail',w:w});}};})();";

    private java.util.Set<String> origins() {
        java.util.Set<String> o = new java.util.HashSet<>();
        if (site.equals("botbooru")) {
            o.add("https://botbooru.com");
            o.add("https://*.botbooru.com");
        } else if (site.equals("chararc")) {
            o.add("https://chararc.bernkastel.pictures");
        } else {
            o.add("https://chub.ai");
            o.add("https://*.chub.ai");
            o.add("https://characterhub.org");
            o.add("https://*.characterhub.org");
            o.add("https://*.charhub.io");
        }
        return o;
    }

    private volatile String pageHost = ""; // the main frame's host, for WebViews without message listeners

    private boolean pageIsMine() {
        String h = pageHost;
        for (String o : origins()) {
            String d = o.replace("https://", "").replace("*.", "");
            if (h.equals(d) || h.endsWith("." + d)) return true;
        }
        return false;
    }

    /** What a page of the site may ask of the app. */
    private interface Calls {
        void onBlob(String dataUrl, String mime);
        void onFile(String dataUrl, String mime, String name);
        void armDownload();
        void onFail(String why);
    }

    private void notePage(String url) {
        try {
            Uri u = Uri.parse(url == null ? "" : url);
            pageHost = "https".equals(u.getScheme()) && u.getHost() != null ? u.getHost().toLowerCase(Locale.ROOT) : "";
        } catch (Exception e) {
            pageHost = "";
        }
    }

    private volatile long lastTap = 0;
    private volatile long armedAt = 0; // set by the page hook when a Download / PNG button is tapped
    private volatile String userAgent = "";

    private void readBlob(String url, String mime) {
        String js = "(function(){var x=new XMLHttpRequest();x.open('GET','" + url.replace("'", "") + "',true);x.responseType='blob';"
                + "x.onload=function(){var r=new FileReader();r.onloadend=function(){OcmBridge.onBlob(r.result,'" + (mime == null ? "" : mime.replace("'", "")) + "');};r.readAsDataURL(x.response);};x.send();})();";
        runOnUiThread(() -> web.evaluateJavascript(SHIM + js, null));
    }

    private void updateImportButton(String url) {
        Pattern page = site.equals("botbooru") ? BOTBOORU_PAGE : site.equals("chararc") ? NEVER : CHUB_PAGE;
        final boolean show = url != null && page.matcher(url).find();
        runOnUiThread(() -> importPage.setVisibility(show ? View.VISIBLE : View.GONE));
    }

    /** A message in the screen's own bar, for a few seconds (longer for longer text). */
    void toast(String t) {
        runOnUiThread(() -> {
            if (banner == null || isFinishing()) return;
            ui.removeCallbacks(hideBanner);
            banner.animate().cancel();
            banner.setText(t);
            banner.setAlpha(1f);
            banner.setVisibility(View.VISIBLE);
            ui.postDelayed(hideBanner, Math.min(7000, 2500 + t.length() * 40L));
        });
    }

    private void download(String url, String ua, String referer, String name) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestProperty("User-Agent", ua);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) c.setRequestProperty("Cookie", cookies);
            if (referer != null) c.setRequestProperty("Referer", referer);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() >= 400) throw new Exception("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BYTES) throw new Exception("too large");
                }
                saveBytes(out.toByteArray(), name);
            }
        } catch (Exception e) {
            toast("Download failed: " + e.getMessage());
        }
    }

    private synchronized void saveBytes(byte[] bytes, String name) {
        if (finished || bytes.length > MAX_BYTES) return;
        try {
            File dir = new File(getCacheDir(), "chub");
            dir.mkdirs();
            File f = new File(dir, System.currentTimeMillis() + "-" + name.replaceAll("[^\\w.\\-]+", "_"));
            try (FileOutputStream o = new FileOutputStream(f)) {
                o.write(bytes);
            }
            // the app imports it now and says how it went in the message bar; the screen stays open for more
            if (ChubBrowserPlugin.deliverFile(f)) {
                toast("Importing " + name + "…");
                return;
            }
            files.add(f.getAbsolutePath());
            toast("Got " + name + " – importing…");
            runOnUiThread(this::finishWithResult); // the app is not listening: hand it back by closing
        } catch (Exception e) {
            toast("Couldn't save the download");
        }
    }

    private void finishWithResult() {
        if (finished) return;
        finished = true;
        String u = web != null ? web.getUrl() : null;
        if (u != null) getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("last_" + site, u).apply(); // reopen here next time
        Intent r = new Intent();
        r.putStringArrayListExtra("files", files);
        r.putStringArrayListExtra("links", links);
        setResult(RESULT_OK, r);
        finish();
    }

    private void goBackOrLeave() {
        if (web != null && web.canGoBack()) web.goBack();
        else finishWithResult();
    }

    @Override
    public void onBackPressed() { // Android 12 and older (13+ uses the callback above)
        goBackOrLeave();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        ui.removeCallbacks(hideBanner);
        if (web != null) {
            web.stopLoading();
            web.destroy();
        }
        super.onDestroy();
    }
}
