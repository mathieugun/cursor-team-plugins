"""Live-test helper for cursor-team-plugins: read Cursor's logs, install the build, back up settings.
Standard library only; run from the repository root (or pass --repo).

  python scripts/live_check.py status   [--repo DIR] [--host SSH_HOST] [--since WHEN] [--grep REGEX] [--lines N]
  python scripts/live_check.py install  [--repo DIR] [--host SSH_HOST] [--no-package] [--dry-run]
  python scripts/live_check.py settings backup|diff|restore DIR [--settings FILE] [--force]

status   Which version is installed and whether its files match the working tree, then for each window of the
         newest Cursor session that has an extension host: the Team Plugins output lines and Cursor's plugin
         registrations since WHEN. WHEN: "host" (start of the window's current extension host, the default),
         "install" (when the installed version was installed; reads the logs of every reload since), "10m", "07:10"
         (today) or "2026-11-26T07:10" (local time).
install  Package the working tree (scripts/package.js), install the VSIX in the local Cursor (or with the Cursor
         server's CLI on SSH_HOST), then print the installed check. Changes the Cursor the user works in: ask first.
settings Back up Cursor's user settings.json to DIR (refuses to overwrite a backup without --force), show the diff
         between the backup and the current file, or restore the backup.
"""

import argparse
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ISO = re.compile(r"\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z\]")
HOST_DIR = re.compile(r"output_logging_(\d{8}T\d{6})")
PLUGIN_LINE = re.compile(r"(Registered extension plugin|Unregistered extension plugin|Plugins reload completed|\[error\]|\[warning\])")
SKIP_COMPARE = {"package.json", ".vsixmanifest", "[Content_Types].xml"}


def repo_info(repo):
    pkg = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    return f"{pkg['publisher']}.{pkg['name']}".lower(), pkg["name"], pkg["version"]


# ---- times -------------------------------------------------------------------------------------------------------

def utc_of_line(line):
    m = ISO.search(line)
    return dt.datetime.fromisoformat(m.group(1)).replace(tzinfo=dt.timezone.utc) if m else None


def local_hms(t):
    return t.astimezone().strftime("%H:%M:%S")


def parse_since(text, host_start, install_time):
    if text == "host":
        return host_start
    if text == "install":
        return install_time
    m = re.fullmatch(r"(\d+)([mh])", text)
    if m:
        delta = dt.timedelta(minutes=int(m.group(1))) if m.group(2) == "m" else dt.timedelta(hours=int(m.group(1)))
        return dt.datetime.now(dt.timezone.utc) - delta
    if re.fullmatch(r"\d\d?:\d\d(:\d\d)?", text):
        text = dt.date.today().isoformat() + "T" + text
    return dt.datetime.fromisoformat(text).astimezone(dt.timezone.utc)


# ---- logs --------------------------------------------------------------------------------------------------------

