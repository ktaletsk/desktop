#!/usr/bin/env python3
"""Sync E2E test — WebDriver (UI) + runtimed Python client as concurrent peers.

Drives the Tauri notebook app via its embedded WebDriver server while
simultaneously connecting a runtimed Python client to the same notebook.
Tests that CRDT sync works correctly between the two peers, including
emoji/surrogate pair handling.

Prerequisites:
    - E2E app binary built: cargo xtask build-e2e
    - Daemon running: cargo xtask dev-daemon (or runt-nightly daemon start)
    - App launched with WebDriver: target/debug/notebook (the e2e build)
    - Python deps: pip install selenium runtimed

Usage:
    # Against dev daemon (auto-discovers socket):
    uv run python scripts/sync-e2e.py

    # Against nightly daemon:
    uv run python scripts/sync-e2e.py --socket ~/Library/Caches/runt-nightly/runtimed.sock

    # With custom WebDriver port:
    uv run python scripts/sync-e2e.py --webdriver-port 4445

    # Skip app launch (if already running):
    uv run python scripts/sync-e2e.py --no-launch

Architecture:
    ┌─────────────┐       ┌───────────┐       ┌──────────────┐
    │  WebDriver   │──W3C──│  Tauri App │──sync──│   runtimed   │
    │  (selenium)  │  HTTP │  (wry)     │       │   daemon     │
    └─────────────┘       └───────────┘       └──────────────┘
                                                      ▲
    ┌─────────────┐                                   │
    │  runtimed   │───────────────────────────────────┘
    │  (Python)   │  direct socket
    └─────────────┘

    Both the Tauri app and the Python client connect to the same daemon
    notebook room as separate Automerge peers. Changes made via WebDriver
    (typing in CodeMirror) sync to the Python client, and vice versa.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Optional imports — fail gracefully with instructions
# ---------------------------------------------------------------------------

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait
except ImportError:
    print("selenium not installed. Run: uv pip install selenium")
    sys.exit(1)

try:
    from runtimed import Client
except ImportError:
    print("runtimed not installed. Run: cd python/runtimed && maturin develop")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Test result tracking
# ---------------------------------------------------------------------------


@dataclass
class TestResult:
    name: str
    passed: bool
    duration_ms: float
    message: str = ""


@dataclass
class TestSuite:
    results: list[TestResult] = field(default_factory=list)

    def record(self, name: str, passed: bool, duration_ms: float, message: str = ""):
        self.results.append(TestResult(name, passed, duration_ms, message))
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status} {name} ({duration_ms:.0f}ms){f' — {message}' if message else ''}")

    def summary(self):
        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        total = len(self.results)
        print()
        print("=" * 60)
        print(f"Sync E2E: {passed}/{total} passed, {failed} failed")
        if failed:
            print("Failures:")
            for r in self.results:
                if not r.passed:
                    print(f"  ✗ {r.name}: {r.message}")
        print("=" * 60)
        return failed == 0


# ---------------------------------------------------------------------------
# WebDriver helpers
# ---------------------------------------------------------------------------


def connect_webdriver(port: int, timeout: float = 30.0) -> webdriver.Remote:
    """Connect to the Tauri embedded WebDriver server."""
    url = f"http://localhost:{port}"

    # Poll until the WebDriver server is ready
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            import urllib.request

            with urllib.request.urlopen(f"{url}/status", timeout=2) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.5)
    else:
        raise TimeoutError(f"WebDriver not ready at {url} after {timeout}s")

    # Connect with wry capabilities
    options = webdriver.ChromeOptions()
    # wry uses a custom browserName but accepts Chrome-like capabilities
    driver = webdriver.Remote(
        command_executor=url,
        options=options,
        # Override the capabilities for wry
        desired_capabilities={"browserName": "wry"},
    )
    return driver


def connect_webdriver_wry(port: int, timeout: float = 30.0) -> webdriver.Remote:
    """Connect to the wry WebDriver with raw W3C capabilities."""
    url = f"http://localhost:{port}"

    # Poll until ready
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            import urllib.request

            with urllib.request.urlopen(f"{url}/status", timeout=2) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.5)
    else:
        raise TimeoutError(f"WebDriver not ready at {url} after {timeout}s")

    # Use raw W3C session creation for wry compatibility
    from selenium.webdriver.remote.remote_connection import RemoteConnection

    conn = RemoteConnection(url)
    driver = webdriver.Remote(
        command_executor=conn,
        options=webdriver.ChromeOptions(),
    )
    return driver


def wait_for_app_ready(driver: webdriver.Remote, timeout: float = 15.0):
    """Wait for the notebook toolbar to appear."""
    WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script(
            "return !!document.querySelector('[data-testid=\"notebook-toolbar\"]')"
        )
    )


def wait_for_notebook_synced(driver: webdriver.Remote, timeout: float = 15.0):
    """Wait for Automerge sync to complete (cells rendered)."""
    wait_for_app_ready(driver, timeout)
    WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script("""
            const el = document.querySelector('[data-notebook-synced]');
            return el && el.getAttribute('data-notebook-synced') === 'true';
        """)
    )


def wait_for_kernel_ready(driver: webdriver.Remote, timeout: float = 120.0):
    """Wait for the kernel to reach idle state."""
    wait_for_app_ready(driver, timeout)
    WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script("""
            const el = document.querySelector('[data-testid="kernel-status"]');
            if (!el) return false;
            const status = (el.getAttribute('data-kernel-status') || '').trim().toLowerCase();
            return status === 'idle' || status === 'busy';
        """)
    )


def get_cell_count(driver: webdriver.Remote) -> int:
    """Get the number of cells visible in the UI."""
    return driver.execute_script('return document.querySelectorAll("[data-cell-type]").length')


def get_cell_ids(driver: webdriver.Remote) -> list[str]:
    """Get all cell IDs from the UI."""
    return driver.execute_script("""
        return Array.from(document.querySelectorAll('[data-cell-id]'))
            .map(el => el.getAttribute('data-cell-id'));
    """)


def get_cell_source_from_ui(driver: webdriver.Remote, index: int = 0) -> str:
    """Read cell source from the CodeMirror editor via DOM."""
    return driver.execute_script(f"""
        const cells = document.querySelectorAll('[data-cell-type="code"]');
        if (cells.length <= {index}) return null;
        const cm = cells[{index}].querySelector('.cm-content[contenteditable]');
        if (!cm || !cm.cmTile || !cm.cmTile.view) return null;
        return cm.cmTile.view.state.doc.toString();
    """)


def set_cell_source_via_ui(driver: webdriver.Remote, source: str, index: int = 0):
    """Set cell source via CodeMirror's dispatch API (bypasses keyboard events)."""
    driver.execute_script(
        """
        const [source, idx] = arguments;
        const cells = document.querySelectorAll('[data-cell-type="code"]');
        if (cells.length <= idx) throw new Error('Cell not found at index ' + idx);
        const cm = cells[idx].querySelector('.cm-content[contenteditable]');
        if (!cm || !cm.cmTile || !cm.cmTile.view) throw new Error('No CM view');
        const view = cm.cmTile.view;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: source }
        });
    """,
        source,
        index,
    )


