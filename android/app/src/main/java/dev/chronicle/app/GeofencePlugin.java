package dev.chronicle.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Place triggers (schedule_task when place): Android's own proximity alerts (LocationManager.addProximityAlert – no
 * Google Play services). Each place gets an alert with a PendingIntent to GeofenceReceiver, which turns "entered" /
 * "left" into a trigger event (Triggers.fire). The alerts do not survive a restart or an update, so WakeReceiver calls
 * rearm() then, and the page hands over the list again at every start (sync).
 *
 * addProximityAlert needs ACCESS_FINE_LOCATION; for it to keep working with the app in the background Android 10+ also
 * needs ACCESS_BACKGROUND_LOCATION, which is asked for on its own, after the foreground location: on Android 10 in a
 * dialog ("Allow all the time"), on 11+ the system shows the app's location settings page instead.
 */
@CapacitorPlugin(
    name = "Geofence",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "background", strings = { "android.permission.ACCESS_BACKGROUND_LOCATION" }),
    }
)
public class GeofencePlugin extends Plugin {
    static final String PREFS = "ocm_geofence";
    static final String ACTION = "dev.chronicle.app.PLACE";
    static final int MAX = 10;

    static boolean granted(Context c, String p) {
        return ContextCompat.checkSelfPermission(c, p) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean background(Context c) {
        return Build.VERSION.SDK_INT < 29 ? granted(c, Manifest.permission.ACCESS_FINE_LOCATION) : granted(c, "android.permission.ACCESS_BACKGROUND_LOCATION");
    }

    static PendingIntent pending(Context c, String id) {
        Intent i = new Intent(c, GeofenceReceiver.class).setAction(ACTION).setData(Uri.fromParts("ocmplace", id, null));
        // mutable: LocationManager adds KEY_PROXIMITY_ENTERING to it (an immutable one would arrive without it); the
        // intent names our receiver, so nobody else can redirect it
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(c, ("place:" + id).hashCode(), i, flags);
    }

    /** Remove every alert set before and set one per stored place. → how many are armed. */
    static synchronized int rearm(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return 0;
        JSONArray old = Triggers.arr(p.getString("armed", "[]"));
        for (int i = 0; i < old.length(); i++) {
            try {
                lm.removeProximityAlert(pending(c, old.optString(i)));
            } catch (Exception ignored) {
            }
        }
        JSONArray places = Triggers.arr(p.getString("places", "[]"));
        JSONArray armed = new JSONArray();
        JSONObject since = new JSONObject();
        String error = "";
        long now = System.currentTimeMillis();
        if (places.length() > 0 && !granted(c, Manifest.permission.ACCESS_FINE_LOCATION)) error = "no precise location";
        else {
            for (int i = 0; i < places.length() && armed.length() < MAX; i++) {
                JSONObject o = places.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id");
                try {
                    lm.addProximityAlert(o.optDouble("lat"), o.optDouble("lon"), (float) Math.max(100, o.optDouble("radius", 200)), -1, pending(c, id));
                    armed.put(id);
                    since.put(id, now);
                } catch (SecurityException e) {
                    error = "not allowed";
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                }
            }
        }
        p.edit().putString("armed", armed.toString()).putString("since", since.toString()).putString("error", error).apply();
        return armed.length();
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("fine", granted(c, Manifest.permission.ACCESS_FINE_LOCATION));
        r.put("coarse", granted(c, Manifest.permission.ACCESS_COARSE_LOCATION));
        r.put("background", background(c));
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        if (lm != null && Build.VERSION.SDK_INT >= 28) r.put("locationOn", lm.isLocationEnabled());
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                r.put("label", String.valueOf(c.getPackageManager().getBackgroundPermissionOptionLabel()));
            } catch (Exception ignored) {
            }
        }
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        r.put("armed", Triggers.arr(p.getString("armed", "[]")).length());
        r.put("error", p.getString("error", ""));
        call.resolve(r);
    }

    /** Precise location first (a dialog), then "Allow all the time": a dialog on Android 10, the settings page on 11+. */
    @PluginMethod
    public void askBackground(PluginCall call) {
        if (background(getContext())) {
            done(call);
            return;
        }
        if (!Launch.inFront(getActivity())) {
            call.reject("Android can only ask while Chronicle is on screen.", "BACKGROUND");
            return;
        }
        if (!granted(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)) requestPermissionForAlias("location", call, "foregroundAnswered");
        else requestPermissionForAlias("background", call, "backgroundAnswered");
    }

    @PermissionCallback
    private void foregroundAnswered(PluginCall call) {
        if (call == null) return;
        if (!granted(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)) {
            done(call); // the user kept precise location for themselves: status says so
            return;
        }
        if (background(getContext()) || !Launch.inFront(getActivity())) {
            done(call); // (before Android 10 the foreground location is all there is)
            return;
        }
        // asked separately, after the foreground location – Android ignores it when asked together
        requestPermissionForAlias("background", call, "backgroundAnswered");
    }

    @PermissionCallback
    private void backgroundAnswered(PluginCall call) {
        if (call == null) return;
        if (background(getContext())) rearm(getContext());
        done(call);
    }

    private void done(PluginCall call) {
        JSObject r = new JSObject();
        r.put("fine", granted(getContext(), Manifest.permission.ACCESS_FINE_LOCATION));
        r.put("background", background(getContext()));
        call.resolve(r);
    }

    /** App info: Permissions › Location, when Android no longer shows its question (refused twice). */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        JSObject r = new JSObject();
        r.put("opened", Launch.startOrNotify(getActivity(), getContext(), i, "Chronicle's App info"));
        call.resolve(r);
    }

    /** Replace the places: [{ id, convId, lat, lon, radius, on, label }] (at most 10), and arm them. */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray in = call.getArray("places", new JSArray());
        JSArray keep = new JSArray();
        for (int i = 0; i < in.length() && keep.length() < MAX; i++) {
            JSONObject o = in.optJSONObject(i);
            if (o != null && o.has("lat") && o.has("lon") && !o.optString("id").isEmpty()) keep.put(o);
        }
        Context c = getContext();
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("places", keep.toString()).commit();
        if (keep.length() == 0) Triggers.drop(c, "place");
        JSObject r = new JSObject();
        r.put("armed", rearm(c));
        r.put("background", background(c));
        call.resolve(r);
    }

    @PluginMethod
    public void takeEvents(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("events", new JSArray(Triggers.take(getContext(), "place").toString()));
        } catch (Exception e) {
            r.put("events", new JSArray());
        }
        call.resolve(r);
    }
}
