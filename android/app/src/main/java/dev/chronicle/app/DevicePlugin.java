package dev.chronicle.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Locale;
import java.util.TimeZone;

/**
 * The phone's own data for the assistant's tools – the calendar, contacts and location – and the switches that let
 * it work longer and wider: no battery limits, and all of the phone's storage for the Linux shell.
 *
 * Each needs Android's own permission, asked the first time it is used (the user can say no, or allow only an
 * approximate location). The JS side asks the user in the chat as well, before the assistant sees any of it.
 * The app is not on the Play Store, so permissions Play restricts (all files, no battery optimisation) are fine.
 */
@CapacitorPlugin(
    name = "Device",
    permissions = {
        @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    }
)
public class DevicePlugin extends Plugin {

    // ---------- what is allowed ----------

    static boolean allFiles() {
        return Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager();
    }

    private boolean batteryFree() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("calendar", getPermissionState("calendar").toString());
        r.put("contacts", getPermissionState("contacts").toString());
        r.put("location", has("location") ? "granted" : getPermissionState("location").toString());
        r.put("preciseLocation", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        r.put("batteryFree", batteryFree());
        r.put("allFiles", allFiles());
        r.put("allFilesPossible", Build.VERSION.SDK_INT >= 30);
        call.resolve(r);
    }

    private boolean granted(String p) {
        return androidx.core.content.ContextCompat.checkSelfPermission(getContext(), p) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** Android's "let this app run in the background without limits" question. */
    @PluginMethod
    public void askBattery(PluginCall call) {
        JSObject r = new JSObject();
        if (batteryFree()) {
            r.put("batteryFree", true);
            call.resolve(r);
            return;
        }
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
        try {
            Launch.startOrNotify(getActivity(), getContext(), i, "Let Chronicle run without battery limits");
        } catch (Exception e) {
            // some phones hide the direct question: the list of apps instead
            Launch.startOrNotify(getActivity(), getContext(), new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), "Let Chronicle run without battery limits");
        }
        r.put("batteryFree", false);
        call.resolve(r);
    }

    /** The "All files access" switch for this app (Android 11+): the Linux shell then sees the phone's storage at /sdcard. */
    @PluginMethod
    public void askAllFiles(PluginCall call) {
        JSObject r = new JSObject();
        if (Build.VERSION.SDK_INT < 30 || allFiles()) {
            r.put("allFiles", allFiles());
            call.resolve(r);
            return;
        }
        Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        try {
            Launch.startOrNotify(getActivity(), getContext(), i, "Give Chronicle's shell all files access");
        } catch (Exception e) {
            Launch.startOrNotify(getActivity(), getContext(), new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "Give Chronicle's shell all files access");
        }
        r.put("allFiles", false);
        call.resolve(r);
    }

    // ---------- permission plumbing: ask, then run the call again ----------

    /** true = go on; false = Android is asking now (the call is run again with the answer) or said no. */
    private boolean has(String alias) {
        // location: an approximate location is a yes (the user may keep the precise one for themselves)
        if ("location".equals(alias)) return granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION);
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    /** The call Android's permission question is open for, and the calls that came in meanwhile (asked one at a time). */
    private PluginCall asking;
    private final java.util.ArrayDeque<PluginCall> waiting = new java.util.ArrayDeque<>();

    private boolean need(PluginCall call, String alias) {
        if (has(alias)) return true;
        synchronized (waiting) {
            // Android takes one permission question at a time: a second one while the first is open comes straight
            // back as "not answered", and the answers would go to the wrong calls. The others wait for this one.
            if (asking != null) {
                waiting.add(call);
                return false;
            }
            // the question can only be shown over the app: asked from the background Android drops it, and the call
            // would hang until the user comes back and then be told "refused" although nobody was asked
            if (!Launch.inFront(getActivity())) {
                call.reject("Android can only ask for the " + alias + " permission while Chronicle is on screen. Ask the user to open Chronicle, then try again.", "BACKGROUND");
                return false;
            }
            asking = call;
        }
        // asked every time it is missing: after "don't ask again" Android answers no at once, without a prompt; a
        // prompt that was only dismissed is shown again (the stored "denied" state cannot tell the two apart)
        requestPermissionForAlias(alias, call, "answered");
        return false;
    }

