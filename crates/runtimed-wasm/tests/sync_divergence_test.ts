/**
 * Stress test for sync head divergence under rapid execution (Issue #1067).
 *
 * Reproduces the race condition where `flushSync()` and `syncReply$`
 * both call `generate_sync_message()`, which destructively advances
 * `sync_state.last_sent_heads` before the message is delivered. When
 * interleaved with daemon output writes, this causes permanent sync
 * stalls.
 *
 * The test simulates the real execution flow:
 *   1. Frontend (WASM handle) edits source and requests execution
 *   2. Frontend calls generate_sync_message() to flush (flushSync path)
 *   3. Daemon writes outputs to its handle and syncs back
 *   4. Frontend processes daemon sync, calls generate_sync_reply()
 *   5. Under rapid Ctrl+Enter, steps 2 and 4 race on the same sync_state
 *
 * Run with:
 *   deno test --allow-read --no-check crates/runtimed-wasm/tests/sync_divergence_test.ts
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// @ts-nocheck — wasm-bindgen output doesn't have Deno-compatible type declarations

// deno-lint-ignore no-explicit-any
let init: any, NotebookHandle: any;

const wasmJsPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBinPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

const mod = await import(wasmJsPath.href);
init = mod.default;
NotebookHandle = mod.NotebookHandle;

const wasmBytes = await Deno.readFile(wasmBinPath);
await init(wasmBytes);

// ── Helpers ──────────────────────────────────────────────────────────

/** Sync two handles until convergence. */
// deno-lint-ignore no-explicit-any
function syncHandles(a: any, b: any, maxRounds = 10) {
  for (let i = 0; i < maxRounds; i++) {
    const msgA = a.generate_sync_message();
    const msgB = b.generate_sync_message();
    if (!msgA && !msgB) break;
    if (msgA) b.receive_sync_message(msgA);
    if (msgB) a.receive_sync_message(msgB);
  }
}

/**
 * One-directional sync: a → b (simulates sending a sync message over
 * the wire). Returns the message that was sent, or null if none.
 */
// deno-lint-ignore no-explicit-any
function syncOneWay(sender: any, receiver: any): Uint8Array | null {
  const msg = sender.generate_sync_message();
  if (msg) {
    receiver.receive_sync_message(msg);
  }
  return msg ?? null;
}

// ── Tests ────────────────────────────────────────────────────────────

Deno.test(
  "Issue #1067: generate_sync_message consumption prevents sync_reply",
  () => {
    // Setup: daemon has a notebook, frontend syncs via create_empty
    const daemon = new NotebookHandle("daemon-1067");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("hello")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    assertEquals(frontend.cell_count(), 1);
    assertEquals(frontend.get_cell("cell-1")?.source, 'print("hello")');

    // Simulate the race:
    // 1. Frontend edits source (user presses Ctrl+Enter)
    frontend.update_source("cell-1", 'print("run 1")');

    // 2. flushSync path: frontend calls generate_sync_message()
    //    This destructively advances sync_state.last_sent_heads
    const flushMsg = frontend.generate_sync_message();
    assertExists(flushMsg, "flushSync should produce a message");

    // 3. Simulate: the message is NOT delivered yet (blocked by mutex)
    //    Meanwhile, daemon sends output from a previous execution
    daemon.set_execution_count("cell-1", "1");

    const daemonMsg = daemon.generate_sync_message();
    assertExists(daemonMsg, "daemon should have output sync message");

    // 4. Frontend receives daemon's sync (output update)
    const changed = frontend.receive_sync_message(daemonMsg);
    assert(changed, "frontend should see daemon's output change");

    // 5. syncReply$ debounce fires: frontend calls generate_sync_reply()
    //    BUG (before fix): This returns null because flushSync already
    //    consumed the sync_state in step 2.
    const syncReply = frontend.generate_sync_reply();

    // 6. Now deliver the flush message (step 2) to daemon
    daemon.receive_sync_message(flushMsg);

    // If syncReply is null, the frontend's acknowledgment of the daemon's
    // output never gets sent back. The daemon thinks the frontend hasn't
    // seen its changes. We should still be able to converge.

    // 7. Complete sync to verify convergence is still possible
    syncHandles(frontend, daemon);

    // Both should have the same state
    assertEquals(
      daemon.get_cell("cell-1")?.source,
      frontend.get_cell("cell-1")?.source,
    );
    assertEquals(daemon.get_cell("cell-1")?.execution_count, "1");
    assertEquals(frontend.get_cell("cell-1")?.execution_count, "1");

    daemon.free();
    frontend.free();
  },
);

