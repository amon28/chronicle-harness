package dev.chronicle.app;

import android.content.Context;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Bytes on their way to the web side. Small answers travel as base64 in the message; anything over a few MB is written
 * to a file in the cache and only its path is sent – the page reads it straight from there (Capacitor serves app
 * files). A 100 MB download as base64 was ~133 MB of text plus the copies the bridge makes: enough to run out of memory.
 * Files older than 15 minutes are swept on the next use.
 */
final class BigBytes extends OutputStream {
    static final int INLINE_MAX = 4 * 1024 * 1024;
    private final Context ctx;
    private ByteArrayOutputStream mem = new ByteArrayOutputStream();
    private File file;
    private FileOutputStream out;
    private long size;

    BigBytes(Context ctx) {
        this.ctx = ctx;
    }

    static File dir(Context ctx) {
        File d = new File(ctx.getCacheDir(), "bridge");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static void sweep(Context ctx) {
        File[] l = dir(ctx).listFiles();
        if (l == null) return;
        long old = System.currentTimeMillis() - 15 * 60 * 1000;
        for (File f : l) if (f.lastModified() < old) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    @Override
    public void write(int b) throws IOException {
        write(new byte[] { (byte) b }, 0, 1);
    }

    @Override
    public void write(byte[] b, int off, int len) throws IOException {
        size += len;
        if (out == null && mem.size() + len > INLINE_MAX) {
            sweep(ctx);
            file = File.createTempFile("bridge-", ".bin", dir(ctx)); // (a prefix under 3 characters throws "Prefix string too short")
            out = new FileOutputStream(file);
            mem.writeTo(out);
            mem = null;
        }
        if (out != null) out.write(b, off, len);
        else mem.write(b, off, len);
    }

    long size() {
        return size;
    }

    /** The bytes in memory (only for a small result). */
    byte[] bytes() {
        return mem != null ? mem.toByteArray() : null;
    }

    /** Into the answer: { base64 } when small, { path } when it went to a file. */
    void into(JSObject r) throws IOException {
        if (out != null) {
            out.close();
            r.put("path", file.getAbsolutePath());
            r.put("size", size);
        } else {
            r.put("base64", Base64.encodeToString(mem.toByteArray(), Base64.NO_WRAP));
        }
    }

    /** A file that already exists (a PDF): sent by path when big, inline when small. */
    static void fileInto(Context ctx, File f, JSObject r) throws IOException {
        if (f.length() > INLINE_MAX) {
            File keep = new File(dir(ctx), "f" + System.nanoTime() + ".bin");
            if (!f.renameTo(keep)) throw new IOException("could not keep the file");
            r.put("path", keep.getAbsolutePath());
            r.put("size", keep.length());
        } else {
            byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
            r.put("base64", Base64.encodeToString(b, Base64.NO_WRAP));
        }
    }

    @Override
    public void close() throws IOException {
        if (out != null) out.close();
    }
}