def execute_cell_via_ui(driver: webdriver.Remote, index: int = 0):
    """Click the execute button on a cell."""
    driver.execute_script(
        f"""
        const cells = document.querySelectorAll('[data-cell-type="code"]');
        if (cells.length <= {index}) throw new Error('Cell not found');
        const btn = cells[{index}].querySelector('[data-testid="execute-button"]');
        if (btn) btn.click();
    """
    )


def get_notebook_id_from_ui(driver: webdriver.Remote) -> str | None:
    """Extract the notebook ID from the app's internal state."""
    return driver.execute_script("""
        // The notebook ID is stored in the Zustand store. Access via window.__ZUSTAND_STORE__
        // or by reading the data attribute from the notebook container.
        const el = document.querySelector('[data-notebook-id]');
        if (el) return el.getAttribute('data-notebook-id');
        // Fallback: try the store
        return null;
    """)


def wait_for_cell_source_in_ui(
    driver: webdriver.Remote, expected: str, index: int = 0, timeout: float = 10.0
) -> bool:
    """Wait for a cell's source to match expected text."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        actual = get_cell_source_from_ui(driver, index)
        if actual == expected:
            return True
        time.sleep(0.3)
    return False


def wait_for_cell_count_in_ui(
    driver: webdriver.Remote, expected: int, timeout: float = 10.0
) -> bool:
    """Wait for the UI to show expected number of cells."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        actual = get_cell_count(driver)
        if actual >= expected:
            return True
        time.sleep(0.3)
    return False


# ---------------------------------------------------------------------------
# runtimed helpers
# ---------------------------------------------------------------------------


async def get_notebook_from_client(client: Client, notebook_id: str | None = None):
    """Join a notebook via the Python client."""
    if notebook_id:
        return await client.join_notebook(notebook_id)

    # Auto-discover: join the first active notebook
    notebooks = await client.list_active_notebooks()
    if not notebooks:
        raise RuntimeError("No active notebooks found on daemon")
    return await client.join_notebook(notebooks[0].notebook_id)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


