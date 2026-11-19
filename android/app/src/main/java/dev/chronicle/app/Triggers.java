package dev.chronicle.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Trigger events (a matching notification, arriving at / leaving a place) waiting for the page, and the wake-up that
 * brings them there. An event is kept here (at most MAX_EVENTS, the oldest dropped), then WakeReceiver gets an explicit
 * broadcast with one due item: a running page is woken ("wake" event, it then takes the events), a closed app gets a
 * notification that opens the chat – exactly as for an alarm. At most PER_HOUR events per task an hour: the rest are
 * dropped here, before anything is woken. The page applies the same limit again (src/triggers.js).
 */
final class Triggers {
    private Triggers() {}

    static final String PREFS = "ocm_triggers";
    static final String ACTION = "dev.chronicle.app.TRIGGER";
    static final int PER_HOUR = 6;
    static final int MAX_EVENTS = 30;

    static JSONObject obj(String s) {
        try {
            return new JSONObject(s == null ? "{}" : s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static JSONArray arr(String s) {
        try {
            return new JSONArray(s == null ? "[]" : s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static String clip(CharSequence s, int n) {
        String t = s == null ? "" : s.toString().replaceAll("\\s+", " ").trim();
        return t.length() > n ? t.substring(0, n - 1) + "…" : t;
    }

    /** Keep the event and wake the page. false = this task already fired PER_HOUR times in the last hour. */
    static synchronized boolean fire(Context c, JSONObject ev, String title, String body) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        String task = ev.optString("taskId", "");
        JSONObject fired = obj(p.getString("fired", "{}"));
        JSONObject keep = new JSONObject();
        int recent = 0;
        try {
            java.util.Iterator<String> it = fired.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONArray times = fired.optJSONArray(k);
                JSONArray left = new JSONArray();
                for (int i = 0; times != null && i < times.length(); i++) if (now - times.optLong(i) < 3600_000L) left.put(times.optLong(i));
                if (k.equals(task)) recent = left.length();
                if (left.length() > 0) keep.put(k, left);
            }
            if (recent >= PER_HOUR) {
                p.edit().putString("fired", keep.toString()).commit();
                return false;
            }
            JSONArray mine = keep.optJSONArray(task);
            if (mine == null) mine = new JSONArray();
            mine.put(now);
            keep.put(task, mine);
            JSONArray events = arr(p.getString("events", "[]"));
            JSONArray out = new JSONArray();
            for (int i = Math.max(0, events.length() - (MAX_EVENTS - 1)); i < events.length(); i++) out.put(events.opt(i));
            out.put(ev);
            // commit, not apply: the process may be gone a moment later
            p.edit().putString("fired", keep.toString()).putString("events", out.toString()).commit();

            JSONObject due = new JSONObject();
            due.put("at", now);
            due.put("convId", ev.optString("convId", ""));
            due.put("kind", "trigger");
            due.put("title", title);
            due.put("body", body);
            Intent i = new Intent(c, WakeReceiver.class).setAction(ACTION).putExtra("due", new JSONArray().put(due).toString());
            c.sendBroadcast(i);
        } catch (Exception e) {
            return false;
        }
        return true;
    }

    /** The due items of a trigger broadcast (for WakeReceiver). */
    static JSONArray dueFrom(Intent i) {
        return arr(i == null ? null : i.getStringExtra("due"));
    }

    /** Take (and forget) the waiting events of one kind: "notification" or "place". */
    static synchronized JSONArray take(Context c, String kind) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray events = arr(p.getString("events", "[]"));
        JSONArray mine = new JSONArray();
        JSONArray rest = new JSONArray();
        for (int i = 0; i < events.length(); i++) {
            JSONObject o = events.optJSONObject(i);
            if (o == null) continue;
            if (kind.equals(o.optString("kind"))) mine.put(o);
            else rest.put(o);
        }
        if (mine.length() > 0) p.edit().putString("events", rest.toString()).commit();
        return mine;
    }

    /** Forget the waiting events of one kind (its switch was turned off). */
    static void drop(Context c, String kind) {
        take(c, kind);
    }
}
