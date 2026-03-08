# Protocol Correctness Audit

**Date**: 2026-03-08
**Scope**: Wire protocol, sync protocol, and kernel execution protocol correctness — race conditions, ordering guarantees, error recovery, state machine gaps

This audit complements `protocol-audit.md` (security). This document focuses on protocol correctness: can the system lose messages, get stuck, diverge, or misbehave under concurrent or failure conditions?

---

## 1. Wire Protocol (Length-Prefixed Binary Framing)

**Files**: `crates/runtimed/src/connection.rs`

### Design

Every IPC connection uses `[4-byte big-endian length][payload]` framing. The first frame is a JSON handshake declaring the channel type. Notebook sync connections use typed frames where the first payload byte indicates the message type (0x00 = Automerge sync, 0x01 = request, 0x02 = response, 0x03 = broadcast).

### Strengths

- Frame size limits enforced symmetrically on send and receive sides (100 MiB)
- 10-second handshake timeout prevents stalled connections
- Clean EOF handling with `Option<Vec<u8>>`
- Empty frame rejection prevents panics on type byte access
- u32 overflow prevented by MAX_FRAME_SIZE being well below u32::MAX

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **No request/response correlation IDs.** Responses are correlated to requests purely by ordering. If the server ever sends two responses (bug) or a response is lost (connection error mid-frame), the client misattributes the next response. Currently single-request-at-a-time, which avoids this, but fragile if pipelining is ever added. | `connection.rs:82-96`, `notebook_sync_client.rs:1359-1413` |
| **Low** | **No keepalive or heartbeat.** No way to detect half-open connections (peer SIGKILL'd). The eviction timer (30s default) provides eventual cleanup, but `active_peers` can be wrong during that window. | `notebook_sync_server.rs:710,784` |
| **Low** | **Partial frame writes are not atomic.** `send_frame` writes length then payload in two `write_all` calls. If the process crashes between them, the peer reads a valid length followed by truncated data. Acceptable for Unix sockets (local, reliable). | `connection.rs:187-189` |

---

## 2. Three-Peer Automerge Sync Protocol

**Files**: `crates/runtimed/src/notebook_sync_server.rs`, `crates/runtimed/src/notebook_sync_client.rs`, `apps/notebook/src/hooks/useAutomergeNotebook.ts`

### Design

Three Automerge peers participate in sync:
1. **Frontend (WASM)** — `NotebookHandle` in the webview. Cell mutations execute locally. Sync messages flow to the Tauri relay via `invoke("send_automerge_sync")`.
2. **Tauri relay** — `NotebookSyncClient`. Maintains its own Automerge doc. Forwards sync between frontend and daemon.
3. **Daemon** — `NotebookDoc` in the room. Canonical doc for kernel execution and persistence.

### Strengths

- WASM schema compatibility ensures no CRDT type mismatches between frontend and daemon
- Virtual sync handshake (`GetDocBytes`) prevents phantom cells by deferring `frontend_peer_state` initialization
- Persistence uses `watch` channel with "latest value" semantics — never queues stale saves
- Debounced persistence with both quiet-period (500ms) and max-interval (5s) guarantees
- `Lagged` handling for `kernel_broadcast_rx` triggers full Automerge doc sync to catch up
- File watcher self-write detection using timestamp-based skip window (600ms > debounce 500ms)
- Race protection in hot-sync uses `launch_id` to detect kernel swaps during async operations

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **High** | **`sync_to_daemon()` drops non-sync frames during ack wait.** When the relay sends a sync message to the daemon and waits for the ack, it reads exactly one frame. If a `Broadcast` frame arrives first (kernel status, output), it is silently ignored — consumed from the socket but never queued. This is distinct from `wait_for_response_with_broadcast` which properly queues broadcasts. Every `sync_to_daemon()` call risks dropping one broadcast frame. | `notebook_sync_client.rs:1289-1298` |
| **High** | **`changed_rx.recv()` does not handle `Lagged` or `Closed` explicitly.** The `changed_tx` broadcast channel has capacity 16. In `run_sync_loop_v2`, `changed_rx.recv()` uses `_ = changed_rx.recv()`, discarding the `Result`. If the receiver lags, `recv()` returns `Err(Lagged(n))` — the branch still fires and generates a sync message (accidentally correct), but `Lagged` is never logged. More importantly, a `Closed` error is also silently swallowed, meaning the loop never terminates when the room is being evicted. | `notebook_sync_server.rs:978` |
| **High** | **Relay doc is a full participant, not a passthrough.** The Tauri relay maintains its own `AutoCommit` document. Every mutation goes through three merge operations. The CLAUDE.md notes this is "transitional." Until simplified, the relay's doc can diverge from both peers if sync errors are silently swallowed. The `receive_and_relay_sync_message` method uses the daemon peer state for frontend messages, which could corrupt sync state if called when `frontend_peer_state` is active. | `notebook_sync_client.rs:1623-1647`, `notebook_sync_client.rs:1248-1261` |
| **Medium** | **`try_send` drops sync updates silently when channel full.** When the daemon sends changes, the relay uses `try_send` on `changes_tx` (capacity 32). If full, the update is silently dropped with no logging. Cell/metadata state in the Tauri layer becomes permanently stale until the next successful send. | `notebook_sync_client.rs:1878-1882` |
| **Medium** | **`biased` select starves socket reads under command load.** The `run_sync_task` uses `biased` select prioritizing commands over socket reads. Under sustained command load (rapid typing, auto-save), daemon broadcasts accumulate in the socket buffer, delaying kernel output display. | `notebook_sync_client.rs:1677-1683` |
| **Medium** | **Virtual sync handshake loops at most 10 times.** When initializing `frontend_peer_state` via `GetDocBytes`, convergence is bounded by `for _ in 0..10`. For documents with complex merge histories, 10 rounds may be insufficient. Incomplete convergence causes stale/duplicate data on the first real sync cycle. | `notebook_sync_client.rs:1778` |
| **Medium** | **Frontend sync is fire-and-forget.** `syncToRelay` calls `invoke("send_automerge_sync")` with `.catch()` that only logs. If Tauri IPC fails, the mutation exists in WASM but never reaches the daemon. Lost on page reload. No retry mechanism or user-visible error indicator. | `useAutomergeNotebook.ts:101-106` |
| **Medium** | **`raw_sync_tx` send failures silently ignored.** If the frontend receiver is dropped, sync messages to the frontend are silently lost. The relay continues running without forwarding, with no recovery mechanism. Unlike `changes_tx` failure, this does not break the loop. | `notebook_sync_client.rs:1841,1898` |
| **Low** | **Document save serializes under write lock.** `doc.save()` is called while holding `room.doc.write()`. For large documents, serialization blocks all other peers. Bytes are persisted outside the lock via `persist_tx`, but serialization itself holds the lock. | `notebook_sync_server.rs:922-923` |
| **Low** | **`format_notebook_cells` acquires write lock per cell.** Each cell formatted individually; other peers can interleave mutations between cells, leading to partially-formatted visible state. | `notebook_sync_server.rs:2459-2466` |

---

## 3. Room Lifecycle and Peer Counting

**Files**: `crates/runtimed/src/notebook_sync_server.rs`

### Strengths

- Room creation mutex-protected, preventing double-creation races
- Double-check eviction pattern: checks `active_peers > 0` before lock, re-checks after
- Eviction delay clamped (5s to 7 days)

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **No RAII guard for peer counting — panic leaks a peer count.** `active_peers` is incremented at line 710 and decremented at line 784 manually. If anything between panics, the decrement never executes. The room permanently appears to have a connected peer, preventing eviction and leaking resources. | `notebook_sync_server.rs:710-784` |
| **Medium** | **Multiple eviction timers stack without cancellation.** Every disconnect spawns a new timer. No generation counter or `CancellationToken` to invalidate stale timers. While double-check prevents incorrect eviction, a late-firing stale timer could evict moments after reconnect if the `Relaxed` load sees a transiently stale zero. | `notebook_sync_server.rs:801-847` |
| **Medium** | **Eviction race with `Ordering::Relaxed`.** All `active_peers` operations use `Relaxed` ordering. The mutex acquisition provides happens-before for the final check, but pre-lock checks and auto-launch guards could observe stale values. `Acquire`/`Release` pairs would be more correct. | `notebook_sync_server.rs:710,784,805,816` |
| **Low** | **`peers == 1` auto-launch TOCTOU.** Two simultaneous connections can both observe `peers == 1` due to gap between `fetch_add` and `load`. Mitigated by kernel mutex, but using `fetch_add`'s return value would eliminate the race entirely. | `notebook_sync_server.rs:710-720` |
| **Low** | **Potential `active_peers` underflow.** `fetch_sub(1, Relaxed)` on `usize` wraps to `usize::MAX` if count is already 0. Would also panic in debug mode on the `- 1` arithmetic at line 784. | `notebook_sync_server.rs:784` |

---

## 4. Kernel Execution Queue

**Files**: `crates/runtimed/src/kernel_manager.rs`, `crates/runtimed/src/notebook_sync_server.rs`

### Strengths

- Triple death detection: process watcher, iopub loop exit, heartbeat monitor
- Idempotent `kernel_died()` with `Dead` status check
- Idempotent `queue_cell` prevents duplicate executions across multiple windows
- `cell_id_map` bounded by `retain` cleanup on re-execution
- Process group isolation with `process_group(0)` and `killpg`
- `kill_on_drop(true)` on kernel process
- SHA-256 verified tool downloads (Deno, UV)
- Stop-on-error clears queue for both manual and auto-launched kernels
- Heartbeat with 5-second grace period before monitoring begins

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **Interrupt does not clear `executing` state.** `interrupt()` clears the queue but does NOT set `self.executing = None`. Relies on the kernel sending iopub idle after interrupt. If the kernel is stuck in a C extension that catches SIGINT, `executing` stays set and the queue is permanently stuck. No timeout or fallback to forcibly clear it. | `kernel_manager.rs:1878-1902` |
| **Medium** | **Leaked iopub task on launch failure.** When `kernel_info_reply` fails or times out, the error path aborts `process_watcher_task` but NOT `iopub_task`. Dropping a `JoinHandle` in Tokio detaches rather than aborts. The iopub task runs until ZMQ connection eventually fails. Transient resource leak. | `kernel_manager.rs:769,1421-1436` |
| **Medium** | **`try_send(ExecutionDone)` failure permanently stalls queue.** All `try_send(QueueCommand)` calls discard errors. Channel capacity is 100. For `KernelDied`, triple detection provides redundancy. For `ExecutionDone`, a dropped signal means `executing` stays `Some(...)` forever. Unlikely (requires 100+ unprocessed messages) but possible under extreme load. | `kernel_manager.rs:808` |
| **Medium** | **`cell_id_map` entries for deleted cells never cleaned.** If a cell is executed then deleted without re-execution, its entry persists until kernel shutdown. The `retain` cleanup only fires on re-execution of the same cell. | `kernel_manager.rs:1787,2168` |
| **Medium** | **Duplicated QueueCommand handler code.** The dispatch logic is copy-pasted for auto-launch and manual-launch paths. A bug fix in one copy might not be applied to the other. | `notebook_sync_server.rs:1441-1480,1799-1849` |
| **Low** | **Heartbeat creates new ZMQ connection every 5 seconds.** Calls `create_client_heartbeat_connection` inside the loop on every interval. Unnecessary socket churn on long-running kernels. | `kernel_manager.rs:1660-1663` |
| **Low** | **No timeout for overall kernel startup.** 500ms sleep before iopub connect is fragile for slow environments. `kernel_info_reply` has a 30s timeout, which is reasonable. | `kernel_manager.rs:729,1413` |
| **Low** | **`pending_history` and `pending_completions` not cleaned on kernel death.** Oneshot senders are leaked; waiters time out after 5s rather than getting immediate error. | `kernel_manager.rs:1837-1875` |
| **Low** | **Shutdown sends ShutdownRequest after aborting tasks.** Tasks aborted before sending shutdown request — kernel gets SIGKILL before graceful shutdown. | `kernel_manager.rs:2126-2143` |
| **Info** | **stdout/stderr piped to null.** Kernel startup errors before ZMQ connection produce no diagnostic output. | `kernel_manager.rs:607,660,680,702` |
| **Info** | **Tool bootstrap cached permanently in OnceCell.** A failed bootstrap due to transient network issues caches the error permanently. Daemon must be restarted to retry. | `tools.rs:271,769` |
| **Info** | **Port reservation TOCTOU.** `peek_ports` discovers ephemeral ports; another process could steal them before kernel binds. Inherent to Jupyter connection file protocol. | `kernel_manager.rs:540` |
| **Info** | **Supply chain: checksums fetched from same origin as binaries.** Not pinned in code. A compromised GitHub release would serve matching checksums. | `tools.rs:404-524,643-765` |

---

## 5. Reconnection and State Recovery

**Files**: `crates/notebook/src/lib.rs`, `apps/notebook/src/hooks/useAutomergeNotebook.ts`, `apps/notebook/src/hooks/useDaemonKernel.ts`

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **High** | **Kernel state is lost on daemon restart.** All kernel processes are orphaned when the daemon restarts. Connection info, HMAC keys, and session IDs are gone. Running cells produce output nobody receives. User must re-launch manually. | `kernel_manager.rs` (entire lifecycle) |
| **Medium** | **Reconnection is not automatic.** Frontend shows a banner on disconnect, waiting for manual reconnect. No automatic retry with backoff. | `notebook_sync_client.rs:1920-1928`, `App.tsx:815,897` |
| **Medium** | **Notebook dirty state can be wrong after reconnect.** `dirty` flag reflects pre-disconnect state. After reconnect, doc is re-bootstrapped from daemon's persisted state. `bootstrap()` does not reset `dirty`. | `useAutomergeNotebook.ts:44,166` |
| **Medium** | **`reset_sync_state()` on reconnect discards unsynced local changes.** When `daemon:ready` fires, the frontend replaces the WASM handle entirely. Mutations applied to WASM but not yet synced are lost. User sees edits disappear. | `useAutomergeNotebook.ts:165-166` |
| **Low** | **`ReconnectInProgress` allows second reconnect to silently succeed without reconnecting.** User gets no feedback that the attempt was skipped. | `lib.rs:1888-1896` |

---

## 6. Broadcast Channel Semantics

**Files**: `crates/runtimed/src/notebook_sync_server.rs`, `crates/runtimed/src/kernel_manager.rs`

### Strengths

- `Lagged` on `kernel_broadcast_rx` triggers full Automerge doc sync for catch-up

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **`broadcast::channel(64)` can lag under rapid output.** Rapid kernel output generates hundreds of broadcasts/second. `Lagged` recovery handles persisted data via doc sync, but ephemeral broadcasts (status changes, queue state) are lost. | `notebook_sync_server.rs:991,523` |
| **Medium** | **Output broadcasts are ephemeral — no catch-up for late-joining peers.** A peer joining after execution starts receives no historical broadcasts. Only catches up through Automerge doc (persisted outputs). | `notebook_sync_server.rs:887-903` |
| **Low** | **`send()` return value ignored for broadcasts.** Fire-and-forget. Output during no-peer windows only persists to Automerge doc. | `kernel_manager.rs:770-773` |

---

## 7. Protocol Versioning

**Files**: `crates/runtimed/src/connection.rs`

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **Protocol version not enforced.** The `protocol` field is optional and defaults to `None`. Client sending `protocol: "v99"` is served v2 without warning. No way for client to detect version mismatch. | `connection.rs:48-52`, `notebook_sync_server.rs:776-779,885` |
| **Low** | **No wire format version marker.** Frame format has no version byte. If framing needs to change, no negotiation mechanism exists. | `connection.rs:1-7` |

---

## Action Items (Priority Order)

### Critical (can cause stuck/lost state)

1. **Fix `sync_to_daemon()` broadcast dropping.** Read frames in a loop until AutomergeSync found, queuing Broadcast frames (same pattern as `wait_for_response_with_broadcast`).

2. **Handle `changed_rx.recv()` result explicitly.** Log `Lagged`, and on `Closed` exit the sync loop cleanly.

3. **Add interrupt timeout with forced `executing` clear.** After interrupt, start a timer (e.g., 10s). If `executing` still set, forcibly clear it and broadcast error.

### Important (protocol robustness)

4. **Plan relay simplification to passthrough.** Largest correctness surface area — eliminates triple-merge divergence risk.

5. **Add automatic reconnection with exponential backoff.** Manual reconnect causes friction on daemon upgrades.

6. **Introduce RAII `PeerGuard` for peer counting.** Prevents panic-leaked counts and co-locates eviction trigger with state change.

7. **Add eviction generation counter.** Increment on peer connect; stale timers abort if generation changed.

8. **Use `Ordering::AcqRel` for `active_peers`.** Correct for ARM (Apple Silicon Macs).

### Nice-to-have (hardening)

9. Add request/response correlation IDs for future pipelining.
10. Add keepalive/heartbeat for half-open connection detection.
11. Abort iopub task on launch failure.
12. Extract QueueCommand dispatch into shared function (eliminate duplication).
13. Use `send().await` instead of `try_send()` for `ExecutionDone`.
14. Enforce protocol version in handshake.
15. Add ephemeral state snapshots for lagged peers.
16. Clean up `pending_history`/`pending_completions` on kernel death.
