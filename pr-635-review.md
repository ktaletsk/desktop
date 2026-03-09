# PR #635 Review: feat(updater): install daemon before app restart

## Summary

Three commits:
1. `6a7ed3a` — Core feature: `install_daemon_for_update` Tauri command + frontend wiring
2. `28f67e9` — Add `protocol_version` and `daemon_version` to handshake responses
3. `233c8bd` — Revert to "ready" status if `relaunch()` fails

The PR solves the "restart twice" problem: when the user clicks "Restart to
update", the old daemon would still be running, causing a protocol mismatch
on the new app's first connection. Now the daemon is upgraded before relaunch.

## Findings

### 1. `protocol_version` is sent but never checked (medium)

**File:** `crates/runtimed/src/notebook_sync_client.rs`

The server now sends `protocol_version: Some(2)` and `daemon_version` in both
`ProtocolCapabilities` and `NotebookConnectionInfo` responses. But the client
still only checks the legacy `protocol == "v2"` string — `protocol_version` is
completely ignored on the receiving side.

This means the new fields are informational-only for now. That's fine as a first
step, but it should be called out: if a future version bumps `PROTOCOL_VERSION`
to 3 without also changing the `PROTOCOL_V2` string, the client won't detect it.
The client validation in `init()`, `init_open_notebook()`, and
`init_create_notebook()` all still do:

```rust
Ok(caps) if caps.protocol == PROTOCOL_V2 => { ... }
// and
if info.protocol != PROTOCOL_V2 { return Err(...) }
```

**Suggestion:** Either add client-side validation of `protocol_version` now (with
backward-compat fallback for old daemons that don't send it), or add a TODO
comment making clear this is intentionally deferred.

### 2. Upgrade disconnects all open notebooks during the update (low-medium)

**File:** `crates/notebook/src/lib.rs:877`

`install_daemon_for_update` calls `upgrade_daemon_via_sidecar`, which runs
`runtimed install`. That command does "stop old → copy binary → start new"
(line 779 comment). This kills the running daemon, which disconnects all open
notebook sync connections. The `useDaemonKernel` hook fires `daemon:disconnected`
and resets kernel status to `NOT_STARTED`.

Since we're about to `relaunch()` immediately after, this is mostly fine — the
user won't see the disconnect because the app is restarting. But there's a gap:

- If `upgrade_daemon_via_sidecar` succeeds but `relaunch()` fails (commit 3
  handles this by reverting to "ready"), the user is now running the **old app**
  with the **new daemon**. All their open notebooks have been disconnected and
  the kernel status reset. The app would need to reconnect, but there's no
  automatic reconnection triggered here.

This is an edge case (relaunch failures are rare), but worth a comment.

### 3. No timeout/cancellation on the daemon install (low)

**File:** `apps/notebook/src/hooks/useUpdater.ts:80-86`

The `invoke("install_daemon_for_update")` call has no timeout. The underlying
`upgrade_daemon_via_sidecar` waits up to 10 seconds (20 attempts × 500ms) for
the new daemon to respond, so it's bounded. But if the sidecar process hangs
(e.g., the binary is corrupt or the stop step blocks), the user sees
"Preparing…" indefinitely with no way to cancel.

**Suggestion:** Consider wrapping the invoke in a `Promise.race` with a
reasonable timeout (e.g., 30s), after which it falls through to relaunch anyway
(same as the current error handling).

### 4. `daemon_version()` duplicates existing version logic (nit)

**File:** `crates/runtimed/src/lib.rs:56-58`

```rust
pub fn daemon_version() -> String {
    format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("GIT_COMMIT"))
}
```

This exact format string already exists in `singleton.rs:180` inside
`DaemonLock::write_info()`:

```rust
version: format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("GIT_COMMIT")),
```

And in `crates/notebook/src/lib.rs` as `bundled_daemon_version()`.

**Suggestion:** Have `DaemonLock::write_info()` use `daemon_version()` to
deduplicate.

### 5. No `negotiate_protocol` or range-based negotiation (design note)

The PR uses a single `PROTOCOL_VERSION: u32 = 2` constant that the server sends
in responses. There's no client→server negotiation — the client doesn't declare
what versions it supports, and the server doesn't pick a compatible version.

This is simpler than range-based negotiation and sufficient for the immediate
goal (debugging version mismatches, pre-restart daemon install). But it means
that when protocol v3 is introduced, the server can't fall back to v2 for old
clients — it's all-or-nothing. This is a deliberate trade-off, not a bug.

### 6. The "Preparing…" spinner reuses RotateCcw (nit)

**File:** `apps/notebook/src/components/NotebookToolbar.tsx:507`

The spinner uses the same `RotateCcw` icon as the "Restart to update" button,
with `animate-spin`. This is consistent with the "Updating…" indicator above it
(line 484). No issue, just noting it's intentionally consistent.

## Overall Assessment

The PR is clean, focused, and solves the right problem with minimal changes.
The graceful fallback (proceed with relaunch even if daemon install fails) is
the right call. The `protocol_version`/`daemon_version` fields in handshake
responses are a good foundation.

The main gap is finding #1: the new version fields are write-only (server sends
them, nobody reads them). This should either be addressed in a follow-up or
documented as intentional.
