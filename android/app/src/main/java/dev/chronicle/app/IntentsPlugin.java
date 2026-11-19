package dev.chronicle.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/**
 * Hands something to another app (android_intent). Only the actions below can be started, every one of them
 * opens an app for the user to finish, and the JavaScript side asks the user before each call.
 */
@CapacitorPlugin(name = "Intents")
public class IntentsPlugin extends Plugin {
    private static final Set<String> ACTIONS = new HashSet<>(Arrays.asList(
            Intent.ACTION_VIEW, Intent.ACTION_DIAL, Intent.ACTION_SENDTO, Intent.ACTION_INSERT, Intent.ACTION_SEND,
            "android.intent.action.SET_ALARM", "android.intent.action.SET_TIMER",
            "android.settings.WIFI_SETTINGS", "android.settings.BLUETOOTH_SETTINGS", "android.settings.DISPLAY_SETTINGS",
            "android.settings.SOUND_SETTINGS", "android.intent.action.POWER_USAGE_SUMMARY", "android.settings.LOCATION_SOURCE_SETTINGS",
            "android.settings.ALL_APPS_NOTIFICATION_SETTINGS", "android.settings.APPLICATION_SETTINGS", "android.settings.DATE_SETTINGS",
            "android.settings.LOCALE_SETTINGS", "android.settings.ACCESSIBILITY_SETTINGS", "android.settings.INTERNAL_STORAGE_SETTINGS",
            "android.settings.APPLICATION_DETAILS_SETTINGS"));

    /** The apps you can open (launcher apps): [{ name, package }], filtered by a query on either. */
    @PluginMethod
    public void apps(PluginCall call) {
        String q = call.getString("query", "").toLowerCase(java.util.Locale.ROOT).trim();
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        java.util.List<android.content.pm.ResolveInfo> list = pm.queryIntentActivities(main, 0);
        java.util.TreeMap<String, String> found = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (android.content.pm.ResolveInfo r : list) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(getContext().getPackageName())) continue;
            String name = String.valueOf(r.loadLabel(pm));
            if (!q.isEmpty() && !name.toLowerCase(java.util.Locale.ROOT).contains(q) && !pkg.toLowerCase(java.util.Locale.ROOT).contains(q)) continue;
            found.put(name + "\u0000" + pkg, pkg);
        }
        // all: also the apps without an icon in the launcher (services, keyboards, system parts) – QUERY_ALL_PACKAGES
        if (Boolean.TRUE.equals(call.getBoolean("all", false))) {
            for (android.content.pm.ApplicationInfo ai : pm.getInstalledApplications(0)) {
                if (ai.packageName.equals(getContext().getPackageName()) || found.containsValue(ai.packageName)) continue;
                String name = String.valueOf(ai.loadLabel(pm));
                if (!q.isEmpty() && !name.toLowerCase(java.util.Locale.ROOT).contains(q) && !ai.packageName.toLowerCase(java.util.Locale.ROOT).contains(q)) continue;
                found.put(name + "\u0000" + ai.packageName, ai.packageName);
            }
        }
        com.getcapacitor.JSArray out = new com.getcapacitor.JSArray();
        for (String k : found.keySet()) {
            JSObject o = new JSObject();
            o.put("name", k.substring(0, k.indexOf('\u0000')));
            o.put("package", found.get(k));
            out.put(o);
            if (out.length() >= 300) break;
        }
        JSObject r = new JSObject();
        r.put("apps", out);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Intent i;
            String launch = call.getString("launch");
            if (launch != null) {
                i = getContext().getPackageManager().getLaunchIntentForPackage(launch);
                if (i == null) {
                    call.reject("No app " + launch + " is installed (no app can open it)");
                    return;
                }
            } else {
                String action = call.getString("action", "");
                if (!ACTIONS.contains(action)) {
                    call.reject("That kind of intent is not allowed");
                    return;
                }
                i = new Intent(action);
                String data = call.getString("data");
                if (data != null) {
                    if ("package:self".equals(data)) data = "package:" + getContext().getPackageName();
                    Uri u = Uri.parse(data);
                    String sch = u.getScheme() == null ? "" : u.getScheme();
                    // VIEW only for web pages and the map (a place, or directions to one); nothing that reaches into files or other apps' content
                    if (Intent.ACTION_VIEW.equals(action) && !(sch.equals("http") || sch.equals("https") || sch.equals("geo") || sch.equals("google.navigation"))) {
                        call.reject("That address is not allowed");
                        return;
                    }
                    if (Intent.ACTION_INSERT.equals(action) && !data.equals("content://com.android.calendar/events")) {
                        call.reject("That address is not allowed");
                        return;
                    }
                    String type = call.getString("type");
                    if (type != null) i.setDataAndType(u, type);
                    else i.setData(u);
                } else if (call.getString("type") != null) i.setType(call.getString("type"));
                JSObject ex = call.getObject("extras", new JSObject());
                for (Iterator<String> it = ex.keys(); it.hasNext(); ) {
                    String k = it.next();
                    Object v = ex.opt(k);
                    if (v instanceof Boolean) i.putExtra(k, (Boolean) v);
                    else if (v instanceof Integer) i.putExtra(k, (Integer) v);
                    else if (v instanceof Long) i.putExtra(k, (Long) v);
                    else if (v instanceof Double) {
                        double d = (Double) v; // a whole number stays a long (alarm hours, minutes), a fraction stays a double
                        if (d == Math.rint(d) && Math.abs(d) < 9e15) i.putExtra(k, (long) d);
                        else i.putExtra(k, d);
                    }
                    else if (v != null) i.putExtra(k, String.valueOf(v));
                }
                if (Boolean.TRUE.equals(call.getBoolean("chooser", false))) i = Intent.createChooser(i, null);
            }
            // in the background Android does not let it open (and says nothing): a notification waits for a tap instead
            boolean opened = Launch.startOrNotify(getActivity(), getContext(), i, call.getString("title", "Chronicle has something to open"));
            JSObject r = new JSObject();
            r.put("opened", opened);
            r.put("notified", !opened);
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can do that");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }
}
