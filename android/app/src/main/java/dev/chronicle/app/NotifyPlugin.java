package dev.chronicle.app;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Other apps' notifications for the `notifications` tool (src/private.js), through NotifyListener. Only the apps on the
 * user's allow-list are ever returned (the list comes with each call and is stored for the listener; the JS side
 * filters again). Android's notification access is a special access: openSettings() opens its page.
 */
@CapacitorPlugin(name = "Notify")
public class NotifyPlugin extends Plugin {
    static final String PREFS = "ocm_notify";
    static final int MAX = 30;

    static Set<String> allowed(SharedPreferences p) {
        Set<String> s = new HashSet<>();
        JSONArray a = Triggers.arr(p.getString("apps", "[]"));
        for (int i = 0; i < a.length(); i++) s.add(a.optString(i));
        return s;
    }

    static String label(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception e) {
            return pkg;
        }
    }

    /** An app showed a notification (the switch is on): its package name and when – never what it said. At most 80. */
    static synchronized void remember(Context c, String pkg) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject seen = Triggers.obj(p.getString("seen", "{}"));
        try {
            long now = System.currentTimeMillis();
            if (now - seen.optLong(pkg, 0) < 3600_000L) return; // once an hour is enough
            seen.put(pkg, now);
            while (seen.length() > 80) {
                String old = null;
                long t = Long.MAX_VALUE;
                java.util.Iterator<String> it = seen.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (seen.optLong(k) < t) {
                        t = seen.optLong(k);
                        old = k;
                    }
                }
                if (old == null) break;
                seen.remove(old);
            }
            p.edit().putString("seen", seen.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private boolean accessOn() {
        return NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", accessOn());
        r.put("connected", NotifyListener.live != null);
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Android's notification access page – Chronicle's own entry where the phone has one (Android 11+). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        if (Build.VERSION.SDK_INT >= 30) {
            Intent d = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            d.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, new ComponentName(getContext(), NotifyListener.class).flattenToString());
            if (d.resolveActivity(getContext().getPackageManager()) != null) i = d;
        }
        JSObject r = new JSObject();
        try {
            r.put("opened", Launch.startOrNotify(getActivity(), getContext(), i, "Turn on notification access for Chronicle"));
        } catch (Exception e) {
            r.put("opened", Launch.startOrNotify(getActivity(), getContext(), new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS), "Turn on notification access for Chronicle"));
        }
        call.resolve(r);
    }

    /** App info – where Android 13+ hides "Allow restricted settings" (⋮) for apps installed from a file. */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        JSObject r = new JSObject();
        r.put("opened", Launch.startOrNotify(getActivity(), getContext(), i, "Chronicle's App info"));
        call.resolve(r);
    }

    /** The in-app switch, the allow-list and the notification triggers, for the listener. */
    @PluginMethod
    public void setConfig(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSArray apps = call.getArray("apps", new JSArray());
        JSArray triggers = call.getArray("triggers", new JSArray());
        SharedPreferences.Editor e = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).putString("apps", apps.toString()).putString("triggers", on ? triggers.toString() : "[]");
        if (!on) e.remove("seen"); // switched off: forget which apps were seen too
        e.apply();
        if (!on) Triggers.drop(getContext(), "notification");
        call.resolve();
    }

    /** Apps that showed a notification (now, or since the switch was on): package and name, for the allow-list. */
    @PluginMethod
    public void apps(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> pkgs = new HashSet<>();
        java.util.Iterator<String> it = Triggers.obj(p.getString("seen", "{}")).keys();
        while (it.hasNext()) pkgs.add(it.next());
        NotifyListener l = NotifyListener.live;
        if (l != null) {
            try {
                StatusBarNotification[] all = l.getActiveNotifications();
                if (all != null) for (StatusBarNotification s : all) pkgs.add(s.getPackageName());
            } catch (Exception ignored) {
            }
        }
        pkgs.remove(getContext().getPackageName());
        JSArray out = new JSArray();
        for (String pkg : pkgs) {
            JSObject o = new JSObject();
            o.put("pkg", pkg);
            o.put("label", label(getContext(), pkg));
            out.put(o);
        }
        JSObject r = new JSObject();
        r.put("apps", out);
        call.resolve(r);
    }

    private static Set<String> appsOf(PluginCall call) {
        Set<String> s = new HashSet<>();
        JSArray a = call.getArray("apps", new JSArray());
        for (int i = 0; i < a.length(); i++) s.add(a.optString(i));
        return s;
    }

    /** One active notification of an allowed app by key, or null. */
    private static StatusBarNotification find(NotifyListener l, String key, Set<String> apps) {
        StatusBarNotification[] all = l.getActiveNotifications();
        if (all == null) return null;
        for (StatusBarNotification s : all) if (s.getKey().equals(key) && apps.contains(s.getPackageName())) return s;
        return null;
    }

    /** The current notifications of the allowed apps, newest first (no group summaries, none of ours). */
    @PluginMethod
    public void list(PluginCall call) {
        NotifyListener l = NotifyListener.live;
        if (l == null) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
            return;
        }
        Set<String> apps = appsOf(call);
        int limit = (int) Math.max(1, Math.min(MAX, Args.whole(call, "limit", MAX)));
        try {
            StatusBarNotification[] all = l.getActiveNotifications();
            java.util.List<StatusBarNotification> mine = new java.util.ArrayList<>();
            if (all != null) for (StatusBarNotification s : all) if (apps.contains(s.getPackageName()) && !NotifyListener.summary(s) && !getContext().getPackageName().equals(s.getPackageName())) mine.add(s);
            java.util.Collections.sort(mine, (a, b) -> Long.compare(b.getPostTime(), a.getPostTime()));
            JSArray out = new JSArray();
            for (StatusBarNotification s : mine) {
                if (out.length() >= limit) break;
                Notification n = s.getNotification();
                JSObject o = new JSObject();
                o.put("key", s.getKey());
                o.put("app", s.getPackageName());
                o.put("label", label(getContext(), s.getPackageName()));
                o.put("title", Triggers.clip(NotifyListener.title(n), 120));
                o.put("text", Triggers.clip(NotifyListener.text(n), 600));
                o.put("time", s.getPostTime());
                o.put("ongoing", s.isOngoing());
                o.put("clearable", s.isClearable());
                o.put("canOpen", n != null && n.contentIntent != null);
                out.put(o);
            }
            JSObject r = new JSObject();
            r.put("items", out);
            call.resolve(r);
        } catch (SecurityException e) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        NotifyListener l = NotifyListener.live;
        if (l == null) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
            return;
        }
        try {
            StatusBarNotification s = find(l, call.getString("key", ""), appsOf(call));
            if (s == null) {
                call.reject("That notification is gone.", "NOT_FOUND");
                return;
            }
            if (!s.isClearable()) {
                call.reject("That notification cannot be dismissed.", "NOT_CLEARABLE");
                return;
            }
            l.cancelNotification(s.getKey());
            JSObject r = new JSObject();
            r.put("dismissed", true);
            call.resolve(r);
        } catch (SecurityException e) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** Tap it, as in the shade: its own PendingIntent (only with Chronicle on screen – Android blocks it otherwise). */
    @PluginMethod
    public void open(PluginCall call) {
        if (!Launch.inFront(getActivity())) {
            call.reject("Chronicle is not on screen.", "BACKGROUND");
            return;
        }
        NotifyListener l = NotifyListener.live;
        if (l == null) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
            return;
        }
        try {
            StatusBarNotification s = find(l, call.getString("key", ""), appsOf(call));
            if (s == null) {
                call.reject("That notification is gone.", "NOT_FOUND");
                return;
            }
            Notification n = s.getNotification();
            PendingIntent pi = n == null ? null : n.contentIntent;
            if (pi == null) {
                call.reject("That notification has nothing to open.", "NO_ACTION");
                return;
            }
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14+: the app that sends another app's PendingIntent must lend it its right to start an activity
                ActivityOptions o = ActivityOptions.makeBasic();
                o.setPendingIntentBackgroundActivityStartMode(Build.VERSION.SDK_INT >= 36 ? ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE : ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                Bundle b = o.toBundle();
                pi.send(getContext(), 0, null, null, null, null, b);
            } else {
                pi.send();
            }
            if ((n.flags & Notification.FLAG_AUTO_CANCEL) != 0) l.cancelNotification(s.getKey()); // as the shade does
            JSObject r = new JSObject();
            r.put("opened", true);
            call.resolve(r);
        } catch (PendingIntent.CanceledException e) {
            call.reject("That notification's app no longer accepts it.", "NOT_FOUND");
        } catch (SecurityException e) {
            call.reject("Notification access is off.", "NOT_CONNECTED");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** The notification-trigger events kept since the page last asked. */
    @PluginMethod
    public void takeEvents(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("events", new JSArray(Triggers.take(getContext(), "notification").toString()));
        } catch (Exception e) {
            r.put("events", new JSArray());
        }
        call.resolve(r);
    }
}
