package dev.chronicle.app;

import android.system.Os;
import android.system.StructStat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * The file mode of the bound directories, which Capacitor's Filesystem does not expose.
 *
 * Why it matters: a script created in the shell with chmod +x must stay executable when the app
 * rewrites it, or the toolkit reports "sha256 ok" for a file nobody can run - a green tick that lies.
 * Everything here is confined to the app's own files directory; a path that resolves outside it is
 * refused rather than followed.
 */
@CapacitorPlugin(name = "FileMode")
public class FileModePlugin extends Plugin {

    private String resolve(String rel) {
        try {
            File base = getContext().getFilesDir();
            File f = new File(base, rel == null ? "" : rel);
            String b = base.getCanonicalPath();
            String p = f.getCanonicalPath();
            if (p.equals(b) || p.startsWith(b + File.separator)) return p;
        } catch (Exception ignored) {
        }
        return null;
    }

    /** { exists, mode, executable, size } for one path inside the app's directory. */
    @PluginMethod
    public void stat(PluginCall call) {
        JSObject r = new JSObject();
        r.put("exists", false);
        String p = resolve(call.getString("path", ""));
        if (p != null) {
            try {
                StructStat st = Os.stat(p);
                r.put("exists", true);
                r.put("mode", st.st_mode & 07777);
                r.put("executable", (st.st_mode & 0111) != 0);
                r.put("size", st.st_size);
            } catch (Exception ignored) {
            }
        }
        call.resolve(r);
    }

    /**
     * { paths: [...] } - every regular file under one directory (relative, '/'-separated) whose mode
     * has an exec bit. One call per sync instead of one stat per file.
     */
    @PluginMethod
    public void execs(PluginCall call) {
        String root = resolve(call.getString("path", ""));
        JSArray out = new JSArray();
        if (root != null) walk(new File(root), "", out, new int[] { 0 });
        JSObject r = new JSObject();
        r.put("paths", out);
        call.resolve(r);
    }

    private void walk(File dir, String prefix, JSArray out, int[] seen) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (++seen[0] > 20000) return;
            String rel = prefix.isEmpty() ? k.getName() : prefix + "/" + k.getName();
            try {
                StructStat st = Os.lstat(k.getPath());
                if (android.system.OsConstants.S_ISDIR(st.st_mode)) {
                    if (!shellOnly(k.getName())) walk(k, rel, out, seen);
                }
                else if (android.system.OsConstants.S_ISREG(st.st_mode) && (st.st_mode & 0111) != 0) out.put(rel);
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * { files: { "<rel path>": <mode> } } - every regular file under one directory with its permission
     * bits. The whole mode, not just the exec bit: a 644 must not come back 666 (write bits added) and a
     * 600 must not lose its protection. One call per sync, same walk as execs.
     */
    @PluginMethod
    public void modes(PluginCall call) {
        String root = resolve(call.getString("path", ""));
        JSObject files = new JSObject();
        JSArray links = new JSArray();
        // stat: also each file's size and time, the folders left out and whether the walk stopped early – the whole
        // listing in this one call, instead of a call per folder from the app (decision 259)
        boolean stat = Boolean.TRUE.equals(call.getBoolean("stat", false));
        JSObject info = stat ? new JSObject() : null;
        JSArray excluded = stat ? new JSArray() : null;
        String[] incomplete = { "" };
        if (root != null) walkModes(new File(root), "", files, links, new int[] { 0 }, info, excluded, incomplete);
        JSObject r = new JSObject();
        r.put("files", files);
        // symbolic links: the app's scan must not follow them (a link to ../.. would walk the app's own folders)
        r.put("links", links);
        if (stat) {
            r.put("info", info);
            r.put("excluded", excluded);
            r.put("incomplete", incomplete[0]);
            r.put("exists", root != null && new File(root).isDirectory());
        }
        call.resolve(r);
    }

    /** What the app never mirrors (the JS scan skips them too): a package install or a clone, thousands of files. */
    // the same list as SHELL_ONLY in src/shellfs.js: caches and installs, thousands of files nobody reads through the app
    private static final java.util.Set<String> SHELL_ONLY = new java.util.HashSet<>(java.util.Arrays.asList(
        "node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache", ".gradle", ".tox", ".mypy_cache", ".pytest_cache", "target"));
    private static boolean shellOnly(String name) {
        return SHELL_ONLY.contains(name);
    }

    private void walkModes(File dir, String prefix, JSObject out, JSArray links, int[] seen, JSObject info, JSArray excluded, String[] incomplete) {
        File[] kids = dir.listFiles();
        if (kids == null) {
            if (info != null && !prefix.isEmpty() && incomplete[0].isEmpty()) incomplete[0] = "could not read " + prefix;
            return;
        }
        for (File k : kids) {
            if (++seen[0] > 20000) {
                if (incomplete[0].isEmpty()) incomplete[0] = "more than 20,000 files (the scan stopped in " + (prefix.isEmpty() ? "the top directory" : prefix) + ")";
                return;
            }
            String rel = prefix.isEmpty() ? k.getName() : prefix + "/" + k.getName();
            try {
                StructStat st = Os.lstat(k.getPath());
                if (android.system.OsConstants.S_ISLNK(st.st_mode)) links.put(rel);
                else if (android.system.OsConstants.S_ISDIR(st.st_mode)) {
                    if (!shellOnly(k.getName())) walkModes(k, rel, out, links, seen, info, excluded, incomplete);
                    else if (excluded != null) excluded.put(rel);
                }
                else if (android.system.OsConstants.S_ISREG(st.st_mode)) {
                    out.put(rel, (int) (st.st_mode & 07777));
                    // the same size and time the app's own folder listing reports (File.length / lastModified)
                    if (info != null) {
                        JSArray a = new JSArray();
                        a.put(k.length());
                        a.put(k.lastModified());
                        info.put(rel, a);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    /** chmod one path inside the app's directory. */
    @PluginMethod
    public void chmod(PluginCall call) {
        String p = resolve(call.getString("path", ""));
        if (p == null) {
            call.reject("That path is outside the app's own files");
            return;
        }
        int mode = call.getInt("mode", 0644) & 07777;
        try {
            Os.chmod(p, mode);
            JSObject r = new JSObject();
            r.put("mode", mode);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not change the mode: " + e.getMessage());
        }
    }

    /** The file keeps the time it was written at (the app's copy of a helper's write, decision 182), not the copy's. */
    @PluginMethod
    public void touch(PluginCall call) {
        String p = resolve(call.getString("path", ""));
        if (p == null) {
            call.reject("That path is outside the app's own files");
            return;
        }
        Long t = call.getLong("mtime");
        if (t == null || t <= 0) {
            call.reject("mtime is required");
            return;
        }
        JSObject r = new JSObject();
        r.put("ok", new java.io.File(p).setLastModified(t));
        call.resolve(r);
    }
}
