package dev.chronicle.app;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * A small Linux (Debian since decision 190; Alpine before) that runs inside the app, without root: proot (shipped as a native library, the only kind of
 * program Android lets an app execute) runs a root filesystem that is downloaded once into the app's private storage.
 * One persistent shell per chat, so `cd` and variables carry on between commands.
 */
@CapacitorPlugin(name = "Shell")
public class ShellPlugin extends Plugin {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Sh> shells = new java.util.concurrent.ConcurrentHashMap<>(); // touched by bridge, reader and exec threads
    private volatile boolean installing = false;

    private static class Sh {
        Process p;
        OutputStream in;
        final StringBuilder buf = new StringBuilder();
        String marker;
        String skipUntil; // a command that timed out: drop its output up to its marker, it is not the next answer
        String mounts = ""; // the bind spec this shell was started with; a different one needs a new shell
        PluginCall pending;
        Runnable timeout;
    }

    static File linuxDirOf(Context c) {
        return new File(c.getFilesDir(), "linux");
    }

    static File rootfsOf(Context c) {
        return new File(linuxDirOf(c), "rootfs");
    }

    static String libOf(Context c, String name) {
        return new File(c.getApplicationInfo().nativeLibraryDir, name).getPath();
    }

    /**
     * The one place a proot process is described (environment included). The shell and the device
     * self-test both build from here, so a wrong loader path or a missing env var shows up in the
     * self-test instead of only on the phone.
     */
    static ProcessBuilder proot(Context c, File tmp, List<String> tail) {
        tmp.mkdirs();
        List<String> cmd = new ArrayList<>();
        cmd.add(libOf(c, "libproot.so"));
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("-0");
        cmd.add("-r");
        cmd.add(rootfsOf(c).getPath());
        for (String d : new String[]{"/dev", "/proc", "/sys"}) {
            cmd.add("-b");
            cmd.add(d);
        }
        cmd.addAll(tail);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        Map<String, String> env = pb.environment();
        env.clear();
        env.put("PROOT_LOADER", libOf(c, "libproot-loader.so"));
        env.put("PROOT_TMP_DIR", tmp.getPath());
        env.put("PROOT_NO_SECCOMP", "1");
        env.put("LD_LIBRARY_PATH", c.getApplicationInfo().nativeLibraryDir);
        env.put("HOME", "/root");
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("TERM", "xterm-256color");
        env.put("LANG", "C.UTF-8");
        // no __pycache__: an edit within the same second that keeps the size (a - b -> a + b) would otherwise
        // run the OLD bytecode, and the caches would show up in the workspace as files nobody wrote
        env.put("PYTHONDONTWRITEBYTECODE", "1");
        pb.redirectErrorStream(true);
        return pb;
    }

    private File linuxDir() {
        return linuxDirOf(getContext());
    }

    private File rootfs() {
        return rootfsOf(getContext());
    }

    private String lib(String name) {
        return libOf(getContext(), name);
    }

    private boolean hasProot() {
        return new File(lib("libproot.so")).exists() && new File(lib("libproot-loader.so")).exists();
    }

    private boolean hasRootfs() {
        return new File(rootfs(), "bin/busybox").exists() || new File(rootfs(), "bin/sh").exists();
    }

    /** The installed Linux, from its /etc/os-release (ID=…). */
    private String distro() {
        File f = new File(rootfs(), "etc/os-release");
        if (!f.exists()) f = new File(rootfs(), "usr/lib/os-release");
        try {
            for (String line : new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n")) {
                if (line.startsWith("ID=")) return line.substring(3).replace("\"", "").trim();
            }
        } catch (Exception ignored) {
        }
        return hasRootfs() ? "unknown" : "";
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", hasProot() && Build.SUPPORTED_ABIS.length > 0 && Build.SUPPORTED_ABIS[0].equals("arm64-v8a"));
        r.put("installed", hasRootfs());
        r.put("installing", installing);
        r.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        r.put("distro", distro()); // "debian", "alpine" (an install from before decision 190) or ""
        call.resolve(r);
    }

    private void progress(String phase, int pct) {
        JSObject o = new JSObject();
        o.put("phase", phase);
        o.put("pct", pct);
        notifyListeners("install", o);
    }