async def test_ui_edit_syncs_to_python(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """UI types in a cell → Python client sees the change."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-reader")

        # Wait for sync to settle
        await asyncio.sleep(1.0)

        # Find a code cell in the UI and set its source
        source = 'print("sync test from UI")'
        set_cell_source_via_ui(driver, source, index=0)

        # Wait for CRDT sync to propagate to daemon → Python client
        await asyncio.sleep(2.0)

        # Read from the Python client
        cell_ids = notebook.cells.ids
        if not cell_ids:
            suite.record("ui_edit_syncs_to_python", False, _ms(t0), "No cells in Python client")
            await notebook.close()
            return

        cell = notebook.cells[cell_ids[0]]
        actual = cell.source

        if actual == source:
            suite.record("ui_edit_syncs_to_python", True, _ms(t0))
        else:
            suite.record(
                "ui_edit_syncs_to_python",
                False,
                _ms(t0),
                f"Expected {source!r}, got {actual!r}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("ui_edit_syncs_to_python", False, _ms(t0), str(e))


async def test_python_edit_syncs_to_ui(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Python client edits a cell → UI shows the change."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-writer")
        await asyncio.sleep(1.0)

        cell_ids = notebook.cells.ids
        if not cell_ids:
            suite.record("python_edit_syncs_to_ui", False, _ms(t0), "No cells")
            await notebook.close()
            return

        # Python client sets cell source
        source = 'print("sync test from Python")'
        cell = notebook.cells[cell_ids[0]]
        await cell.set_source(source)

        # Wait for sync to UI
        found = wait_for_cell_source_in_ui(driver, source, index=0, timeout=5.0)
        if found:
            suite.record("python_edit_syncs_to_ui", True, _ms(t0))
        else:
            actual = get_cell_source_from_ui(driver, 0)
            suite.record(
                "python_edit_syncs_to_ui",
                False,
                _ms(t0),
                f"UI shows {actual!r}, expected {source!r}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("python_edit_syncs_to_ui", False, _ms(t0), str(e))


async def test_python_create_cell_appears_in_ui(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Python client creates a cell → UI renders it."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-creator")
        await asyncio.sleep(1.0)

        initial_count = get_cell_count(driver)

        # Create a new cell via Python
        cell = await notebook.cells.create(
            source='print("created by Python peer")', cell_type="code"
        )

        # Wait for UI to show the new cell
        found = wait_for_cell_count_in_ui(driver, initial_count + 1, timeout=5.0)
        if found:
            suite.record("python_create_cell_appears_in_ui", True, _ms(t0))
        else:
            actual = get_cell_count(driver)
            suite.record(
                "python_create_cell_appears_in_ui",
                False,
                _ms(t0),
                f"UI has {actual} cells, expected {initial_count + 1}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("python_create_cell_appears_in_ui", False, _ms(t0), str(e))


async def test_emoji_survives_roundtrip(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Emoji set from UI roundtrips through CRDT to Python client correctly."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-emoji")
        await asyncio.sleep(1.0)

        # Set emoji source from UI
        source = 'print("hello 🌍🐸⚡")'
        set_cell_source_via_ui(driver, source, index=0)

        # Wait for sync
        await asyncio.sleep(2.0)

        cell_ids = notebook.cells.ids
        if not cell_ids:
            suite.record("emoji_survives_roundtrip", False, _ms(t0), "No cells")
            await notebook.close()
            return

        cell = notebook.cells[cell_ids[0]]
        actual = cell.source

        if actual == source:
            suite.record("emoji_survives_roundtrip", True, _ms(t0))
        else:
            suite.record(
                "emoji_survives_roundtrip",
                False,
                _ms(t0),
                f"Expected {source!r}, got {actual!r}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("emoji_survives_roundtrip", False, _ms(t0), str(e))


async def test_emoji_edit_after_roundtrip(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Edit text after emoji — the position should be correct (UTF-16 fix)."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-emoji-edit")
        await asyncio.sleep(1.0)

        # Set source with emoji from UI
        source = 'x = "🐸 hello"'
        set_cell_source_via_ui(driver, source, index=0)
        await asyncio.sleep(1.5)

        # Now append via Python (at the end — tests that positions after emoji are correct)
        cell_ids = notebook.cells.ids
        if not cell_ids:
            suite.record("emoji_edit_after_roundtrip", False, _ms(t0), "No cells")
            await notebook.close()
            return

        cell = notebook.cells[cell_ids[0]]
        await cell.append("\ny = 42")
        await asyncio.sleep(1.5)

        # Check UI shows the appended text
        expected = 'x = "🐸 hello"\ny = 42'
        found = wait_for_cell_source_in_ui(driver, expected, index=0, timeout=5.0)
        if found:
            suite.record("emoji_edit_after_roundtrip", True, _ms(t0))
        else:
            actual = get_cell_source_from_ui(driver, 0)
            suite.record(
                "emoji_edit_after_roundtrip",
                False,
                _ms(t0),
                f"UI shows {actual!r}, expected {expected!r}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("emoji_edit_after_roundtrip", False, _ms(t0), str(e))


async def test_concurrent_edits_converge(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Both peers edit simultaneously — they should converge."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-concurrent")
        await asyncio.sleep(1.0)

        # Set initial source
        set_cell_source_via_ui(driver, "initial", index=0)
        await asyncio.sleep(1.5)

        # Create a second cell from Python for concurrent editing
        cell2 = await notebook.cells.create(source="# python cell", cell_type="code")
        await asyncio.sleep(1.0)

        # UI edits first cell while Python edits second cell
        set_cell_source_via_ui(driver, "ui edited this", index=0)
        await cell2.set_source("python edited this")

        # Wait for convergence
        await asyncio.sleep(3.0)

        # Both peers should see the same state
        cell_ids = notebook.cells.ids
        ui_cell_count = get_cell_count(driver)
        python_cell_count = len(cell_ids)

        # Cell counts should match (structural convergence)
        if ui_cell_count == python_cell_count:
            suite.record(
                "concurrent_edits_converge", True, _ms(t0), f"Both peers have {ui_cell_count} cells"
            )
        else:
            suite.record(
                "concurrent_edits_converge",
                False,
                _ms(t0),
                f"UI has {ui_cell_count} cells, Python has {python_cell_count}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("concurrent_edits_converge", False, _ms(t0), str(e))


async def test_python_execute_output_appears_in_ui(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Python client executes a cell → output appears in UI."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-exec")
        await asyncio.sleep(1.0)

        cell_ids = notebook.cells.ids
        if not cell_ids:
            suite.record("python_execute_output_in_ui", False, _ms(t0), "No cells")
            await notebook.close()
            return

        # Set source and execute from Python
        cell = notebook.cells[cell_ids[0]]
        await cell.set_source('print("executed by python peer")')
        await asyncio.sleep(0.5)

        result = await cell.run(timeout_secs=30)

        if not result.success:
            suite.record(
                "python_execute_output_in_ui", False, _ms(t0), f"Execution failed: {result.outputs}"
            )
            await notebook.close()
            return

        # Wait for output to appear in UI
        deadline = time.monotonic() + 10.0
        found = False
        while time.monotonic() < deadline:
            has_output = driver.execute_script("""
                const outputs = document.querySelectorAll('[data-slot="ansi-stream-output"]');
                for (const o of outputs) {
                    if (o.textContent.includes('executed by python peer')) return true;
                }
                return false;
            """)
            if has_output:
                found = True
                break
            await asyncio.sleep(0.5)

        if found:
            suite.record("python_execute_output_in_ui", True, _ms(t0))
        else:
            suite.record(
                "python_execute_output_in_ui", False, _ms(t0), "Output not visible in UI after 10s"
            )
        await notebook.close()
    except Exception as e:
        suite.record("python_execute_output_in_ui", False, _ms(t0), str(e))


async def test_python_delete_cell_removed_from_ui(
    driver: webdriver.Remote, client: Client, notebook_id: str, suite: TestSuite
):
    """Python client deletes a cell → UI removes it."""
    t0 = time.monotonic()
    try:
        notebook = await client.join_notebook(notebook_id, peer_label="sync-e2e-delete")
        await asyncio.sleep(1.0)

        # Create a cell to delete
        cell = await notebook.cells.create(source="# delete me", cell_type="code")
        await asyncio.sleep(1.5)

        count_before = get_cell_count(driver)
        await cell.delete()
        await asyncio.sleep(1.5)

        count_after = get_cell_count(driver)
        if count_after < count_before:
            suite.record("python_delete_cell_removed_from_ui", True, _ms(t0))
        else:
            suite.record(
                "python_delete_cell_removed_from_ui",
                False,
                _ms(t0),
                f"Count before={count_before}, after={count_after}",
            )
        await notebook.close()
    except Exception as e:
        suite.record("python_delete_cell_removed_from_ui", False, _ms(t0), str(e))


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _ms(t0: float) -> float:
    return (time.monotonic() - t0) * 1000


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run_tests(
    socket_path: str | None,
    webdriver_port: int,
    notebook_id: str | None,
    no_launch: bool,
):
    suite = TestSuite()
    driver: webdriver.Remote | None = None
    app_proc: subprocess.Popen | None = None

    try:
        # ── Connect to daemon via Python client ──────────────────────
        client = Client(socket_path=socket_path, peer_label="sync-e2e")

        if not await client.is_running():
            print("❌ Daemon not running. Start it first:")
            print("   cargo xtask dev-daemon")
            return False

        print(f"✓ Daemon connected (socket: {socket_path or 'auto'})")

        # ── Launch app if needed ─────────────────────────────────────
        if not no_launch:
            repo_root = Path(__file__).resolve().parent.parent
            app_binary = repo_root / "target" / "debug" / "notebook"
            if not app_binary.exists():
                print(f"❌ E2E app binary not found at {app_binary}")
                print("   Build with: cargo xtask build-e2e")
                return False

            print(f"Launching app: {app_binary}")
            app_proc = subprocess.Popen(
                [str(app_binary)],
                env={
                    **os.environ,
                    "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS": "1",
                },
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Give it a moment to start the WebDriver server
            time.sleep(3)

        # ── Connect WebDriver ────────────────────────────────────────
        print(f"Connecting WebDriver on port {webdriver_port}...")
        try:
            driver = connect_webdriver_wry(webdriver_port, timeout=30.0)
        except Exception as e:
            print(f"❌ WebDriver connection failed: {e}")
            print("   Is the E2E app running with WebDriver enabled?")
            print(f"   Check http://localhost:{webdriver_port}/status")
            return False
        print("✓ WebDriver connected")

        # ── Wait for app readiness ───────────────────────────────────
        print("Waiting for app to load...")
        wait_for_app_ready(driver, timeout=15.0)
        print("✓ App ready")

        print("Waiting for notebook sync...")
        wait_for_notebook_synced(driver, timeout=15.0)
        print("✓ Notebook synced")

        # ── Discover notebook ID ─────────────────────────────────────
        if not notebook_id:
            # Try to get from UI first
            notebook_id = get_notebook_id_from_ui(driver)
            if not notebook_id:
                # Fall back to first active notebook on daemon
                notebooks = await client.list_active_notebooks()
                if notebooks:
                    notebook_id = notebooks[0].notebook_id
                else:
                    print("❌ No notebooks found")
                    return False

        print(f"✓ Notebook: {notebook_id[:12]}...")
        print()

        # ── Run tests ────────────────────────────────────────────────
        print("Running sync E2E tests...")
        print()

        await test_ui_edit_syncs_to_python(driver, client, notebook_id, suite)
        await test_python_edit_syncs_to_ui(driver, client, notebook_id, suite)
        await test_python_create_cell_appears_in_ui(driver, client, notebook_id, suite)
        await test_emoji_survives_roundtrip(driver, client, notebook_id, suite)
        await test_emoji_edit_after_roundtrip(driver, client, notebook_id, suite)
        await test_concurrent_edits_converge(driver, client, notebook_id, suite)
        await test_python_execute_output_appears_in_ui(driver, client, notebook_id, suite)
        await test_python_delete_cell_removed_from_ui(driver, client, notebook_id, suite)

        return suite.summary()

    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        if app_proc:
            app_proc.terminate()
            app_proc.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(
        prog="sync-e2e",
        description="🔄 Sync E2E test — WebDriver + runtimed Python client as concurrent peers",
    )
    parser.add_argument(
        "--socket",
        default=None,
        help="Daemon socket path (default: auto-discover)",
    )
    parser.add_argument(
        "--webdriver-port",
        type=int,
        default=4445,
        help="WebDriver server port (default: 4445)",
    )
    parser.add_argument(
        "--notebook-id",
        default=None,
        help="Notebook ID to test (default: auto-discover)",
    )
    parser.add_argument(
        "--no-launch",
        action="store_true",
        help="Skip app launch (connect to already-running app)",
    )
    args = parser.parse_args()

    print("🔄 Sync E2E — WebDriver + runtimed concurrent peers")
    print()

    try:
        success = asyncio.run(
            run_tests(
                socket_path=args.socket,
                webdriver_port=args.webdriver_port,
                notebook_id=args.notebook_id,
                no_launch=args.no_launch,
            )
        )
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n🔄 Interrupted.")
        sys.exit(1)
    except Exception:
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
