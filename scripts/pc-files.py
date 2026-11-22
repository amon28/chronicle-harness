#!/usr/bin/env python3
"""
pc-files: lets Chronicle's assistant on your phone look at (and, if you allow it, save to) folders on this computer.
Python 3.8+, nothing to install.

    python3 pc-files.py ~/Documents ~/Projects/game
    python3 pc-files.py --write ~/Projects/game         # also let it save files (never delete)
    python3 pc-files.py --full                          # full control: any file, and run commands (see below)
    python3 pc-files.py ~/Projects --write --autostart  # remember these settings and start at every log-in

It prints a QR code: in Chronicle, Settings › Connections › Files on my PC › Scan the QR (or type the address and the
secret it prints). Every request needs "Authorization: Bearer <secret>". Use it on your own network, or over
Tailscale/WireGuard from elsewhere (--host 100.x.y.z listens only there): anyone with the address and the secret can
use what you share.

Only the folders you name are reachable – nothing above them, and no link inside them that points out of them. Each
folder gets a short name (its folder name, or the one you give as name=path); the phone sees paths like
"game/src/main.py". Read-only unless you start it with --write. Hidden files and folders (.git, .env, .ssh…) are left
out unless you start it with --dotfiles.

--full gives the phone FULL CONTROL of this computer, as your user: every file (absolute paths like /home/you/x or
C:/Users/you/x, hidden ones included, reading and saving) and running commands. Chronicle asks you on the phone before
each command unless that chat is in Auto or Bypass mode. Only use it with a phone and a network you trust.

  GET  /health                         {app, version, write, full, os, folders: [{name}]}
  POST /list   {path, recursive}       {entries: [{path, dir, size, mtime}], cut}
  POST /stat   {path}                  {exists, dir, size, mtime}
  POST /read   {path, offset, length}  {data: base64, size, eof}
  POST /search {path, name, text, max} {matches: [{path, line, text} | {path}], cut}
  POST /write  {path, data: base64, append, mkdirs}   {size}   (with --write or --full)
  POST /exec   {command, cwd, timeout, wait}  {job, running, exit, stdout, stderr, timed_out}   (only with --full)
               a command still running after `wait` (default 20 s) goes on as a job; timeout (default 600 s) ends it
  POST /job    {job, wait, kill}       the same, for a job: wait up to 25 s more, read its output, or kill it
  POST /preview {command, cwd}         what a kill or delete would hit: {processes: [...], files: [...]}
"""
import base64, fnmatch, json, os, platform, secrets, shutil, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 3
MAX_READ = 8 * 1024 * 1024
MAX_WRITE = 32 * 1024 * 1024
MAX_LIST = 2000
MAX_SEARCH_FILE = 4 * 1024 * 1024
MAX_OUT = 200 * 1024
IS_WIN = os.name == "nt"

USAGE = """usage: pc-files.py FOLDER [FOLDER …] [--write] [--full] [--autostart] [--port 8766]

  Folders are written without a dash in front. For example:
    Windows:      py pc-files.py C:\\Users\\you\\Desktop --write
                  py pc-files.py "C:\\Users\\you\\Desktop\\New folder"
                  py pc-files.py ~/Desktop           (~ is your user folder)
    Mac / Linux:  python3 pc-files.py ~/Desktop ~/Projects/game --write

  --write         also let the assistant save files there (it never deletes)
  --dotfiles      also share hidden files (.git, .env, .ssh…) – usually leave this off
  --full          FULL CONTROL: every file on this computer and running commands (asked on the phone first)
  name=FOLDER     give a folder its own short name, e.g. notes=~/Documents/Notes
  --host IP       listen only on this address (e.g. your Tailscale 100.x.y.z); default all networks
  --autostart     remember these settings (and the secret) and start in the background at every log-in
  --no-autostart  stop starting at log-in, and stop the background copy
  --show-qr       show the QR code and address of the saved settings again (e.g. when it started by itself)
  --stop          stop the background copy (it starts again at the next log-in while --autostart is on)
  --no-qr / --qr-invert   no QR code / dark modules light (for terminals with a light background)"""


# ---------- a QR code, drawn in the terminal (byte mode, error correction L, versions 1–6: up to 134 characters) ----------

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _gmul(a, b):
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _rs(data, n):
    gen = [1]
    for i in range(n):
        nxt = [0] * (len(gen) + 1)
        for j, c in enumerate(gen):
            nxt[j] ^= c
            nxt[j + 1] ^= _gmul(c, _EXP[i])
        gen = nxt
    rem = [0] * n
    for b in data:
        f = b ^ rem[0]
        rem = rem[1:] + [0]
        for i in range(n):
            rem[i] ^= _gmul(gen[i + 1], f)
    return rem


