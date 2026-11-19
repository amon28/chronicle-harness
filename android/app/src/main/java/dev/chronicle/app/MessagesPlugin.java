package dev.chronicle.app;

import android.Manifest;
import android.database.Cursor;
import android.provider.CallLog;
import android.provider.Telephony;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Text messages and the call log, read only, for the `messages` tool (src/private.js). The JS side asks the user in the
 * chat every time first; Android's runtime permission (READ_SMS / READ_CALL_LOG) is asked the first time, and only while
 * Chronicle is on screen. Nothing here sends, writes or deletes.
 */
@CapacitorPlugin(
    name = "Messages",
    permissions = {
        @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS }),
        @Permission(alias = "calls", strings = { Manifest.permission.READ_CALL_LOG }),
    }
)
public class MessagesPlugin extends Plugin {
    static final int SMS_MAX = 20;
    static final int CALLS_MAX = 30;

    private PluginCall asking;

    /** true = go on; false = Android is asking now (the call runs again with the answer) or the call was rejected. */
    private boolean need(PluginCall call, String alias) {
        if (getPermissionState(alias) == PermissionState.GRANTED) return true;
        synchronized (this) {
            if (asking != null) {
                call.reject("Android is already asking for a permission – try again in a moment.", "BUSY");
                return false;
            }
            if (!Launch.inFront(getActivity())) {
                call.reject("Android can only ask for this permission while Chronicle is on screen. Ask the user to open Chronicle, then try again.", "BACKGROUND");
                return false;
            }
            asking = call;
        }
        requestPermissionForAlias(alias, call, "answered");
        return false;
    }

    @PermissionCallback
    private void answered(PluginCall saved) {
        PluginCall call;
        synchronized (this) {
            call = saved != null ? saved : asking;
            asking = null;
        }
        if (call == null) return;
        boolean sms = "smsSearch".equals(call.getMethodName());
        String alias = sms ? "sms" : "calls";
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            call.reject("The user did not allow Chronicle to read " + (sms ? "text messages" : "the call log") + ". It can be allowed in Settings › Apps › Chronicle › Permissions.", "DENIED");
            return;
        }
        if (sms) smsSearch(call);
        else calls(call);
    }

    private static String likeArg(String s) {
        return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    @PluginMethod
    public void smsSearch(PluginCall call) {
        if (!need(call, "sms")) return;
        final String query = call.getString("query", "").trim();
        final String from = call.getString("from", "").trim();
        final long since = Math.max(0, Args.whole(call, "since", 0));
        final int limit = (int) Math.max(1, Math.min(SMS_MAX, Args.whole(call, "limit", 10)));
        new Thread(() -> {
            try {
                List<String> where = new ArrayList<>();
                List<String> args = new ArrayList<>();
                if (!query.isEmpty()) {
                    where.add(Telephony.Sms.BODY + " LIKE ? ESCAPE '\\'");
                    args.add(likeArg(query));
                }
                if (!from.isEmpty()) {
                    where.add(Telephony.Sms.ADDRESS + " LIKE ? ESCAPE '\\'");
                    args.add(likeArg(from));
                }
                if (since > 0) {
                    where.add(Telephony.Sms.DATE + " >= ?");
                    args.add(String.valueOf(since));
                }
                String[] cols = { Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ };
                JSArray out = new JSArray();
                try (Cursor c = getContext().getContentResolver().query(Telephony.Sms.CONTENT_URI, cols, where.isEmpty() ? null : android.text.TextUtils.join(" AND ", where), args.toArray(new String[0]), Telephony.Sms.DATE + " DESC")) {
                    while (c != null && c.moveToNext() && out.length() < limit) {
                        JSObject o = new JSObject();
                        o.put("address", c.getString(0) == null ? "" : c.getString(0));
                        o.put("body", Triggers.clip(c.getString(1), 600));
                        o.put("date", c.getLong(2));
                        int t = c.getInt(3);
                        o.put("type", t == Telephony.Sms.MESSAGE_TYPE_SENT ? "sent" : t == Telephony.Sms.MESSAGE_TYPE_INBOX ? "inbox" : t == Telephony.Sms.MESSAGE_TYPE_DRAFT ? "draft" : "other");
                        o.put("read", c.getInt(4) == 1);
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("messages", out);
                call.resolve(r);
            } catch (SecurityException e) {
                call.reject("Android does not allow Chronicle to read text messages.", "DENIED");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void calls(PluginCall call) {
        if (!need(call, "calls")) return;
        final long since = Math.max(0, Args.whole(call, "since", 0));
        final int limit = (int) Math.max(1, Math.min(CALLS_MAX, Args.whole(call, "limit", 15)));
        new Thread(() -> {
            try {
                String[] cols = { CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION };
                JSArray out = new JSArray();
                try (Cursor c = getContext().getContentResolver().query(CallLog.Calls.CONTENT_URI, cols, since > 0 ? CallLog.Calls.DATE + " >= ?" : null, since > 0 ? new String[] { String.valueOf(since) } : null, CallLog.Calls.DATE + " DESC")) {
                    while (c != null && c.moveToNext() && out.length() < limit) {
                        JSObject o = new JSObject();
                        o.put("number", c.getString(0) == null ? "" : c.getString(0));
                        o.put("name", c.getString(1) == null ? "" : c.getString(1));
                        int t = c.getInt(2);
                        o.put("type", t == CallLog.Calls.INCOMING_TYPE ? "incoming" : t == CallLog.Calls.OUTGOING_TYPE ? "outgoing" : t == CallLog.Calls.MISSED_TYPE ? "missed" : t == CallLog.Calls.REJECTED_TYPE ? "rejected" : t == CallLog.Calls.BLOCKED_TYPE ? "blocked" : t == CallLog.Calls.VOICEMAIL_TYPE ? "voicemail" : "other");
                        o.put("date", c.getLong(3));
                        o.put("duration", c.getLong(4));
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("calls", out);
                call.resolve(r);
            } catch (SecurityException e) {
                call.reject("Android does not allow Chronicle to read the call log.", "DENIED");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }
}
