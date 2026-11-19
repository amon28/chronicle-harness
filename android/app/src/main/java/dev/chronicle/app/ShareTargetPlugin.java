package dev.chronicle.app;

import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** "Share to Chronicle": text, links, pictures and files shared from other apps arrive as a "share" event. */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static final long MAX_TOTAL = 40L * 1024 * 1024;

    @Override
    public void load() {
        if (getActivity() != null) read(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        read(intent);
    }

    private void read(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean selected = Intent.ACTION_PROCESS_TEXT.equals(action); // "Ask Chronicle" from the text-selection menu
        if (!selected && !Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        final String text = selected ? String.valueOf(intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)) : intent.getStringExtra(Intent.EXTRA_TEXT);
        final String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        final List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> l = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (l != null) uris.addAll(l);
            }
            ClipData cd = intent.getClipData();
            if (uris.isEmpty() && cd != null) for (int i = 0; i < cd.getItemCount(); i++) if (cd.getItemAt(i).getUri() != null) uris.add(cd.getItemAt(i).getUri());
        } catch (Exception ignored) {
        }
        // handled: don't deliver the same share again after a rotation or resume
        if (getActivity() != null) getActivity().setIntent(new Intent());
        new Thread(() -> {
            JSArray files = new JSArray();
            long total = 0;
            for (Uri u : uris) {
                try {
                    String name = "shared";
                    try (Cursor c = getContext().getContentResolver().query(u, null, null, null, null)) {
                        if (c != null && c.moveToFirst()) {
                            int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                            if (i >= 0) name = c.getString(i);
                        }
                    } catch (Exception ignored) {
                    }
                    String mime = getContext().getContentResolver().getType(u);
                    if (!foreignContent(getContext(), u)) continue; // another app pointing at this app's private files
                    try (InputStream in = getContext().getContentResolver().openInputStream(u)) {
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            bo.write(buf, 0, n);
                            if (total + bo.size() > MAX_TOTAL) throw new Exception("too big");
                        }
                        total += bo.size();
                        JSObject o = new JSObject();
                        o.put("name", name);
                        o.put("mime", mime == null ? "application/octet-stream" : mime);
                        o.put("base64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                        files.put(o);
                    }
                } catch (Exception ignored) {
                }
            }
            JSObject data = new JSObject();
            if (text != null) data.put("text", text);
            if (subject != null) data.put("subject", subject);
            data.put("files", files);
            notifyListeners("share", data, true); // kept until the page is ready to listen (app opened by the share)
        }).start();
    }

    /** A shared or pasted item is read only when it comes from another app: never a file:// path, never this app's own provider. */
    static boolean foreignContent(android.content.Context ctx, android.net.Uri u) {
        if (u == null || !"content".equals(u.getScheme())) return false;
        String auth = u.getAuthority() == null ? "" : u.getAuthority();
        return !auth.startsWith(ctx.getPackageName());
    }
}
