package dev.chronicle.app;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.LocationManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.net.Uri;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.telephony.TelephonyManager;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.KeyEvent;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The phone itself for the assistant's tools (phone_status, phone_control, take_photo, android_intent share_file /
 * open_file): what state it is in, a few small switches, a photo from the camera app, and a workspace file handed to
 * another app.
 *
 * Nothing here needs a permission except the Wi-Fi names (Android only gives those with precise location and
 * Location switched on – asked the first time they are wanted). The camera app takes the photo, so there is no
 * CAMERA permission: it must stay undeclared, because an app that declares CAMERA without holding it gets a
 * SecurityException from ACTION_IMAGE_CAPTURE. The JavaScript side asks the user in the chat before anything
 * personal is read or anything is switched.
 *
 * No method touches a view; the ones that need the main thread (clipboard) post to it. Every call is answered once.
 */
@CapacitorPlugin(
    name = "Phone",
    permissions = {
        // both together: from Android 12 a request for the precise location alone is ignored
        @Permission(alias = "wifi", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    }
)
public class PhonePlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());

    private Object service(String name) {
        return getContext().getApplicationContext().getSystemService(name);
    }

    private boolean granted(String p) {
        return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- phone_status ----------

    /** { battery?, thermal?, storage?, memory?, device?, network?, sound?, alarm? } – a part the phone cannot give is left out. */
    @PluginMethod
    public void status(PluginCall call) {
        JSArray want = call.getArray("sections", null);
        java.util.Set<String> only = new java.util.HashSet<>();
        if (want != null) {
            for (int i = 0; i < want.length(); i++) only.add(want.optString(i, ""));
        }
        JSObject r = new JSObject();
        putIf(r, only, "battery", this::battery);
        putIf(r, only, "thermal", this::thermal);
        putIf(r, only, "storage", this::storage);
        putIf(r, only, "memory", this::memory);
        putIf(r, only, "device", this::device);
        putIf(r, only, "network", this::network);
        putIf(r, only, "sound", this::sound);
        putIf(r, only, "alarm", this::alarm);
        call.resolve(r);
    }

    private interface Part {
        JSObject read() throws Exception;
    }

    private static void putIf(JSObject r, java.util.Set<String> only, String key, Part p) {
        if (!only.isEmpty() && !only.contains(key)) return;
        try {
            JSObject o = p.read();
            if (o != null) r.put(key, o);
        } catch (Throwable ignored) {
            // an older Android, a vendor quirk: this part is simply not reported
        }
    }

    private JSObject battery() {
        Intent b = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED)); // sticky: no receiver needed
        if (b == null) return null;
        JSObject o = new JSObject();
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        if (level >= 0 && scale > 0) o.put("percent", Math.round(level * 100f / scale));
        int st = b.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN);
        o.put("status", st == BatteryManager.BATTERY_STATUS_CHARGING ? "charging" : st == BatteryManager.BATTERY_STATUS_DISCHARGING ? "discharging" : st == BatteryManager.BATTERY_STATUS_FULL ? "full" : st == BatteryManager.BATTERY_STATUS_NOT_CHARGING ? "not_charging" : "unknown");
        int plug = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
        o.put("plug", plug == BatteryManager.BATTERY_PLUGGED_AC ? "ac" : plug == BatteryManager.BATTERY_PLUGGED_USB ? "usb" : plug == BatteryManager.BATTERY_PLUGGED_WIRELESS ? "wireless" : plug == 8 /* BATTERY_PLUGGED_DOCK, API 33 */ ? "dock" : "none");
        int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
        if (temp != Integer.MIN_VALUE) o.put("tempC", temp / 10.0);
        int health = b.getIntExtra(BatteryManager.EXTRA_HEALTH, BatteryManager.BATTERY_HEALTH_UNKNOWN);
        o.put("health", health == BatteryManager.BATTERY_HEALTH_GOOD ? "good" : health == BatteryManager.BATTERY_HEALTH_OVERHEAT ? "overheat" : health == BatteryManager.BATTERY_HEALTH_COLD ? "cold" : health == BatteryManager.BATTERY_HEALTH_DEAD ? "dead" : health == BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE ? "over_voltage" : "unknown");
        PowerManager pm = (PowerManager) service(Context.POWER_SERVICE);
        if (pm != null) o.put("powerSave", pm.isPowerSaveMode());
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                BatteryManager bm = (BatteryManager) service(Context.BATTERY_SERVICE);
                long ms = bm == null ? -1 : bm.computeChargeTimeRemaining();
                if (ms > 0) o.put("minutesToFull", Math.round(ms / 60000.0));
            } catch (Throwable ignored) {
            }
        }
        return o;
    }

    private JSObject thermal() {
        if (Build.VERSION.SDK_INT < 29) return null;
        PowerManager pm = (PowerManager) service(Context.POWER_SERVICE);
        if (pm == null) return null;
        int s = pm.getCurrentThermalStatus();
        String[] names = { "none", "light", "moderate", "severe", "critical", "emergency", "shutdown" };
        JSObject o = new JSObject();
        o.put("status", s >= 0 && s < names.length ? names[s] : "none");
        return o;
    }

    private JSObject storage() {
        StatFs fs = new StatFs(Environment.getDataDirectory().getPath());
        JSObject o = new JSObject();
        o.put("freeBytes", fs.getAvailableBytes());
        o.put("totalBytes", fs.getTotalBytes());
        return o;
    }

    private JSObject memory() {
        ActivityManager am = (ActivityManager) service(Context.ACTIVITY_SERVICE);
        if (am == null) return null;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        JSObject o = new JSObject();
        o.put("availBytes", mi.availMem);
        o.put("totalBytes", mi.totalMem);
        o.put("low", mi.lowMemory);
        return o;
    }

    private JSObject device() {
        JSObject o = new JSObject();
        o.put("brand", Build.BRAND);
        o.put("model", Build.MODEL);
        o.put("android", Build.VERSION.RELEASE);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("patch", Build.VERSION.SECURITY_PATCH);
        if (Build.SUPPORTED_ABIS.length > 0) o.put("abi", Build.SUPPORTED_ABIS[0]);
        o.put("locale", Locale.getDefault().toLanguageTag());
        o.put("timezone", TimeZone.getDefault().getID());
        o.put("uptimeMin", SystemClock.elapsedRealtime() / 60000L);
        DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        JSObject sc = new JSObject();
        sc.put("w", dm.widthPixels);
        sc.put("h", dm.heightPixels);
        sc.put("dpi", dm.densityDpi);
        o.put("screen", sc);
        o.put("dark", (getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        return o;
    }

    private JSObject network() {
        ConnectivityManager cm = (ConnectivityManager) service(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        JSObject o = new JSObject();
        Network n = cm.getActiveNetwork();
        NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
        if (c == null) {
            o.put("online", false);
            o.put("transport", "none");
        } else {
            boolean vpn = c.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
            o.put("transport", c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular" : c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : c.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) ? "bluetooth" : vpn ? "vpn" : "other");
            o.put("online", c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
            o.put("validated", c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            o.put("metered", !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            o.put("vpn", vpn);
            o.put("downKbps", c.getLinkDownstreamBandwidthKbps());
            o.put("upKbps", c.getLinkUpstreamBandwidthKbps());
            if (Build.VERSION.SDK_INT >= 28 && c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) o.put("roaming", !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING));
        }
        try {
            int rb = cm.getRestrictBackgroundStatus();
            o.put("dataSaver", rb == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED ? "on" : rb == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED ? "whitelisted" : "off");
        } catch (Throwable ignored) {
        }
        try {
            TelephonyManager tm = (TelephonyManager) service(Context.TELEPHONY_SERVICE);
            String op = tm == null ? null : tm.getNetworkOperatorName(); // the network's name, not the number: no permission
            if (op != null && !op.trim().isEmpty()) o.put("operator", op.trim());
        } catch (Throwable ignored) {
        }
        return o;
    }

    private static final int[] STREAMS = { AudioManager.STREAM_MUSIC, AudioManager.STREAM_RING, AudioManager.STREAM_ALARM, AudioManager.STREAM_VOICE_CALL };
    private static final String[] STREAM_NAMES = { "media", "ring", "alarm", "call" };

    private JSObject sound() {
        AudioManager am = (AudioManager) service(Context.AUDIO_SERVICE);
        if (am == null) return null;
        JSObject o = new JSObject();
        int rm = am.getRingerMode();
        o.put("ringer", rm == AudioManager.RINGER_MODE_SILENT ? "silent" : rm == AudioManager.RINGER_MODE_VIBRATE ? "vibrate" : "normal");
        try {
            NotificationManager nm = (NotificationManager) service(Context.NOTIFICATION_SERVICE);
            int f = nm == null ? 0 : nm.getCurrentInterruptionFilter();
            String d = f == NotificationManager.INTERRUPTION_FILTER_ALL ? "off" : f == NotificationManager.INTERRUPTION_FILTER_PRIORITY ? "priority" : f == NotificationManager.INTERRUPTION_FILTER_ALARMS ? "alarms" : f == NotificationManager.INTERRUPTION_FILTER_NONE ? "none" : null;
            if (d != null) o.put("dnd", d);
        } catch (Throwable ignored) {
        }
        JSObject v = new JSObject();
        for (int i = 0; i < STREAMS.length; i++) {
            JSArray a = new JSArray();
            a.put(am.getStreamVolume(STREAMS[i]));
            a.put(am.getStreamMaxVolume(STREAMS[i]));
            v.put(STREAM_NAMES[i], a);
        }
        o.put("volume", v);
        return o;
    }

    private JSObject alarm() {
        AlarmManager am = (AlarmManager) service(Context.ALARM_SERVICE);
        if (am == null) return null;
        AlarmManager.AlarmClockInfo next = am.getNextAlarmClock();
        JSObject o = new JSObject();
        o.put("next", next == null ? 0 : next.getTriggerTime());
        return o;
    }

    // ---------- Wi-Fi (names need precise location + Location on) ----------

    /**
     * { enabled, connected, ssid?, rssi, level, maxLevel, linkMbps, freqMhz, standard?, security?, ipv4[], gateway?, dns[] }
     * and with scan: true also { networks: [{ ssid, rssi, freqMhz, security }], fresh, ageMs }.
     * Rejects DENIED (no precise location), LOCATION_OFF, NO_WIFI.
     */
    @PluginMethod
    public void wifi(PluginCall call) {
        final WifiManager wm = (WifiManager) service(Context.WIFI_SERVICE);
        if (wm == null || !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI)) {
            call.reject("This device has no Wi-Fi", "NO_WIFI");
            return;
        }
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            if (getPermissionState("wifi") == PermissionState.DENIED) {
                call.reject("Android does not allow Chronicle to see Wi-Fi names: that needs the precise location, which was refused. The user can allow it in Settings › Apps › Chronicle › Permissions › Location (with \"Use precise location\" on).", "DENIED");
                return;
            }
            requestPermissionForAlias("wifi", call, "wifiAnswered");
            return;
        }
        LocationManager lm = (LocationManager) service(Context.LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 28 && lm != null && !lm.isLocationEnabled()) {
            call.reject("Location is switched off on the phone", "LOCATION_OFF");
            return;
        }
        final JSObject r;
        try {
            r = connection(wm);
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
            return;
        }
        if (!call.getData().optBoolean("scan", false) || !wm.isWifiEnabled()) {
            call.resolve(r);
            return;
        }
        // a scan: ask for a fresh one and wait for Android to say it is there (or that it will not come: scans are
        // limited to 4 in 2 minutes – then the last results are given, marked as not fresh)
        final AtomicBoolean done = new AtomicBoolean(false);
        final Context app = getContext().getApplicationContext();
        final BroadcastReceiver[] holder = new BroadcastReceiver[1];
        final java.util.function.Consumer<Boolean> finish = (fresh) -> {
            if (!done.compareAndSet(false, true)) return;
            try {
                if (holder[0] != null) app.unregisterReceiver(holder[0]);
            } catch (Exception ignored) {
            }
            new Thread(() -> {
                try {
                    scanInto(wm, r, fresh);
                    call.resolve(r);
                } catch (SecurityException e) {
                    call.reject("Android did not give the Wi-Fi networks (the precise location is needed)", "DENIED");
                } catch (Throwable e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            }).start();
        };
        holder[0] = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                finish.accept(i.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false));
            }
        };
        try {
            // a broadcast from the system: no other app can send it, exported or not
            ContextCompat.registerReceiver(app, holder[0], new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
            @SuppressWarnings("deprecation")
            boolean started = wm.startScan();
            if (!started) finish.accept(false);
            else main.postDelayed(() -> finish.accept(false), 8000);
        } catch (Throwable e) {
            finish.accept(false);
        }
    }

    @PermissionCallback
    private void wifiAnswered(PluginCall call) {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("The user did not allow the precise location, which Android needs before it shows Wi-Fi names.", "DENIED");
            return;
        }
        wifi(call);
    }

    @SuppressWarnings("deprecation")
    private JSObject connection(WifiManager wm) {
        JSObject r = new JSObject();
        boolean on = wm.isWifiEnabled();
        r.put("enabled", on);
        r.put("connected", false);
        if (!on) return r;
        ConnectivityManager cm = (ConnectivityManager) service(Context.CONNECTIVITY_SERVICE);
        Network wifiNet = null;
        if (cm != null) {
            Network active = cm.getActiveNetwork();
            NetworkCapabilities ac = active == null ? null : cm.getNetworkCapabilities(active);
            if (ac != null && ac.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifiNet = active;
            else {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities c = cm.getNetworkCapabilities(n);
                    if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        wifiNet = n;
                        break;
                    }
                }
            }
        }
        // deprecated since Android 12 but still the one call that gives the name to an app with precise location
        WifiInfo wi = wm.getConnectionInfo();
        if (wi == null || wi.getNetworkId() == -1 && wifiNet == null) return r;
        if (wifiNet == null && wi.getRssi() <= -127) return r;
        r.put("connected", true);
        String ssid = wi.getSSID();
        if (ssid != null && !ssid.isEmpty() && !"<unknown ssid>".equals(ssid)) {
            if (ssid.length() >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) ssid = ssid.substring(1, ssid.length() - 1);
            r.put("ssid", ssid);
        }
        int rssi = wi.getRssi();
        r.put("rssi", rssi);
        if (Build.VERSION.SDK_INT >= 30) {
            r.put("level", wm.calculateSignalLevel(rssi));
            r.put("maxLevel", wm.getMaxSignalLevel());
        } else {
            r.put("level", WifiManager.calculateSignalLevel(rssi, 5));
            r.put("maxLevel", 4);
        }
        if (wi.getLinkSpeed() > 0) r.put("linkMbps", wi.getLinkSpeed());
        if (wi.getFrequency() > 0) r.put("freqMhz", wi.getFrequency());
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                String std = standard(wi.getWifiStandard());
                if (std != null) r.put("standard", std);
            } catch (Throwable ignored) {
            }
        }
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                String sec = security(wi.getCurrentSecurityType());
                if (sec != null) r.put("security", sec);
            } catch (Throwable ignored) {
            }
        }
        try {
            LinkProperties lp = cm == null || wifiNet == null ? null : cm.getLinkProperties(wifiNet);
            if (lp != null) {
                JSArray v4 = new JSArray();
                for (LinkAddress a : lp.getLinkAddresses()) {
                    if (a.getAddress() instanceof Inet4Address) v4.put(a.getAddress().getHostAddress() + "/" + a.getPrefixLength());
                }
                r.put("ipv4", v4);
                for (RouteInfo ri : lp.getRoutes()) {
                    if (ri.isDefaultRoute() && ri.getGateway() instanceof Inet4Address) {
                        r.put("gateway", ri.getGateway().getHostAddress());
                        break;
                    }
                }
                JSArray dns = new JSArray();
                for (InetAddress d : lp.getDnsServers()) dns.put(d.getHostAddress());
                r.put("dns", dns);
            }
        } catch (Throwable ignored) {
        }
        return r;
    }

    private static String standard(int s) {
        switch (s) {
            case ScanResult.WIFI_STANDARD_LEGACY: return "802.11a/b/g";
            case ScanResult.WIFI_STANDARD_11N: return "Wi-Fi 4 (802.11n)";
            case ScanResult.WIFI_STANDARD_11AC: return "Wi-Fi 5 (802.11ac)";
            case ScanResult.WIFI_STANDARD_11AX: return "Wi-Fi 6 (802.11ax)";
            case 8 /* WIFI_STANDARD_11BE, API 33 */: return "Wi-Fi 7 (802.11be)";
            default: return null;
        }
    }

    private static String security(int t) {
        switch (t) {
            case WifiInfo.SECURITY_TYPE_OPEN: return "open (no password)";
            case WifiInfo.SECURITY_TYPE_WEP: return "WEP (weak)";
            case WifiInfo.SECURITY_TYPE_PSK: return "WPA2";
            case WifiInfo.SECURITY_TYPE_SAE: return "WPA3";
            case WifiInfo.SECURITY_TYPE_OWE: return "open, encrypted (OWE)";
            case WifiInfo.SECURITY_TYPE_EAP:
            case WifiInfo.SECURITY_TYPE_EAP_WPA3_ENTERPRISE:
            case WifiInfo.SECURITY_TYPE_EAP_WPA3_ENTERPRISE_192_BIT: return "enterprise (sign-in)";
            default: return null;
        }
    }

    private static String securityOf(String caps) {
        String c = caps == null ? "" : caps.toUpperCase(Locale.ROOT);
        if (c.contains("SAE")) return c.contains("PSK") ? "WPA2/WPA3" : "WPA3";
        if (c.contains("EAP")) return "enterprise (sign-in)";
        if (c.contains("PSK")) return "WPA2";
        if (c.contains("WEP")) return "WEP (weak)";
        if (c.contains("OWE")) return "open, encrypted (OWE)";
        return "open (no password)";
    }

    /** The networks in range: strongest first, one line per name, without the access points' addresses (they give a position away). */
    private void scanInto(WifiManager wm, JSObject r, boolean fresh) {
        List<ScanResult> list = wm.getScanResults();
        Map<String, ScanResult> best = new HashMap<>();
        long newest = 0;
        if (list != null) {
            for (ScanResult s : list) {
                @SuppressWarnings("deprecation")
                String name = s.SSID == null ? "" : s.SSID;
                ScanResult old = best.get(name);
                if (old == null || s.level > old.level) best.put(name, s);
                newest = Math.max(newest, s.timestamp);
            }
        }
        List<Map.Entry<String, ScanResult>> sorted = new ArrayList<>(best.entrySet());
        Collections.sort(sorted, (a, b) -> b.getValue().level - a.getValue().level);
        JSArray out = new JSArray();
        for (Map.Entry<String, ScanResult> e : sorted) {
            if (out.length() >= 30) break;
            JSObject o = new JSObject();
            o.put("ssid", e.getKey());
            o.put("rssi", e.getValue().level);
            o.put("freqMhz", e.getValue().frequency);
            o.put("security", securityOf(e.getValue().capabilities));
            out.put(o);
        }
        r.put("networks", out);
        r.put("fresh", fresh);
        r.put("ageMs", newest > 0 ? Math.max(0, SystemClock.elapsedRealtime() - newest / 1000) : 0);
    }

    // ---------- phone_control ----------

    @PluginMethod
    public void control(PluginCall call) {
        final JSObject d = call.getData();
        final String action = d.optString("action", "");
        try {
            switch (action) {
                case "flashlight":
                    torch(call, d.optBoolean("on", false));
                    return;
                case "volume":
                    volume(call, d.optString("stream", "media"), d.optInt("percent", -1));
                    return;
                case "media":
                    media(call, d.optString("command", ""));
                    return;
                case "vibrate":
                    vibrate(call, Math.max(20, Math.min(2000, d.optInt("ms", 400))));
                    return;
                case "clipboard_set":
                case "clipboard_get":
                    clipboard(call, "clipboard_set".equals(action) ? d.optString("text", "") : null);
                    return;
                default:
                    call.reject("Unknown action");
            }
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    private void torch(PluginCall call, boolean on) {
        CameraManager cm = (CameraManager) service(Context.CAMERA_SERVICE);
        try {
            String id = null;
            if (cm != null) {
                for (String c : cm.getCameraIdList()) {
                    CameraCharacteristics ch = cm.getCameraCharacteristics(c);
                    Boolean flash = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
                    if (Boolean.TRUE.equals(flash) && (id == null || (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK))) {
                        id = c;
                        if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) break;
                    }
                }
            }
            if (id == null) {
                call.reject("This phone has no flashlight", "NO_FLASH");
                return;
            }
            cm.setTorchMode(id, on); // the torch alone needs no camera permission
            JSObject r = new JSObject();
            r.put("on", on);
            call.resolve(r);
        } catch (CameraAccessException e) {
            call.reject("The camera is in use", "CAMERA_BUSY");
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    private void volume(PluginCall call, String stream, int percent) {
        AudioManager am = (AudioManager) service(Context.AUDIO_SERVICE);
        int idx = java.util.Arrays.asList(STREAM_NAMES).indexOf(stream);
        if (am == null || idx < 0 || percent < 0 || percent > 100) {
            call.reject("volume needs stream (media, ring, alarm, call) and percent 0-100");
            return;
        }
        if (am.isVolumeFixed()) {
            call.reject("This device has a fixed volume", "FIXED");
            return;
        }
        int s = STREAMS[idx];
        int max = am.getStreamMaxVolume(s);
        int min = Build.VERSION.SDK_INT >= 28 ? am.getStreamMinVolume(s) : 0;
        int level = Math.max(min, Math.min(max, Math.round(percent * max / 100f)));
        try {
            am.setStreamVolume(s, level, AudioManager.FLAG_SHOW_UI);
        } catch (SecurityException e) {
            // silencing the ringer, or any change while Do Not Disturb is on, needs notification-policy access
            call.reject("Android did not allow that volume change", "DND");
            return;
        }
        JSObject r = new JSObject();
        r.put("level", am.getStreamVolume(s));
        r.put("max", max);
        call.resolve(r);
    }

    private void media(PluginCall call, String command) {
        final AudioManager am = (AudioManager) service(Context.AUDIO_SERVICE);
        int code = "play_pause".equals(command) ? KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE : "next".equals(command) ? KeyEvent.KEYCODE_MEDIA_NEXT : "previous".equals(command) ? KeyEvent.KEYCODE_MEDIA_PREVIOUS : "stop".equals(command) ? KeyEvent.KEYCODE_MEDIA_STOP : 0;
        if (am == null || code == 0) {
            call.reject("media needs command: play_pause, next, previous or stop");
            return;
        }
        long t = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0));
        // a moment for the player to react, then: is anything playing?
        main.postDelayed(() -> {
            JSObject r = new JSObject();
            try {
                r.put("musicActive", am.isMusicActive());
            } catch (Throwable ignored) {
            }
            call.resolve(r);
        }, 600);
    }

    @SuppressWarnings("deprecation")
    private void vibrate(PluginCall call, int ms) {
        Vibrator v = (Vibrator) service(Context.VIBRATOR_SERVICE);
        JSObject r = new JSObject();
        if (v == null || !v.hasVibrator()) {
            r.put("vibrated", false);
            call.resolve(r);
            return;
        }
        v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
        r.put("vibrated", true);
        call.resolve(r);
    }

    /** text != null: put it on the clipboard; null: read it (Android only lets the app in front read). On the main thread. */
    private void clipboard(PluginCall call, String text) {
        final Activity a = getActivity();
        if (text == null && !Launch.inFront(a)) {
            call.reject("Chronicle is not on screen", "BACKGROUND");
            return;
        }
        main.post(() -> {
            try {
                ClipboardManager cb = (ClipboardManager) service(Context.CLIPBOARD_SERVICE);
                if (cb == null) {
                    call.reject("This device has no clipboard");
                    return;
                }
                JSObject r = new JSObject();
                if (text != null) {
                    cb.setPrimaryClip(ClipData.newPlainText("Chronicle", text));
                    r.put("set", true);
                } else {
                    ClipData clip = cb.getPrimaryClip();
                    CharSequence cs = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).coerceToText(getContext());
                    String s = cs == null ? "" : cs.toString();
                    if (s.length() > 20000) {
                        s = s.substring(0, 20000);
                        r.put("cut", true);
                    }
                    r.put("text", s);
                }
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    // ---------- take_photo: the camera app takes it ----------

    private File shareDir() {
        File dir = new File(getContext().getCacheDir(), "share"); // the folder the file provider may hand out (file_paths.xml)
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** Photos and shared files from earlier calls: gone after an hour (the other app has long read them). */
    private void sweepShare() {
        File[] l = shareDir().listFiles();
        if (l == null) return;
        long old = System.currentTimeMillis() - 3600_000L;
        for (File f : l) {
            if (f.lastModified() < old) {
                if (f.isDirectory()) {
                    File[] in = f.listFiles();
                    if (in != null) for (File g : in) //noinspection ResultOfMethodCallIgnored
                        g.delete();
                }
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    /**
     * Opens the camera app; → { path, size } of the JPEG it saved – or, with video: true, of the video it recorded
     * (decision 229). dest (optional, e.g. "work/<chat>/videos/v.mp4"): the file is moved there, under the app's shell
     * storage (a chat's /workspace), so a big video reaches Linux without going through the app's memory.
     * Rejects BACKGROUND, NO_APP, CANCELLED.
     */
    @PluginMethod
    public void capture(PluginCall call) {
        if (!Launch.inFront(getActivity())) {
            call.reject("Chronicle is not on screen", "BACKGROUND");
            return;
        }
        try {
            sweepShare();
            boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
            File f = new File(shareDir(), (video ? "video-" : "photo-") + System.currentTimeMillis() + (video ? ".mp4" : ".jpg"));
            Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, u);
            i.setClipData(ClipData.newRawUri("photo", u)); // so the permission below reaches the camera app on every Android
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (i.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("No camera app", "NO_APP");
                return;
            }
            call.getData().put("photoPath", f.getAbsolutePath());
            startActivityForResult(call, i, "captured");
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No camera app", "NO_APP");
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @ActivityCallback
    private void captured(PluginCall call, ActivityResult result) {
        if (call == null) return;
        String path = call.getData().optString("photoPath", "");
        File f = new File(path);
        // some camera apps ignore the place they were given for a video and hand back their own: copied from there
        if (result != null && result.getResultCode() == Activity.RESULT_OK && !path.isEmpty() && (!f.isFile() || f.length() == 0) && result.getData() != null && result.getData().getData() != null) {
            try (java.io.InputStream in = getContext().getContentResolver().openInputStream(result.getData().getData()); FileOutputStream out = new FileOutputStream(f)) {
                if (in != null) {
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            } catch (Exception ignored) {
            }
        }
        if (result == null || result.getResultCode() != Activity.RESULT_OK || path.isEmpty() || !f.isFile() || f.length() == 0) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            call.reject("Nothing was recorded", "CANCELLED");
            return;
        }
        String dest = call.getString("dest", "");
        if (dest != null && !dest.isEmpty()) {
            try {
                File base = new File(getContext().getFilesDir(), "shell").getCanonicalFile();
                File to = new File(base, dest.replaceFirst("^/+", "")).getCanonicalFile();
                if (!to.getPath().startsWith(base.getPath() + "/work/")) throw new Exception("not a place for it");
                File dir = to.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new Exception("could not make the folder");
                if (!f.renameTo(to)) {
                    try (java.io.InputStream in = new java.io.FileInputStream(f); FileOutputStream out = new FileOutputStream(to)) {
                        byte[] buf = new byte[1 << 20];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
                f = to;
            } catch (Exception e) {
                call.reject("Recorded, but it could not be put in the chat's folder: " + e.getMessage());
                return;
            }
        }
        JSObject r = new JSObject();
        r.put("path", f.getAbsolutePath());
        r.put("size", f.length());
        call.resolve(r);
    }

    // ---------- a workspace file → another app ----------

    private static String safeName(String n) {
        String s = (n == null ? "" : n).replaceAll("[^\\w.() +-]", "_");
        while (s.startsWith(".")) s = s.substring(1);
        if (s.length() > 100) s = s.substring(s.length() - 100);
        return s.isEmpty() ? "file" : s;
    }

    private File shareFileOf(JSObject d) {
        String id = d.optString("id", "").replaceAll("[^a-z0-9]", "");
        if (id.isEmpty()) id = "x";
        File dir = new File(shareDir(), "f" + id);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, safeName(d.optString("name", "")));
    }

    /** One piece of the file ({ id, name, base64, first }): written into the app's share folder. */
    @PluginMethod
    public void sharePut(PluginCall call) {
        JSObject d = call.getData();
        try {
            boolean first = d.optBoolean("first", false);
            if (first) sweepShare();
            File f = shareFileOf(d);
            byte[] bytes = Base64.decode(d.optString("base64", ""), Base64.DEFAULT);
            try (FileOutputStream out = new FileOutputStream(f, !first)) {
                out.write(bytes);
            }
            JSObject r = new JSObject();
            r.put("size", f.length());
            call.resolve(r);
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** { id, name, mime, mode: "send" | "view", title } → the share sheet, or the app that opens such a file. → { opened, notified } */
    @PluginMethod
    public void shareFile(PluginCall call) {
        JSObject d = call.getData();
        try {
            File f = shareFileOf(d);
            if (!f.isFile()) {
                call.reject("The file did not arrive");
                return;
            }
            String mime = d.optString("mime", "");
            if (mime.isEmpty()) mime = "application/octet-stream";
            if (f.getName().toLowerCase(Locale.ROOT).endsWith(".apk") || "application/vnd.android.package-archive".equals(mime)) {
                call.reject("Apps cannot be handed over this way");
                return;
            }
            Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i;
            if ("view".equals(d.optString("mode", "send"))) {
                i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(u, mime);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (i.resolveActivity(getContext().getPackageManager()) == null) {
                    call.reject("No app on this phone can open that");
                    return;
                }
            } else {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, u);
                send.setClipData(ClipData.newRawUri(f.getName(), u)); // the read permission travels through the chooser with it
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i = Intent.createChooser(send, null);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            boolean opened = Launch.startOrNotify(getActivity(), getContext(), i, d.optString("title", "Chronicle has a file to open"));
            JSObject r = new JSObject();
            r.put("opened", opened);
            r.put("notified", !opened);
            call.resolve(r);
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No app on this phone can open that");
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }
}
