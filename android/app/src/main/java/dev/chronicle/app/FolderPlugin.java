package dev.chronicle.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * A folder on the phone the user chose with Android's folder picker (Storage Access Framework). The grant is
 * persistent, so the app can list/read/write/delete inside that one folder – and nothing outside it.
 */
@CapacitorPlugin(name = "Folder")
public class FolderPlugin extends Plugin {

    @PluginMethod
    public void pick(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject()); // cancelled
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        DocumentFile d = DocumentFile.fromTreeUri(getContext(), uri);
        JSObject r = new JSObject();
        r.put("uri", uri.toString());
        r.put("name", d != null && d.getName() != null ? d.getName() : "folder");
        call.resolve(r);
    }

    /**
     * A file into the phone's Downloads (Download/Chronicle), where the Files app and every other app find it. Android 10+
     * needs no permission for that. → { name (as saved: Android adds " (1)" to a taken name), folder }
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String name = call.getString("name", "file");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        if (android.os.Build.VERSION.SDK_INT < 29) {
            call.reject("Saving to Downloads needs Android 10 or newer – use Save as… instead");
            return;
        }
        ContentResolver cr = getContext().getContentResolver();
        try {
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/Chronicle");
            v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Android did not give a place to save it");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new Exception("could not open the file for writing");
                out.write(Base64.decode(data, Base64.DEFAULT));
            } catch (Exception e) {
                cr.delete(uri, null, null); // no half-written, pending entry left in Downloads
                throw e;
            }
            android.content.ContentValues done = new android.content.ContentValues();
            done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            String saved = name;
            try (android.database.Cursor c = cr.query(uri, new String[] { android.provider.MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) saved = c.getString(0);
            }
            JSObject r = new JSObject();
            r.put("name", saved);
            r.put("folder", "Download/Chronicle");
            r.put("uri", uri.toString());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save to Downloads: " + e.getMessage());
        }
    }

    /** Android's own "save to" screen (any folder, Drive…), then the bytes into the file it made. → { saved, name } */
    @PluginMethod
    public void saveAs(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(call.getString("mime", "application/octet-stream"));
        i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "file"));
        startActivityForResult(call, i, "onSaveAs");
    }

    @ActivityCallback
    private void onSaveAs(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject r = new JSObject();
            r.put("saved", false);
            call.resolve(r); // cancelled
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new Exception("could not open the file for writing");
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            DocumentFile d = DocumentFile.fromSingleUri(getContext(), uri);
            JSObject r = new JSObject();
            r.put("saved", true);
            r.put("name", d != null && d.getName() != null ? d.getName() : call.getString("name", "file"));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save: " + e.getMessage());
        }
    }

    private DocumentFile root(PluginCall call) {
        String u = call.getString("uri", "");
        if (u.isEmpty()) return null;
        try {
            return DocumentFile.fromTreeUri(getContext(), Uri.parse(u));
        } catch (Exception e) {
            return null;
        }
    }

    private static String[] parts(String path) {
        if (path == null) return new String[0];
        String p = path.replace('\\', '/');
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (String s : p.split("/")) if (!s.isEmpty() && !s.equals(".") && !s.equals("..")) out.add(s);
        return out.toArray(new String[0]);
    }

    private DocumentFile find(DocumentFile root, String path) {
        DocumentFile cur = root;
        for (String s : parts(path)) {
            if (cur == null) return null;
            cur = cur.findFile(s);
        }
        return cur;
    }

    private void addEntries(DocumentFile dir, String prefix, boolean recursive, JSArray out, int[] budget) {
        DocumentFile[] kids = dir.listFiles();
        if (kids == null) return;
        for (DocumentFile k : kids) {
            if (budget[0] <= 0) return;
            String name = k.getName() == null ? "?" : k.getName();
            String rel = prefix.isEmpty() ? name : prefix + "/" + name;
            JSObject o = new JSObject();
            o.put("path", rel);
            o.put("name", name);
            o.put("isDir", k.isDirectory());
            o.put("size", k.isDirectory() ? 0 : k.length());
            o.put("mtime", k.lastModified());
            out.put(o);
            budget[0]--;
            if (recursive && k.isDirectory()) addEntries(k, rel, true, out, budget);
        }
    }

    /**
     * The real directory behind a SAF tree, when the app can read it directly. That is what lets the
     * built-in Linux bind the folder instead of copying it. Returns {} when there is no such path
     * (Android does not always expose one) - the app then mirrors the folder, hash by hash.
     */
    @PluginMethod
    public void localPath(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            try {
                android.net.Uri uri = Uri.parse(call.getString("uri", ""));
                String docId = null;
                try {
                    docId = android.provider.DocumentsContract.getTreeDocumentId(uri);
                } catch (Exception ignored) {
                }
                String path = null;
                if (docId != null) {
                    int c = docId.indexOf(':');
                    String type = c > 0 ? docId.substring(0, c) : "";
                    String rel = c > 0 ? docId.substring(c + 1) : docId;
                    if ("primary".equals(type)) path = new File(android.os.Environment.getExternalStorageDirectory(), rel).getPath();
                    else if ("raw".equals(type)) path = rel;
                    else if (!type.isEmpty()) path = "/storage/" + type + "/" + rel;
                }
                String sub = call.getString("path", "");
                if (path != null && sub != null && !sub.isEmpty()) path = new File(path, sub).getPath();
                File f = path == null ? null : new File(path);
                if (f != null && f.isDirectory() && f.canRead() && f.list() != null && reallyReadable(call, f)) r.put("path", f.getAbsolutePath());
            } catch (Exception ignored) {
            }
            call.resolve(r);
        }).start();
    }

    /**
     * The folder as a path is only worth binding into Linux when the app can really use it there. With scoped storage
     * a shared folder can list as empty, or list files the app may not open – then the shell saw an empty /phone and
     * the assistant went hunting. Every name Android's picker sees must be in the path's listing, and the first file
     * must open.
     */
    private boolean reallyReadable(PluginCall call, File f) {
        try {
            DocumentFile dir = find(root(call), call.getString("path", ""));
            if (dir == null) return false;
            java.util.HashSet<String> here = new java.util.HashSet<>();
            String[] names = f.list();
            if (names == null) return false;
            java.util.Collections.addAll(here, names);
            DocumentFile[] kids = dir.listFiles();
            File sample = null;
            for (int i = 0; kids != null && i < kids.length && i < 200; i++) {
                String n = kids[i].getName();
                if (n == null) continue;
                if (!here.contains(n)) return false;
                if (sample == null && kids[i].isFile()) sample = new File(f, n);
            }
            if (sample != null) {
                try (InputStream in = new java.io.FileInputStream(sample)) {
                    in.read();
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * One file of the linked folder streamed into the shell's copy of it (files/shell/phone/<chat>/…), for a file too big
     * to go through the app's memory – a video for ffmpeg. Written to a temporary name and then renamed, so the shell
     * never sees half a file. Progress: "copyProgress" { done, total }. → { bytes }
     */
    @PluginMethod
    public void copyIntoShell(PluginCall call) {
        new Thread(() -> {
            File tmp = null;
            try {
                DocumentFile root = root(call);
                if (root == null) throw new Exception("That folder isn't available any more – link it again");
                DocumentFile src = find(root, call.getString("path", ""));
                if (src == null || !src.isFile()) throw new Exception("No such file: " + call.getString("path", ""));
                File base = new File(getContext().getFilesDir(), "shell").getCanonicalFile();
                File dest = new File(base, call.getString("dest", "").replaceFirst("^/+", "")).getCanonicalFile();
                if (!dest.getPath().startsWith(base.getPath() + "/phone/")) throw new Exception("not a place for it");
                File dir = dest.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new Exception("could not make " + dir.getName());
                tmp = new File(dest.getPath() + ".chronicle-copy");
                long total = src.length(), done = 0, told = 0;
                try (InputStream in = getContext().getContentResolver().openInputStream(src.getUri()); OutputStream out = new java.io.FileOutputStream(tmp)) {
                    if (in == null) throw new Exception("could not open the file");
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (done - told >= 8L << 20) {
                            told = done;
                            JSObject pr = new JSObject();
                            pr.put("done", done);
                            pr.put("total", total);
                            notifyListeners("copyProgress", pr);
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("only " + done + " of " + total + " bytes could be read");
                if (!tmp.renameTo(dest)) throw new Exception("could not put it in place");
                JSObject r = new JSObject();
                r.put("bytes", done);
                call.resolve(r);
            } catch (Exception e) {
                if (tmp != null) tmp.delete();
                call.reject("Could not copy it into Linux: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void list(PluginCall call) {
        DocumentFile root = root(call);
        if (root == null) {
            call.reject("That folder isn't available any more – link it again");
            return;
        }
        String path = call.getString("path", "");
        boolean recursive = Boolean.TRUE.equals(call.getBoolean("recursive", false));
        int max = call.getInt("max", 1000);
        // on a thread of its own: every plugin call of the app waits on the one plugin thread, and a big folder listed
        // there held up every other chat's file and shell calls (decision 259)
        new Thread(() -> {
            JSArray out = new JSArray();
            String prefix = String.join("/", parts(path));
            boolean fast = false;
            try {
                Uri tree = Uri.parse(call.getString("uri", ""));
                String dirId = findDocId(tree, DocumentsContract.getTreeDocumentId(tree), path);
                if (dirId == null) {
                    call.reject("No such folder: " + path);
                    return;
                }
                fast = fastEntries(tree, dirId, prefix, recursive, out, new int[]{max});
            } catch (Exception e) {
                fast = false;
            }
            if (!fast) {
                // a provider that does not answer the one-query listing: the slower way, one entry at a time
                out = new JSArray();
                DocumentFile dir = find(root, path);
                if (dir == null || !dir.isDirectory()) {
                    call.reject("No such folder: " + path);
                    return;
                }
                addEntries(dir, prefix, recursive, out, new int[]{max});
            }
            JSObject r = new JSObject();
            r.put("entries", out);
            call.resolve(r);
        }).start();
    }

    // One query per folder gives every child's name, type, size and time together: DocumentFile asks the provider
    // again for each of those, per entry (five or six round trips each), and findFile lists and names all siblings for
    // every step of a path (decision 259).
    private static final String[] COLS = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    };

    private interface Child {
        void on(String id, String name, boolean dir, long size, long mtime);
    }

    /** The children of a folder, one query. → false when the provider could not answer it. */
    private boolean children(Uri tree, String docId, Child each) {
        Uri u = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        try (Cursor c = getContext().getContentResolver().query(u, COLS, null, null, null)) {
            if (c == null) return false;
            while (c.moveToNext()) {
                boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));
                each.on(c.getString(0), c.getString(1), dir, c.isNull(3) ? 0 : c.getLong(3), c.isNull(4) ? 0 : c.getLong(4));
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** The document id of a folder inside the tree, by its path; null when there is none. */
    private String findDocId(Uri tree, String rootId, String path) throws Exception {
        String cur = rootId;
        for (String s : parts(path)) {
            final String[] hit = { null };
            if (!children(tree, cur, (id, name, dir, size, mtime) -> {
                if (hit[0] == null && dir && s.equals(name)) hit[0] = id;
            })) throw new Exception("no listing");
            if (hit[0] == null) return null;
            cur = hit[0];
        }
        return cur;
    }

    private boolean fastEntries(Uri tree, String docId, String prefix, boolean recursive, JSArray out, int[] budget) {
        java.util.ArrayList<String[]> dirs = new java.util.ArrayList<>();
        boolean ok = children(tree, docId, (id, name, dir, size, mtime) -> {
            if (budget[0] <= 0) return;
            String n = name == null ? "?" : name;
            String rel = prefix.isEmpty() ? n : prefix + "/" + n;
            JSObject o = new JSObject();
            o.put("path", rel);
            o.put("name", n);
            o.put("isDir", dir);
            o.put("size", dir ? 0 : size);
            o.put("mtime", mtime);
            out.put(o);
            budget[0]--;
            if (recursive && dir) dirs.add(new String[] { id, rel });
        });
        if (!ok) return false;
        for (String[] d : dirs) {
            if (budget[0] <= 0) break;
            if (!fastEntries(tree, d[0], d[1], true, out, budget)) return false;
        }
        return true;
    }

    @PluginMethod
    public void read(PluginCall call) {
        DocumentFile root = root(call);
        DocumentFile f = root == null ? null : find(root, call.getString("path", ""));
        if (f == null || !f.isFile()) {
            call.reject("No such file: " + call.getString("path", ""));
            return;
        }
        long max = Args.whole(call, "maxBytes", 25L * 1024 * 1024); // (getLong ignores a size under 2 GB: it arrives as an Integer)
        if (f.length() > max) {
            call.reject("That file is too big (" + (f.length() / 1024 / 1024) + " MB)");
            return;
        }
        new Thread(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(f.getUri())) {
                BigBytes bo = new BigBytes(getContext()); // a big file is handed over as a file path, not base64
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                JSObject r = new JSObject();
                bo.into(r);
                r.put("size", bo.size());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Couldn't read it: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void write(PluginCall call) {
        DocumentFile root = root(call);
        String[] segs = parts(call.getString("path", ""));
        if (root == null || segs.length == 0) {
            call.reject("Folder or file name missing");
            return;
        }
        final byte[] bytes = Base64.decode(call.getString("base64", ""), Base64.DEFAULT);
        final boolean append = call.getBoolean("append", false); // big files arrive in pieces: the first one replaces the file, the rest are added
        new Thread(() -> {
            try {
                DocumentFile dir = root;
                for (int i = 0; i < segs.length - 1; i++) {
                    DocumentFile next = dir.findFile(segs[i]);
                    if (next == null) next = dir.createDirectory(segs[i]);
                    if (next == null || !next.isDirectory()) throw new Exception("Can't create folder " + segs[i]);
                    dir = next;
                }
                String name = segs[segs.length - 1];
                DocumentFile f = dir.findFile(name);
                boolean existed = f != null;
                if (f != null && f.isDirectory()) throw new Exception(name + " is a folder");
                if (f == null) {
                    String ext = MimeTypeMap.getFileExtensionFromUrl("x." + name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT));
                    String mime = name.contains(".") ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) : null;
                    f = dir.createFile(mime == null ? "application/octet-stream" : mime, name);
                }
                if (f == null) throw new Exception("Couldn't create " + name);
                try (OutputStream out = getContext().getContentResolver().openOutputStream(f.getUri(), append ? "wa" : "wt")) {
                    out.write(bytes);
                }
                JSObject r = new JSObject();
                r.put("existed", existed);
                r.put("name", f.getName());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Couldn't write: " + e.getMessage());
            }
        }).start();
    }

    /**
     * A file from the Linux shell's disk, streamed straight into the linked folder (uri + path) or into
     * Download/Chronicle – never through the app's memory, so a 500 MB recording is fine. `guest` is the file's
     * real path inside Linux (links already resolved by the shell); it must stay inside the Linux root, the
     * app's sign-in folder there is refused, and so is a private key. Progress: "exportProgress" { done, total }.
     * → { name, folder, bytes }
     */
    /**
     * A file the user picks (a backup), copied whole into the app's own cache, so it can then be read in exact pieces
     * with readCached (decision 220). Reading a big picked file through the WebView in slices could land on the wrong
     * bytes; a plain file in the app's storage cannot. → { path, size, name } or {} when cancelled.
     */
    @PluginMethod
    public void pickToCache(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "onPickedToCache");
    }

    private File importDir() {
        return new File(getContext().getCacheDir(), "import");
    }

    @ActivityCallback
    private void onPickedToCache(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject()); // cancelled
            return;
        }
        final Uri uri = result.getData().getData();
        new Thread(() -> {
            File dest = null;
            try {
                ContentResolver cr = getContext().getContentResolver();
                String name = "backup.zip";
                long total = -1;
                try (android.database.Cursor c = cr.query(uri, new String[] { android.provider.OpenableColumns.SIZE, android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        if (!c.isNull(0)) total = c.getLong(0);
                        if (!c.isNull(1)) name = c.getString(1);
                    }
                }
                File dir = importDir();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete(); // one picked file at a time
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no room in the app's cache");
                dest = new File(dir, "picked.bin");
                long done = 0, told = 0;
                try (InputStream in = cr.openInputStream(uri); OutputStream out = new java.io.FileOutputStream(dest)) {
                    if (in == null) throw new Exception("could not open the file");
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (done - told >= 16L << 20) {
                            told = done;
                            JSObject pr = new JSObject();
                            pr.put("done", done);
                            pr.put("total", total);
                            notifyListeners("pickProgress", pr);
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("only " + done + " of " + total + " bytes could be read");
                JSObject r = new JSObject();
                r.put("path", dest.getAbsolutePath());
                r.put("size", done);
                r.put("name", name);
                call.resolve(r);
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject("Could not read the file: " + e.getMessage());
            }
        }).start();
    }

    /** length bytes from offset of the file pickToCache made (at most 8 MB at a time). → { data: base64 } */
    @PluginMethod
    public void readCached(final PluginCall call) {
        new Thread(() -> {
            try {
                File f = new File(call.getString("path", "")).getCanonicalFile();
                if (!f.getPath().startsWith(importDir().getCanonicalPath() + "/")) throw new Exception("not a picked file");
                long off = Args.whole(call, "offset", 0L);
                int len = (int) Math.min(8L << 20, Math.max(0, Args.whole(call, "length", 0L)));
                byte[] buf = new byte[len];
                int got = 0;
                try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
                    raf.seek(off);
                    while (got < len) {
                        int n = raf.read(buf, got, len - got);
                        if (n < 0) break;
                        got += n;
                    }
                }
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(buf, 0, got, Base64.NO_WRAP));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read the file: " + e.getMessage());
            }
        }).start();
    }

    /** The copy pickToCache made is not needed any more. */
    @PluginMethod
    public void dropCached(PluginCall call) {
        File[] old = importDir().listFiles();
        if (old != null) for (File f : old) f.delete();
        call.resolve();
    }

    /**
     * A file the user picks on the phone (Android's file picker), streamed into Linux at `guest` – only under
     * /var/tmp/chronicle-move/, where "Import Linux home" unpacks it (decision 218). Never through the app's memory: a
     * home folder can be gigabytes. Progress: "importProgress" { done, total }. → { bytes, name } or {} when cancelled.
     */
    @PluginMethod
    public void pickIntoLinux(PluginCall call) {
        String guest = call.getString("guest", "");
        if (!guest.startsWith("/var/tmp/chronicle-move/") || guest.contains("..")) {
            call.reject("not a place for an import");
            return;
        }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "onPickedIntoLinux");
    }

    @ActivityCallback
    private void onPickedIntoLinux(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject()); // cancelled
            return;
        }
        final Uri uri = result.getData().getData();
        new Thread(() -> {
            File dest = null;
            try {
                File base = ShellPlugin.rootfsOf(getContext()).getCanonicalFile();
                dest = new File(base, call.getString("guest", "").replaceFirst("^/+", "")).getCanonicalFile();
                if (!dest.getPath().startsWith(base.getPath() + "/var/tmp/chronicle-move/")) throw new Exception("not a place for an import");
                File dir = dest.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new Exception("Linux is not set up (no /var/tmp)");
                ContentResolver cr = getContext().getContentResolver();
                long total = -1;
                String name = "file";
                try (android.database.Cursor c = cr.query(uri, new String[] { android.provider.OpenableColumns.SIZE, android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        if (!c.isNull(0)) total = c.getLong(0);
                        if (!c.isNull(1)) name = c.getString(1);
                    }
                }
                long done = 0, told = 0;
                try (InputStream in = cr.openInputStream(uri); OutputStream out = new java.io.FileOutputStream(dest)) {
                    if (in == null) throw new Exception("could not open the file");
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (done - told >= 8L << 20) {
                            told = done;
                            JSObject pr = new JSObject();
                            pr.put("done", done);
                            pr.put("total", total);
                            notifyListeners("importProgress", pr);
                        }
                    }
                }
                JSObject r = new JSObject();
                r.put("bytes", done);
                r.put("name", name);
                call.resolve(r);
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject("Could not bring the file into Linux: " + e.getMessage());
            }
        }).start();
    }

    /**
     * A file the user picks (any size: a video, an archive), streamed into a chat's folder in the app's shell storage
     * (decision 249) – `dir` like "work/<chat>/uploads", which the chat's Linux sees as /workspace/uploads. Never
     * through the app's memory. An existing name gets " (2)", " (3)"… Progress: "importProgress" { done, total }.
     * → { name, size } or {} when cancelled.
     */
    @PluginMethod
    public void pickIntoChat(PluginCall call) {
        String dir = call.getString("dir", "");
        if (!dir.startsWith("work/") || dir.contains("..")) {
            call.reject("not a place for it");
            return;
        }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        String type = call.getString("type", "*/*");
        i.setType(type == null || type.isEmpty() ? "*/*" : type);
        startActivityForResult(call, i, "onPickedIntoChat");
    }

    @ActivityCallback
    private void onPickedIntoChat(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject()); // cancelled
            return;
        }
        final Uri uri = result.getData().getData();
        new Thread(() -> {
            File dest = null;
            try {
                File base = new File(getContext().getFilesDir(), "shell").getCanonicalFile();
                File dir = new File(base, call.getString("dir", "").replaceFirst("^/+", "")).getCanonicalFile();
                if (!dir.getPath().startsWith(base.getPath() + "/work/")) throw new Exception("not a place for it");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("could not make the folder");
                ContentResolver cr = getContext().getContentResolver();
                long total = -1;
                String name = "file";
                try (android.database.Cursor c = cr.query(uri, new String[] { android.provider.OpenableColumns.SIZE, android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        if (!c.isNull(0)) total = c.getLong(0);
                        if (!c.isNull(1)) name = c.getString(1);
                    }
                }
                name = name.replaceAll("[\\\\/\\x00-\\x1f]", "_").replaceAll("^\\.+", "_").trim();
                if (name.isEmpty()) name = "file";
                if (name.length() > 120) name = name.substring(name.length() - 120);
                dest = new File(dir, name);
                int dot = name.lastIndexOf('.');
                String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
                for (int k = 2; dest.exists() && k < 1000; k++) dest = new File(dir, stem + " (" + k + ")" + ext);
                long done = 0, told = 0;
                try (InputStream in = cr.openInputStream(uri); OutputStream out = new java.io.FileOutputStream(dest)) {
                    if (in == null) throw new Exception("could not open the file");
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (done - told >= 4L << 20) {
                            told = done;
                            JSObject pr = new JSObject();
                            pr.put("done", done);
                            pr.put("total", total);
                            notifyListeners("importProgress", pr);
                        }
                    }
                }
                JSObject r = new JSObject();
                r.put("name", dest.getName());
                r.put("size", done);
                call.resolve(r);
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject("Could not put the file in the chat's folder: " + e.getMessage());
            }
        }).start();
    }

    /**
     * "Attach a file or image" (decision 262): one picker for any file, several at once. A file up to `inline` bytes comes
     * back to the app (base64) and is attached as before; a bigger one is copied into the chat's folder in Linux (`dir`),
     * never through the app's memory. → { files: [{ name, size, mime, data } | { name, size, mime, copied: true }] }
     */
    @PluginMethod
    public void pickForChat(PluginCall call) {
        String dir = call.getString("dir", "");
        if (!dir.startsWith("work/") || dir.contains("..")) {
            call.reject("not a place for it");
            return;
        }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "onPickedForChat");
    }

    @ActivityCallback
    private void onPickedForChat(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            JSObject r = new JSObject();
            r.put("files", new JSArray());
            call.resolve(r); // cancelled
            return;
        }
        final long inline = call.getLong("inline", 10L * 1024 * 1024);
        new Thread(() -> {
            JSArray out = new JSArray();
            File dest = null;
            try {
                File base = new File(getContext().getFilesDir(), "shell").getCanonicalFile();
                File dir = new File(base, call.getString("dir", "").replaceFirst("^/+", "")).getCanonicalFile();
                if (!dir.getPath().startsWith(base.getPath() + "/work/")) throw new Exception("not a place for it");
                ContentResolver cr = getContext().getContentResolver();
                for (Uri uri : uris) {
                    long total = -1;
                    String name = "file";
                    try (android.database.Cursor c = cr.query(uri, new String[] { android.provider.OpenableColumns.SIZE, android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                        if (c != null && c.moveToFirst()) {
                            if (!c.isNull(0)) total = c.getLong(0);
                            if (!c.isNull(1)) name = c.getString(1);
                        }
                    }
                    name = name.replaceAll("[\\\\/\\x00-\\x1f]", "_").replaceAll("^\\.+", "_").trim();
                    if (name.isEmpty()) name = "file";
                    if (name.length() > 120) name = name.substring(name.length() - 120);
                    String mime = cr.getType(uri);
                    JSObject o = new JSObject();
                    o.put("mime", mime == null ? "" : mime);
                    // small enough: its bytes, to be attached like any picked file (a picture stays a picture)
                    if (total >= 0 && total <= inline) {
                        ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.max(total, 16));
                        try (InputStream in = cr.openInputStream(uri)) {
                            if (in == null) throw new Exception("could not open " + name);
                            byte[] b = new byte[1 << 16];
                            int n;
                            while ((n = in.read(b)) > 0) {
                                buf.write(b, 0, n);
                                if (buf.size() > inline) break;
                            }
                        }
                        if (buf.size() <= inline) {
                            o.put("name", name);
                            o.put("size", buf.size());
                            o.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                            out.put(o);
                            continue;
                        }
                    }
                    // bigger (or of unknown size): copied into the chat's folder, a megabyte at a time
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("could not make the folder");
                    dest = new File(dir, name);
                    int dot = name.lastIndexOf('.');
                    String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
                    for (int k = 2; dest.exists() && k < 1000; k++) dest = new File(dir, stem + " (" + k + ")" + ext);
                    long done = 0, told = 0;
                    try (InputStream in = cr.openInputStream(uri); OutputStream os = new java.io.FileOutputStream(dest)) {
                        if (in == null) throw new Exception("could not open " + name);
                        byte[] b = new byte[1 << 20];
                        int n;
                        while ((n = in.read(b)) > 0) {
                            os.write(b, 0, n);
                            done += n;
                            if (done - told >= 4L << 20) {
                                told = done;
                                JSObject pr = new JSObject();
                                pr.put("done", done);
                                pr.put("total", total);
                                pr.put("name", name);
                                notifyListeners("importProgress", pr);
                            }
                        }
                    }
                    o.put("name", dest.getName());
                    o.put("size", done);
                    o.put("copied", true);
                    out.put(o);
                    dest = null;
                }
                JSObject r = new JSObject();
                r.put("files", out);
                call.resolve(r);
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject("Could not attach it: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void exportLinuxFile(PluginCall call) {
        final String guest = call.getString("guest", "");
        final String uriStr = call.getString("uri", "");
        final String path = call.getString("path", "");
        new Thread(() -> {
            try {
                // "linux": a path in the root filesystem; "shell": a chat's /workspace or /phone copy, which are
                // bound in from the app's own storage (shell/work/<chat>, shell/phone/<chat>) – nothing else
                boolean shellSide = "shell".equals(call.getString("base", "linux"));
                File base = (shellSide ? new File(getContext().getFilesDir(), "shell") : ShellPlugin.rootfsOf(getContext())).getCanonicalFile();
                File src = new File(base, guest.replaceFirst("^/+", "")).getCanonicalFile();
                String b = base.getPath() + "/";
                if (guest.isEmpty() || !src.getPath().startsWith(b)) throw new Exception("not a file inside Linux");
                String inside = "/" + src.getPath().substring(b.length());
                if (shellSide && !(inside.startsWith("/work/") || inside.startsWith("/phone/"))) throw new Exception("not a file inside Linux");
                if (!shellSide && (inside.equals("/root/.config/chronicle") || inside.startsWith("/root/.config/chronicle/"))) throw new Exception("the app's sign-in folder is never exported");
                if (!src.isFile()) throw new Exception("not a file: " + inside);
                byte[] head = new byte[8192];
                int hn;
                try (InputStream in = new java.io.FileInputStream(src)) {
                    hn = Math.max(0, in.read(head));
                }
                String h = new String(head, 0, hn, java.nio.charset.StandardCharsets.ISO_8859_1);
                if (h.contains("PRIVATE KEY-----") || h.startsWith("PuTTY-User-Key-File-")) throw new Exception("a private key is never exported");
                String name = call.getString("name", src.getName());
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                String mime = call.getString("mime", null);
                if (mime == null || mime.isEmpty()) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                if (mime == null) mime = "application/octet-stream";
                ContentResolver cr = getContext().getContentResolver();
                Uri dest;
                String folder;
                boolean pending = false;
                if (!uriStr.isEmpty()) {
                    DocumentFile dir = DocumentFile.fromTreeUri(getContext(), Uri.parse(uriStr));
                    String[] segs = parts(path.isEmpty() ? name : path);
                    if (dir == null || segs.length == 0) throw new Exception("Folder or file name missing");
                    for (int i = 0; i < segs.length - 1; i++) {
                        DocumentFile next = dir.findFile(segs[i]);
                        if (next == null) next = dir.createDirectory(segs[i]);
                        if (next == null || !next.isDirectory()) throw new Exception("Can't create folder " + segs[i]);
                        dir = next;
                    }
                    String fn = segs[segs.length - 1];
                    DocumentFile f = dir.findFile(fn);
                    if (f != null && f.isDirectory()) throw new Exception(fn + " is a folder");
                    if (f == null) f = dir.createFile(mime, fn);
                    if (f == null) throw new Exception("Couldn't create " + fn);
                    dest = f.getUri();
                    folder = dir.getName() == null ? "the phone folder" : dir.getName();
                    name = f.getName();
                } else {
                    if (android.os.Build.VERSION.SDK_INT < 29) throw new Exception("Saving to Downloads needs Android 10 or newer");
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/Chronicle");
                    v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
                    dest = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (dest == null) throw new Exception("Android did not give a place to save it");
                    folder = "Download/Chronicle";
                    pending = true;
                }
                long total = src.length();
                long done = 0;
                long told = 0;
                try (InputStream in = new java.io.FileInputStream(src); OutputStream out = cr.openOutputStream(dest, "wt")) {
                    if (out == null) throw new Exception("could not open the file for writing");
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (done - told >= 8L << 20 || done == total) {
                            told = done;
                            JSObject pr = new JSObject();
                            pr.put("done", done);
                            pr.put("total", total);
                            notifyListeners("exportProgress", pr);
                        }
                    }
                } catch (Exception e) {
                    if (pending) cr.delete(dest, null, null); // no half-written, pending entry left in Downloads
                    throw e;
                }
                if (pending) {
                    android.content.ContentValues fin = new android.content.ContentValues();
                    fin.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
                    cr.update(dest, fin, null, null);
                    try (android.database.Cursor c = cr.query(dest, new String[] { android.provider.MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                        if (c != null && c.moveToFirst()) name = c.getString(0);
                    }
                }
                JSObject r = new JSObject();
                r.put("name", name);
                r.put("folder", folder);
                r.put("bytes", done);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not save it: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        DocumentFile root = root(call);
        DocumentFile f = root == null ? null : find(root, call.getString("path", ""));
        if (f == null || parts(call.getString("path", "")).length == 0) {
            call.reject("No such file or folder");
            return;
        }
        // a folder only when it is empty: DocumentFile.delete() would take everything in it along
        DocumentFile[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null && kids.length > 0) {
            call.reject("The folder is not empty", "NOT_EMPTY");
            return;
        }
        call.resolve(new JSObject().put("ok", f.delete()));
    }

    /**
     * The page has read a big answer that came as a file (BigBytes): delete it now instead of at the 15-minute sweep.
     * Only a file directly in cache/bridge is ever deleted, whatever path the page sends.
     */
    @PluginMethod
    public void releaseBytes(PluginCall call) {
        try {
            File f = new File(call.getString("path", "")).getCanonicalFile();
            File d = BigBytes.dir(getContext()).getCanonicalFile();
            if (d.equals(f.getParentFile()) && f.isFile()) //noinspection ResultOfMethodCallIgnored
                f.delete();
        } catch (Exception ignored) {
            // a path that cannot be resolved is not one of ours
        }
        call.resolve();
    }

    @PluginMethod
    public void exists(PluginCall call) {
        DocumentFile root = root(call);
        DocumentFile f = root == null ? null : find(root, call.getString("path", ""));
        JSObject r = new JSObject();
        r.put("exists", f != null);
        r.put("isDir", f != null && f.isDirectory());
        r.put("size", f != null && f.isFile() ? f.length() : 0);
        call.resolve(r);
    }
}