    /**
     * Downloads the root filesystem (a .tar.gz from the given https address, checked against its SHA-256) and unpacks
     * it (decision 190). `auth`: an Authorization header for the first request only (Docker Hub's registry hands out
     * the Debian image after a sign-in token; its answer is a redirect to a download server that must not get it).
     * The home folder /root of an earlier install is kept – the user's files, clones and sign-ins stay where they are.
     */
    @PluginMethod
    public void install(final PluginCall call) {
        final String url = call.getString("url", "");
        final String sha = call.getString("sha256", "");
        final String auth = call.getString("auth", "");
        final long size = call.getLong("size", 0L);
        if (!url.startsWith("https://")) {
            call.reject("The Linux image must come from an https address");
            return;
        }
        if (installing) {
            call.reject("Already installing");
            return;
        }
        installing = true;
        new Thread(() -> {
            File tgz = new File(getContext().getCacheDir(), "rootfs.tar.gz");
            File keptHome = new File(linuxDir(), "home-kept");
            final String[] stage = {""};
            try {
                linuxDir().mkdirs();
                stage[0] = "downloading";
                progress("download", 0);
                HttpURLConnection c = open(url, auth);
                long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : size;
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tgz)) {
                    byte[] b = new byte[64 * 1024];
                    long got = 0;
                    int n;
                    int last = -1;
                    while ((n = in.read(b)) > 0) {
                        out.write(b, 0, n);
                        md.update(b, 0, n);
                        got += n;
                        int pct = total > 0 ? (int) (got * 100 / total) : 0;
                        if (pct != last) {
                            last = pct;
                            progress("download", pct);
                        }
                    }
                }
                if (!sha.isEmpty()) {
                    StringBuilder hex = new StringBuilder();
                    for (byte x : md.digest()) hex.append(String.format("%02x", x));
                    if (!hex.toString().equalsIgnoreCase(sha)) throw new Exception("The download did not match its checksum");
                }
                // nothing runs in the old Linux while it is replaced
                for (Sh sh : shells.values()) if (sh.p != null) sh.p.destroyForcibly();
                shells.clear();
                stage[0] = "unpacking";
                progress("unpack", 0);
                File root = rootfs();
                File home = new File(root, "root");
                // the home folder is never deleted here. One kept by an install that did not finish is the one to put
                // back (the /root there now is a fresh image's, or the user's: then it is set aside too, never lost)
                if (keptHome.isDirectory()) {
                    if (home.isDirectory() && !home.renameTo(new File(linuxDir(), "home-kept-" + System.currentTimeMillis())))
                        throw new Exception("Could not set the home folder /root aside");
                } else if (home.isDirectory() && !home.renameTo(keptHome)) throw new Exception("Could not keep the home folder /root");
                // unpacked into a new, empty folder – never on top of what an earlier Linux (or a failed install) left
                File fresh = new File(linuxDir(), "rootfs-new");
                deleteTree(fresh);
                if (fresh.exists()) fresh = new File(linuxDir(), "rootfs-new-" + System.currentTimeMillis());
                fresh.mkdirs();
                final long all = tgz.length();
                RootfsTar.extract(tgz, fresh, (read) -> progress("unpack", all > 0 ? (int) Math.min(99, read * 100 / all) : 0));
                if (!new File(fresh, "bin/sh").exists()) throw new Exception("Unpacking left no /bin/sh");
                // the old one is moved aside (a rename always works, whatever is inside), then deleted as far as it goes
                if (root.exists()) {
                    File old = new File(linuxDir(), "rootfs-old-" + System.currentTimeMillis());
                    if (!root.renameTo(old)) throw new Exception("Could not move the old Linux aside");
                    deleteTree(old);
                }
                if (!fresh.renameTo(root)) throw new Exception("Could not put the new Linux in place");
                // leftovers of earlier tries (a folder that could not be deleted then): another go
                File[] olds = linuxDir().listFiles((d, n) -> n.startsWith("rootfs-old-") || n.startsWith("rootfs-new"));
                if (olds != null) for (File o : olds) deleteTree(o);
                if (keptHome.isDirectory()) {
                    deleteTree(home);
                    if (!keptHome.renameTo(home)) throw new Exception("Could not put the home folder /root back");
                }
                stage[0] = "setting it up";
                setUp(root);
                progress("done", 100);
                installing = false;
                call.resolve();
            } catch (Throwable t) {
                installing = false;
                // the home folder stays where it was kept (files/linux/home-kept) – the next install that finishes puts
                // it back as /root. Nothing of it is deleted on the way.
                // the kind of error too: java.nio's "file already exists" is only the path otherwise
                String why = t.getClass().getSimpleName() + (t.getMessage() == null ? "" : ": " + t.getMessage());
                call.reject("Install failed" + (stage[0].isEmpty() ? "" : " while " + stage[0]) + ": " + why + (keptHome.isDirectory() ? " – your /root folder is kept and comes back with the next install" : ""));
            } finally {
                tgz.delete();
            }
        }).start();
    }

    /** GET with the sign-in header on the first request only; redirects followed by hand (at most 5, https only). */
    private static HttpURLConnection open(String url, String auth) throws Exception {
        String at = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(at).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            if (i == 0 && auth != null && !auth.isEmpty()) c.setRequestProperty("Authorization", auth);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = c.getHeaderField("Location");
                c.disconnect();
                if (next == null) throw new Exception("The download server sent a redirect without an address");
                at = new URL(new URL(at), next).toString();
                if (!at.startsWith("https://")) throw new Exception("The download was redirected away from https");
                continue;
            }
            if (code == 429) throw new Exception("Docker Hub's download limit for this network is reached – try again in an hour or two, or on another network");
            if (code != 200) throw new Exception("The download server answered " + code);
            return c;
        }
        throw new Exception("Too many redirects");
    }

    /**
     * What the image needs to run under proot on a phone: name servers and hosts (a container image leaves them to the
     * container runtime – often a link to a file that is not there, never written through), the Linux folders the app
     * binds, and apt told not to switch to its _apt user (proot only pretends to be root, so that switch fails).
     */
    private static void setUp(File root) throws Exception {
        for (String d : new String[] {"root", "work", "tmp", "etc/apt/apt.conf.d", "etc/profile.d"}) new File(root, d).mkdirs();
        // /tmp and /var/tmp are shared: sticky (1777), as on any Linux – Claude Code checks it
        for (String d : new String[] {"tmp", "var/tmp"}) {
            try {
                File t = new File(root, d);
                t.mkdirs();
                android.system.Os.chmod(t.getPath(), 01777);
            } catch (Exception ignored) {
            }
        }
        writeFresh(new File(root, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        File hosts = new File(root, "etc/hosts");
        if (java.nio.file.Files.isSymbolicLink(hosts.toPath()) || !hosts.exists() || hosts.length() == 0)
            writeFresh(hosts, "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n");
        if (new File(root, "usr/bin/apt-get").exists()) {
            writeFresh(new File(root, "etc/apt/apt.conf.d/99chronicle"),
                "// Chronicle (decision 190): apt under proot on a phone\n"
                    + "APT::Sandbox::User \"root\";\n"
                    + "APT::Install-Recommends \"false\";\n"
                    + "Acquire::Retries \"3\";\n"
                    + "Dpkg::Use-Pty \"false\";\n");
            writeFresh(new File(root, "etc/profile.d/chronicle-apt.sh"), "export DEBIAN_FRONTEND=noninteractive\n");
        }
    }

    /** Writes a file, replacing a link at its name instead of writing through it. */
    private static void writeFresh(File f, String text) throws Exception {
        java.nio.file.Files.deleteIfExists(f.toPath());
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        byte[] b = new byte[4096];
        int n;
        while ((n = in.read(b)) > 0) sb.append(new String(b, 0, n, StandardCharsets.UTF_8));
        return sb.toString();
    }

    private static void deleteTree(File f) {
        if (!f.exists()) return;
        try {
            // symlinks are removed, never followed
            if (java.nio.file.Files.isSymbolicLink(f.toPath())) {
                f.delete();
                return;
            }
        } catch (Exception ignored) {
        }
        // a folder the app may not read or change (a mode from the image, e.g. 0555 or 0700 as another user) is opened
        // up first: without that its files stayed, and the folder with them (a leftover /bin broke the next install)
        if (f.isDirectory()) {
            f.setReadable(true, true);
            f.setWritable(true, true);
            f.setExecutable(true, true);
        }
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    @PluginMethod
    public void uninstall(PluginCall call) {
        for (Sh s : shells.values()) if (s.p != null) s.p.destroyForcibly();
        shells.clear();
        deleteTree(linuxDir());
        call.resolve();
    }

    /** "host:guest;host:guest" -> the binds that exist and are readable. Anything else is ignored, never guessed. */
    /** With "All files access" allowed (Settings › Connections › Linux terminal), the phone's storage is at /sdcard too. */
    static String withStorage(String spec) {
        String s = spec == null ? "" : spec;
        File sd = android.os.Environment.getExternalStorageDirectory(); // /storage/emulated/0 for the main user, …/10 in a work profile or for a second user
        if (!DevicePlugin.allFiles() || !sd.isDirectory() || s.contains(":/sdcard")) return s;
        return s.isEmpty() ? sd.getPath() + ":/sdcard" : s + ";" + sd.getPath() + ":/sdcard";
    }

    private static java.util.List<String> parseMounts(String spec) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (spec == null || spec.isEmpty()) return out;
        for (String part : spec.split(";")) {
            int i = part.indexOf(':');
            if (i <= 0) continue;
            String host = part.substring(0, i).trim();
            String guest = part.substring(i + 1).trim();
            if (!host.startsWith("/") || !guest.startsWith("/") || guest.contains("..")) continue;
            File h = new File(host);
            if (!h.isDirectory() || !h.canRead()) continue;
            out.add(host + ":" + guest);
        }
        return out;
    }

    /**
     * The name servers of the network the phone is on now, then public ones (decision 272): resolv.conf was written once
     * at install as 1.1.1.1 / 8.8.8.8, so a router's names (nas.lan, homeassistant.local via the router, fritz.box)
     * never resolved, and a network that blocks public DNS left the shell with none. Written at each shell start.
     * A file the user replaced with their own (no "# chronicle" line) is left alone.
     */
    private void freshDns(File root) {
        try {
            File rc = new File(root, "etc/resolv.conf");
            if (rc.exists() && !java.nio.file.Files.isSymbolicLink(rc.toPath())) {
                String cur = new String(java.nio.file.Files.readAllBytes(rc.toPath()), StandardCharsets.UTF_8);
                if (!cur.contains("# chronicle") && !cur.equals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")) return;
            }
            StringBuilder sb = new StringBuilder("# chronicle: this network's name servers first, written at each shell start\n");
            java.util.LinkedHashSet<String> ns = new java.util.LinkedHashSet<>();
            String search = "";
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.Network net = cm == null ? null : cm.getActiveNetwork();
            android.net.LinkProperties lp = net == null ? null : cm.getLinkProperties(net);
            if (lp != null) {
                for (java.net.InetAddress a : lp.getDnsServers()) if (a instanceof java.net.Inet4Address) ns.add(a.getHostAddress());
                if (lp.getDomains() != null) search = lp.getDomains().trim();
            }
            int n = 0;
            for (String a : ns) if (n++ < 2) sb.append("nameserver ").append(a).append('\n');
            for (String a : new String[] {"1.1.1.1", "8.8.8.8"}) if (n++ < 3 && !ns.contains(a)) sb.append("nameserver ").append(a).append('\n');
            if (!search.isEmpty()) sb.append("search ").append(search.replaceAll("[^A-Za-z0-9. -]", "")).append('\n');
            sb.append("options timeout:2 attempts:2\n");
            writeFresh(rc, sb.toString());
        } catch (Exception ignored) {
        }
    }

    private Sh spawn(String id, String mountsSpec) throws Exception {
        File tmp = new File(getContext().getCacheDir(), "proot");
        new File(rootfs(), "workspace").mkdirs(); // the app-side bridge mirrors this chat's workspace here
        freshDns(rootfs());
        List<String> tail = new ArrayList<>();
        for (String b : parseMounts(mountsSpec)) {
            tail.add("-b");
            tail.add(b);
        }
        tail.add("-w");
        tail.add("/root");
        tail.add("/bin/sh");
        ProcessBuilder pb = proot(getContext(), tmp, tail);
        // a chat shell's proot does not end everything under it when its shell ends: a timed-out command's shell is
        // stopped (or it would go on with the rest of the line), and a `nohup … &` server started earlier must live on.
        // What runs here is stopped by the reaper (procs.js), not by proot; the terminal and the self-test keep the flag
        pb.command().remove("--kill-on-exit");
        // every process this shell starts inherits it: the app finds what a chat left running (`nohup … &`) by it
        pb.environment().put("OCM_SHELL", id);
        final Sh s = new Sh();
        s.mounts = mountsSpec == null ? "" : mountsSpec;
        s.p = pb.start();
        s.in = s.p.getOutputStream();
        final String key = id;
        new Thread(() -> {
            // decoded as a stream: a character split between two reads (é, emoji, CJK) is not turned into �
            try (java.io.Reader in = new java.io.InputStreamReader(s.p.getInputStream(), StandardCharsets.UTF_8)) {
                char[] b = new char[8192];
                int n;
                while ((n = in.read(b)) > 0) onData(key, s, new String(b, 0, n));
            } catch (Exception ignored) {
            }
            onExit(key, s);
        }).start();
        return s;
    }

    private void onData(String id, Sh s, String text) {
        PluginCall done = null;
        String out = null;
        int exit = 0;
        boolean quiet = false;
        synchronized (s) {
            s.buf.append(text);
            // a command that prints without end must not eat the phone's memory: keep the newest part (the marker is at the end)
            if (s.buf.length() > 4_000_000) s.buf.delete(0, s.buf.length() - 2_000_000);
            // a command that already timed out is still running: its output (and its marker) belong to
            // nobody now, so it is dropped up to its marker instead of being blamed on the next command
            if (s.skipUntil != null) {
                int i = s.buf.indexOf(s.skipUntil);
                if (i >= 0) {
                    int end = s.buf.indexOf("__", i + s.skipUntil.length());
                    if (end >= 0) {
                        s.buf.delete(0, end + 2);
                        s.skipUntil = null;
                    } else {
                        quiet = true; // the marker is here, its exit code is still arriving
                    }
                } else {
                    int keep = s.skipUntil.length() + 8;
                    if (s.buf.length() > keep) s.buf.delete(0, s.buf.length() - keep);
                    quiet = true;
                }
            }
            if (!quiet && s.marker != null) {
                int i = s.buf.indexOf(s.marker);
                if (i >= 0) {
                    int end = s.buf.indexOf("__", i + s.marker.length());
                    if (end >= 0) {
                        try {
                            exit = Integer.parseInt(s.buf.substring(i + s.marker.length(), end).trim());
                        } catch (Exception ignored) {
                        }
                        out = s.buf.substring(0, i);
                        s.buf.setLength(0);
                        done = s.pending;
                        s.pending = null;
                        s.marker = null;
                        if (s.timeout != null) ui.removeCallbacks(s.timeout);
                    }
                }
            }
        }
        if (quiet) return;
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("data", done != null ? out : text);
        if (done == null || (out != null && out.length() > 0)) notifyListeners("out", o);
        if (done != null) {
            JSObject r = new JSObject();
            r.put("output", out);
            r.put("exit", exit);
            done.resolve(r);
        }
    }

    private void onExit(String id, Sh s) {
        PluginCall done;
        String out;
        synchronized (s) {
            done = s.pending;
            s.pending = null;
            out = s.buf.toString();
            if (s.timeout != null) ui.removeCallbacks(s.timeout);
        }
        if (shells.get(id) == s) shells.remove(id);
        if (done != null) {
            JSObject r = new JSObject();
            r.put("output", out);
            // `exit 3` in a command ends the shell itself: say the code it ended with, not just "ended"
            int code = -1;
            try {
                if (s.p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) code = s.p.exitValue();
            } catch (Exception ignored) {
            }
            r.put("exit", code);
            r.put("ended", true);
            done.resolve(r);
        }
    }

    /** Runs one command in this chat's shell (started on first use) and resolves with its output and exit code. */
    @PluginMethod
    public void exec(final PluginCall call) {
        final String id = call.getString("id", "main");
        final String cmd = call.getString("cmd", "");
        final int timeoutMs = Math.max(1000, Math.min(600000, call.getInt("timeoutMs", 60000)));
        if (!hasProot() || !hasRootfs()) {
            call.reject("Linux is not installed yet");
            return;
        }
        final String mountsSpec = withStorage(call.getString("mounts", ""));
        new Thread(() -> {
            try {
                Sh s;
                synchronized (shells) {
                    s = shells.get(id);
                    if (s != null && s.p.isAlive() && !mountsSpec.equals(s.mounts)) {
                        // a bind cannot be added to a running proot: start a new shell with the new mounts
                        if (s.pending != null) {
                            call.reject("The shell is busy with another command – try again when it finishes");
                            return;
                        }
                        s.p.destroyForcibly();
                        shells.remove(id);
                        s = null;
                    }
                    if (s == null || !s.p.isAlive()) {
                        s = spawn(id, mountsSpec);
                        shells.put(id, s);
                    }
                }
                final Sh sh = s;
                synchronized (sh) {
                    if (sh.pending != null) {
                        call.reject("The previous command in this shell is still running");
                        return;
                    }
                    sh.buf.setLength(0);
                    sh.marker = "__OCMDONE" + UUID.randomUUID().toString().replace("-", "").substring(0, 10) + "_";
                    sh.pending = call;
                    sh.timeout = () -> {
                        PluginCall c;
                        String out;
                        synchronized (sh) {
                            c = sh.pending;
                            sh.pending = null;
                            out = sh.buf.toString();
                            // the command keeps running: its later output is dropped up to its marker, so
                            // the next command's answer is not polluted by it. The shell is NOT killed -
                            // that is what turned one slow build into a lost shell.
                            sh.skipUntil = sh.marker;
                            sh.marker = null;
                            sh.buf.setLength(0);
                        }
                        if (c != null) {
                            JSObject r = new JSObject();
                            r.put("output", out);
                            r.put("exit", -1);
                            r.put("timedOut", true);
                            r.put("running", true);
                            c.resolve(r);
                        }
                    };
                    ui.postDelayed(sh.timeout, timeoutMs);
                    String script = cmd + "\necho " + sh.marker + "$?__\n";
                    sh.in.write(script.getBytes(StandardCharsets.UTF_8));
                    sh.in.flush();
                }
            } catch (Throwable t) {
                call.reject("Could not run the command: " + t.getMessage());
            }
        }).start();
    }

    // ---------- full-screen programs (vim, htop, less…): a real terminal through `script` ----------
    private final Map<String, Process> ptys = new java.util.concurrent.ConcurrentHashMap<>();

    /** Start a program on a pseudo-terminal: events ptyData { id, b64 } and ptyExit { id, code }. */
    @PluginMethod
    public void ptyStart(final PluginCall call) {
        final String id = call.getString("id", "pty").replaceAll("[^A-Za-z0-9_-]", "");
        final String cmd = call.getString("cmd", "sh -l");
        final int cols = Math.max(20, Math.min(400, call.getInt("cols", 80)));
        final int rows = Math.max(5, Math.min(200, call.getInt("rows", 24)));
        if (!hasProot() || !hasRootfs()) {
            call.reject("Linux is not installed yet");
            return;
        }
        try {
            Process old = ptys.remove(id);
            if (old != null) old.destroyForcibly();
            File tmp = new File(getContext().getCacheDir(), "proot");
            List<String> tail = new ArrayList<>();
            for (String b : parseMounts(withStorage(call.getString("mounts", "")))) {
                tail.add("-b");
                tail.add(b);
            }
            tail.add("-w");
            tail.add("/root");
            tail.add("/bin/sh");
            tail.add("-c");
            // `script` gives the program a real terminal; its tty is noted so the window size can be changed later
            String inner = "tty > /tmp/ocm-pty-" + id + "; stty rows " + rows + " cols " + cols + " 2>/dev/null; exec " + cmd;
            // Debian has `script` (bsdutils); Alpine's busybox does not: there it is installed the first time (about 1 MB)
            String need = "command -v script >/dev/null 2>&1 || { echo 'Setting up the terminal (one time, about 1 MB)…'; "
                + "if command -v apk >/dev/null 2>&1; then apk add --no-cache util-linux-misc >/tmp/ocm-pty-setup.log 2>&1 || apk add --no-cache util-linux >>/tmp/ocm-pty-setup.log 2>&1; "
                + "else DEBIAN_FRONTEND=noninteractive apt-get install -y -q bsdutils >/tmp/ocm-pty-setup.log 2>&1; fi; }; "
                + "command -v script >/dev/null 2>&1 || { echo 'The terminal program (script, from util-linux) could not be installed:'; tail -n 5 /tmp/ocm-pty-setup.log; exit 127; }; ";
            tail.add(need + "exec script -q -c " + shq(inner) + " /dev/null");
            ProcessBuilder pb = proot(getContext(), tmp, tail);
            pb.environment().put("TERM", "xterm-256color");
            pb.environment().put("COLORTERM", "truecolor");
            pb.redirectErrorStream(true);
            final Process p = pb.start();
            ptys.put(id, p);
            new Thread(() -> {
                try (InputStream in = p.getInputStream()) {
                    byte[] b = new byte[16384];
                    int n;
                    while ((n = in.read(b)) > 0) {
                        JSObject o = new JSObject();
                        o.put("id", id);
                        o.put("b64", android.util.Base64.encodeToString(b, 0, n, android.util.Base64.NO_WRAP));
                        notifyListeners("ptyData", o);
                    }
                } catch (Exception ignored) {
                }
                int code = -1;
                try {
                    code = p.waitFor();
                } catch (Exception ignored) {
                }
                ptys.remove(id, p);
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("code", code);
                notifyListeners("ptyExit", o);
            }).start();
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start it: " + e.getMessage());
        }
    }

    /** Keys typed in the terminal (as text; control keys are their control characters). */
    @PluginMethod
    public void ptyWrite(PluginCall call) {
        Process p = ptys.get(call.getString("id", "pty"));
        if (p == null) {
            call.reject("Not running");
            return;
        }
        try {
            OutputStream o = p.getOutputStream();
            o.write(call.getString("data", "").getBytes(StandardCharsets.UTF_8));
            o.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** A new window size: stty on the program's terminal, then SIGWINCH to whatever runs on it. */
    @PluginMethod
    public void ptyResize(final PluginCall call) {
        final String id = call.getString("id", "pty").replaceAll("[^A-Za-z0-9_-]", "");
        final int cols = Math.max(20, Math.min(400, call.getInt("cols", 80)));
        final int rows = Math.max(5, Math.min(200, call.getInt("rows", 24)));
        new Thread(() -> {
            try {
                File tmp = new File(getContext().getCacheDir(), "proot");
                List<String> tail = new ArrayList<>();
                tail.add("/bin/sh");
                tail.add("-c");
                tail.add("T=$(cat /tmp/ocm-pty-" + id + " 2>/dev/null) && stty -F \"$T\" rows " + rows + " cols " + cols + " && for p in /proc/[0-9]*; do [ \"$(readlink $p/fd/0 2>/dev/null)\" = \"$T\" ] && kill -WINCH ${p#/proc/} 2>/dev/null; done; true");
                Process p = proot(getContext(), tmp, tail).start();
                p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception ignored) {
            }
            call.resolve();
        }).start();
    }

    @PluginMethod
    public void ptyKill(PluginCall call) {
        Process p = ptys.remove(call.getString("id", "pty"));
        if (p != null) p.destroyForcibly();
        call.resolve();
    }

    private static String shq(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /**
     * Stops this chat's shell (a running command is cut off). proot runs with --kill-on-exit, so destroying it kills
     * everything under it – a `nohup … &` server started earlier too. With spare: true (the reaper has already
     * stopped the command and the shell that ran it) the proot is only let go: its input is closed and it ends by
     * itself once its last process, such a server, ends. The chat's next command gets a new shell.
     */
    @PluginMethod
    public void kill(PluginCall call) {
        String id = call.getString("id", "main");
        Sh s = shells.remove(id);
        if (s != null && s.p != null) {
            if (Boolean.TRUE.equals(call.getBoolean("spare", false))) {
                try {
                    s.in.close();
                } catch (Exception ignored) {
                }
            } else s.p.destroyForcibly();
        }
        call.resolve();
    }
}