    private static String aliasOf(PluginCall call) {
        String m = call.getMethodName();
        return "calendars".equals(m) || "events".equals(m) || "addEvent".equals(m) ? "calendar" : "contacts".equals(m) ? "contacts" : "location";
    }

    /** Run a call again from the start (it checks its permission again). */
    private void again(PluginCall call) {
        String m = call.getMethodName();
        if ("calendars".equals(m)) calendars(call);
        else if ("events".equals(m)) events(call);
        else if ("addEvent".equals(m)) addEvent(call);
        else if ("contacts".equals(m)) contacts(call);
        else location(call);
    }

    @PermissionCallback
    private void answered(PluginCall saved) {
        final PluginCall call;
        final java.util.List<PluginCall> next;
        synchronized (waiting) {
            call = saved != null ? saved : asking;
            asking = null;
            next = new java.util.ArrayList<>(waiting);
            waiting.clear();
        }
        if (call != null) {
            String alias = aliasOf(call);
            if (!has(alias)) {
                boolean forGood = getPermissionState(alias) == PermissionState.DENIED;
                call.reject(forGood
                    ? "Android does not allow Chronicle to use the " + alias + " (it was refused). The user can allow it in Settings › Apps › Chronicle › Permissions."
                    : "The user did not allow the " + alias + ".", "DENIED");
            } else {
                again(call);
            }
        }
        for (PluginCall c : next) {
            try {
                again(c);
            } catch (Exception e) {
                c.reject(String.valueOf(e.getMessage()));
            }
        }
    }

    // ---------- calendar ----------

