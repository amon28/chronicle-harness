package dev.chronicle.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A tap on a notification button, or text typed into its reply box (reply to a chat, answer a question, allow / deny a
 * tool call). The answer goes to the app if it is running; otherwise it waits in a small queue that the app reads when
 * it next starts. The notification then shows what was sent, so the reply box stops spinning.
 */
public class NotifActionReceiver extends BroadcastReceiver {
    static final String KEY_TEXT = "ocm_reply";
    static final String PREFS = "ocm_notif_actions";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String id = intent.getStringExtra("id");
        String kind = intent.getStringExtra("kind");
        String action = intent.getStringExtra("action");
        int nid = intent.getIntExtra("nid", 0);
        String text = null;
        Bundle ri = RemoteInput.getResultsFromIntent(intent);
        if (ri != null && ri.getCharSequence(KEY_TEXT) != null) text = ri.getCharSequence(KEY_TEXT).toString();
        JSONObject o = new JSONObject();
        try {
            o.put("id", id == null ? "" : id);
            o.put("kind", kind == null ? "" : kind);
            o.put("action", action == null ? "" : action);
            o.put("text", text == null ? "" : text);
            o.put("at", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        if (!KeepAlivePlugin.deliver(o)) {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            try {
                JSONArray q = new JSONArray(p.getString("queue", "[]"));
                q.put(o);
                p.edit().putString("queue", q.toString()).apply();
            } catch (Exception ignored) {
            }
        }
        // show what happened instead of the buttons
        GenerationService.channels(ctx);
        String shown = text != null && !text.isEmpty() ? "You: " + text : "You chose: " + action;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, GenerationService.CH_DONE)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "Chronicle")
                .setContentText(shown)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setTimeoutAfter(text != null ? 0 : 8000)
                .setContentIntent(GenerationService.openApp(ctx, "chronicle://open?conv=" + android.net.Uri.encode(id == null ? "" : id), nid));
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(nid, b.build());
        } catch (SecurityException ignored) {
        }
    }
}
