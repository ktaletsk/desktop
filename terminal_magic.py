#!/usr/bin/env python3
"""
terminal_magic.py — A showcase of cool terminal tricks in Python.

Demos:
  1. Animated spinner
  2. Progress bar
  3. Typewriter effect
  4. Matrix rain
  5. Bouncing ball
  6. Gradient text (256-color)
  7. ASCII art banner
  8. Live system stats
  9. Countdown timer
 10. Interactive menu
"""

import itertools
import math
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime

# ── ANSI escape helpers ────────────────────────────────────────────────────────

ESC = "\033"
RESET = f"{ESC}[0m"
BOLD = f"{ESC}[1m"
DIM = f"{ESC}[2m"
ITALIC = f"{ESC}[3m"
UNDERLINE = f"{ESC}[4m"
BLINK = f"{ESC}[5m"
REVERSE = f"{ESC}[7m"
HIDE_CURSOR = f"{ESC}[?25l"
SHOW_CURSOR = f"{ESC}[?25h"
CLEAR = f"{ESC}[2J{ESC}[H"
CLEAR_LINE = f"{ESC}[2K\r"


def move_to(row: int, col: int) -> str:
    return f"{ESC}[{row};{col}H"


def fg(r: int, g: int, b: int) -> str:
    return f"{ESC}[38;2;{r};{g};{b}m"


def bg(r: int, g: int, b: int) -> str:
    return f"{ESC}[48;2;{r};{g};{b}m"


def fg256(n: int) -> str:
    return f"{ESC}[38;5;{n}m"


def bg256(n: int) -> str:
    return f"{ESC}[48;5;{n}m"


def term_size() -> tuple[int, int]:
    s = shutil.get_terminal_size((80, 24))
    return s.columns, s.lines


# ── Graceful exit ──────────────────────────────────────────────────────────────


def _cleanup(*_):
    print(SHOW_CURSOR + RESET, end="", flush=True)
    sys.exit(0)


signal.signal(signal.SIGINT, _cleanup)
signal.signal(signal.SIGTERM, _cleanup)

# ── 1. Animated Spinner ────────────────────────────────────────────────────────

SPINNERS = {
    "dots": list("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"),
    "braille": list("⣾⣽⣻⢿⡿⣟⣯⣷"),
    "moon": ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
    "clock": ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"],
    "arrow": list("←↖↑↗→↘↓↙"),
    "bounce": list("⠁⠂⠄⡀⢀⠠⠐⠈"),
}


def spinner_demo(duration: float = 3.0):
    print(BOLD + "\n── Spinner Showcase ──" + RESET)
    print(HIDE_CURSOR, end="", flush=True)
    deadline = time.time() + duration
    cols = list(SPINNERS.items())
    iters = [itertools.cycle(frames) for _, frames in cols]
    try:
        while time.time() < deadline:
            parts = []
            for (name, _), it in zip(cols, iters):
                frame = next(it)
                parts.append(f"  {fg(180, 220, 255)}{frame}{RESET} {DIM}{name}{RESET}")
            print(CLEAR_LINE + "  ".join(parts), end="", flush=True)
            time.sleep(0.08)
    finally:
        print(SHOW_CURSOR + "\n")


# ── 2. Progress Bar ────────────────────────────────────────────────────────────


def progress_bar(
    total: int = 60,
    width: int = 40,
    label: str = "Processing",
    color_start=(50, 200, 50),
    color_end=(50, 220, 255),
):
    print(BOLD + "\n── Progress Bar ──" + RESET)
    print(HIDE_CURSOR, end="", flush=True)
    try:
        for i in range(total + 1):
            frac = i / total
            filled = int(frac * width)
            empty = width - filled
            # interpolate color
            r = int(color_start[0] + frac * (color_end[0] - color_start[0]))
            g = int(color_start[1] + frac * (color_end[1] - color_start[1]))
            b = int(color_start[2] + frac * (color_end[2] - color_start[2]))
            bar = fg(r, g, b) + "█" * filled + DIM + "░" * empty + RESET
            pct = f"{frac * 100:5.1f}%"
            eta = (total - i) * 0.04
            print(
                f"\r  {BOLD}{label}{RESET}  [{bar}] {BOLD}{pct}{RESET}"
                f"  {DIM}ETA {eta:.1f}s{RESET}",
                end="",
                flush=True,
            )
            time.sleep(0.04)
    finally:
        print(SHOW_CURSOR + "\n")