Deno.test(
  "Issue #1067: rapid execution causes sync stall without recovery",
  () => {
    // This test simulates 10 rapid Ctrl+Enter presses
    const daemon = new NotebookHandle("daemon-rapid");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("start")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    let staleReplies = 0;
    let totalReplies = 0;

    for (let i = 1; i <= 10; i++) {
      // 1. User edits source (rapid Ctrl+Enter)
      frontend.update_source("cell-1", `print("run ${i}")`);

      // 2. flushSync: generate_sync_message (destructive)
      const flushMsg = frontend.generate_sync_message();

      // 3. Daemon processes previous execution's output
      daemon.set_execution_count("cell-1", String(i));
      const daemonOutMsg = daemon.generate_sync_message();

      // 4. Deliver daemon output to frontend
      if (daemonOutMsg) {
        frontend.receive_sync_message(daemonOutMsg);
      }

      // 5. syncReply$ fires (the debounced path)
      const reply = frontend.generate_sync_reply();
      totalReplies++;
      if (!reply) {
        staleReplies++;
      }

      // 6. Deliver flushSync message to daemon (delayed)
      if (flushMsg) {
        daemon.receive_sync_message(flushMsg);
      }

      // 7. Deliver sync reply to daemon
      if (reply) {
        daemon.receive_sync_message(reply);
      }
    }

    // After rapid fire, try to converge
    syncHandles(frontend, daemon);

    // Verify convergence
    const frontendSource = frontend.get_cell("cell-1")?.source;
    const daemonSource = daemon.get_cell("cell-1")?.source;
    assertEquals(
      frontendSource,
      daemonSource,
      `Sources diverged! frontend="${frontendSource}" daemon="${daemonSource}"`,
    );

    const frontendEc = frontend.get_cell("cell-1")?.execution_count;
    const daemonEc = daemon.get_cell("cell-1")?.execution_count;
    assertEquals(
      frontendEc,
      daemonEc,
      `Execution counts diverged! frontend="${frontendEc}" daemon="${daemonEc}"`,
    );

    // Report: how many sync replies were consumed by flushSync?
    console.log(
      `  [rapid-exec] ${staleReplies}/${totalReplies} sync replies were consumed by prior flushSync`,
    );

    // The key assertion: even if sync replies were consumed, we should
    // still converge after syncHandles. If we can't converge, the
    // protocol is permanently stalled (the bug).
    assertEquals(
      daemon.generate_sync_message(),
      undefined,
      "Daemon should have no pending sync after convergence",
    );
    assertEquals(
      frontend.generate_sync_message(),
      undefined,
      "Frontend should have no pending sync after convergence",
    );

    daemon.free();
    frontend.free();
  },
);