# version: (data codewords in all, error-correction codewords per block, blocks), alignment pattern centres
_QR_L = {1: (19, 7, 1), 2: (34, 10, 1), 3: (55, 15, 1), 4: (80, 20, 1), 5: (108, 26, 1), 6: (136, 18, 2)}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}


def qr_matrix(text):
    """→ a square list of rows of booleans (True = dark), or None when the text is too long."""
    data = text.encode("utf-8")
    ver = next((v for v in range(1, 7) if 4 + 8 + 8 * len(data) <= _QR_L[v][0] * 8), None)
    if ver is None:
        return None
    ndata, nec, nblocks = _QR_L[ver]
    bits = [0, 1, 0, 0] + [(len(data) >> i) & 1 for i in range(7, -1, -1)]
    for b in data:
        bits += [(b >> i) & 1 for i in range(7, -1, -1)]
    bits += [0] * min(4, ndata * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    words = [int("".join(map(str, bits[i : i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    while len(words) < ndata:
        words.append(pad[(len(words) - len(bits) // 8) % 2])
    per = ndata // nblocks
    blocks = [words[i * per : (i + 1) * per] for i in range(nblocks)]
    ecs = [_rs(b, nec) for b in blocks]
    final = [b[i] for i in range(per) for b in blocks] + [e[i] for i in range(nec) for e in ecs]

    size = 17 + 4 * ver
    mod = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        mod[y][x] = dark
        fn[y][x] = True

    for i in range(size):  # timing
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):  # finders and their separators
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    d = max(abs(dx), abs(dy))
                    setf(x, y, d not in (2, 4))
    al = _ALIGN[ver]
    for i, ay in enumerate(al):
        for j, ax in enumerate(al):
            if (i == 0 and j == 0) or (i == 0 and j == len(al) - 1) or (i == len(al) - 1 and j == 0):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)

    def draw_format(mask):
        d = (1 << 3) | mask  # error correction L = 01
        rem = d
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        f = ((d << 10) | rem) ^ 0x5412
        bit = lambda i: (f >> i) & 1 == 1
        for i in range(6):
            setf(8, i, bit(i))
        setf(8, 7, bit(6))
        setf(8, 8, bit(7))
        setf(7, 8, bit(8))
        for i in range(9, 15):
            setf(14 - i, 8, bit(i))
        for i in range(8):
            setf(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, bit(i))
        setf(8, size - 8, True)

    draw_format(0)  # reserves the format areas before the data goes in
    i = 0
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                y = size - 1 - vert if ((right + 1) & 2) == 0 else vert
                if not fn[y][x] and i < len(final) * 8:
                    mod[y][x] = (final[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2

    masks = [
        lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0, lambda x, y: (x + y) % 3 == 0,
        lambda x, y: (x // 3 + y // 2) % 2 == 0, lambda x, y: x * y % 2 + x * y % 3 == 0,
        lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0, lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
    ]

    def apply(m):
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and masks[m](x, y):
                    mod[y][x] = not mod[y][x]

    def penalty():
        p = 0
        for lines in (mod, [list(c) for c in zip(*mod)]):
            for row in lines:
                run, prev = 0, None
                for v in row:
                    run = run + 1 if v == prev else 1
                    prev = v
                    if run == 5:
                        p += 3
                    elif run > 5:
                        p += 1
                s = "".join("1" if v else "0" for v in row)
                p += 40 * (s.count("10111010000") + s.count("00001011101"))
        for y in range(size - 1):
            for x in range(size - 1):
                if mod[y][x] == mod[y][x + 1] == mod[y + 1][x] == mod[y + 1][x + 1]:
                    p += 3
        dark = sum(map(sum, mod))
        p += abs(dark * 20 - size * size * 10) // (size * size) * 10
        return p

    best = None
    for m in range(8):
        apply(m)
        draw_format(m)
        score = penalty()
        if best is None or score < best[0]:
            best = (score, m)
        apply(m)  # undo (masking twice restores)
    apply(best[1])
    draw_format(best[1])
    return mod


def qr_text(text, invert=False):
    """The QR code as terminal text: two rows per line with half blocks, a quiet zone of 2 around it."""
    m = qr_matrix(text)
    if m is None:
        return None
    q = 2
    size = len(m) + 2 * q
    dark = lambda x, y: q <= x < size - q and q <= y < size - q and m[y - q][x - q]
    light = lambda x, y: dark(x, y) if invert else not dark(x, y)  # a dark terminal: light modules are drawn
    lines = []
    for y in range(0, size, 2):
        row = ""
        for x in range(size):
            a, b = light(x, y), y + 1 < size and light(x, y + 1)
            row += "█" if a and b else "▀" if a else "▄" if b else " "
        lines.append(row)
    return "\n".join(lines)


# ---------- saved settings and auto start ----------


def config_dir():
    base = os.environ.get("APPDATA") if IS_WIN else os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base or os.path.expanduser("~"), "chronicle-pc")


CONFIG = os.path.join(config_dir(), "config.json")
PIDFILE = os.path.join(config_dir(), "pc-files.pid")
LOGFILE = os.path.join(config_dir(), "pc-files.log")


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_config(c):
    os.makedirs(config_dir(), exist_ok=True)
    with open(CONFIG, "w") as f:
        json.dump(c, f, indent=2)
    if not IS_WIN:
        os.chmod(CONFIG, 0o600)  # it holds the secret


def find_folder(path):
    """The folder a typed path means, or None. Takes off stray quotes (cmd keeps a quote after a final backslash)."""
    path = path.strip().strip('"').strip("'").rstrip("\\/") or path
    real = os.path.realpath(os.path.expanduser(path))
    return real if os.path.isdir(real) else None


def not_a_folder(path):
    msg = f"not a folder: {path}"
    p = path.strip().strip('"')
    if p.startswith("-"):
        rest = p.lstrip("-")
        msg += f"\n  Folders are written without a dash in front: {rest!r}" + (" is a folder, so use that." if find_folder(rest) else ".")
    home = os.path.expanduser("~")
    real = os.path.realpath(os.path.expanduser(p.lstrip("-")))
    # Windows often keeps Desktop and Documents in OneDrive
    if real.lower().startswith(home.lower() + os.sep):
        od = os.path.join(home, "OneDrive", real[len(home) + 1 :])
        if os.path.isdir(od):
            msg += f"\n  Your Desktop/Documents are in OneDrive on this PC – try: {od}"
    if '" ' in path or path.endswith('"'):
        msg += '\n  In cmd, a backslash right before a closing quote ("…\\") swallows the quote – leave the last backslash out.'
    return msg + "\n\n" + USAGE


if sys.argv[1:2] == ["--qr-matrix"]:  # for tests: the QR code of a text as rows of 0/1
    m = qr_matrix(sys.argv[2] if len(sys.argv) > 2 else "")
    sys.exit(print("\n".join("".join("1" if v else "0" for v in row) for row in m)) if m else "too long")

args = sys.argv[1:]
# cmd hands '"C:\x\" --write' over as one word: split it again
args = [w for a in args for w in ([a.split('" ', 1)[0], *a.split('" ', 1)[1].split()] if '" ' in a else [a])]
port, host, secret, allow_write, dotfiles, full, port_file = 8766, "0.0.0.0", os.environ.get("PC_FILES_SECRET") or "", False, False, False, None
roots = {}
action, show_qr, qr_invert, from_config, logfile = "", True, False, False, None
while args:
    k = args.pop(0).strip()
    if k == "--write":
        allow_write = True
    elif k == "--dotfiles":
        dotfiles = True
    elif k == "--full":
        full = True
    elif k in ("--autostart", "--no-autostart", "--show-qr", "--stop"):
        action = k
    elif k == "--no-qr":
        show_qr = False
    elif k == "--qr-invert":
        qr_invert = True
    elif k == "--from-config":
        from_config = True
    elif k == "--secret-stdin":
        secret = sys.stdin.readline().strip()
    elif k in ("--port", "--host", "--secret", "--port-file", "--log"):
        v = args.pop(0) if args else ""
        if k == "--port":
            port = int(v)
        elif k == "--host":
            host = v
        elif k == "--secret":
            secret = v
        elif k == "--log":
            logfile = v
        else:
            port_file = v
    elif k in ("-h", "--help", "/?"):
        print(__doc__)
        print(USAGE)
        sys.exit(0)
    elif k.startswith("--"):
        sys.exit(f"unknown option {k}\n\n{USAGE}")
    else:
        name, _, path = k.partition("=") if "=" in k and not find_folder(k) else ("", "", k)
        real = find_folder(path)
        if not real:
            sys.exit(not_a_folder(path))
        name = (name or os.path.basename(real.rstrip(os.sep)) or "root").replace("/", "_").replace("\\", "_")
        base, n = name, 2
        while name in roots:
            name, n = f"{base}-{n}", n + 1
        roots[name] = real

if logfile:  # started in the background (no console): what it prints goes to a file
    os.makedirs(os.path.dirname(os.path.abspath(logfile)), exist_ok=True)
    sys.stdout = sys.stderr = open(logfile, "a", buffering=1, encoding="utf-8")


def lan_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        a = s.getsockname()[0]
        s.close()
        return a
    except OSError:
        return "127.0.0.1"


def pairing_link(addr, sec):
    from urllib.parse import quote

    return f"chronicle://pc?u={quote(addr, safe='')}&s={quote(sec, safe='')}&n={quote(socket.gethostname()[:24], safe='')}"


def print_pairing(addr, sec, show_secret=True):
    print(f"Address: {addr}")
    if show_secret:
        print(f"Secret:  {sec}")
    if show_qr:
        q = qr_text(pairing_link(addr, sec), qr_invert)
        if q:
            print("\nScan this in Chronicle (Settings › Connections › Files on my PC › Scan the QR):\n")
            print(q)
            print("\n(No QR on a light terminal? Add --qr-invert.)")
    print("Or enter the address and the secret by hand.", flush=True)


def stop_background():
    try:
        with open(PIDFILE) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return False
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, creationflags=0x08000000)
        else:
            os.kill(pid, 15)
    except OSError:
        pass
    try:
        os.remove(PIDFILE)
    except OSError:
        pass
    return True


SCRIPT_COPY = os.path.join(config_dir(), "pc-files.py")
SERVICE = "chronicle-pc-files"


def autostart_paths():
    if IS_WIN:
        return os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs\Startup", SERVICE + ".vbs")
    if sys.platform == "darwin":
        return os.path.expanduser(f"~/Library/LaunchAgents/dev.chronicle.pc-files.plist")
    return os.path.expanduser(f"~/.config/systemd/user/{SERVICE}.service")


def background_python():
    if IS_WIN:
        # the windowless Python: next to this one, next to the base install (a venv), or on PATH
        for d in (os.path.dirname(sys.executable), os.path.dirname(getattr(sys, "_base_executable", "") or ""), sys.exec_prefix, sys.base_exec_prefix):
            w = os.path.join(d or "", "pythonw.exe")
            if d and os.path.exists(w):
                return w
        return shutil.which("pythonw") or sys.executable
    return sys.executable


def install_autostart():
    """Copies this script next to the saved settings (so moving the download does not break it) and starts it at log-in."""
    shutil.copyfile(os.path.abspath(__file__), SCRIPT_COPY)
    py = background_python()
    cmd = [py, SCRIPT_COPY, "--from-config", "--log", LOGFILE]
    path = autostart_paths()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if IS_WIN:
        # a .vbs starts it with no window at all (a .cmd in Startup flashes a console window at every log-in)
        line = " ".join('""' + c + '""' for c in cmd)
        with open(path, "w") as f:
            f.write(f'CreateObject("WScript.Shell").Run "{line}", 0, False\r\n')
        old = path[: -len(".vbs")] + ".cmd"  # what an earlier version put there
        if os.path.exists(old):
            os.remove(old)
        # started now the same way as at log-in: Windows Script Host runs it with the window hidden (style 0), which
        # works whichever python it is – started directly, some Python installs still got a console window, and closing
        # that window stopped sharing
        subprocess.Popen(["wscript.exe", path], creationflags=0x08000000, close_fds=True)
        return "Windows Startup folder"
    if sys.platform == "darwin":
        items = "".join(f"<string>{c}</string>" for c in cmd)
        with open(path, "w") as f:
            f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.chronicle.pc-files</string><key>ProgramArguments</key><array>{items}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n')
        subprocess.run(["launchctl", "unload", path], capture_output=True)
        subprocess.run(["launchctl", "load", "-w", path], capture_output=True)
        return "a LaunchAgent"
    if shutil.which("systemctl"):
        with open(path, "w") as f:
            f.write(f"[Unit]\nDescription=Chronicle pc-files\nAfter=network-online.target\n\n[Service]\nExecStart={' '.join(cmd)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n")
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        r = subprocess.run(["systemctl", "--user", "enable", "--now", SERVICE + ".service"], capture_output=True, text=True)
        if r.returncode == 0:
            return "a systemd user service"
    # no systemd (or it refused): the desktop's own autostart, and a copy started now
    desk = os.path.expanduser(f"~/.config/autostart/{SERVICE}.desktop")
    os.makedirs(os.path.dirname(desk), exist_ok=True)
    with open(desk, "w") as f:
        f.write(f"[Desktop Entry]\nType=Application\nName=Chronicle pc-files\nExec={' '.join(cmd)}\nX-GNOME-Autostart-enabled=true\n")
    subprocess.Popen(cmd, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return "the desktop's autostart"


def remove_autostart():
    path = autostart_paths()
    if sys.platform == "darwin":
        subprocess.run(["launchctl", "unload", "-w", path], capture_output=True)
    elif not IS_WIN and shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "disable", "--now", SERVICE + ".service"], capture_output=True)
    for p in (path, path[: -len(".vbs")] + ".cmd", os.path.expanduser(f"~/.config/autostart/{SERVICE}.desktop")):
        try:
            os.remove(p)
        except OSError:
            pass
    stop_background()


cfg = load_config()
if action == "--stop":
    sys.exit(print("Stopped the background copy." if stop_background() else "No background copy is running.") or 0)
if action == "--no-autostart":
    remove_autostart()
    sys.exit(print("Auto start is off, and the background copy is stopped. The saved settings stay in " + CONFIG) or 0)
if action == "--show-qr":
    if not cfg:
        sys.exit("Nothing is saved yet – start it once with --autostart (and your folders).")
    h = cfg.get("host", "0.0.0.0")
    print_pairing(f"http://{lan_address() if h in ('0.0.0.0', '') else h}:{cfg.get('port', 8766)}", cfg["secret"])
    sys.exit(0)

if from_config or (not roots and not full and cfg and action != "--autostart"):
    if not cfg:
        sys.exit("No saved settings – start it with your folders (and --autostart to save them).")
    roots = dict(cfg.get("folders") or {})
    allow_write, dotfiles, full = bool(cfg.get("write")), bool(cfg.get("dotfiles")), bool(cfg.get("full"))
    host, port, secret = cfg.get("host", host), int(cfg.get("port", port)), secret or cfg.get("secret", "")
if full and not roots:
    roots["home"] = os.path.realpath(os.path.expanduser("~"))
if full:
    allow_write = dotfiles = True
if not roots:
    sys.exit("Say which folders to share.\n\n" + USAGE)
given = bool(secret)
# the saved secret stays: the phone keeps working after a restart, and when --autostart is run again
secret = secret or (cfg or {}).get("secret") if action == "--autostart" else secret
secret = secret or secrets.token_urlsafe(18)

if action == "--autostart":
    save_config({"folders": roots, "write": allow_write, "dotfiles": dotfiles, "full": full, "host": host, "port": port, "secret": secret})
    stop_background()
    how = install_autostart()
    print(f"Saved in {CONFIG} and set to start at log-in ({how}); it is running in the background now.")
    print(f"Log: {LOGFILE}.  Undo: --no-autostart.  QR again: --show-qr.\n")
    print_pairing(f"http://{lan_address() if host in ('0.0.0.0', '') else host}:{port}", secret)
    sys.exit(0)


class Refused(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def is_abs(p):
    s = str(p or "")
    return s.startswith("/") or (len(s) > 2 and s[1] == ":" and s[2] in "/\\")


def resolve(rel, must_exist=True):
    """'game/src/a.py' → the real path, inside that folder (links that lead out of it are refused).
    With --full an absolute path (/home/you/x, C:/Users/you/x) is taken as it is."""
    if full and is_abs(rel):
        real = os.path.realpath(os.path.expanduser(str(rel)))
        if must_exist and not os.path.exists(real):
            raise Refused(404, f"not found: {rel}")
        return real, os.path.splitdrive(real)[0] + os.sep, [str(rel)]
    parts = [p for p in str(rel or "").replace("\\", "/").split("/") if p and p != "."]
    if not parts:
        return None, None, []
    if ".." in parts:
        raise Refused(400, '".." is not allowed in a path')
    if not dotfiles and any(p.startswith(".") for p in parts[1:]):
        raise Refused(403, "hidden files and folders (names starting with a dot) are not shared")
    if parts[0] not in roots:
        raise Refused(404, f"no shared folder called {parts[0]!r} (shared: {', '.join(roots)})")
    root = roots[parts[0]]
    joined = os.path.join(root, *parts[1:])
    real = os.path.realpath(joined)
    if real != root and not real.startswith(root + os.sep):
        raise Refused(403, "that path leads outside the shared folder")
    if must_exist and not os.path.exists(real):
        raise Refused(404, f"not found: {'/'.join(parts)}")
    return real, root, parts


def entry(rel, real):
    st = os.stat(real)
    return {"path": rel, "dir": os.path.isdir(real), "size": 0 if os.path.isdir(real) else st.st_size, "mtime": int(st.st_mtime * 1000)}


def walk(real, rel, recursive, depth=0, cap=MAX_LIST):
    """depth: how many levels below this folder (0 = no limit when recursive); cap: at most this many entries."""
    out, cut = [], False
    stack = [(real, rel, 1)]
    absolute = is_abs(rel)
    while stack:
        d, r, level = stack.pop(0)
        try:
            names = sorted(os.listdir(d), key=str.lower)
        except OSError:
            continue
        for n in names:
            if not dotfiles and n.startswith("."):
                continue
            fpath = os.path.join(d, n)
            fr = f"{r.rstrip('/')}/{n}"
            try:
                if not absolute:
                    # a link that leads out of the shared folder is left out
                    root = roots[fr.split("/")[0]]
                    rp = os.path.realpath(fpath)
                    if rp != root and not rp.startswith(root + os.sep):
                        continue
                e = entry(fr, fpath)
            except OSError:
                continue
            if len(out) >= cap:
                return out, True
            out.append(e)
            if recursive and e["dir"] and not os.path.islink(fpath) and (not depth or level < depth):
                stack.append((fpath, fr, level + 1))
    return out, cut


def rel_of(path, parts):
    return str(path) if full and is_abs(path) else "/".join(parts)


def do_list(b):
    path = b.get("path") or ""
    if not str(path).strip("/ .") and not (full and str(path).strip() == "/"):
        return {"entries": [{"path": n, "dir": True, "size": 0, "mtime": int(os.stat(r).st_mtime * 1000)} for n, r in roots.items()], "cut": False}
    real, _, parts = resolve(path)
    if not os.path.isdir(real):
        return {"entries": [entry(rel_of(path, parts), real)], "cut": False}
    depth = max(0, int(b.get("depth") or 0))
    cap = max(1, min(20000, int(b.get("max") or MAX_LIST)))
    entries, cut = walk(real, rel_of(path, parts), bool(b.get("recursive")) or depth > 1, depth, cap)
    return {"entries": entries, "cut": cut}


def do_stat(b):
    try:
        real, _, parts = resolve(b.get("path"))
    except Refused as e:
        if e.status == 404:
            return {"exists": False}
        raise
    if real is None:
        return {"exists": True, "dir": True, "size": 0}
    e = entry(rel_of(b.get("path"), parts), real)
    return {"exists": True, "dir": e["dir"], "size": e["size"], "mtime": e["mtime"]}


def do_read(b):
    real, _, parts = resolve(b.get("path"))
    if real is None or os.path.isdir(real):
        raise Refused(400, "that is a folder – list it instead")
    size = os.path.getsize(real)
    offset = max(0, int(b.get("offset") or 0))
    length = min(MAX_READ, max(0, int(b.get("length") or MAX_READ)))
    with open(real, "rb") as f:
        f.seek(offset)
        data = f.read(length)
    return {"data": base64.b64encode(data).decode("ascii"), "size": size, "eof": offset + len(data) >= size}


def do_search(b):
    path = b.get("path") or ""
    name = str(b.get("name") or "")
    text = str(b.get("text") or "")
    limit = max(1, min(500, int(b.get("max") or 100)))
    if not name and not text:
        raise Refused(400, "give name (a pattern like *.py) or text (words to find in files), or both")
    if not str(path).strip("/ ."):
        starts = [(r, n) for n, r in roots.items()]
    else:
        real, _, parts = resolve(path)
        starts = [(real, rel_of(path, parts))]
    matches, cut, needle = [], False, text.lower()
    for real, rel in starts:
        files = [entry(rel, real)] if not os.path.isdir(real) else walk(real, rel, True)[0]
        for e in files:
            if e["dir"]:
                continue
            base = e["path"].rsplit("/", 1)[-1]
            if name and not fnmatch.fnmatch(base.lower(), name.lower()):
                continue
            if not text:
                matches.append({"path": e["path"]})
            elif e["size"] <= MAX_SEARCH_FILE:
                try:
                    fr = resolve(e["path"])[0]
                    with open(fr, "rb") as f:
                        raw = f.read()
                    if b"\0" in raw[:4096]:
                        continue
                    for i, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                        if needle in line.lower():
                            matches.append({"path": e["path"], "line": i, "text": line.strip()[:300]})
                            if len(matches) >= limit:
                                break
                except (OSError, Refused):
                    continue
            if len(matches) >= limit:
                return {"matches": matches, "cut": True}
    return {"matches": matches, "cut": cut}


def do_write(b):
    if not allow_write:
        raise Refused(403, "this computer shares its folders read-only (start pc-files.py with --write to allow saving)")
    real, root, parts = resolve(b.get("path"), must_exist=False)
    if real is None or (len(parts) < 2 and not (full and is_abs(b.get("path")))):
        raise Refused(400, "give a file path inside a shared folder, e.g. " + next(iter(roots)) + "/notes.txt")
    data = base64.b64decode(b.get("data") or "")
    if len(data) > MAX_WRITE:
        raise Refused(413, "too big to save in one go")
    if os.path.isdir(real):
        raise Refused(400, "that is a folder")
    parent = os.path.dirname(real)
    if not os.path.isdir(parent):
        if not b.get("mkdirs"):
            raise Refused(404, "the folder it goes in does not exist")
        os.makedirs(parent, exist_ok=True)
        rp = os.path.realpath(parent)
        if not full and rp != root and not rp.startswith(root + os.sep):
            raise Refused(403, "that path leads outside the shared folder")
    if b.get("append"):
        with open(real, "ab") as f:
            f.write(data)
    else:
        # write to a temporary file next to it, then swap: a cut-short save never leaves half a file
        tmp = f"{real}.pc-files-{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, real)
    return {"size": os.path.getsize(real)}


JOBS = {}  # id → {proc, out, err, cwd, command, started, timeout}
JOBS_LOCK = threading.Lock()


def _tail(path):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > MAX_OUT:
                f.seek(size - MAX_OUT)
            data = f.read()
        return data.decode("utf-8", "replace"), size > MAX_OUT
    except OSError:
        return "", False


def _job_state(jid, j):
    code = j["proc"].poll()
    if code is None and time.time() - j["started"] > j["timeout"]:
        _kill_tree(j["proc"])
        j["timed_out"] = True
        code = j["proc"].wait()
    out, c1 = _tail(j["out"])
    err, c2 = _tail(j["err"])
    done = code is not None
    st = {"job": jid, "running": not done, "exit": code if done else None, "stdout": out, "stderr": err, "cut": c1 or c2, "cwd": j["cwd"], "timed_out": bool(j.get("timed_out")), "seconds": round(time.time() - j["started"], 1)}
    if done and not j.get("reaped"):
        j["reaped"] = True
        j["ended"] = time.time()
    return st


def _kill_tree(proc):
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        else:
            os.killpg(proc.pid, 9)
    except OSError:
        pass


def _sweep_jobs():
    now = time.time()
    with JOBS_LOCK:
        for jid in [k for k, j in JOBS.items() if j.get("ended") and now - j["ended"] > 3600]:
            j = JOBS.pop(jid)
            for f in (j["out"], j["err"]):
                try:
                    os.remove(f)
                except OSError:
                    pass


def do_job(b):
    """A command that ran longer than the first wait: wait for it some more (up to 25 s a call), read it, or kill it."""
    jid = str(b.get("job") or "")
    j = JOBS.get(jid)
    if not j:
        raise Refused(404, f"no job {jid!r} (jobs are kept for an hour after they end, and not across a restart)")
    if b.get("kill"):
        _kill_tree(j["proc"])
        j["proc"].wait()
        j["killed"] = True
    wait = max(0, min(25, float(b.get("wait") or 0)))
    end = time.time() + wait
    while j["proc"].poll() is None and time.time() < end:
        time.sleep(0.2)
    st = _job_state(jid, j)
    st["killed"] = bool(j.get("killed"))
    return st


def do_exec(b):
    if not full:
        raise Refused(403, "running commands needs full control (start pc-files.py with --full)")
    command = str(b.get("command") or "").strip()
    if not command:
        raise Refused(400, "give a command")
    cwd = os.path.realpath(os.path.expanduser(str(b.get("cwd") or "~")))
    if not os.path.isdir(cwd):
        raise Refused(404, f"no such folder: {b.get('cwd')}")
    # timeout: how long it may run in all (a job keeps going after the call returns); wait: how long this call waits
    timeout = max(1, min(6 * 3600, int(b.get("timeout") or 600)))
    wait = max(0, min(25, float(b.get("wait") if b.get("wait") is not None else 20)))
    print(f"run in {cwd}: {command}", flush=True)
    _sweep_jobs()
    jid = "j" + secrets.token_hex(3)
    jobdir = os.path.join(config_dir(), "jobs")
    os.makedirs(jobdir, exist_ok=True)
    outp, errp = os.path.join(jobdir, jid + ".out"), os.path.join(jobdir, jid + ".err")
    with open(outp, "wb") as fo, open(errp, "wb") as fe:
        proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=fo, stderr=fe, stdin=subprocess.DEVNULL, creationflags=0x08000000 if IS_WIN else 0, start_new_session=not IS_WIN)  # CREATE_NO_WINDOW
    with JOBS_LOCK:
        JOBS[jid] = {"proc": proc, "out": outp, "err": errp, "cwd": cwd, "command": command, "started": time.time(), "timeout": timeout}
    end = time.time() + wait
    while proc.poll() is None and time.time() < end:
        time.sleep(0.1)
    return _job_state(jid, JOBS[jid])


def _targets_processes(command):
    """Processes a kill command would hit: [{pid, name, title}] (best effort; [] when it names none)."""
    import re, csv, io

    c = command.strip()
    names = re.findall(r"(?i)\btaskkill\b.*?/im\s+\"?([^\s\"]+)", c) + re.findall(r"(?i)\bstop-process\b.*?-name\s+\"?([^\s\",]+)", c) + re.findall(r"(?i)\b(?:pkill|killall)\b(?:\s+-\S+)*\s+\"?([^\s\"]+)", c)
    pids = re.findall(r"(?i)/pid\s+(\d+)", c) + re.findall(r"(?i)stop-process\b.*?-id\s+(\d+)", c) + re.findall(r"(?i)\bkill\b(?:\s+-\S+)*\s+(\d+)", c)
    if not names and not pids:
        return []
    procs = []
    try:
        if IS_WIN:
            out = subprocess.run(["tasklist", "/v", "/fo", "csv"], capture_output=True, text=True, creationflags=0x08000000).stdout
            for row in list(csv.reader(io.StringIO(out)))[1:]:
                if len(row) >= 9:
                    procs.append({"name": row[0], "pid": int(row[1]), "title": row[8] if row[8] != "N/A" else ""})
        else:
            out = subprocess.run(["ps", "-eo", "pid=,comm=,args="], capture_output=True, text=True).stdout
            for line in out.splitlines():
                parts = line.strip().split(None, 2)
                if len(parts) >= 2:
                    procs.append({"pid": int(parts[0]), "name": parts[1], "title": (parts[2] if len(parts) > 2 else "")[:120]})
    except OSError:
        return []
    base = lambda n: n.lower()[:-4] if n.lower().endswith(".exe") else n.lower()
    want = [base(n) for n in names]
    return [p for p in procs if str(p["pid"]) in pids or base(p["name"]) in want][:50]


def _targets_files(command, cwd):
    """Files and folders a delete command would hit: [{path, dir, size, items}] (best effort)."""
    import glob, re, shlex

    m = re.match(r"(?i)^\s*(?:rm|del|erase|rd|rmdir|remove-item|ri)\b(.*)$", command.strip())
    if not m:
        return []
    try:
        words = shlex.split(m.group(1), posix=not IS_WIN)
    except ValueError:
        words = m.group(1).split()
    found = []
    for w in words:
        w = w.strip('"')
        if not w or w.startswith("-") or (IS_WIN and w.startswith("/") and len(w) <= 3):
            continue
        p = w if os.path.isabs(os.path.expanduser(w)) else os.path.join(cwd, w)
        for hit in sorted(glob.glob(os.path.expanduser(p)))[:200]:
            d = os.path.isdir(hit)
            items = sum(len(fs) + len(ds) for _, ds, fs in os.walk(hit)) if d else 0
            found.append({"path": hit, "dir": d, "size": 0 if d else os.path.getsize(hit), "items": items})
    return found[:50]


def do_preview(b):
    """What a command is about to touch, before it runs: matching processes for a kill, matching files for a delete."""
    if not full:
        raise Refused(403, "needs full control")
    command = str(b.get("command") or "")
    cwd = os.path.realpath(os.path.expanduser(str(b.get("cwd") or "~")))
    return {"processes": _targets_processes(command), "files": _targets_files(command, cwd)}


ROUTES = {"/list": do_list, "/stat": do_stat, "/read": do_read, "/search": do_search, "/write": do_write, "/exec": do_exec, "/job": do_job, "/preview": do_preview}


class Handler(BaseHTTPRequestHandler):
    server_version = "pc-files"

    def log_message(self, fmt, *a):
        pass

    def send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        h = self.headers.get("Authorization") or ""
        if not secrets.compare_digest(h.encode(), f"Bearer {secret}".encode()):
            time.sleep(0.5)  # slows guessing down
            self.send(401, {"error": "wrong secret"})
            return False
        return True

    def do_GET(self):
        if not self.authed():
            return
        if self.path.split("?")[0] == "/health":
            return self.send(200, {"app": "pc-files", "version": VERSION, "write": allow_write, "full": full, "os": f"{platform.system()} {platform.release()}", "shell": "cmd" if IS_WIN else "sh", "host": socket.gethostname(), "folders": [{"name": n} for n in roots]})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.authed():
            return
        fn = ROUTES.get(self.path.split("?")[0])
        if not fn:
            return self.send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_WRITE * 2:
                return self.send(413, {"error": "request too big"})
            b = json.loads(self.rfile.read(n) or b"{}")
            out = fn(b)
            if fn is do_write:
                print(f"saved {b.get('path')} ({out['size']} bytes)", flush=True)
            self.send(200, out)
        except Refused as e:
            self.send(e.status, {"error": str(e)})
        except (OSError, ValueError) as e:
            self.send(500, {"error": f"{type(e).__name__}: {e}"})


try:
    server = ThreadingHTTPServer((host, port), Handler)
except OSError as e:
    sys.exit(f"Could not listen on port {port}: {e}.\nIs it already running (auto start)? Then use --show-qr, or --stop first; or pick another --port.")
real_port = server.server_address[1]
if port_file:
    with open(port_file, "w") as f:
        f.write(str(real_port))
if from_config:
    os.makedirs(config_dir(), exist_ok=True)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
where = lan_address() if host in ("0.0.0.0", "") else host
print(f"Sharing {', '.join(f'{n} ({r})' for n, r in roots.items())} – {'read and save' if allow_write else 'read-only'}")
if full:
    print("FULL CONTROL is on: the phone can reach every file and run commands on this computer as you.")
if not from_config:
    print_pairing(f"http://{where}:{real_port}", secret, show_secret=not given)
    print("Ctrl+C stops sharing.", flush=True)
# served from a thread: on Windows Ctrl+C does not reach a server waiting for requests in the main thread
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    while True:
        time.sleep(0.5)
except KeyboardInterrupt:
    print("Stopped sharing.")
    server.shutdown()
