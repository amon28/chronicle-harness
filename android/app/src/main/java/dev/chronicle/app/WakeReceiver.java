package dev.chronicle.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The wake alarm fired (or the phone restarted). Due items go to the running app; if the app is not running,
 * each becomes a notification that opens its chat, where the app does the work. Then the next alarm is armed.
 */
public class WakeReceiver extends BroadcastReceiver {
    private static final String CHANNEL = "ocm_wake";

    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || "android.intent.action.MY_PACKAGE_REPLACED".equals(a) || "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED".equals(a)) {
            // after a restart, an update, or when exact alarms were just allowed: set the alarms again (exact now)
            SchedulerPlugin.arm(c);
            GeofencePlugin.rearm(c); // place triggers: Android forgets proximity alerts on a restart and an update
            return;
        }
        long now = System.currentTimeMillis();
        // a notification or place trigger fired (Triggers.fire): its one item is due now, and the plan stays as it is
        final boolean trigger = Triggers.ACTION.equals(a);
        JSONArray plan = trigger ? Triggers.dueFrom(intent) : SchedulerPlugin.readPlan(c);
        JSONArray due = new JSONArray();
        JSONArray rest = new JSONArray();
        for (int k = 0; k < plan.length(); k++) {
            JSONObject o = plan.optJSONObject(k);
            if (o == null) continue;
            if (trigger || o.optLong("at", 0) <= now + 30000) due.put(o);
            else rest.put(o);
        }
        if (!trigger) c.getSharedPreferences(SchedulerPlugin.PREFS, Context.MODE_PRIVATE).edit().putString("plan", rest.toString()).apply();
        final long token = due.length() > 0 ? SchedulerPlugin.wake(due) : 0;
        if (due.length() > 0 && token == 0) {
            for (int k = 0; k < due.length(); k++) notifyDue(c, due.optJSONObject(k));
        } else if (due.length() > 0) {
            // handed to the page – but a page frozen in the background never runs it: no answer in a few seconds, the
            // notifications go out. The broadcast is kept open meanwhile (goAsync): once onReceive returns Android may
            // freeze or kill a background process, and a timer alone would never fire. Android allows about 10 s.
            final Context app = c.getApplicationContext();
            final JSONArray items = due;
            final PendingResult pending = goAsync();
            final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
            final java.util.concurrent.atomic.AtomicBoolean over = new java.util.concurrent.atomic.AtomicBoolean(false);
            final Runnable late = () -> {
                if (SchedulerPlugin.giveUp(token)) for (int k = 0; k < items.length(); k++) notifyDue(app, items.optJSONObject(k));
                if (over.compareAndSet(false, true)) pending.finish();
            };
            main.postDelayed(late, 8000);
            SchedulerPlugin.whenTaken(token, () -> main.post(() -> {
                main.removeCallbacks(late);
                if (over.compareAndSet(false, true)) pending.finish();
            }));
        }
        SchedulerPlugin.arm(c);
    }

    private static void notifyDue(Context c, JSONObject o) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || o == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Scheduled and proactive", NotificationManager.IMPORTANCE_DEFAULT));
        }
        String conv = o.optString("convId", "");
        PendingIntent pi = GenerationService.openApp(c, "chronicle://open?conv=" + Uri.encode(conv) + "&wake=" + Uri.encode(o.optString("kind", "")), ("wake" + conv + o.optString("kind")).hashCode());
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(o.optString("title", "Chronicle"))
                .setContentText(o.optString("body", ""))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(o.optString("body", "")))
                .setAutoCancel(true)
                .setContentIntent(pi);
        try {
            nm.notify(("wake:" + conv + ":" + o.optString("kind")).hashCode(), b.build());
        } catch (SecurityException ignored) {
            /* notifications not allowed */
        }
    }
}
