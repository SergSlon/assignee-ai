#!/usr/bin/env python3
"""
PTY-driven CLI audit driver — captures every prompt screen exactly as a
terminal user sees it, sends a deterministic answer, continues until
the process exits.

The script is the canonical reproducer for the wizard UX audit
findings catalogued in `_backlog/wizard-ux-audit-2026-05-22.md`. It
allocates a real pseudo-terminal in raw mode, captures stdout per
idle period, strips ANSI escape sequences, collapses spinner
animations, and emits one "SCREEN N" block per prompt the CLI shows.

Default decision strategy: send ENTER on every prompt (accept default).
To navigate arrow-key menus, edit the decision logic inline or set an
ANSWERS list per screen — the simple ENTER-loop already exercises every
prompt path enough to find UX inconsistencies.

Usage:

    python3 apps/cli/scripts/pty-driver.py \\
        node apps/cli/dist/index.js dev init --wizard

    python3 apps/cli/scripts/pty-driver.py \\
        node apps/cli/dist/index.js infra plan --wizard --no-apply \\
        "create ec2 with ssh access"

Re-running the audit:

    1. `pnpm build` (so apps/cli/dist/index.js is fresh).
    2. Pick the wizard command you want to capture.
    3. Run the driver against it. Output streams to stdout.
    4. Diff vs the prior capture or save into _backlog/ for the
       next audit doc.

Python 3.8+. No external deps. Should work on macOS + Linux. Windows
PTY semantics differ; not supported.

@see _backlog/wizard-ux-audit-2026-05-22.md — the original audit
@see _backlog/wizard-ux-audit-2026-05-22.md#driver-retained-for-re-runs
"""
import os
import pty
import select
import sys
import re
import time
import termios
import struct
import fcntl

PROMPT_QUIET_MS = 1500
TIMEOUT_S = 180
ANSI_RE = re.compile(r"\x1b\[[\?0-9;]*[a-zA-Z]")
OSC_RE = re.compile(r"\x1b\][^\x07]*(\x07|\x1b\\)")


def strip_ansi(s: str) -> str:
    """Remove CSI / OSC / other escape sequences from terminal output."""
    s = ANSI_RE.sub("", s)
    s = OSC_RE.sub("", s)
    s = re.sub(r"\x1b[=>78H]", "", s)
    return s


def set_raw_pty(fd):
    """Disable cooked mode on the slave PTY.

    Without this, the PTY translates CR → CRLF, mangles spinner
    animations, and echoes our keystrokes back through the capture
    stream. Raw mode + ICANON/ECHO off keeps the output stream clean.
    """
    try:
        attrs = termios.tcgetattr(fd)
        attrs[1] &= ~(termios.OPOST | termios.ONLCR | termios.OCRNL)
        attrs[0] &= ~termios.ICRNL
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except (termios.error, OSError):
        pass


def set_pty_size(fd, rows=40, cols=120):
    """Set PTY winsize so the CLI doesn't render in a 24x80 tty."""
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main(argv):
    if not argv:
        print("usage: pty-driver.py <cmd> <args...>", file=sys.stderr)
        sys.exit(2)

    pid, fd = pty.fork()
    if pid == 0:
        # child — exec target
        os.environ["TERM"] = "xterm-256color"
        os.environ.setdefault("CI", "1")
        os.execvp(argv[0], argv)

    set_raw_pty(fd)
    set_pty_size(fd)

    prompt_n = 0
    deadline = time.time() + TIMEOUT_S
    buf = b""

    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], PROMPT_QUIET_MS / 1000)
        if r:
            try:
                data = os.read(fd, 16384)
            except OSError:
                break
            if not data:
                break
            buf += data
        else:
            # idle — assume a prompt has settled
            if not buf:
                try:
                    pid_status, _ = os.waitpid(pid, os.WNOHANG)
                    if pid_status != 0:
                        break
                except ChildProcessError:
                    break
                continue
            text = strip_ansi(buf.decode("utf-8", errors="replace"))
            # Collapse identical spinner frames so they don't flood output
            lines = text.split("\n")
            seen = set()
            collapsed = []
            for ln in lines:
                key = ln.strip()
                if key and key in seen:
                    continue
                seen.add(key)
                collapsed.append(ln)
            text_clean = "\n".join(collapsed)

            prompt_n += 1
            sys.stdout.write(f"\n========== SCREEN {prompt_n} ==========\n")
            sys.stdout.write(text_clean)
            if not text_clean.endswith("\n"):
                sys.stdout.write("\n")
            sys.stdout.write(f"========== /SCREEN {prompt_n} (action: ENTER) ==========\n")
            sys.stdout.flush()
            try:
                os.write(fd, b"\r")
            except OSError:
                break
            buf = b""

    if buf:
        text = strip_ansi(buf.decode("utf-8", errors="replace"))
        sys.stdout.write(f"\n========== FINAL ==========\n{text}\n========== /FINAL ==========\n")

    try:
        _, status = os.waitpid(pid, 0)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else "signal"
        sys.stdout.write(f"\n[driver] exit code: {code}\n")
    except ChildProcessError:
        pass


if __name__ == "__main__":
    main(sys.argv[1:])
