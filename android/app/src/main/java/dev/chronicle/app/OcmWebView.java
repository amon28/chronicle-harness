package dev.chronicle.app;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.util.AttributeSet;
import android.util.Base64;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;

import com.getcapacitor.CapacitorWebView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * The app's WebView. It tells the keyboard that the message box accepts pictures, so tapping a picture in Gboard's
 * clipboard (or a sticker/GIF) is delivered instead of "not supported". The picture goes to the page as
 * window.__ocmCommit(mimeType, base64).
 */
public class OcmWebView extends CapacitorWebView {

    public OcmWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (ic == null || outAttrs == null) return ic;
        EditorInfoCompat.setContentMimeTypes(outAttrs, new String[]{"image/png", "image/jpeg", "image/gif", "image/webp", "image/*"});
        return InputConnectionCompat.createWrapper(ic, outAttrs, (info, flags, opts) -> {
            if (Build.VERSION.SDK_INT >= 25 && (flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    info.requestPermission();
                } catch (Exception e) {
                    return false;
                }
            }
            final Uri uri = info.getContentUri();
            final String mime = info.getDescription().getMimeTypeCount() > 0 ? info.getDescription().getMimeType(0) : "image/png";
            new Thread(() -> {
                try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        bo.write(buf, 0, n);
                        if (bo.size() > 15 * 1024 * 1024) throw new Exception("too big");
                    }
                    final String b64 = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
                    post(() -> evaluateJavascript("window.__ocmCommit && window.__ocmCommit('" + mime.replace("'", "") + "','" + b64 + "')", null));
                } catch (Exception ignored) {
                } finally {
                    try {
                        info.releasePermission();
                    } catch (Exception ignored) {
                    }
                }
            }).start();
            return true;
        });
    }
}
