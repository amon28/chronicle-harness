package dev.chronicle.app;

import android.content.Intent;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;

/** Opens the Chub browser screen and returns what was downloaded (as base64) or the page links to import. */
@CapacitorPlugin(name = "ChubBrowser")
public class ChubBrowserPlugin extends Plugin {

    /** The plugin while a browser screen is open and the app listens for items as they come (open with live: true). */
    private static volatile ChubBrowserPlugin live;

    /** A downloaded file, sent to the app now. false when the app is not listening (then it goes back on close). */
    static boolean deliverFile(File f) {
        ChubBrowserPlugin p = live;
        if (p == null) return false;
        try {
            JSObject o = new JSObject();
            o.put("name", f.getName().replaceFirst("^\\d+-", ""));
            o.put("base64", Base64.encodeToString(readAll(f), Base64.NO_WRAP));
            p.notifyListeners("item", o);
            f.delete();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** A character page to import, sent to the app now. */
    static boolean deliverLink(String url) {
        ChubBrowserPlugin p = live;
        if (p == null) return false;
        JSObject o = new JSObject();
        o.put("link", url);
        p.notifyListeners("item", o);
        return true;
    }

    private static byte[] readAll(File f) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** The app's answer about an item (imported, failed), shown in the open browser screen's message bar. */
    @PluginMethod
    public void status(PluginCall call) {
        ChubBrowserActivity a = ChubBrowserActivity.current;
        String t = call.getString("text", "");
        if (a != null && !t.isEmpty()) a.toast(t);
        call.resolve();
    }

    @PluginMethod
    public void open(PluginCall call) {
        live = call.getBoolean("live", false) ? this : null;
        Intent i = new Intent(getContext(), ChubBrowserActivity.class);
        String url = call.getString("url");
        if (url != null && !url.isEmpty()) i.putExtra("url", url);
        i.putExtra("site", call.getString("site", "chub"));
        startActivityForResult(call, i, "onBrowserResult");
    }

    @ActivityCallback
    private void onBrowserResult(PluginCall call, ActivityResult result) {
        live = null;
        if (call == null) return;
        JSArray items = new JSArray();
        Intent d = result.getData();
        if (d != null) {
            ArrayList<String> files = d.getStringArrayListExtra("files");
            if (files != null) {
                for (String path : files) {
                    try {
                        File f = new File(path);
                        JSObject o = new JSObject();
                        o.put("name", f.getName().replaceFirst("^\\d+-", ""));
                        o.put("base64", Base64.encodeToString(readAll(f), Base64.NO_WRAP));
                        items.put(o);
                        f.delete();
                    } catch (Exception ignored) {
                    }
                }
            }
            ArrayList<String> links = d.getStringArrayListExtra("links");
            if (links != null) {
                for (String l : links) {
                    JSObject o = new JSObject();
                    o.put("link", l);
                    items.put(o);
                }
            }
        }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }
}
