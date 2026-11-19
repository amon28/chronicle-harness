package dev.chronicle.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/** Home-screen widget: "New chat" opens a fresh chat with the keyboard up; 🎤 opens it and starts listening. */
public class QuickWidget extends AppWidgetProvider {
    private PendingIntent open(Context c, String uri, int code) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
        i.setClass(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_quick);
            v.setOnClickPendingIntent(R.id.widget_new, open(context, "chronicle://new?focus=1", 1));
            v.setOnClickPendingIntent(R.id.widget_voice, open(context, "chronicle://new?voice=1", 2));
            mgr.updateAppWidget(id, v);
        }
    }
}
