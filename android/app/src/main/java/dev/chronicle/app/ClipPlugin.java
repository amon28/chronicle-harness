package dev.chronicle.app;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** Pictures on the phone's clipboard (copied from Photos, Gboard's clipboard, a browser, a screenshot preview…). */
@CapacitorPlugin(name = "Clip")
public class ClipPlugin extends Plugin {

    private ClipboardManager cm() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void hasImage(PluginCall call) {
        JSObject r = new JSObject();
        boolean has = false;
        long stamp = 0;
        try {
            ClipboardManager m = cm();
            if (m != null && m.hasPrimaryClip()) {
                ClipDescription d = m.getPrimaryClipDescription();
                if (d != null) {
                    for (int i = 0; i < d.getMimeTypeCount(); i++) if (d.getMimeType(i).startsWith("image/")) has = true;
                    if (android.os.Build.VERSION.SDK_INT >= 26) stamp = d.getTimestamp();
                }
            }
        } catch (Exception ignored) {
        }
        r.put("has", has);
        r.put("stamp", stamp);
        call.resolve(r);
    }

    @PluginMethod
    public void readImages(PluginCall call) {
        new Thread(() -> {
            JSArray out = new JSArray();
            try {
                ClipData clip = cm().getPrimaryClip();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount() && out.length() < 4; i++) {
                        Uri u = clip.getItemAt(i).getUri();
                        if (u == null) continue;
                        String mime = getContext().getContentResolver().getType(u);
                        if (mime == null || !mime.startsWith("image/")) continue;
                        if (!ShareTargetPlugin.foreignContent(getContext(), u)) continue;
                        try (InputStream in = getContext().getContentResolver().openInputStream(u)) {
                            ByteArrayOutputStream bo = new ByteArrayOutputStream();
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                bo.write(buf, 0, n);
                                if (bo.size() > 15 * 1024 * 1024) throw new Exception("too big");
                            }
                            JSObject o = new JSObject();
                            o.put("mime", mime);
                            o.put("base64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                            out.put(o);
                        } catch (Exception ignored) {
                        }
                    }
                }
            } catch (Exception e) {
                call.reject("Couldn't read the clipboard: " + e.getMessage());
                return;
            }
            JSObject r = new JSObject();
            r.put("images", out);
            call.resolve(r);
        }).start();
    }
}
