package dev.chronicle.app;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.zip.GZIPInputStream;

/**
 * Unpacks a root filesystem (.tar.gz) into a folder, in Java (decision 190). Android's own tar cannot make the hard
 * links a Debian image has (an app may not create hard links in its storage – proot fakes them for the same reason):
 * here a hard link becomes a copy of the file. Symbolic links, modes and dates are kept; ustar, GNU long names and pax
 * headers are read. Nothing is written outside the folder: a name with ".." or a link that would lead out is refused.
 * Plain Java only (java.nio needs API 26, the app's minimum), so it is tested on a computer too.
 */
public final class RootfsTar {
    public interface Progress {
        void at(long bytesRead);
    }

    private RootfsTar() {}

    /** → the number of entries unpacked. */
    public static int extract(File tgz, File dest, Progress progress) throws IOException {
        Path root = dest.getCanonicalFile().toPath();
        Files.createDirectories(root);
        List<Object[]> dirModes = new ArrayList<>(); // set last: a read-only folder must still be written into first
        int n = 0;
        try (CountingInput counted = new CountingInput(new FileInputStream(tgz), progress);
             InputStream in = new BufferedInputStream(new GZIPInputStream(new BufferedInputStream(counted, 1 << 16), 1 << 16), 1 << 16)) {
            byte[] h = new byte[512];
            String longName = null;
            String longLink = null;
            String paxPath = null;
            String paxLink = null;
            long paxSize = -1;
            while (true) {
                if (!readFully(in, h)) break;
                if (allZero(h)) break; // end of archive
                String name = str(h, 0, 100);
                String prefix = str(h, 345, 155);
                if (!prefix.isEmpty() && "ustar".equals(str(h, 257, 5))) name = prefix + "/" + name;
                char type = (char) h[156];
                long size = num(h, 124, 12);
                int mode = (int) num(h, 100, 8);
                long mtime = num(h, 136, 12);
                String link = str(h, 157, 100);
                if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                    byte[] data = readData(in, size);
                    if (type == 'L') longName = cstr(data);
                    else if (type == 'K') longLink = cstr(data);
                    else if (type == 'x') {
                        for (String[] kv : pax(data)) {
                            if (kv[0].equals("path")) paxPath = kv[1];
                            else if (kv[0].equals("linkpath")) paxLink = kv[1];
                            else if (kv[0].equals("size")) paxSize = Long.parseLong(kv[1]);
                        }
                    }
                    continue;
                }
                if (longName != null) name = longName;
                if (paxPath != null) name = paxPath;
                if (longLink != null) link = longLink;
                if (paxLink != null) link = paxLink;
                if (paxSize >= 0) size = paxSize;
                longName = longLink = paxPath = paxLink = null;
                paxSize = -1;

                Path target = inside(root, name);
                if (target == null || target.equals(root) || name.contains("/.wh.") || name.startsWith(".wh.")) {
                    skip(in, (type == '0' || type == 0 || type == '7') ? size : 0);
                    if (target != null && target.equals(root) && type == '5') dirModes.add(new Object[] {root, mode, mtime});
                    continue;
                }
                Files.createDirectories(target.getParent());
                switch (type) {
                    case '5':
                        if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
                            clear(target);
                            Files.createDirectory(target);
                        }
                        dirModes.add(new Object[] {target, mode, mtime});
                        break;
                    case '2':
                        clear(target);
                        Files.createSymbolicLink(target, new File(link).toPath()); // as written: proot resolves it inside
                        break;
                    case '1': {
                        // a hard link: a copy of the file it names (both were the same file; nothing writes through it)
                        Path from = inside(root, link);
                        clear(target);
                        if (from != null && Files.isRegularFile(from, LinkOption.NOFOLLOW_LINKS)) {
                            Files.copy(from, target);
                            chmod(target, mode);
                            target.toFile().setLastModified(mtime * 1000);
                        }
                        break;
                    }
                    case '0':
                    case 0:
                    case '7': {
                        clear(target);
                        try (OutputStream out = new FileOutputStream(target.toFile())) {
                            copy(in, out, size);
                        }
                        chmod(target, mode);
                        target.toFile().setLastModified(mtime * 1000);
                        break;
                    }
                    default:
                        skip(in, size); // devices and FIFOs: proot binds the real /dev
                }
                n++;
            }
        }
        for (int i = dirModes.size() - 1; i >= 0; i--) {
            Object[] d = dirModes.get(i);
            chmod((Path) d[0], (Integer) d[1]);
            ((Path) d[0]).toFile().setLastModified((Long) d[2] * 1000);
        }
        return n;
    }

    /** Whatever is at the path goes – a whole folder too (a name that was a folder before and is a link now). */
    static void clear(Path p) throws IOException {
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
            File d = p.toFile();
            d.setReadable(true, true);
            d.setWritable(true, true);
            d.setExecutable(true, true);
            File[] kids = d.listFiles();
            if (kids != null) for (File k : kids) clear(k.toPath());
        }
        Files.deleteIfExists(p);
    }

    /** The path inside the root, or null when the name leads out of it. */
    static Path inside(Path root, String name) {
        String n = name.replace('\\', '/');
        while (n.startsWith("./")) n = n.substring(2);
        while (n.startsWith("/")) n = n.substring(1);
        if (n.isEmpty() || n.equals(".")) return root;
        for (String part : n.split("/")) if (part.equals("..")) return null;
        Path p = root.resolve(n).normalize();
        return p.startsWith(root) ? p : null;
    }

    private static void chmod(Path p, int mode) {
        Set<PosixFilePermission> s = EnumSet.noneOf(PosixFilePermission.class);
        PosixFilePermission[] all = {
            PosixFilePermission.OTHERS_EXECUTE, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_READ,
            PosixFilePermission.GROUP_EXECUTE, PosixFilePermission.GROUP_WRITE, PosixFilePermission.GROUP_READ,
            PosixFilePermission.OWNER_EXECUTE, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_READ,
        };
        for (int i = 0; i < 9; i++) if ((mode & (1 << i)) != 0) s.add(all[i]);
        // the app owns every file: it always needs to read and change them (and enter its folders) itself
        s.add(PosixFilePermission.OWNER_READ);
        s.add(PosixFilePermission.OWNER_WRITE);
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) s.add(PosixFilePermission.OWNER_EXECUTE);
        try {
            Files.setPosixFilePermissions(p, s);
        } catch (Exception ignored) {
            // a file system without modes: the defaults stay
        }
        // the special bits java.nio cannot set: sticky (/tmp, /var/tmp are 1777 – Claude Code refuses a /tmp without it),
        // setuid/setgid. Android's Os.chmod can; looked up by name so this class stays plain Java (tests on a computer)
        if ((mode & 07000) != 0 && OS_CHMOD != null) {
            try {
                int bits = (mode & 07777) | 0600 | (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) ? 0100 : 0);
                OS_CHMOD.invoke(null, p.toString(), bits);
            } catch (Exception ignored) {
                // kept without it
            }
        }
    }

    private static final java.lang.reflect.Method OS_CHMOD = osChmod();

    private static java.lang.reflect.Method osChmod() {
        try {
            return Class.forName("android.system.Os").getMethod("chmod", String.class, int.class);
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean allZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    private static String str(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static String cstr(byte[] b) {
        int end = 0;
        while (end < b.length && b[end] != 0) end++;
        return new String(b, 0, end, StandardCharsets.UTF_8);
    }

    /** An octal field, or a base-256 one (the high bit set: sizes over 8 GB). */
    static long num(byte[] b, int off, int len) {
        if ((b[off] & 0x80) != 0) {
            long v = b[off] & 0x7f;
            for (int i = off + 1; i < off + len; i++) v = (v << 8) | (b[i] & 0xff);
            return v;
        }
        long v = 0;
        for (int i = off; i < off + len; i++) {
            int c = b[i];
            if (c == 0 || c == ' ') {
                if (v > 0) break;
                continue;
            }
            if (c < '0' || c > '7') break;
            v = v * 8 + (c - '0');
        }
        return v;
    }

    /** pax records: "len key=value\n" → [key, value] pairs. */
    private static List<String[]> pax(byte[] data) {
        List<String[]> out = new ArrayList<>();
        int i = 0;
        while (i < data.length) {
            int sp = i;
            while (sp < data.length && data[sp] != ' ') sp++;
            if (sp >= data.length) break;
            int len;
            try {
                len = Integer.parseInt(new String(data, i, sp - i, StandardCharsets.UTF_8));
            } catch (NumberFormatException e) {
                break;
            }
            if (len <= 0 || i + len > data.length) break;
            String rec = new String(data, sp + 1, i + len - sp - 1, StandardCharsets.UTF_8);
            if (rec.endsWith("\n")) rec = rec.substring(0, rec.length() - 1);
            int eq = rec.indexOf('=');
            if (eq > 0) out.add(new String[] {rec.substring(0, eq), rec.substring(eq + 1)});
            i += len;
        }
        return out;
    }

    private static boolean readFully(InputStream in, byte[] b) throws IOException {
        int got = 0;
        while (got < b.length) {
            int n = in.read(b, got, b.length - got);
            if (n < 0) {
                if (got == 0) return false;
                throw new IOException("The image ends in the middle of an entry");
            }
            got += n;
        }
        return true;
    }

    private static byte[] readData(InputStream in, long size) throws IOException {
        if (size > 16 * 1024 * 1024) throw new IOException("A header entry is too big");
        byte[] b = new byte[(int) size];
        if (size > 0 && !readFully(in, b)) throw new IOException("The image ends early");
        skipPad(in, size);
        return b;
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = size;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("The image ends in the middle of a file");
            out.write(buf, 0, n);
            left -= n;
        }
        skipPad(in, size);
    }

    private static void skip(InputStream in, long size) throws IOException {
        long left = size + pad(size);
        byte[] buf = new byte[1 << 16];
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("The image ends early");
            left -= n;
        }
    }

    private static long pad(long size) {
        return (512 - (size % 512)) % 512;
    }

    private static void skipPad(InputStream in, long size) throws IOException {
        long p = pad(size);
        byte[] b = new byte[(int) p];
        if (p > 0 && !readFully(in, b)) throw new IOException("The image ends early");
    }

    /** Counts the compressed bytes read, for the progress bar. */
    private static final class CountingInput extends java.io.FilterInputStream {
        private final Progress progress;
        private long count;
        private long told;

        CountingInput(InputStream in, Progress progress) {
            super(in);
            this.progress = progress;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) tick(1);
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) tick(n);
            return n;
        }

        private void tick(long n) {
            count += n;
            if (progress != null && count - told > (1 << 20)) {
                told = count;
                progress.at(count);
            }
        }
    }
}
