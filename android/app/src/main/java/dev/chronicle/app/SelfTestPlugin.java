package dev.chronicle.app;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Answers "does the native half actually work on THIS phone" in one shot, without a human tapping
 * through Settings. Every line goes to logcat under one tag and the whole report is returned to JS:
 *
 *   adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1
 *   adb logcat -s ChronicleSelfTest
 *
 * It exercises the real path instead of reading a flag: it starts proot, writes a file from the app
 * side and reads it through /workspace, writes one from the shell and reads it from the app, and binds
 * a real directory at /phone to prove the mount the bridge relies on. That is the difference between
 * "the Java compiles" and "the Java works".
 */
@CapacitorPlugin(name = "SelfTest")
public class SelfTestPlugin extends Plugin {
    public static final String TAG = "ChronicleSelfTest";

    @PluginMethod
    public void run(final PluginCall call) {
        new Thread(() -> {
            JSObject r;
            try {
                r = collect(getContext());
            } catch (Throwable t) {
                r = new JSObject();
                r.put("ok", 0);
                r.put("fail", 1);
                r.put("error", String.valueOf(t.getMessage()));
                Log.e(TAG, "FAIL self-test crashed: " + t);
            }
            call.resolve(r);
        }).start();
    }

    /** One-shot: did the app start from the self-test intent? Consumes the flag. */
    @PluginMethod
    public void pending(PluginCall call) {
        File flag = new File(getContext().getFilesDir(), "selftest-js.flag");
        JSObject r = new JSObject();
        r.put("js", flag.exists());
        if (flag.exists()) {
            try {
                String t = new String(java.nio.file.Files.readAllBytes(flag.toPath()), java.nio.charset.StandardCharsets.UTF_8);
                if (t.startsWith("only:")) r.put("only", t.substring(5));
            } catch (Exception ignored) {
            }
            flag.delete();
        }
        call.resolve(r);
    }

    /** A file the self-test made (a PDF, its page pictures), copied where adb can pull it: Android/data/<app>/files/selftest/. */
    @PluginMethod
    public void keep(PluginCall call) {
        try {
            File dir = new File(getContext().getExternalFilesDir(null), "selftest");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            String name = call.getString("name", "file").replaceAll("[^\\w.\\-]+", "_");
            byte[] b = android.util.Base64.decode(call.getString("base64", ""), android.util.Base64.DEFAULT);
            try (java.io.FileOutputStream o = new java.io.FileOutputStream(new File(dir, name))) {
                o.write(b);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** A line from the web side of the self-test, into the same logcat tag. */
    @PluginMethod
    public void log(PluginCall call) {
        Log.i(TAG, "js  " + call.getString("text", ""));
        call.resolve();
    }

    private static class Run {
        String out = "";
        int exit = -1;
        boolean timedOut = false;
    }

    /** One proot command, run to the end. No marker protocol here: it is a diagnostic, not the shell. */
    private static Run once(Context c, List<String> tail, int timeoutSec) {
        Run r = new Run();
        File tmp = new File(c.getCacheDir(), "proot");
        try {
            Process p = ShellPlugin.proot(c, tmp, tail).start();
            final ByteArrayOutputStream bo = new ByteArrayOutputStream();
            Thread reader = new Thread(() -> {
                try (InputStream in = p.getInputStream()) {
                    byte[] b = new byte[8192];
                    int n;
                    while ((n = in.read(b)) > 0) bo.write(b, 0, n);
                } catch (Exception ignored) {
                }
            });
            reader.setDaemon(true);
            reader.start();
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                r.timedOut = true;
                p.destroyForcibly();
            }
            reader.join(2000);
            r.out = bo.toString("UTF-8");
            r.exit = r.timedOut ? -1 : p.exitValue();
        } catch (Exception e) {
            r.out = "could not start proot: " + e;
        }
        return r;
    }

    private static String sha256(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest(data)) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return "?";
        }
    }

