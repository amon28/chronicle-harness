package dev.chronicle.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates: download the new APK (works for private repos with a token) and hand it to Android's installer.
 * Android always asks the user to confirm the install; the app needs the "install unknown apps" permission once.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private boolean busy = false;

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url", "");
        final String token = call.getString("token", "");
        if (url.isEmpty()) {
            call.reject("No download link");
            return;
        }
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            // one-time permission: send the user to the switch for this app
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            Launch.startOrNotify(getActivity(), ctx, s, "Allow Chronicle to install its updates");
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        if (busy) {
            call.reject("Already downloading");
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(ctx.getCacheDir(), "update");
                dir.mkdirs();
                File apk = new File(dir, "chronicle.apk");
                download(url, token, apk);
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                JSObject done = new JSObject();
                done.put("notified", !Launch.startOrNotify(getActivity(), ctx, i, "Chronicle update ready to install"));
                call.resolve(done);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage());
            } finally {
                busy = false;
            }
        }).start();
    }

    private void download(String start, String token, File out) throws Exception {
        String url = start;
        boolean sendAuth = !token.isEmpty();
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setRequestProperty("Accept", "application/octet-stream");
            // the token goes only to GitHub itself; the storage host it redirects to must not get it
            String h = new URL(url).getHost();
            if (sendAuth && ("github.com".equals(h) || h.endsWith(".github.com"))) c.setRequestProperty("Authorization", "Bearer " + token);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                continue;
            }
            if (code == 404 || code == 401) throw new Exception("GitHub refused the download (add a token with read access to the repo)");
            if (code != 200) throw new Exception("Download failed (HTTP " + code + ")");
            long total = c.getContentLengthLong();
            long got = 0;
            int lastPct = -1;
            try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    got += n;
                    int pct = total > 0 ? (int) (got * 100 / total) : -1;
                    if (pct != lastPct) {
                        lastPct = pct;
                        JSObject p = new JSObject();
                        p.put("percent", pct);
                        p.put("bytes", got);
                        notifyListeners("progress", p);
                    }
                }
            }
            if (out.length() < 100000) throw new Exception("That didn't look like an app file");
            return;
        }
        throw new Exception("Too many redirects");
    }
}