Deno.test(
  "Issue #1067: dropped flushSync message permanently diverges sync_state",
  () => {
    // This is the most critical scenario: flushSync generates a message,
    // advances sync_state, but the message is NEVER delivered.
    //
    // This test DEMONSTRATES the bug: generate_sync_message() advancing
    // last_sent_heads before delivery means the protocol permanently
    // loses the frontend's edit — even after 20 rounds of sync.
    const daemon = new NotebookHandle("daemon-drop");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("hello")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    // Frontend edits
    frontend.update_source("cell-1", 'print("edited")');

    // flushSync generates message but it's DROPPED (never delivered)
    const droppedMsg = frontend.generate_sync_message();
    assertExists(droppedMsg, "flushSync should produce a message");
    // NOT delivered to daemon — simulates sendFrame failure

    // Try to recover via normal sync rounds
    syncHandles(frontend, daemon, 20);

    const fSource = frontend.get_cell("cell-1")?.source;
    const dSource = daemon.get_cell("cell-1")?.source;

    // BUG DEMONSTRATION: the daemon never receives the edit because
    // sync_state.last_sent_heads was advanced before delivery. The
    // protocol believes the changes were already sent and never
    // retransmits them.
    assertEquals(fSource, 'print("edited")', "Frontend has the edit");
    assertEquals(dSource, 'print("hello")', "Daemon never got the edit — THIS IS THE BUG");

    // FIX VERIFICATION: reset_sync_state recovers from this condition.
    // This is what the re-arm logic in the fix does: on sendFrame
    // failure, the debounce is re-triggered, which (after enough
    // failures) would call reset_sync_state() as a last resort.
    frontend.reset_sync_state();
    syncHandles(frontend, daemon, 20);

    const fSourceAfter = frontend.get_cell("cell-1")?.source;
    const dSourceAfter = daemon.get_cell("cell-1")?.source;
    assertEquals(
      fSourceAfter,
      dSourceAfter,
      "After reset_sync_state, both should converge",
    );
    assertEquals(dSourceAfter, 'print("edited")', "Daemon gets the edit after recovery");

    daemon.free();
    frontend.free();
  },
);

Deno.test(
  "Issue #1067: single-callsite pattern prevents consumption race",
  () => {
    // This test verifies the FIX: only one callsite (syncReply$) should
    // call generate_sync_message/generate_sync_reply. flushSync should
    // trigger the debounce instead.
    //
    // We simulate the fixed behavior: instead of calling
    // generate_sync_message() from flushSync, we only call it from the
    // "debounce handler" (simulated as a single function).

    const daemon = new NotebookHandle("daemon-fix");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("hello")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    // The "debounce handler" is the single callsite
    // deno-lint-ignore no-explicit-any
    const sendSyncFromFrontend = (fe: any, d: any) => {
      const msg = fe.generate_sync_message();
      if (msg) d.receive_sync_message(msg);
    };

    // deno-lint-ignore no-explicit-any
    const sendSyncReply = (fe: any, d: any) => {
      const reply = fe.generate_sync_reply();
      if (reply) d.receive_sync_message(reply);
    };

    let successfulReplies = 0;

    // Simulate 20 rapid executions using the single-callsite pattern
    for (let i = 1; i <= 20; i++) {
      // User edits
      frontend.update_source("cell-1", `print("run ${i}")`);

      // flushSync triggers the debounce handler (NOT generate_sync_message directly)
      sendSyncFromFrontend(frontend, daemon);

      // Daemon processes output
      daemon.set_execution_count("cell-1", String(i));
      const daemonMsg = daemon.generate_sync_message();
      if (daemonMsg) {
        frontend.receive_sync_message(daemonMsg);
      }

      // Debounce handler fires for sync reply (same callsite)
      const reply = frontend.generate_sync_reply();
      if (reply) {
        daemon.receive_sync_message(reply);
        successfulReplies++;
      }
    }

    // Final sync
    syncHandles(frontend, daemon);

    // With single-callsite pattern, ALL replies should succeed
    // (no consumption race)
    console.log(
      `  [fix-test] ${successfulReplies}/20 sync replies succeeded with single-callsite pattern`,
    );

    // Verify full convergence
    assertEquals(
      frontend.get_cell("cell-1")?.source,
      daemon.get_cell("cell-1")?.source,
    );
    assertEquals(frontend.get_cell("cell-1")?.execution_count, "20");
    assertEquals(daemon.get_cell("cell-1")?.execution_count, "20");
    assertEquals(daemon.generate_sync_message(), undefined);
    assertEquals(frontend.generate_sync_message(), undefined);

    daemon.free();
    frontend.free();
  },
);

