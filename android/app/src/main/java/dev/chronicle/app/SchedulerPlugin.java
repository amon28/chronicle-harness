package dev.chronicle.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The wake plan: the app hands over every moment it has something to do on its own (a scheduled task, a retry,
 * a character writing first). One alarm is armed for the earliest; when it fires, a running app is woken
 * ("wake" event) and a closed one gets a notification that opens it. The plan survives a reboot.
 */
@CapacitorPlugin(name = "Scheduler")
public class SchedulerPlugin extends Plugin {
    static final String PREFS = "ocm_wake";
    private static SchedulerPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        // the screen is gone (the process may live on): the next alarm must not be handed to a page that no longer exists
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Wake-ups handed to the page that it has not taken yet (ack): each with what to do when it does. */
    private static final java.util.Map<Long, Runnable> unanswered = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.atomic.AtomicLong wakeSeq = new java.util.concurrent.atomic.AtomicLong();
    private static final Runnable NOTHING = () -> {};

    /** From WakeReceiver: wake the running app. 0 = it is not running; otherwise this wake-up's number. The page answers with ack(). */
    static long wake(JSONArray due) {
        SchedulerPlugin p = instance;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return 0;
        long token = wakeSeq.incrementAndGet();
        try {
            JSObject o = new JSObject();
            o.put("due", new JSArray(due.toString()));
            unanswered.put(token, NOTHING);
            p.notifyListeners("wake", o, true);
            return token;
        } catch (Exception e) {
            unanswered.remove(token);
            return 0;
        }
    }

    /** Run then when the page takes this wake-up (at once if it already has). */
    static void whenTaken(long token, Runnable then) {
        if (unanswered.replace(token, then) == null) then.run();
    }

    /** The wait for this wake-up is over. true = the page never took it. */
    static boolean giveUp(long token) {
        return unanswered.remove(token) != null;
    }

    /** The page took the wake-up (it is running, not frozen in the background): every one handed over so far. */
    @PluginMethod
    public void ack(PluginCall call) {
        for (Long k : new java.util.ArrayList<>(unanswered.keySet())) {
            Runnable r = unanswered.remove(k);
            if (r != null) r.run();
        }
        call.resolve();
    }

    /** Replace the whole plan: items [{ at, convId, kind, title, body }]. */
    @PluginMethod
    public void plan(PluginCall call) {
        JSArray items = call.getArray("items", new JSArray());
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("plan", items.toString()).apply();
        arm(getContext());
        JSObject r = new JSObject();
        r.put("exact", canExact(getContext()));
        call.resolve(r);
    }

    /** Whether alarms can be exact (Android 12+ asks the user); without it they may come a few minutes late in Doze. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("exact", canExact(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void askExact(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && !canExact(getContext())) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:" + getContext().getPackageName()));
                Launch.startOrNotify(getActivity(), getContext(), i, "Allow exact alarms for Chronicle");
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    static JSONArray readPlan(Context c) {
        try {
            return new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("plan", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** Arm one alarm for the earliest item still to come (or cancel it when there is none). */
    static void arm(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(c, WakeReceiver.class);
        PendingIntent pi = PendingIntent.getBroadcast(c, 4711, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        JSONArray plan = readPlan(c);
        long next = Long.MAX_VALUE;
        for (int k = 0; k < plan.length(); k++) {
            JSONObject o = plan.optJSONObject(k);
            if (o != null) next = Math.min(next, o.optLong("at", Long.MAX_VALUE));
        }
        am.cancel(pi);
        if (next == Long.MAX_VALUE) return;
        next = Math.max(next, System.currentTimeMillis() + 5000);
        try {
            if (canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
        }
    }
}