# ── 3. Typewriter Effect ───────────────────────────────────────────────────────

LOREM = (
    "The quick brown fox jumps over the lazy dog. "
    "Pack my box with five dozen liquor jugs. "
    "How vexingly quick daft zebras jump! "
    "The five boxing wizards jump quickly."
)


def typewriter(text: str = LOREM, delay: float = 0.03, color=(220, 220, 120)):
    print(BOLD + "\n── Typewriter ──" + RESET)
    r, g, b = color
    for ch in text:
        print(fg(r, g, b) + ch + RESET, end="", flush=True)
        time.sleep(random.uniform(delay * 0.5, delay * 1.5))
    print("\n")


# ── 4. Matrix Rain ─────────────────────────────────────────────────────────────

KATAKANA = (
    "アイウエオカキクケコサシスセソタチツテトナニヌネノ"
    "ハヒフヘホマミムメモヤユヨラリルレロワヲン"
    "0123456789ABCDEF"
)


def matrix_rain(duration: float = 6.0):
    cols, rows = term_size()
    # Each column tracks its current row and speed
    streams = [
        {"row": random.randint(-rows, 0), "speed": random.uniform(0.5, 1.5)}
        for _ in range(cols)
    ]
    trails: dict[tuple[int, int], int] = {}  # (col, row) -> age

    print(CLEAR + HIDE_CURSOR, end="", flush=True)
    print(
        BOLD
        + move_to(1, (cols - 18) // 2)
        + fg(0, 255, 70)
        + "── Matrix Rain ──"
        + RESET,
        end="",
        flush=True,
    )

    deadline = time.time() + duration
    try:
        while time.time() < deadline:
            buf = []
            for col_idx, s in enumerate(streams):
                row_int = int(s["row"])
                if 1 <= row_int < rows:
                    ch = random.choice(KATAKANA)
                    # bright head
                    buf.append(
                        move_to(row_int, col_idx + 1)
                        + fg(200, 255, 200)
                        + BOLD
                        + ch
                        + RESET
                    )
                    trails[(col_idx, row_int)] = 0

                s["row"] += s["speed"]
                if s["row"] > rows + 10:
                    s["row"] = random.randint(-rows // 2, 0)
                    s["speed"] = random.uniform(0.5, 1.8)

            # age trails
            dead = []
            for pos, age in trails.items():
                c, r = pos
                if 1 <= r < rows:
                    fade = max(0, 180 - age * 25)
                    if age == 0:
                        color = fg(100, 255, 100)
                    elif age < 4:
                        color = fg(0, fade, 0)
                    else:
                        color = fg(0, max(fade - 60, 0), 0)
                    buf.append(
                        move_to(r, c + 1) + color + random.choice(KATAKANA) + RESET
                    )
                if age > 7:
                    buf.append(move_to(r, c + 1) + " ")
                    dead.append(pos)
            for pos in dead:
                del trails[pos]
            for pos in trails:
                trails[pos] += 1

            sys.stdout.write("".join(buf))
            sys.stdout.flush()
            time.sleep(0.06)
    finally:
        print(CLEAR + SHOW_CURSOR, end="", flush=True)


# ── 5. Bouncing Ball ───────────────────────────────────────────────────────────


def bouncing_ball(duration: float = 5.0):
    cols, rows = term_size()
    # reserve 3 rows for header/footer
    arena_w, arena_h = cols - 2, rows - 4
    x, y = arena_w / 2, arena_h / 2
    vx, vy = random.choice([-1, 1]) * 1.2, random.choice([-1, 1]) * 0.7
    BALL = "●"
    hue = 0

    print(CLEAR + HIDE_CURSOR, end="", flush=True)
    prev_r, prev_c = 0, 0
    deadline = time.time() + duration
    try:
        while time.time() < deadline:
            hue = (hue + 3) % 360
            r_c = int(180 + 75 * math.sin(math.radians(hue)))
            g_c = int(180 + 75 * math.sin(math.radians(hue + 120)))
            b_c = int(180 + 75 * math.sin(math.radians(hue + 240)))

            # erase previous
            sys.stdout.write(move_to(prev_r + 3, prev_c + 1) + " ")
            # draw ball
            row_i, col_i = int(y) + 3, int(x) + 1
            sys.stdout.write(
                move_to(row_i, col_i) + fg(r_c, g_c, b_c) + BOLD + BALL + RESET
            )
            # border + title
            border_top = "┌" + "─" * arena_w + "┐"
            border_bot = "└" + "─" * arena_w + "┘"
            sys.stdout.write(
                move_to(2, 1)
                + DIM
                + border_top
                + RESET
                + move_to(arena_h + 3, 1)
                + DIM
                + border_bot
                + RESET
                + move_to(1, (cols - 18) // 2)
                + BOLD
                + fg(255, 200, 50)
                + "── Bouncing Ball ──"
                + RESET
            )
            sys.stdout.flush()

            prev_r, prev_c = int(y), int(x)
            x += vx
            y += vy
            if x <= 0 or x >= arena_w - 1:
                vx *= -1
            if y <= 0 or y >= arena_h - 1:
                vy *= -1
            x = max(0, min(arena_w - 1, x))
            y = max(0, min(arena_h - 1, y))
            time.sleep(0.03)
    finally:
        print(CLEAR + SHOW_CURSOR, end="", flush=True)


# ── 6. Gradient Text ──────────────────────────────────────────────────────────


def gradient_text(text: str = "  GRADIENT TEXT SHOWCASE — Python Terminal Magic  "):
    print(BOLD + "\n── Gradient Text ──" + RESET)
    n = len(text)
    # rainbow gradient across the string
    for line in range(3):
        out = []
        for i, ch in enumerate(text):
            t = i / max(n - 1, 1)
            # shift hue per line
            angle = t * 360 + line * 40
            r = int(127 + 127 * math.sin(math.radians(angle)))
            g = int(127 + 127 * math.sin(math.radians(angle + 120)))
            b = int(127 + 127 * math.sin(math.radians(angle + 240)))
            out.append(fg(r, g, b) + BOLD + ch)
        print("  " + "".join(out) + RESET)
    print()


# ── 7. ASCII Art Banner ────────────────────────────────────────────────────────

BIG_LETTERS = {
    "P": ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
    "Y": ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
    "T": ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
    "H": ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
    "O": [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
    "N": [
        "███╗   ██╗",
        "████╗  ██║",
        "██╔██╗ ██║",
        "██║╚██╗██║",
        "██║ ╚████║",
        "╚═╝  ╚═══╝",
    ],
    "!": ["██╗", "██║", "██║", "╚═╝", "██╗", "╚═╝"],
}


def ascii_banner(word: str = "PYTHON!"):
    print(BOLD + "\n── ASCII Banner ──" + RESET + "\n")
    cols, _ = term_size()
    letters = [BIG_LETTERS.get(c.upper(), BIG_LETTERS["!"]) for c in word]
    height = max(len(l) for l in letters)
    for row in range(height):
        line_parts = []
        for li, letter in enumerate(letters):
            row_str = letter[row] if row < len(letter) else " " * len(letter[0])
            hue = li * 50
            r = int(127 + 127 * math.sin(math.radians(hue)))
            g = int(127 + 127 * math.sin(math.radians(hue + 120)))
            b = int(127 + 127 * math.sin(math.radians(hue + 240)))
            line_parts.append(fg(r, g, b) + BOLD + row_str + RESET)
        full = "  ".join(line_parts)
        # crude center — strip ANSI for width calc
        import re

        plain = re.sub(r"\033\[[0-9;]*m", "", full)
        pad = max(0, (cols - len(plain)) // 2)
        print(" " * pad + full)
    print()


# ── 8. Live System Stats ───────────────────────────────────────────────────────


def _cpu_usage() -> float:
    """Very rough single-sample CPU% via /proc/stat or ps."""
    try:
        out = subprocess.check_output(
            ["ps", "-A", "-o", "%cpu"], stderr=subprocess.DEVNULL, text=True
        )
        return min(
            100.0, sum(float(x) for x in out.strip().split("\n")[1:] if x.strip())
        )
    except Exception:
        return random.uniform(5, 40)


def _mem_usage() -> tuple[float, float]:
    """Returns (used_gb, total_gb)."""
    try:
        import resource

        # macOS / BSD: vm_stat
        out = subprocess.check_output(["vm_stat"], stderr=subprocess.DEVNULL, text=True)
        page_size = 4096
        stats = {}
        for line in out.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                stats[k.strip()] = int(v.strip().rstrip("."))
        free = stats.get("Pages free", 0) * page_size
        inactive = stats.get("Pages inactive", 0) * page_size
        wired = stats.get("Pages wired down", 0) * page_size
        active = stats.get("Pages active", 0) * page_size
        total = free + inactive + wired + active
        used = wired + active
        return used / 1e9, total / 1e9
    except Exception:
        return random.uniform(4, 8), 16.0


def sparkline(values: list[float], width: int = 20) -> str:
    SPARKS = " ▁▂▃▄▅▆▇█"
    if not values:
        return " " * width
    lo, hi = min(values), max(values)
    rng = hi - lo or 1
    out = []
    for v in values[-width:]:
        idx = int((v - lo) / rng * (len(SPARKS) - 1))
        out.append(SPARKS[idx])
    return "".join(out)


def live_stats(duration: float = 8.0):
    cols, _ = term_size()
    cpu_hist: list[float] = []
    mem_hist: list[float] = []

    print(CLEAR + HIDE_CURSOR, end="", flush=True)
    deadline = time.time() + duration
    start = time.time()
    try:
        while time.time() < deadline:
            cpu = _cpu_usage()
            used_gb, total_gb = _mem_usage()
            mem_pct = 100 * used_gb / total_gb if total_gb else 0
            cpu_hist.append(cpu)
            mem_hist.append(mem_pct)

            elapsed = time.time() - start
            remaining = max(0, duration - elapsed)

            # build display
            cpu_bar_len = 30
            cpu_filled = int(cpu / 100 * cpu_bar_len)
            mem_filled = int(mem_pct / 100 * cpu_bar_len)

            def bar_color(pct):
                if pct < 50:
                    return fg(50, 220, 50)
                if pct < 80:
                    return fg(255, 200, 50)
                return fg(255, 60, 60)

            cpu_bar = (
                bar_color(cpu)
                + "█" * cpu_filled
                + DIM
                + "░" * (cpu_bar_len - cpu_filled)
                + RESET
            )
            mem_bar = (
                bar_color(mem_pct)
                + "█" * mem_filled
                + DIM
                + "░" * (cpu_bar_len - mem_filled)
                + RESET
            )

            now_str = datetime.now().strftime("%H:%M:%S")

            lines = [
                "",
                f"  {BOLD}{fg(100, 200, 255)}── Live System Stats ── {DIM}{now_str}{RESET}",
                "",
                f"  {BOLD}CPU  {RESET}[{cpu_bar}]  {BOLD}{cpu:5.1f}%{RESET}  {DIM}spark:{RESET} {fg(100, 255, 100)}{sparkline(cpu_hist)}{RESET}",
                f"  {BOLD}MEM  {RESET}[{mem_bar}]  {BOLD}{mem_pct:5.1f}%{RESET}  {DIM}spark:{RESET} {fg(100, 200, 255)}{sparkline(mem_hist)}{RESET}",
                f"  {DIM}      {used_gb:.2f} GB / {total_gb:.1f} GB{RESET}",
                "",
                f"  {DIM}Refreshing for {remaining:.0f}s more…{RESET}",
            ]
            sys.stdout.write(move_to(1, 1))
            for ln in lines:
                sys.stdout.write(CLEAR_LINE + ln + "\n")
            sys.stdout.flush()
            time.sleep(0.5)
    finally:
        print(CLEAR + SHOW_CURSOR, end="", flush=True)


# ── 9. Countdown Timer ────────────────────────────────────────────────────────

DIGIT_ART = {
    "0": ["┌─┐", "│ │", "│ │", "│ │", "└─┘"],
    "1": ["  │", "  │", "  │", "  │", "  │"],
    "2": ["┌─┐", " ─┤", "┌─┘", "│  ", "└─┘"],
    "3": ["┌─┐", " ─┤", " ─┤", " ─┤", "└─┘"],
    "4": ["│ │", "└─┤", "  │", "  │", "  │"],
    "5": ["┌─ ", "└─┐", " ─┤", " ─┤", "└─┘"],
    "6": ["┌─ ", "├─┐", "│ │", "│ │", "└─┘"],
    "7": ["┌─┐", "  │", "  │", "  │", "  │"],
    "8": ["┌─┐", "├─┤", "├─┤", "├─┤", "└─┘"],
    "9": ["┌─┐", "│ │", "└─┤", "  │", "└─┘"],
    ":": [" ", " ", "●", " ", "●"],
}


def _render_digits(s: str, color=(100, 220, 255)):
    r, g, b = color
    height = 5
    rows = [""] * height
    for ch in s:
        art = DIGIT_ART.get(ch, [" "] * height)
        for i in range(height):
            rows[i] += (
                fg(r, g, b) + BOLD + (art[i] if i < len(art) else "   ") + "  " + RESET
            )
    return rows


def countdown(seconds: int = 10):
    cols, _ = term_size()
    print(CLEAR + HIDE_CURSOR, end="", flush=True)
    try:
        for remaining in range(seconds, -1, -1):
            s = str(remaining)
            pct = remaining / seconds
            r = int(50 + 205 * (1 - pct))
            g = int(220 - 170 * (1 - pct))
            b = 80
            rows = _render_digits(s, color=(r, g, b))
            sys.stdout.write(move_to(1, 1))
            # title
            title = "── Countdown ──"
            sys.stdout.write(
                CLEAR_LINE
                + " " * ((cols - len(title)) // 2)
                + BOLD
                + fg(200, 200, 200)
                + title
                + RESET
                + "\n\n"
            )
            for row in rows:
                import re

                plain_len = len(re.sub(r"\033\[[0-9;]*m", "", row))
                pad = (cols - plain_len) // 2
                sys.stdout.write(CLEAR_LINE + " " * max(0, pad) + row + "\n")
            msg = (
                "DONE! 🎉"
                if remaining == 0
                else f"  {DIM}{remaining} second{'s' if remaining != 1 else ''} remaining…{RESET}"
            )
            sys.stdout.write(
                CLEAR_LINE + "\n" + CLEAR_LINE + " " * ((cols - 24) // 2) + msg + "\n"
            )
            sys.stdout.flush()
            if remaining > 0:
                time.sleep(1)
    finally:
        print(SHOW_CURSOR, end="", flush=True)
    time.sleep(1)
    print(CLEAR, end="", flush=True)


# ── 10. Interactive Menu ──────────────────────────────────────────────────────

DEMOS = [
    ("Spinner Showcase", lambda: spinner_demo(3.0)),
    ("Progress Bar", lambda: progress_bar(60)),
    ("Typewriter Effect", lambda: typewriter()),
    ("Matrix Rain", lambda: matrix_rain(6.0)),
    ("Bouncing Ball", lambda: bouncing_ball(5.0)),
    ("Gradient Text", lambda: gradient_text()),
    ("ASCII Art Banner", lambda: ascii_banner()),
    ("Live System Stats", lambda: live_stats(8.0)),
    ("Countdown Timer", lambda: countdown(10)),
    ("Run All Demos", None),
    ("Quit", None),
]


def interactive_menu():
    selected = 0
    while True:
        cols, rows = term_size()
        print(CLEAR + HIDE_CURSOR, end="", flush=True)

        title = " Terminal Magic — Python Demo "
        pad = (cols - len(title)) // 2
        print(
            "\n"
            + " " * pad
            + bg(30, 30, 60)
            + fg(150, 220, 255)
            + BOLD
            + title
            + RESET
            + "\n"
        )

        for i, (name, _) in enumerate(DEMOS):
            prefix = "  "
            if i == selected:
                row_str = (
                    "  "
                    + bg(50, 80, 130)
                    + fg(255, 255, 255)
                    + BOLD
                    + f"  ❯ {i + 1:2d}.  {name:<30} "
                    + RESET
                )
            else:
                row_str = "  " + DIM + f"     {i + 1:2d}.  {name:<30} " + RESET
            print(row_str)

        print(f"\n  {DIM}↑/↓ or j/k to navigate · Enter to run · q to quit{RESET}\n")

        # Read a single keypress
        key = _getch()

        if key in ("\x1b[A", "k", "K"):  # up
            selected = (selected - 1) % len(DEMOS)
        elif key in ("\x1b[B", "j", "J"):  # down
            selected = (selected + 1) % len(DEMOS)
        elif key in ("\r", "\n", " "):  # enter / space
            name, fn = DEMOS[selected]
            if name == "Quit":
                break
            elif name == "Run All Demos":
                print(CLEAR + SHOW_CURSOR)
                for dname, dfn in DEMOS[:-2]:
                    print(fg(200, 255, 200) + BOLD + f"\n  ▶ {dname}" + RESET)
                    time.sleep(0.5)
                    dfn()
            else:
                print(CLEAR + SHOW_CURSOR)
                fn()
                input(f"\n  {DIM}Press Enter to return to menu…{RESET}")
        elif key in ("q", "Q", "\x03"):
            break

    print(CLEAR + SHOW_CURSOR + fg(100, 255, 100) + BOLD + "\n  Goodbye! ✨\n" + RESET)


# ── Raw keypress helper ────────────────────────────────────────────────────────


def _getch() -> str:
    """Read one keypress (including escape sequences) from stdin."""
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            # might be an escape sequence
            try:
                tty.setraw(fd)
                ch2 = sys.stdin.read(1)
                if ch2 == "[":
                    ch3 = sys.stdin.read(1)
                    return "\x1b[" + ch3
                return ch + ch2
            except Exception:
                pass
        return ch
    except Exception:
        return ""
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Terminal Magic — Cool terminal demos in Python"
    )
    parser.add_argument(
        "--demo",
        choices=[
            "spinner",
            "progress",
            "typewriter",
            "matrix",
            "ball",
            "gradient",
            "banner",
            "stats",
            "countdown",
            "all",
            "menu",
        ],
        default="menu",
        help="Which demo to run directly (default: interactive menu)",
    )
    parser.add_argument(
        "--no-menu", action="store_true", help="Skip the menu and run --demo directly"
    )
    args = parser.parse_args()

    demo_map = {
        "spinner": lambda: spinner_demo(3.0),
        "progress": lambda: progress_bar(60),
        "typewriter": lambda: typewriter(),
        "matrix": lambda: matrix_rain(6.0),
        "ball": lambda: bouncing_ball(5.0),
        "gradient": lambda: gradient_text(),
        "banner": lambda: ascii_banner(),
        "stats": lambda: live_stats(8.0),
        "countdown": lambda: countdown(10),
    }

    if args.demo == "menu" and not args.no_menu:
        interactive_menu()
    elif args.demo == "all":
        for name, fn in demo_map.items():
            print(fg(200, 255, 200) + BOLD + f"\n  ▶ {name}" + RESET)
            time.sleep(0.4)
            fn()
    else:
        fn = demo_map.get(args.demo)
        if fn:
            fn()
        else:
            interactive_menu()
