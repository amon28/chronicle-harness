package dev.chronicle.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A proximity alert of a place trigger fired (GeofencePlugin): "entered" or "left". The first answer just after an
 * alert was set (Android tells where the phone already is) only records the state; after that, a change of state that
 * the trigger asked for ("arrive" = entered, "leave" = left) becomes a trigger event (Triggers.fire).
 */
public class GeofenceReceiver extends BroadcastReceiver {
    static final long GRACE_MS = 120_000L;

    @Override
    public void onReceive(Context c, Intent intent) {
        if (intent == null || !GeofencePlugin.ACTION.equals(intent.getAction()) || !intent.hasExtra(LocationManager.KEY_PROXIMITY_ENTERING)) return;
        Uri u = intent.getData();
        String id = u == null ? "" : u.getSchemeSpecificPart();
        if (id == null || id.isEmpty()) return;
        boolean entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false);
        SharedPreferences p = c.getSharedPreferences(GeofencePlugin.PREFS, Context.MODE_PRIVATE);
        JSONObject place = null;
        JSONArray places = Triggers.arr(p.getString("places", "[]"));
        for (int i = 0; i < places.length(); i++) {
            JSONObject o = places.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) place = o;
        }
        if (place == null) return; // cancelled meanwhile
        try {
            JSONObject state = Triggers.obj(p.getString("state", "{}"));
            boolean known = state.has(id);
            boolean wasInside = state.optBoolean(id, false);
            state.put(id, entering);
            p.edit().putString("state", state.toString()).apply();
            long since = Triggers.obj(p.getString("since", "{}")).optLong(id, 0);
            if (System.currentTimeMillis() - since < GRACE_MS) return; // where the phone was when the alert was set
            if (known && wasInside == entering) return; // no change
            String on = place.optString("on", "arrive");
            if (("arrive".equals(on) && !entering) || ("leave".equals(on) && entering)) return;
            String label = place.optString("label", "a place");
            JSONObject ev = new JSONObject();
            ev.put("kind", "place");
            ev.put("taskId", id);
            ev.put("convId", place.optString("convId"));
            ev.put("at", System.currentTimeMillis());
            ev.put("on", on);
            Triggers.fire(c, ev, "📍 " + label, (entering ? "You arrived at " : "You left ") + label + " – open Chronicle to run its task.");
        } catch (Exception ignored) {
        }
    }
}
