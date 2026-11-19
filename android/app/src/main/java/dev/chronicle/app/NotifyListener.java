package dev.chronicle.app;

import android.app.Notification;
import android.content.SharedPreferences;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * Chronicle's notification listener. Android binds it once the user turns on notification access for Chronicle
 * (Settings › Notifications › Notification access / Device & app notifications); it does nothing while the in-app switch
 * (Settings › Tools › 🔒 Sensitive phone access › Notifications) is off.
 *
 * It keeps nothing by itself: the notifications are read on demand by NotifyPlugin.list. Two small things happen as a
 * notification arrives, and only while the switch is on: the app's package name is remembered (so the user can pick it
 * in the allow-list – never the text), and a notification of an allowed app that matches a trigger (schedule_task when
 * notification) is kept for the page and wakes it (Triggers.fire).
 */
public class NotifyListener extends NotificationListenerService {
    static volatile NotifyListener live;

    /** Recently fired (task + key) → text hash: an app that updates the same notification does not fire again for it. */
    private static final java.util.LinkedHashMap<String, Integer> lastFired = new java.util.LinkedHashMap<String, Integer>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(java.util.Map.Entry<String, Integer> e) {
            return size() > 64;
        }
    };

    @Override
    public void onListenerConnected() {
        live = this;
    }

    @Override
    public void onListenerDisconnected() {
        if (live == this) live = null;
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        super.onDestroy();
    }

    static String title(Notification n) {
        if (n == null || n.extras == null) return "";
        CharSequence t = n.extras.getCharSequence(Notification.EXTRA_TITLE_BIG);
        if (t == null) t = n.extras.getCharSequence(Notification.EXTRA_TITLE);
        return t == null ? "" : t.toString();
    }

    static String text(Notification n) {
        if (n == null || n.extras == null) return "";
        CharSequence t = n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (t == null) t = n.extras.getCharSequence(Notification.EXTRA_TEXT);
        if (t == null) {
            CharSequence[] lines = n.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null && lines.length > 0) t = android.text.TextUtils.join(" · ", lines);
        }
        return t == null ? "" : t.toString();
    }

    /** A notification that is only a group's summary repeats its children. */
    static boolean summary(StatusBarNotification s) {
        Notification n = s.getNotification();
        return n != null && (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null || getPackageName().equals(sbn.getPackageName())) return;
            SharedPreferences p = getSharedPreferences(NotifyPlugin.PREFS, MODE_PRIVATE);
            if (!p.getBoolean("enabled", false)) return;
            String pkg = sbn.getPackageName();
            NotifyPlugin.remember(this, pkg);
            if (!NotifyPlugin.allowed(p).contains(pkg) || summary(sbn) || sbn.isOngoing()) return;
            JSONArray triggers = Triggers.arr(p.getString("triggers", "[]"));
            if (triggers.length() == 0) return;
            String title = title(sbn.getNotification());
            String text = text(sbn.getNotification());
            String hay = (title + " " + text).toLowerCase(Locale.ROOT);
            for (int i = 0; i < triggers.length(); i++) {
                JSONObject t = triggers.optJSONObject(i);
                if (t == null || !pkg.equals(t.optString("app"))) continue;
                String want = t.optString("contains", "").toLowerCase(Locale.ROOT).trim();
                if (!want.isEmpty() && !hay.contains(want)) continue;
                String id = t.optString("id") + "|" + sbn.getKey();
                int h = (title + "\n" + text).hashCode();
                synchronized (lastFired) {
                    Integer was = lastFired.get(id);
                    if (was != null && was == h) continue;
                    lastFired.put(id, h);
                }
                JSONObject ev = new JSONObject();
                ev.put("kind", "notification");
                ev.put("taskId", t.optString("id"));
                ev.put("convId", t.optString("convId"));
                ev.put("at", sbn.getPostTime());
                ev.put("app", pkg);
                String label = NotifyPlugin.label(this, pkg);
                ev.put("appLabel", label);
                ev.put("title", Triggers.clip(title, 100));
                ev.put("text", Triggers.clip(text, 300));
                // our own notification (when the app is closed) names the app only: the text stays out of the lock screen
                Triggers.fire(this, ev, "⚡ " + label, "A notification from " + label + " matched a trigger – open Chronicle to run its task.");
            }
        } catch (Exception ignored) {
            // a notification we cannot read is not ours to fail on
        }
    }
}