def sessions_with_hosts(logs_root):
    """Session folders, newest first, with their extension-host folders (local: window*/exthost, remote: exthost*)."""
    out = []
    for s in sorted((p for p in logs_root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True):
        hosts = sorted(s.glob("window*/exthost")) or sorted(p for p in s.glob("exthost*") if p.is_dir())
        if hosts:
            out.append((s, hosts))
    return out


def host_label(exthost):
    return exthost.parent.name if exthost.name == "exthost" else exthost.name


def shorten(line, ext_id):
    line = re.sub(r"(?i)[a-z]:\\[^ ]*?\\globalStorage\\" + re.escape(ext_id) + r"\\\.cursor\\plugins\\", r"<plugins>\\", line)
    line = re.sub(r"/[^ ]*?/globalStorage/" + re.escape(ext_id) + r"/\.cursor/plugins/", "<plugins>/", line)
    return line.replace(f" (extension: {ext_id})", "")


def team_logs(exthost):
    """The Team Plugins output logs of a window, one per extension host (each reload starts one), oldest first,
    with each host's start time."""
    out = []
    for d in sorted(exthost.glob("output_logging_*"), key=lambda p: p.name):
        logs = [f for f in d.iterdir() if f.name.endswith("-Team Plugins.log")]
        if logs:
            start = dt.datetime.strptime(HOST_DIR.search(d.name).group(1), "%Y%m%dT%H%M%S").astimezone()
            out.append((logs[0], start.astimezone(dt.timezone.utc)))
    return out


def plugin_logs(exthost):
    d = exthost / "anysphere.cursor-agent-host"
    return sorted(d.glob("Cursor Plugins*.log")) if d.is_dir() else []


def lines_since(path, since, keep=None):
    out = []
    last_t = None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        t = utc_of_line(raw) or last_t
        last_t = t
        if t is None or t < since or (keep and not keep(raw)):
            continue
        out.append((t, raw))
    return out


_REMOTE = None  # (local copy root, "host:~") while showing a remote session


def shown_path(p):
    if not _REMOTE:
        return str(p)
    return _REMOTE[1] + "/" + Path(p).relative_to(_REMOTE[0]).as_posix()


def print_window(exthost, args, ext_id, install_time, newest):
    logs = team_logs(exthost)
    label = host_label(exthost)
    if not logs:
        print(f"\n== {label}: no Team Plugins log (extension not active in this window)")
        return
    start = logs[-1][1]
    since = parse_since(args.since, start, install_time) if install_time or args.since != "install" else start
    grep = re.compile(args.grep) if args.grep else None
    read = [(log, s) for i, (log, s) in enumerate(logs) if i == len(logs) - 1 or logs[i + 1][1] > since]
    team = []
    for log, _ in read:
        team += lines_since(log, since, (lambda l: bool(grep.search(l))) if grep else None)
    plogs = plugin_logs(exthost)
    if not team and not newest and not any(lines_since(p, since, lambda l: bool(PLUGIN_LINE.search(l))) for p in plogs):
        print(f"\n== {label}: extension host started {local_hms(start)}; nothing since {local_hms(since)}")
        return
    print(f"\n== {label}: extension host started {local_hms(start)}; lines since {local_hms(since)}")
    for log, s in read:
        print(f"   {shown_path(log)}" + ("" if s == start else f"  (earlier host, started {local_hms(s)})"))
    shown = team[-args.lines:]
    if len(team) > len(shown):
        print(f"   ... {len(team) - len(shown)} earlier lines not shown (--lines)")
    for t, raw in shown:
        print("   " + local_hms(t) + " " + shorten(ISO.sub("", raw, count=1).strip(), ext_id))
    if not team:
        print("   (none)")
    for plog in plogs:
        reg = lines_since(plog, since, lambda l: bool(PLUGIN_LINE.search(l)) and (ext_id in l or "reload completed" in l
                                                                                   or "[error]" in l or "[warning]" in l))
        # Cursor logs every reload several times: keep only the last one.
        reloads = [x for x in reg if "reload completed" in x[1]]
        reg = [x for x in reg if "reload completed" not in x[1]] + reloads[-1:]
        print(f"   -- Cursor Plugins ({plog.name}): {len(reg)} lines")
        for t, raw in sorted(reg)[-args.lines:]:
            msg = raw.split("[info]")[-1] if "[info]" in raw else ISO.split(raw)[-1]
            print("   " + local_hms(t) + " " + shorten(msg.strip(), ext_id))


# ---- installed extension -----------------------------------------------------------------------------------------

def installed(ext_root, ext_id):
    """(version, folder) of the extension as Cursor's extensions.json records it, else (None, None)."""
    j = ext_root / "extensions.json"
    if not j.is_file():
        return None, None
    for e in json.loads(j.read_text(encoding="utf-8")):
        if e.get("identifier", {}).get("id", "").lower() == ext_id:
            rel = e.get("relativeLocation") or f"{ext_id}-{e['version']}"
            ms = (e.get("metadata") or {}).get("installedTimestamp")
            when = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc) if ms else None
            return e["version"], ext_root / rel, when
    return None, None, None