    @PluginMethod
    public void calendars(PluginCall call) {
        if (!need(call, "calendar")) return;
        new Thread(() -> {
            try {
                JSArray out = new JSArray();
                String[] cols = { CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.IS_PRIMARY, CalendarContract.Calendars.VISIBLE };
                try (Cursor c = getContext().getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, cols, null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        JSObject o = new JSObject();
                        o.put("id", c.getLong(0));
                        o.put("name", c.getString(1));
                        o.put("account", c.getString(2));
                        o.put("writable", c.getInt(3) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR);
                        o.put("primary", c.getInt(4) == 1);
                        o.put("visible", c.getInt(5) == 1);
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("calendars", out);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** Events between from and to (ms), repeats included, optionally only those whose title, place or notes contain query. */
    @PluginMethod
    public void events(PluginCall call) {
        if (!need(call, "calendar")) return;
        final long now = System.currentTimeMillis();
        final long from = Args.whole(call, "from", now);
        final long to = Math.min(Args.whole(call, "to", now + 7L * 86400000L), from + 366L * 86400000L);
        final String q = call.getString("query", "").toLowerCase(Locale.ROOT).trim();
        final int limit = Math.max(1, Math.min(200, call.getInt("limit", 50)));
        new Thread(() -> {
            try {
                Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
                android.content.ContentUris.appendId(b, from);
                android.content.ContentUris.appendId(b, to);
                String[] cols = { CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.CALENDAR_DISPLAY_NAME };
                JSArray out = new JSArray();
                // only calendars shown in the phone's calendar app: a hidden one (a subscribed holiday list, a colleague's) is not the user's plan
                try (Cursor c = getContext().getContentResolver().query(b.build(), cols, CalendarContract.Instances.VISIBLE + " = 1", null, CalendarContract.Instances.BEGIN + " ASC")) {
                    while (c != null && c.moveToNext() && out.length() < limit) {
                        String title = c.getString(1) == null ? "" : c.getString(1);
                        String place = c.getString(5) == null ? "" : c.getString(5);
                        String notes = c.getString(6) == null ? "" : c.getString(6);
                        if (!q.isEmpty() && !(title + "\n" + place + "\n" + notes).toLowerCase(Locale.ROOT).contains(q)) continue;
                        JSObject o = new JSObject();
                        o.put("id", c.getLong(0));
                        o.put("title", title);
                        o.put("start", c.getLong(2));
                        o.put("end", c.getLong(3));
                        o.put("allDay", c.getInt(4) == 1);
                        o.put("location", place);
                        o.put("notes", notes.length() > 500 ? notes.substring(0, 500) + "…" : notes);
                        o.put("calendar", c.getString(7));
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("events", out);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** A new event in a writable calendar (the primary one unless calendarId says which). → { id, calendar } */
    @PluginMethod
    public void addEvent(PluginCall call) {
        if (!need(call, "calendar")) return;
        final String title = call.getString("title", "").trim();
        final Long start = Args.whole(call, "start");
        if (title.isEmpty() || start == null) {
            call.reject("title and start are required");
            return;
        }
        final boolean allDay = Boolean.TRUE.equals(call.getBoolean("allDay", false));
        final long end = Args.whole(call, "end", start + (allDay ? 86400000L : 3600000L));
        final Long want = Args.whole(call, "calendarId"); // (a small number: getLong would answer null and the main calendar be used)
        final Long remind = Args.whole(call, "reminderMinutes");
        new Thread(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                long cal = -1;
                String calName = "";
                String[] cols = { CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.IS_PRIMARY };
                try (Cursor c = cr.query(CalendarContract.Calendars.CONTENT_URI, cols, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + " >= ? AND " + CalendarContract.Calendars.VISIBLE + " = 1", new String[] { String.valueOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) }, null)) {
                    while (c != null && c.moveToNext()) {
                        long id = c.getLong(0);
                        if (want != null ? id == want : (cal < 0 || c.getInt(2) == 1)) {
                            cal = id;
                            calName = c.getString(1);
                            if (want != null || c.getInt(2) == 1) break;
                        }
                    }
                }
                if (cal < 0) {
                    call.reject(want != null ? "That calendar cannot be written to (or does not exist)" : "There is no calendar on this phone that can be written to");
                    return;
                }
                ContentValues v = new ContentValues();
                v.put(CalendarContract.Events.CALENDAR_ID, cal);
                v.put(CalendarContract.Events.TITLE, title);
                v.put(CalendarContract.Events.DESCRIPTION, call.getString("notes", ""));
                v.put(CalendarContract.Events.EVENT_LOCATION, call.getString("location", ""));
                if (allDay) {
                    // all-day events are stored at midnight UTC of their days
                    v.put(CalendarContract.Events.DTSTART, utcMidnight(start));
                    v.put(CalendarContract.Events.DTEND, Math.max(utcMidnight(end), utcMidnight(start) + 86400000L));
                    v.put(CalendarContract.Events.ALL_DAY, 1);
                    v.put(CalendarContract.Events.EVENT_TIMEZONE, "UTC");
                } else {
                    v.put(CalendarContract.Events.DTSTART, start);
                    v.put(CalendarContract.Events.DTEND, Math.max(end, start));
                    v.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
                }
                Uri u = cr.insert(CalendarContract.Events.CONTENT_URI, v);
                if (u == null) throw new Exception("The calendar did not take the event");
                long id = Long.parseLong(u.getLastPathSegment());
                if (remind != null && remind >= 0) {
                    ContentValues rv = new ContentValues();
                    rv.put(CalendarContract.Reminders.EVENT_ID, id);
                    rv.put(CalendarContract.Reminders.MINUTES, (int) Math.min(remind, 40320L));
                    rv.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
                    cr.insert(CalendarContract.Reminders.CONTENT_URI, rv);
                }
                JSObject r = new JSObject();
                r.put("id", id);
                r.put("calendar", calName);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** The local date of t, as midnight UTC (how Android stores all-day events). */
    private static long utcMidnight(long t) {
        java.util.Calendar local = java.util.Calendar.getInstance();
        local.setTimeInMillis(t);
        java.util.Calendar u = java.util.Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        u.clear();
        u.set(local.get(java.util.Calendar.YEAR), local.get(java.util.Calendar.MONTH), local.get(java.util.Calendar.DAY_OF_MONTH));
        return u.getTimeInMillis();
    }

    // ---------- contacts (read only) ----------

    @PluginMethod
    public void contacts(PluginCall call) {
        if (!need(call, "contacts")) return;
        final String q = call.getString("query", "").trim();
        final int limit = Math.max(1, Math.min(50, call.getInt("limit", 20)));
        new Thread(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                Uri base = q.isEmpty() ? ContactsContract.Contacts.CONTENT_URI : Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(q));
                JSArray out = new JSArray();
                String[] cols = { ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY };
                try (Cursor c = cr.query(base, cols, null, null, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY + " ASC")) {
                    while (c != null && c.moveToNext() && out.length() < limit) {
                        long id = c.getLong(0);
                        JSObject o = new JSObject();
                        o.put("name", c.getString(1));
                        JSArray phones = new JSArray();
                        JSArray emails = new JSArray();
                        String[] dc = { ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1, ContactsContract.Data.DATA2, ContactsContract.Data.DATA3 };
                        try (Cursor d = cr.query(ContactsContract.Data.CONTENT_URI, dc, ContactsContract.Data.CONTACT_ID + " = ? AND " + ContactsContract.Data.MIMETYPE + " IN (?, ?)", new String[] { String.valueOf(id), ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE }, null)) {
                            while (d != null && d.moveToNext()) {
                                boolean phone = ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(d.getString(0));
                                String value = d.getString(1);
                                if (value == null || value.isEmpty()) continue;
                                int type = d.isNull(2) ? 0 : d.getInt(2);
                                CharSequence label = phone
                                    ? ContactsContract.CommonDataKinds.Phone.getTypeLabel(getContext().getResources(), type, d.getString(3))
                                    : ContactsContract.CommonDataKinds.Email.getTypeLabel(getContext().getResources(), type, d.getString(3));
                                JSObject e = new JSObject();
                                e.put("value", value);
                                e.put("label", String.valueOf(label));
                                (phone ? phones : emails).put(e);
                            }
                        }
                        o.put("phones", phones);
                        o.put("emails", emails);
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("contacts", out);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    // ---------- location ----------

    /** Where the phone is now: { lat, lon, accuracy (m), provider, time, precise, address? }. Waits up to 30 s for a fix. */
    @PluginMethod
    public void location(PluginCall call) {
        if (!need(call, "location")) return;
        final boolean fine = granted(Manifest.permission.ACCESS_FINE_LOCATION);
        final boolean precise = fine && Boolean.TRUE.equals(call.getBoolean("precise", false));
        final LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.reject("This phone has no location service");
            return;
        }
        if (Build.VERSION.SDK_INT >= 28 && !lm.isLocationEnabled()) {
            call.reject("Location is switched off on the phone (quick settings › Location)", "OFF");
            return;
        }
        String provider = precise && lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER
            : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER
            : (fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) ? LocationManager.GPS_PROVIDER
            : (Build.VERSION.SDK_INT >= 31 && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) ? LocationManager.FUSED_PROVIDER : null;
        if (provider == null) {
            call.reject("No location source is on (no network location, and GPS is off or not allowed)");
            return;
        }
        // approximate: a fix any source had in the last 10 minutes is the answer at once (the owner's harness report: an
        // approximate location took ~21 s waiting for a fresh fix that is then rounded to 1 km anyway)
        if (!precise) {
            Location recent = null;
            try {
                for (String q : lm.getProviders(true)) {
                    Location l = lm.getLastKnownLocation(q);
                    if (l != null && (recent == null || l.getTime() > recent.getTime())) recent = l;
                }
            } catch (SecurityException ignored) {
            }
            if (recent != null && System.currentTimeMillis() - recent.getTime() < 10 * 60 * 1000L) {
                final Location l = recent;
                new Thread(() -> call.resolve(describe(l, false))).start();
                return;
            }
        }
        final String p = provider;
        final java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean(false);
        final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        final android.os.CancellationSignal cancel = new android.os.CancellationSignal();
        final android.location.LocationListener[] listening = { null }; // below Android 11: taken off again, or GPS stays on
        final Runnable[] timeout = { null };
        final java.util.function.Consumer<Location> answer = (loc) -> {
            if (!done.compareAndSet(false, true)) return;
            cancel.cancel();
            if (timeout[0] != null) main.removeCallbacks(timeout[0]);
            if (listening[0] != null) {
                try {
                    lm.removeUpdates(listening[0]);
                } catch (Exception ignored) {
                }
            }
            if (loc == null) {
                // nothing fresh: the last fix any source had, if it is not too old
                Location last = null;
                try {
                    for (String q : lm.getProviders(true)) {
                        Location l = lm.getLastKnownLocation(q);
                        if (l != null && (last == null || l.getTime() > last.getTime())) last = l;
                    }
                } catch (SecurityException ignored) {
                }
                if (last == null) {
                    // in the background Android gives no location at all (the app has no background-location permission)
                    call.reject(Launch.inFront(getActivity())
                        ? "No location fix within 30 s (indoors? try again near a window, or with precise location)"
                        : "Android gives the location only while Chronicle is on screen. Ask the user to open Chronicle, then try again.");
                    return;
                }
                loc = last;
            }
            final Location l = loc;
            new Thread(() -> call.resolve(describe(l, precise))).start();
        };
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(p, cancel, getContext().getMainExecutor(), answer::accept);
            } else {
                listening[0] = new android.location.LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        answer.accept(location);
                    }
                    @Override
                    public void onStatusChanged(String s, int i, android.os.Bundle b) {}
                    @Override
                    public void onProviderEnabled(String s) {}
                    @Override
                    public void onProviderDisabled(String s) {}
                };
                lm.requestSingleUpdate(p, listening[0], android.os.Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            call.reject("Location is not allowed", "DENIED");
            return;
        }
        timeout[0] = () -> answer.accept(null);
        main.postDelayed(timeout[0], 30000);
    }

    private JSObject describe(Location l, boolean precise) {
        JSObject r = new JSObject();
        // an approximate answer is rounded (about 1 km), so it says no more than the user allowed
        double lat = precise ? l.getLatitude() : Math.round(l.getLatitude() * 100) / 100.0;
        double lon = precise ? l.getLongitude() : Math.round(l.getLongitude() * 100) / 100.0;
        r.put("lat", lat);
        r.put("lon", lon);
        r.put("accuracy", Math.round(precise ? l.getAccuracy() : Math.max(l.getAccuracy(), 1000)));
        r.put("provider", l.getProvider());
        r.put("time", l.getTime());
        r.put("precise", precise);
        try {
            if (android.location.Geocoder.isPresent()) {
                // the place name needs the network: at most 4 s, the coordinates are the answer without it
                java.util.concurrent.FutureTask<java.util.List<android.location.Address>> look = new java.util.concurrent.FutureTask<>(() -> {
                    @SuppressWarnings("deprecation")
                    java.util.List<android.location.Address> found = new android.location.Geocoder(getContext(), Locale.getDefault()).getFromLocation(l.getLatitude(), l.getLongitude(), 1);
                    return found;
                });
                new Thread(look).start();
                java.util.List<android.location.Address> a;
                try {
                    a = look.get(4, java.util.concurrent.TimeUnit.SECONDS);
                } catch (java.util.concurrent.TimeoutException te) {
                    look.cancel(true);
                    a = null;
                }
                if (a != null && !a.isEmpty()) {
                    android.location.Address ad = a.get(0);
                    StringBuilder s = new StringBuilder();
                    if (precise && ad.getMaxAddressLineIndex() >= 0) s.append(ad.getAddressLine(0));
                    else {
                        for (String part : new String[] { ad.getSubLocality(), ad.getLocality(), ad.getAdminArea(), ad.getCountryName() }) {
                            if (part != null && !part.isEmpty() && s.indexOf(part) < 0) s.append(s.length() > 0 ? ", " : "").append(part);
                        }
                    }
                    if (s.length() > 0) r.put("address", s.toString());
                }
            }
        } catch (Exception ignored) {
            // no geocoder service or no network: the coordinates are still the answer
        }
        return r;
    }
}
