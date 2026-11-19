package dev.chronicle.app;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Sends an automation result back (Tasker's "Intent Received", MacroDroid, …): a broadcast with the reply. With a
 * package it is delivered only to that app; without one any app listening for the action can read it.
 */
@CapacitorPlugin(name = "Automation")
public class AutomationPlugin extends Plugin {
    @PluginMethod
    public void reply(PluginCall call) {
        String action = call.getString("action", "dev.chronicle.app.RESULT");
        if (action == null || !action.matches("[A-Za-z0-9_.]{3,120}")) {
            call.reject("Bad reply action");
            return;
        }
        Intent i = new Intent(action);
        String pkg = call.getString("package");
        // the reply holds chat text: it goes to the one app that asked, never to whoever listens
        if (pkg == null || !pkg.matches("[A-Za-z0-9_.]{3,120}")) {
            call.reject("No app to reply to (name it with reply_package)");
            return;
        }
        i.setPackage(pkg);
        i.putExtra("request_id", call.getString("id", ""));
        i.putExtra("ok", Boolean.TRUE.equals(call.getBoolean("ok", true)));
        i.putExtra("text", call.getString("text", ""));
        i.putExtra("chat_id", call.getString("chat", ""));
        i.putExtra("error", call.getString("error", ""));
        getContext().sendBroadcast(i);
        call.resolve();
    }
}