def sha1(path):
    return hashlib.sha1(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def print_installed(ext_root, repo, ext_id, version):
    v, folder, when = installed(ext_root, ext_id)
    print("\n== Installed")
    if not v:
        print(f"   {ext_id} is not installed")
        return None
    if not when and folder.is_dir():
        when = dt.datetime.fromtimestamp(folder.stat().st_mtime, dt.timezone.utc)
    note = "same version as the working tree" if v == version else f"working tree is {version}"
    stamp = f", installed {when.astimezone():%Y-%m-%d %H:%M:%S}" if when else ""
    print(f"   {ext_id} {v} ({note}{stamp})")
    if not folder.is_dir():
        print(f"   folder missing: {folder}")
        return None
    obsolete = ext_root / ".obsolete"
    if obsolete.is_file() and folder.name in obsolete.read_text(encoding="utf-8", errors="replace"):
        print("   marked obsolete in .obsolete (removed at the next start)")
    differ, missing, same = [], [], 0
    for f in sorted(p for p in folder.rglob("*") if p.is_file()):
        rel = f.relative_to(folder).as_posix()
        if rel in SKIP_COMPARE or rel.startswith("node_modules/"):
            continue
        mine = repo / rel
        if not mine.is_file():
            missing.append(rel)
        elif sha1(mine) != sha1(f):
            differ.append(rel)
        else:
            same += 1
    print(f"   files: {same} same as the working tree" + (f", {len(differ)} differ: {', '.join(differ)}" if differ else ""))
    if missing:
        print(f"   not in the working tree: {', '.join(missing)}")
    return when


# ---- remote (SSH) ------------------------------------------------------------------------------------------------

# Git for Windows' ssh hangs when run from Python with more than a few kB of output (a 186 kB tar never arrives);
# Windows' own OpenSSH doesn't. Both read ~/.ssh/config.
_WIN_SSH = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "OpenSSH"
SSH = str(_WIN_SSH / "ssh.exe") if (_WIN_SSH / "ssh.exe").is_file() else "ssh"
SCP = str(_WIN_SSH / "scp.exe") if (_WIN_SSH / "scp.exe").is_file() else "scp"

def fetch_remote(host, ext_id, dest):
    """Copies the remote Cursor server's newest log session and the installed extension into dest."""
    script = (
        "cd ~ || exit 1; s=$(ls -d .cursor-server/data/logs/*/exthost* 2>/dev/null | sort | tail -1 | cut -d/ -f1-4); "
        '[ -n "$s" ] || { echo "no Cursor server logs" >&2; exit 3; }; '
        f'tar -cz "$s"/exthost*/output_logging_* "$s"/exthost*/anysphere.cursor-agent-host '
        f".cursor-server/extensions/extensions.json .cursor-server/extensions/{ext_id}-* 2>/dev/null; exit 0"
    )
    r = subprocess.run([SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, script], capture_output=True,
                       stdin=subprocess.DEVNULL, timeout=120)
    if r.returncode != 0 or not r.stdout:
        sys.exit(f"ssh {host} failed ({r.returncode}): {r.stderr.decode(errors='replace').strip()}")
    archive = dest / "remote.tgz"
    archive.write_bytes(r.stdout)
    with tarfile.open(archive) as tar:
        for m in tar.getmembers():
            target = (dest / m.name).resolve()
            if not str(target).startswith(str(dest.resolve())) or m.issym() or m.islnk():
                sys.exit(f"unexpected entry in the remote archive: {m.name}")
        tar.extractall(dest)
    return dest / ".cursor-server" / "data" / "logs", dest / ".cursor-server" / "extensions"


# ---- commands ----------------------------------------------------------------------------------------------------

def cmd_status(args):
    repo = Path(args.repo).resolve()
    ext_id, _, version = repo_info(repo)
    global _REMOTE
    tmp = None
    if args.host:
        tmp = Path(tempfile.mkdtemp(prefix="live_check_"))
        logs_root, ext_root = fetch_remote(args.host, ext_id, tmp)
        _REMOTE = (tmp, f"{args.host}:~")
        where = f"{args.host} (Cursor server)"
    else:
        logs_root = Path(os.environ["APPDATA"]) / "Cursor" / "logs"
        ext_root = Path(os.environ["USERPROFILE"]) / ".cursor" / "extensions"
        where = "this machine"
    try:
        install_time = print_installed(ext_root, repo, ext_id, version)
        found = sessions_with_hosts(logs_root)
        if not found:
            print(f"\nNo Cursor log session with an extension host on {where}")
            return
        session, hosts = found[0]
        print(f"\n== Logs on {where}: session {session.name}, {len(hosts)} extension host(s)")
        if args.since == "install" and not install_time:
            print("   (--since install: nothing installed, using the extension host start)")
        # Locally each window has one exthost folder; on a remote each reload adds an exthost<N>: the last is current.
        for h in hosts:
            print_window(h, args, ext_id, install_time, newest=(h == hosts[-1] or h.name == "exthost"))
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def run(cmd, dry, **kw):
    print("$ " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
    if not dry:
        r = subprocess.run(cmd, **kw)
        if r.returncode != 0:
            sys.exit(f"failed with exit code {r.returncode}")


def cmd_install(args):
    repo = Path(args.repo).resolve()
    ext_id, name, version = repo_info(repo)
    cursor_dir = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "cursor"
    vsix = repo / "dist" / f"{name}-{version}.vsix"
    if not args.no_package:
        run([str(cursor_dir / "Cursor.exe"), "scripts/package.js"], args.dry_run, cwd=repo,
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    if not args.dry_run and not vsix.is_file():
        sys.exit(f"no VSIX at {vsix}")
    if args.host:
        remote_vsix = f"/tmp/{vsix.name}"
        run([SCP, "-o", "BatchMode=yes", str(vsix), f"{args.host}:{remote_vsix}"], args.dry_run)
        cli = ('cli=$(ls -td ~/.cursor-server/bin/linux-x64/*/ | head -1)bin/cursor-server; '
               f'"$cli" --install-extension {remote_vsix} --force')
        run([SSH, "-o", "BatchMode=yes", args.host, cli], args.dry_run, stdin=subprocess.DEVNULL)
    else:
        run(["cmd", "/c", str(cursor_dir / "resources" / "app" / "bin" / "cursor.cmd"), "--install-extension", str(vsix),
             "--force"], args.dry_run)
    if args.dry_run:
        return
    args.since, args.grep, args.lines = "host", None, 0
    if args.host:
        tmp = Path(tempfile.mkdtemp(prefix="live_check_"))
        try:
            print_installed(fetch_remote(args.host, ext_id, tmp)[1], repo, ext_id, version)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        print_installed(Path(os.environ["USERPROFILE"]) / ".cursor" / "extensions", repo, ext_id, version)
    print("\nNext: the user reloads the window (Developer: Reload Window).")


def cmd_settings(args):
    settings = Path(args.settings or Path(os.environ["APPDATA"]) / "Cursor" / "User" / "settings.json")
    backup = Path(args.dir) / "cursor-settings.json.bak"

    def diff():
        a = backup.read_text(encoding="utf-8").splitlines()
        b = settings.read_text(encoding="utf-8").splitlines()
        d = list(difflib.unified_diff(a, b, "backup", "current", lineterm=""))
        print("\n".join(d) if d else "no difference between the backup and the current settings")

    if args.action == "backup":
        if backup.exists() and not args.force:
            sys.exit(f"a backup already exists: {backup} (it may hold the original settings; --force to replace it)")
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(settings, backup)
        print(f"backed up {settings} -> {backup}")
    elif not backup.is_file():
        sys.exit(f"no backup at {backup}")
    elif args.action == "diff":
        diff()
    else:
        diff()
        shutil.copy2(backup, settings)
        print(f"restored {backup} -> {settings}")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status")
    s.add_argument("--repo", default=".")
    s.add_argument("--host")
    s.add_argument("--since", default="host")
    s.add_argument("--grep")
    s.add_argument("--lines", type=int, default=60)
    i = sub.add_parser("install")
    i.add_argument("--repo", default=".")
    i.add_argument("--host")
    i.add_argument("--no-package", action="store_true")
    i.add_argument("--dry-run", action="store_true")
    t = sub.add_parser("settings")
    t.add_argument("action", choices=["backup", "diff", "restore"])
    t.add_argument("dir")
    t.add_argument("--settings")
    t.add_argument("--force", action="store_true")
    args = p.parse_args()
    {"status": cmd_status, "install": cmd_install, "settings": cmd_settings}[args.cmd](args)


if __name__ == "__main__":
    main()
