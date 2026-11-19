package dev.chronicle.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // This screen can be started by any app, so the self-test (it runs the shell and every tool) needs a key only
        // adb can leave: a file in the app's folder under Android/data, which other apps cannot write to.
        //   adb shell touch /sdcard/Android/data/dev.chronicle.app/files/selftest.key
        // (not again when the screen is only started over, after a renderer crash or a rotation)
        // and never when the app is opened from the recent-apps screen: Android hands back the intent that last started
        // it, so the last adb self-test would run again – the app driving itself and going to the background
        boolean selftest = savedInstanceState == null && getIntent() != null && getIntent().hasExtra("selftest") && !fromHistory() && selfTestAllowed();
        // the web layer cannot see the intent: leave it a one-shot flag before the WebView starts
        if (selftest) {
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getFilesDir(), "selftest-js.flag"))) {
                // --es only "build:" runs just the agent scenarios whose name has that in it (quicker while fixing one)
                String only = getIntent().getStringExtra("only");
                out.write((only == null ? "1" : "only:" + only).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (Exception ignored) {
            }
        }
        // the assistant's browser draws whole pages into screenshots: without this a WebView paints only the part that
        // would be on screen, and the rest of a full-page capture comes back black (must run before any WebView exists)
        try {
            android.webkit.WebView.enableSlowWholeDocumentDraw();
        } catch (Throwable ignored) {
        }
        registerPlugin(SelfTestPlugin.class);
        registerPlugin(FileModePlugin.class);
        registerPlugin(GoStreamPlugin.class);
        registerPlugin(IntentsPlugin.class);
        registerPlugin(SchedulerPlugin.class);
        registerPlugin(AutomationPlugin.class);
        registerPlugin(ShortcutsPlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(SpeechPlugin.class);
        registerPlugin(ChubBrowserPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(FolderPlugin.class);
        registerPlugin(ClipPlugin.class);
        registerPlugin(BrowserPlugin.class);
        registerPlugin(ShellPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(DevicePlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(NotifyPlugin.class);
        registerPlugin(MessagesPlugin.class);
        registerPlugin(GeofencePlugin.class);
        Launch.watch(getApplication()); // before this screen starts: it is counted too
        super.onCreate(savedInstanceState);
        // every WebView of the app shares one renderer: when it crashes or is killed for memory (a heavy page in the
        // assistant's browser can do it), Android closes the whole app unless the app's own WebView says it handles it.
        // The assistant's browser pages handle theirs (BrowserPlugin); the app's screen is started again here.
        if (getBridge() != null) {
            getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
                @Override
                public boolean onRenderProcessGone(android.webkit.WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    android.util.Log.w("ChronicleSelfTest", "renderer gone (" + (detail != null && detail.didCrash() ? "crashed" : "killed for memory") + ") – the app's screen is started again");
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                        if (!isFinishing() && !isDestroyed()) recreate();
                    });
                    return true;
                }
            });
        }
        // adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1
        // runs the native checks and reports to logcat, without the UI getting in the way
        if (selftest) {
            new Thread(() -> SelfTestPlugin.collect(this)).start();
            stallWatch(0);
            // --es selftest bg: run it with the app in the background, as when you use another app while the agent works
            // (with the keep-alive service an agent run has, or the phone freezes the app as soon as it is in the back)
            if ("bg".equals(getIntent().getStringExtra("selftest"))) {
                try {
                    android.content.Intent i = new android.content.Intent(this, GenerationService.class);
                    i.putExtra("title", "Self-test");
                    i.putExtra("text", "Running in the background");
                    androidx.core.content.ContextCompat.startForegroundService(this, i);
                } catch (Exception ignored) {
                }
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> moveTaskToBack(true), 8000);
            }
        }
        current = new java.lang.ref.WeakReference<>(this);
        // self-test of the handler above: --es killrenderer 1 (with the key) ends the renderer 20 s after the start
        if (savedInstanceState == null && getIntent() != null && getIntent().hasExtra("killrenderer") && !fromHistory() && selfTestAllowed() && android.os.Build.VERSION.SDK_INT >= 29) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                try {
                    android.webkit.WebViewRenderProcess p = getBridge().getWebView().getWebViewRenderProcess();
                    android.util.Log.w("ChronicleSelfTest", "killrenderer: ending the renderer – " + (p != null && p.terminate() ? "ended" : "could not"));
                } catch (Throwable t) {
                    android.util.Log.w("ChronicleSelfTest", "killrenderer: " + t);
                }
            }, 20000);
        }
    }

    private boolean fromHistory() {
        return (getIntent().getFlags() & android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
    }

    /** The key is good for one run: it is used up here (adb leaves a new one for the next run). */
    private boolean selfTestAllowed() {
        try {
            java.io.File dir = getExternalFilesDir(null); // (made here if it is not there yet, so adb has somewhere to put the key)
            java.io.File key = dir == null ? null : new java.io.File(dir, "selftest.key");
            if (key != null && key.isFile()) {
                key.delete();
                return true;
            }
        } catch (Exception ignored) {
        }
        android.util.Log.w("ChronicleSelfTest", "no key: adb shell touch /sdcard/Android/data/" + getPackageName() + "/files/selftest.key");
        return false;
    }

    private static java.lang.ref.WeakReference<MainActivity> current = new java.lang.ref.WeakReference<>(null);
    private boolean stopped = false;

    /**
     * In the background Chromium treats the app's page as hidden and throttles its timers (once a second, then once a
     * minute), so an agent run that polls a shell job or waits for a page crawls. While the keep-alive service runs,
     * the page is told its window is still visible, so the run goes on at full speed.
     */
    static void keepJsAwake() {
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            MainActivity a = current.get();
            if (a != null && a.stopped) a.wakeWeb();
        });
    }

    /**
     * Self-test only: every 20 s, is the app's own page still running? A page timer stamps window.__hb each second;
     * evaluateJavascript reads how old that stamp is. "no answer" = the page's JavaScript does not run at all; a stale
     * stamp = it runs but its timers do not. When stuck, the window state is logged, the page is woken, and the next
     * tick says whether that helped.
     */
    private void stallWatch(final int n) {
        final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
        h.postDelayed(() -> {
            if (isDestroyed() || getBridge() == null || getBridge().getWebView() == null) return;
            final android.webkit.WebView wv = getBridge().getWebView();
            final boolean[] answered = { false };
            wv.evaluateJavascript(
                "(function(){if(!window.__hbT){window.__hb=Date.now();window.__hbT=setInterval(function(){window.__hb=Date.now()},1000)}return Date.now()-window.__hb})()",
                (v) -> {
                    answered[0] = true;
                    long stale = -1;
                    try {
                        stale = Long.parseLong(v.trim());
                    } catch (Exception ignored) {
                    }
                    if (stale > 5000) stuck("timers stopped (last tick " + stale / 1000 + " s ago)");
                    else if (n % 3 == 0) android.util.Log.i("ChronicleSelfTest", "watch: page ok, timer " + stale + " ms ago, " + state());
                });
            h.postDelayed(() -> {
                if (!answered[0]) stuck("the page's JavaScript does not answer");
            }, 5000);
            stallWatch(n + 1);
        }, n == 0 ? 15000 : 90000);
    }

    private String state() {
        android.webkit.WebView wv = getBridge().getWebView();
        return "stopped=" + stopped + " keepAlive=" + GenerationService.running + " windowVis=" + getWindow().getDecorView().getWindowVisibility() + " webVis=" + wv.getWindowVisibility() + " shown=" + wv.isShown() + " attached=" + wv.isAttachedToWindow();
    }

    private void stuck(String what) {
        android.util.Log.w("ChronicleSelfTest", "watch: STUCK – " + what + "; " + state() + " – waking it");
        try {
            getBridge().getWebView().dispatchWindowVisibilityChanged(android.view.View.VISIBLE);
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        } catch (Throwable ignored) {
        }
    }

    private void wakeWeb() {
        try {
            if (GenerationService.running && getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().dispatchWindowVisibilityChanged(android.view.View.VISIBLE);
                getBridge().getWebView().onResume();
                getBridge().getWebView().resumeTimers();
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        stopped = true;
        wakeWeb();
    }

    @Override
    public void onStart() {
        super.onStart();
        stopped = false;
    }
}