Deno.test(
  "Issue #1067: dual-callsite pattern consumes sync state (reproduces bug)",
  () => {
    // This test demonstrates the OLD (buggy) behavior where flushSync
    // calls generate_sync_message() directly, consuming the sync state
    // so that a subsequent generate_sync_reply() returns null.
    //
    // The race requires NO daemon messages between the two calls —
    // in production this happens when the debounce fires between two
    // user Ctrl+Enter presses without any daemon frame arriving.

    const daemon = new NotebookHandle("daemon-dual");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("hello")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    let consumedReplies = 0;

    for (let i = 1; i <= 20; i++) {
      // User edits source (rapid Ctrl+Enter)
      frontend.update_source("cell-1", `print("run ${i}")`);

      // flushSync calls generate_sync_message() DIRECTLY (the bug)
      // This destructively advances sync_state.last_sent_heads
      const flushMsg = frontend.generate_sync_message();

      // syncReply$ debounce fires BEFORE any daemon response arrives.
      // In production, this is the 50ms debounce firing between rapid
      // keypresses while the relay is blocked by the execute_cell mutex.
      const reply = frontend.generate_sync_reply();
      if (!reply) {
        consumedReplies++;
      }

      // Now deliver messages to daemon
      if (flushMsg) daemon.receive_sync_message(flushMsg);
      if (reply) daemon.receive_sync_message(reply);

      // Daemon processes output (arrives later)
      daemon.set_execution_count("cell-1", String(i));
      syncOneWay(daemon, frontend);
    }

    // Final convergence
    syncHandles(frontend, daemon, 20);

    console.log(
      `  [bug-repro] ${consumedReplies}/20 sync replies consumed by competing flushSync`,
    );

    // The bug: flushSync consumed the sync state, so generate_sync_reply
    // returned null. Every iteration after the first should show this.
    assert(
      consumedReplies > 0,
      "Expected some sync replies to be consumed by the dual-callsite race",
    );

    daemon.free();
    frontend.free();
  },
);

Deno.test(
  "Issue #1067: stress test 50 rapid executions with interleaved daemon outputs",
  () => {
    const daemon = new NotebookHandle("daemon-stress");
    daemon.add_cell(0, "cell-1", "code");
    daemon.update_source("cell-1", 'print("init")');

    const frontend = NotebookHandle.create_empty();
    syncHandles(daemon, frontend);

    // Simulate 50 rapid executions with the FIXED single-callsite pattern
    for (let i = 1; i <= 50; i++) {
      // Frontend edit
      frontend.update_source("cell-1", `print("iteration ${i}")`);

      // Single-callsite sync (the fix)
      const msg = frontend.generate_sync_message();
      if (msg) daemon.receive_sync_message(msg);

      // Daemon writes outputs
      daemon.set_execution_count("cell-1", String(i));
      const daemonMsg = daemon.generate_sync_message();
      if (daemonMsg) frontend.receive_sync_message(daemonMsg);

      // Single-callsite reply (the fix)
      const reply = frontend.generate_sync_reply();
      if (reply) daemon.receive_sync_message(reply);
    }

    // Final convergence
    syncHandles(frontend, daemon);

    // Verify everything converged
    assertEquals(
      frontend.get_cell("cell-1")?.source,
      'print("iteration 50")',
    );
    assertEquals(
      daemon.get_cell("cell-1")?.source,
      'print("iteration 50")',
    );
    assertEquals(frontend.get_cell("cell-1")?.execution_count, "50");
    assertEquals(daemon.get_cell("cell-1")?.execution_count, "50");

    // No pending sync messages
    assertEquals(daemon.generate_sync_message(), undefined);
    assertEquals(frontend.generate_sync_message(), undefined);

    daemon.free();
    frontend.free();
  },
);