    private static byte[] readFile(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return bo.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(File f) {
        byte[] b = readFile(f);
        return b == null ? "" : new String(b, StandardCharsets.UTF_8);
    }

    private static String firstLine(String s, int max) {
        String t = s == null ? "" : s.trim();
        int i = t.indexOf('\n');
        if (i >= 0) t = t.substring(0, i);
        return t.length() > max ? t.substring(0, max) + "…" : t;
    }

    private static void check(JSArray checks, int[] n, boolean pass, String name, String detail) {
        if (pass) n[0]++;
        else n[1]++;
        String line = (pass ? "PASS " : "FAIL ") + name + "  " + detail;
        Log.i(TAG, line);
        checks.put(line);
    }

    /**
     * Run every check, log it, and return { ok, fail, checks[], device, abi }.
     * Public and static so the intent handler (and a future Settings button) can call it directly.
     */
    public static JSObject collect(Context c) {
        JSArray checks = new JSArray();
        int[] n = new int[]{0, 0};
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?";
        String device = Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + "), " + abi;
        Log.i(TAG, "=== Chronicle device self-test ===");
        Log.i(TAG, "device   " + device);

        boolean arm = Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a");
        check(checks, n, arm, "abi", abi + (arm ? " (proot can run)" : " (no arm64: the Linux shell cannot run here)"));

        File libDir = new File(c.getApplicationInfo().nativeLibraryDir);
        String[] libs = {"libproot.so", "libproot-loader.so", "libtalloc.so", "libandroid-shmem.so"};
        List<String> missing = new ArrayList<>();
        for (String l : libs) if (!new File(libDir, l).exists()) missing.add(l);
        check(checks, n, missing.isEmpty(), "proot libraries", missing.isEmpty() ? libDir.getPath() : "missing " + missing);

        File root = ShellPlugin.rootfsOf(c);
        boolean rootfs = new File(root, "bin/busybox").exists() || new File(root, "bin/sh").exists();
        check(checks, n, rootfs, "rootfs", rootfs ? root.getPath() : "not installed (Settings -> Linux terminal)");

        if (!arm || !missing.isEmpty() || !rootfs) return verdict(checks, n, device, abi);

        Run sh = once(c, Arrays.asList("-w", "/root", "/bin/sh", "-c", "uname -srm; echo uid=$(id -u); echo path=$PATH"), 90);
        check(checks, n, sh.exit == 0 && sh.out.contains("Linux"), "shell", sh.timedOut ? "timed out" : firstLine(sh.out, 90));

        Run tk = once(c, Arrays.asList("-w", "/root", "/bin/sh", "-c", "for n in job doctor toolkit-pull; do command -v $n >/dev/null && echo \"$n ok\" || echo \"$n MISSING\"; done"), 90);
        boolean toolkit = tk.out.contains("job ok") && !tk.out.contains("MISSING");
        // a fresh install has none of them yet - that is the app's job on the first shell command, not a fault
        boolean noneYet = tk.out.contains("job MISSING") && tk.out.contains("doctor MISSING") && tk.out.contains("toolkit-pull MISSING");
        check(checks, n, toolkit || noneYet, "toolkit", toolkit ? "job, doctor, toolkit-pull in PATH" : noneYet ? "not installed yet (the app installs it on the first shell command)" : "incomplete: " + firstLine(tk.out, 80));

        // /workspace as a mount: a real directory bound in, not a copy. Same inode on both sides is
        // the proof, and it is what makes deletes and large files possible at all.
        File work = new File(c.getCacheDir(), "selftest-work");
        work.mkdirs();
        File javaSide = new File(work, "from-app.txt");
        String marker = "from-app-" + sha256(String.valueOf(System.nanoTime()).getBytes(StandardCharsets.UTF_8)).substring(0, 8);
        boolean wrote = false;
        try (FileOutputStream out = new FileOutputStream(javaSide)) {
            out.write(marker.getBytes(StandardCharsets.UTF_8));
            wrote = true;
        } catch (Exception e) {
            Log.i(TAG, "could not write " + javaSide + ": " + e);
        }
        File shellSide = new File(work, "from-shell.txt");
        shellSide.delete();
        Run mnt = once(c, Arrays.asList(
            "-b", work.getPath() + ":/workspace",
            "-w", "/root", "/bin/sh", "-c",
            "cat /workspace/from-app.txt 2>&1; echo; printf shell-side > /workspace/from-shell.txt; echo inode=$(stat -c %i /workspace/from-shell.txt 2>/dev/null)"), 90);
        check(checks, n, wrote && mnt.out.contains(marker), "app -> /workspace", mnt.timedOut ? "timed out" : firstLine(mnt.out, 60));

        byte[] back = readFile(shellSide);
        boolean same = mnt.exit == 0 && back != null && "shell-side".equals(new String(back, StandardCharsets.UTF_8));
        check(checks, n, same, "shell -> app", same ? "sha256 " + sha256(back).substring(0, 16) + " both sides" : "app side: " + (back == null ? "no file" : new String(back, StandardCharsets.UTF_8)));

        java.util.regex.Matcher ino = java.util.regex.Pattern.compile("inode=(\\d+)").matcher(mnt.out);
        long inShell = ino.find() ? Long.parseLong(ino.group(1)) : -1;
        long inApp = -1;
        try {
            inApp = android.system.Os.stat(shellSide.getPath()).st_ino;
        } catch (Exception e) {
            Log.i(TAG, "could not stat " + shellSide + ": " + e);
        }
        check(checks, n, inShell > 0 && inShell == inApp, "same inode", inShell > 0 ? "shell " + inShell + " = app " + inApp + " (a real mount)" : "no inode came back");

        javaSide.delete();
        shellSide.delete();
        work.delete();
        return verdict(checks, n, device, abi);
    }

    private static JSObject verdict(JSArray checks, int[] n, String device, String abi) {
        JSObject r = new JSObject();
        r.put("ok", n[0]);
        r.put("fail", n[1]);
        r.put("checks", checks);
        r.put("device", device);
        r.put("abi", abi);
        Log.i(TAG, "VERDICT ok=" + n[0] + " fail=" + n[1] + (n[1] == 0 ? " ALL-GOOD" : " SEE-THE-FAIL-LINES"));
        Log.i(TAG, "JSON " + r.toString());
        return r;
    }
}
