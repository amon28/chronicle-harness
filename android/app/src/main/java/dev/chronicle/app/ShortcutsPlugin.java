package dev.chronicle.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Launcher shortcuts: long-press the app icon → "New chat with <persona>", and pinned home-screen
 * shortcuts. Each opens MainActivity with chronicle://new?persona=<id> (handled in JS via appUrlOpen).
 */
@CapacitorPlugin(name = "Shortcuts")
public class ShortcutsPlugin extends Plugin {

    private ShortcutInfo build(Context ctx, JSONObject o) {
        if (Build.VERSION.SDK_INT < 25) return null;
        String id = o.optString("id");
        String label = o.optString("label", "New chat");
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(o.optString("uri", "chronicle://new")));
        intent.setClass(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        ShortcutInfo.Builder b = new ShortcutInfo.Builder(ctx, id).setShortLabel(label).setLongLabel(o.optString("longLabel", label)).setIntent(intent);
        String icon = o.optString("icon", "");
        if (!icon.isEmpty()) {
            byte[] bytes = Base64.decode(icon, Base64.DEFAULT);
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp != null) b.setIcon(Build.VERSION.SDK_INT >= 26 ? Icon.createWithAdaptiveBitmap(bmp) : Icon.createWithBitmap(bmp));
        } else {
            b.setIcon(Icon.createWithResource(ctx, R.mipmap.ic_launcher));
        }
        return b.build();
    }

    @PluginMethod
    public void set(PluginCall call) {
        if (Build.VERSION.SDK_INT < 25) {
            call.resolve();
            return;
        }
        try {
            Context ctx = getContext();
            ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
            JSArray items = call.getArray("items", new JSArray());
            List<ShortcutInfo> list = new ArrayList<>();
            int max = Math.min(sm.getMaxShortcutCountPerActivity(), 4);
            for (int i = 0; i < items.length() && list.size() < max; i++) {
                ShortcutInfo s = build(ctx, items.getJSONObject(i));
                if (s != null) list.add(s);
            }
            sm.setDynamicShortcuts(list);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void pin(PluginCall call) {
        if (Build.VERSION.SDK_INT < 26) {
            call.reject("Pinning shortcuts needs Android 8 or newer");
            return;
        }
        try {
            Context ctx = getContext();
            ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
            if (!sm.isRequestPinShortcutSupported()) {
                call.reject("Your launcher doesn't support pinned shortcuts");
                return;
            }
            ShortcutInfo s = build(ctx, call.getData());
            sm.requestPinShortcut(s, null);
            JSObject r = new JSObject();
            r.put("requested", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
