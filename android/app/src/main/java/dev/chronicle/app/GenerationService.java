package dev.chronicle.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that runs only while a reply is being generated, so Android doesn't freeze or
 * kill the app when it goes to the background mid-reply. Stopped as soon as the reply finishes.
 */
public class GenerationService extends Service {
    static final String CH_WORK = "generating";
    static final String CH_DONE = "replies";
    static final int ID_WORK = 4101;

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel work = new NotificationChannel(CH_WORK, "Writing replies", NotificationManager.IMPORTANCE_LOW);
        work.setDescription("Shown while a reply is being generated in the background");
        work.setShowBadge(false);
        nm.createNotificationChannel(work);
        NotificationChannel done = new NotificationChannel(CH_DONE, "Finished replies", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("A reply finished while the app was in the background");
        nm.createNotificationChannel(done);
    }

    static PendingIntent openApp(Context ctx, String uri, int req) {
        Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(uri));
        i.setClass(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        String title = intent != null && intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "Writing a reply…";
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Keeps going if you switch apps";
        Notification n = new NotificationCompat.Builder(this, CH_WORK)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setSilent(true)
                .setProgress(0, 0, true)
                .setContentIntent(openApp(this, "chronicle://open", 1))
                .build();
        startedAt = System.currentTimeMillis();
        try {
            // Android 14+: special use has no time limit (dataSync stops after 6 hours on Android 15)
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID_WORK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else if (Build.VERSION.SDK_INT >= 29) startForeground(ID_WORK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(ID_WORK, n);
        } catch (Exception e) {
            // e.g. not allowed to start from the background: the reply goes on unprotected – said, not silent
            // (KeepAlive.status gives it to the app, which tells the user once per run)
            ended("refused: " + why(e));
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        MainActivity.keepJsAwake();
        return START_NOT_STICKY;
    }

    /** True while an agent run (or a reply) is protected by this service: the app's JavaScript must not be throttled. */
    static volatile boolean running = false;
    /** When the last protection started, and why the last one ended: finished, time limit, refused: … (KeepAlive.status). */
    static volatile long startedAt = 0;
    static volatile String lastStop = "";
    static volatile long lastStopAt = 0;

    static void ended(String reason) {
        lastStop = reason;
        lastStopAt = System.currentTimeMillis();
    }

    static String why(Exception e) {
        String n = e.getClass().getSimpleName();
        if (n.contains("NotAllowed") || e instanceof SecurityException) return "Android does not allow it while the app is in the background";
        return n + (e.getMessage() != null ? ": " + e.getMessage() : "");
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lastStopAt < startedAt) ended("finished"); // stopped by the app (the reply ended), not by Android
        super.onDestroy();
    }

    @Override
    public void onTimeout(int startId, int fgsType) { // Android 15+: the dataSync limit calls this one – stop, or the app is crashed
        pausedByAndroid();
    }

    @Override
    public void onTimeout(int startId) { // the short-service form
        pausedByAndroid();
    }

    /** Android's time limit for background work: stop (or the app is crashed), and say so instead of going quiet. */
    private void pausedByAndroid() {
        ended("time limit");
        try {
            channels(this);
            Notification n = new NotificationCompat.Builder(this, CH_DONE)
                    .setSmallIcon(R.drawable.ic_tile)
                    .setContentTitle("Reply paused by Android")
                    .setContentText("Android's time limit for background work was reached. Tap to continue.")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText("Android's time limit for background work was reached, so Chronicle stopped running in the background. Tap to open it – the reply continues while it is open."))
                    .setAutoCancel(true)
                    .setContentIntent(openApp(this, "chronicle://open", 2))
                    .build();
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(ID_WORK + 1, n);
        } catch (Exception ignored) {
            // no notification allowed: the app still shows it when it is next opened (KeepAlive.status)
        }
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
