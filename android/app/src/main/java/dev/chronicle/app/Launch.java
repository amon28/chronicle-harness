package dev.chronicle.app;

import android.app.Activity;
import android.app.Application;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.NotificationCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;

/**
 * Opening another screen (an app, a settings page, the installer). Android blocks activity starts from an app in the
 * background – also with the foreground service running – and startActivity then returns as if it had worked. So: in
 * front, it opens; in the background, a notification says what is waiting and opens it when tapped. → true if opened.
 */
final class Launch {
    private Launch() {}

    /** How many of this app's screens are started (visible) now: MainActivity, the Chub browser over it… */
    private static int started;
    private static boolean watching;

    /** Count this app's visible screens (called once, from MainActivity.onCreate before its own start). */
    static synchronized void watch(Application app) {
        if (watching || app == null) return;
        watching = true;
        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityStarted(Activity x) { synchronized (Launch.class) { started++; } }
            @Override public void onActivityStopped(Activity x) { synchronized (Launch.class) { started = Math.max(0, started - 1); } }
            @Override public void onActivityCreated(Activity x, Bundle b) {}
            @Override public void onActivityResumed(Activity x) {}
            @Override public void onActivityPaused(Activity x) {}
            @Override public void onActivitySaveInstanceState(Activity x, Bundle b) {}
            @Override public void onActivityDestroyed(Activity x) {}
        });
    }

    static boolean inFront(Activity a) {
        if (a == null || a.isFinishing()) return false;
        // another screen of this app covers MainActivity (the in-app Chub browser): MainActivity is stopped, but the app
        // is in front and may open other apps' screens
        synchronized (Launch.class) {
            if (started > 0) return true;
        }
        if (a instanceof LifecycleOwner) return ((LifecycleOwner) a).getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
        return a.hasWindowFocus();
    }

    static boolean startOrNotify(Activity a, Context ctx, Intent i, String what) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (inFront(a)) {
            a.startActivity(i);
            return true;
        }
        // one notification per thing to open: asking twice replaces it instead of stacking, and two different things
        // do not land on the same number (a random one out of 256 did, now and then)
        int id = 0x4c000000 | ((what + "|" + i.getAction() + "|" + i.getDataString()).hashCode() & 0xffffff);
        GenerationService.channels(ctx); // the channel may not exist yet (no reply has run since the install)
        PendingIntent pi = PendingIntent.getActivity(ctx, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, GenerationService.CH_DONE)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(what)
            .setContentText("Tap to open it")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        try {
            if (nm != null) nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // notifications are off: nothing else can be done from the background
        }
        return false;
    }
}
