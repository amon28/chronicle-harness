package dev.chronicle.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** start/stop the generation foreground service, and post "reply finished" notifications. */
@CapacitorPlugin(name = "KeepAlive", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class KeepAlivePlugin extends Plugin {
    private static KeepAlivePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        // the screen is gone (the process may live on): answers from notifications wait in the queue for the next start
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** From NotifActionReceiver: hand an answer to the running app. false = the app is not running (queue it). */
    static boolean deliver(org.json.JSONObject o) {
        KeepAlivePlugin p = instance;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return false;
        try {
            p.notifyListeners("notifAction", JSObject.fromJSONObject(o), true);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Answers given while the app was not running. */
    @PluginMethod
    public void pendingActions(PluginCall call) {
        android.content.SharedPreferences p = getContext().getSharedPreferences(NotifActionReceiver.PREFS, android.content.Context.MODE_PRIVATE);
        String q = p.getString("queue", "[]");
        p.edit().remove("queue").apply();
        JSObject r = new JSObject();
        try {
            r.put("actions", new com.getcapacitor.JSArray(q));
        } catch (Exception e) {
            r.put("actions", new com.getcapacitor.JSArray());
        }
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), GenerationService.class);
        i.putExtra("title", call.getString("title", "Writing a reply…"));
        i.putExtra("text", call.getString("text", "Keeps going if you switch apps"));
        JSObject r = new JSObject();
        try {
            ContextCompat.startForegroundService(getContext(), i);
            // asked for: the service itself may still be refused a moment later (status() tells)
            r.put("started", true);
        } catch (Exception e) {
            GenerationService.ended("refused: " + GenerationService.why(e));
            r.put("started", false);
            r.put("reason", GenerationService.lastStop);
        }
        call.resolve(r);
    }

    /** Background protection now: running, when it started, why the last one ended (finished / time limit / refused: …). */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", GenerationService.running);
        r.put("startedAt", GenerationService.startedAt);
        r.put("lastStop", GenerationService.lastStop);
        r.put("lastStopAt", GenerationService.lastStopAt);
        r.put("notifications", enabled());
        android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        r.put("batteryFree", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), GenerationService.class));
        call.resolve();
    }

    private boolean enabled() {
        return androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    /**
     * Notification permission (Android 13+). Asks with Android's own prompt and answers with what the user chose.
     * Once it has been refused for good, Android shows no prompt any more: with openSettings the app's notification
     * settings open instead (and below Android 13, when notifications were switched off there).
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (enabled() && (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED)) {
            answer(call, true);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.DENIED && getActivity() != null) {
            requestPermissionForAlias("notifications", call, "notifAnswered");
            return;
        }
        settingsIfAsked(call);
    }

    @PermissionCallback
    private void notifAnswered(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED && enabled()) answer(call, true);
        else settingsIfAsked(call);
    }

    private void settingsIfAsked(PluginCall call) {
        boolean open = Boolean.TRUE.equals(call.getBoolean("openSettings", false));
        if (open) {
            Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(i);
            } catch (Exception e) {
                open = false;
            }
        }
        JSObject r = new JSObject();
        r.put("granted", false);
        r.put("settingsOpened", open);
        call.resolve(r);
    }

    private void answer(PluginCall call, boolean granted) {
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        GenerationService.channels(getContext());
        String id = call.getString("id", "");
        int nid = 5000 + (id.hashCode() & 0xfff);
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), GenerationService.CH_DONE)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(call.getString("title", "Reply ready"))
                .setContentText(call.getString("body", ""))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "")))
                .setAutoCancel(true)
                .setContentIntent(GenerationService.openApp(getContext(), call.getString("uri", "chronicle://open"), nid));
        // a reply box and/or buttons, answered without opening the app (NotifActionReceiver)
        String kind = call.getString("kind", "");
        String title = call.getString("title", "Reply ready");
        int req = 0;
        if (call.getBoolean("reply", false)) {
            androidx.core.app.RemoteInput ri = new androidx.core.app.RemoteInput.Builder(NotifActionReceiver.KEY_TEXT).setLabel(call.getString("replyLabel", "Reply")).build();
            b.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_tile, call.getString("replyLabel", "Reply"), actionIntent(id, kind, "reply", nid, title, req++, true)).addRemoteInput(ri).setAllowGeneratedReplies(false).build());
        }
        com.getcapacitor.JSArray acts = call.getArray("actions");
        if (acts != null) {
            for (int i = 0; i < acts.length() && i < 3; i++) {
                String a = acts.optString(i, "");
                if (!a.isEmpty()) b.addAction(new NotificationCompat.Action.Builder(0, a, actionIntent(id, kind, a, nid, title, req++, false)).build());
            }
        }
        if (call.getBoolean("ongoing", false)) b.setAutoCancel(false).setPriority(NotificationCompat.PRIORITY_HIGH);
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            nm.notify(nid, b.build());
        } catch (SecurityException e) {
            /* no permission */
        }
        call.resolve();
    }

    private android.app.PendingIntent actionIntent(String id, String kind, String action, int nid, String title, int req, boolean mutable) {
        Intent i = new Intent(getContext(), NotifActionReceiver.class);
        i.putExtra("id", id);
        i.putExtra("kind", kind);
        i.putExtra("action", action);
        i.putExtra("nid", nid);
        i.putExtra("title", title);
        int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : android.app.PendingIntent.FLAG_IMMUTABLE);
        return android.app.PendingIntent.getBroadcast(getContext(), nid * 8 + req, i, flags);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        String id = call.getString("id", null);
        if (id == null) nm.cancelAll();
        else nm.cancel(5000 + (id.hashCode() & 0xfff));
        call.resolve();
    }
}
