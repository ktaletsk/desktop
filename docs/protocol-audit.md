# Protocol Security Audit

**Date**: 2026-03-08
**Scope**: All IPC, sync, trust, and network protocols in the nteract/desktop codebase

## Executive Summary

The codebase implements six major protocol surfaces: daemon IPC (Unix sockets / named pipes), Automerge notebook sync, HMAC-SHA256 dependency trust, a localhost blob HTTP server, Jupyter kernel wire protocol, and a singleton lock mechanism. Overall the protocol design is solid, with several good security practices already in place (constant-time HMAC comparison, content-addressed blob hashing with strict validation, SHA-256 hashed persistence filenames, socket/key file permissions set to 0600).

This audit identified 1 remaining medium-severity security issue in the blob server (CORS wildcard) and several lower-priority hardening opportunities across trust, IPC, and singleton protocols.

---

## 1. Trust Protocol (HMAC-SHA256 Dependency Signing)

**Files**: `crates/runt-trust/src/lib.rs`, `crates/notebook/src/trust.rs`, `crates/notebook/src/typosquat.rs`

### What it does

Signs notebook dependency metadata (`metadata.runt.uv`, `metadata.runt.conda`) with a per-machine HMAC-SHA256 key stored at `~/.config/runt/trust-key`. Untrusted notebooks prompt the user before installing packages.

### Strengths

- **Constant-time comparison**: Uses `mac.verify_slice()` which provides constant-time comparison via the `subtle` crate internally.
- **Signs only dependency metadata**: Cell edits don't invalidate trust, reducing user friction while maintaining supply-chain protection.
- **Per-machine keys**: Keys never leave the machine, preventing cross-machine signature forgery.
- **Key file permissions**: Set to `0o600` on Unix after creation (`lib.rs:97-102`).
- **Deterministic canonicalization**: `serde_json::Map` is backed by `BTreeMap` (no `preserve_order` feature), ensuring consistent key ordering at all nesting levels.
- **Fail-safe defaults**: When verification fails (read error, parse error, key error), defaults to `Untrusted`.
- **Algorithm prefix**: Signature format includes `hmac-sha256:` prefix, enabling future algorithm migration.
- **Typosquat detection**: Levenshtein distance checks against top ~200 PyPI packages, shown alongside approval prompt.

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **`RUNT_TRUST_KEY_PATH` env override not gated to test/debug builds.** Any process that can set environment variables before the app launches can redirect trust verification to a key it controls, allowing signature forgery. The comment says "Allow override for testing" but the guard is unconditional. | `runt-trust/src/lib.rs:57-63` |
| **Medium** | **Key file permissions not verified on read.** Permissions are set at creation time but never re-checked. If an external process changes permissions to world-readable, the code never warns. | `runt-trust/src/lib.rs:73-81` |
| **Medium** | **No trust check on user-initiated `LaunchKernel` requests.** The daemon's `handle_notebook_request(LaunchKernel)` does not verify trust status — trust is only enforced on auto-launch. Any IPC client can send a `LaunchKernel` request directly to bypass trust approval for inline deps. The frontend checks trust before calling `launchKernel`, but the daemon does not enforce server-side. | `notebook_sync_server.rs:1520-1615` |
| **Medium** | **`get_raw_metadata_additional` only extracts `runt` key, missing legacy deps during signing.** For legacy-format notebooks (`metadata.uv`/`metadata.conda` without `runt` wrapper), the signing input becomes `{}`. The daemon's `verify_trust_from_file` reads full metadata from disk, so the signature never matches. Not exploitable (fails safe), but legacy notebooks can never be trusted via the UI. | `notebook/src/lib.rs:254-268` |
| **Low** | **No key rotation mechanism.** If the key is compromised, the only remediation is manual deletion. No re-sign capability or recovery documentation. | `runt-trust/src/lib.rs:69-106` |
| **Low** | **Key generation uses `rand::random()` without explicit CSPRNG.** Uses `ThreadRng` (ChaCha12), which is cryptographically secure in `rand 0.8`, but relies on an implementation detail. `OsRng` or `getrandom` would be more explicit. | `runt-trust/src/lib.rs:85` |
| **Low** | **No Windows permission protection for key file.** The `#[cfg(unix)]` permission block means Windows builds store the key with default permissions. | `runt-trust/src/lib.rs:97-102` |
| **Low** | **`unwrap_or_default()` on canonicalization failure silently produces empty string.** If `serde_json::to_string()` fails, all notebooks with failed serialization share the same HMAC. In practice should never fail. | `runt-trust/src/lib.rs:129` |
| **Info** | **`trust_timestamp` is written but never verified.** Stored alongside the signature but not included in signed content and never checked. Informational-only. | `notebook/src/lib.rs:296-301` |
| **Info** | **Trust is verified from disk, not the Automerge doc, in the daemon.** Could differ from in-memory doc if another peer has modified deps but the file hasn't been saved. Acknowledged as known limitation. | `notebook_sync_server.rs:410-448` |

---

## 2. Daemon IPC Protocol (Unix Socket / Named Pipe)

**Files**: `crates/runtimed/src/connection.rs`, `crates/runtimed/src/daemon.rs`

### What it does

The daemon listens on a Unix domain socket (`~/.cache/runt/runtimed.sock`) or Windows named pipe. All channels (pool, settings sync, notebook sync, blob) are multiplexed over this single socket using a JSON handshake that declares the channel type, followed by length-prefixed binary frames.

### Strengths

- **Socket permissions**: Explicitly set to `0o600` after binding (`daemon.rs:506-512`).
- **Handshake timeout**: 10-second timeout on handshake read (`daemon.rs:856-861`).
- **Control frame size limit**: Handshake uses `recv_control_frame` (64 KiB), preventing oversized allocations.
- **Symmetric send/receive frame limits**: Both sides enforce `MAX_FRAME_SIZE` (100 MiB), preventing silent u32 truncation.
- **Safe filename derivation**: SHA-256 hashing of `notebook_id` prevents path traversal.
- **Clean EOF handling**: `recv_frame` returns `Option<Vec<u8>>`, with `None` for clean disconnect.
- **Empty frame rejection**: Zero-length frames rejected in `recv_typed_frame`.
- **Stale socket cleanup**: Existing socket file removed before binding.

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **`recv_json_frame` uses 100 MiB limit for post-handshake control traffic.** Pool and blob JSON requests use `recv_json_frame` which calls `recv_frame` (100 MiB). These should never exceed a few KB. A malicious client could force a 99 MiB allocation for a trivial JSON request. `recv_control_frame` (64 KiB) exists but is only used for the handshake. | `connection.rs:246-256`, `daemon.rs:993,1016` |
| **Medium** | **No connection count limit.** The accept loop spawns unbounded tasks per connection with no semaphore. A local process could exhaust memory and file descriptors. | `daemon.rs:516-534` |
| **Medium** | **No validation of `notebook_id` string length.** An arbitrary string up to 64 KiB (control frame limit) is used as a HashMap key and logged verbatim. | `connection.rs:49`, `daemon.rs:864,896-898` |
| **Medium** | **`working_dir` used as filesystem path without sanitization.** Client-supplied path used for project file detection (directory walk-up). Could scan arbitrary filesystem locations. Same-user access limits impact. | `daemon.rs:909`, `notebook_sync_server.rs:1116-1121` |
| **Low** | **Parent directory created with default umask.** `create_dir_all` doesn't set explicit permissions on the socket parent directory. If umask is permissive, directory could be world-readable. | `daemon.rs:423-424` |
| **Low** | **No authentication beyond filesystem permissions.** Any same-user process has full daemon access including `Shutdown`, `FlushPool`, and kernel execution. Standard for local daemon IPC but should be documented. | `daemon.rs:502-512` |
| **Low** | **No protocol version validation.** `protocol: "v99"` silently treated as v2. | `connection.rs:51-52` |
| **Low** | **Settings sync uses full 100 MiB frame limit.** Settings documents should be a few KB. | `sync_server.rs:64` |
| **Info** | **Windows named pipe has no explicit security descriptor.** Default pipe security restricts to creating user's session, but explicit ACLs would provide defense-in-depth. | `daemon.rs:552-554` |

---

## 3. Blob Store & HTTP Server Protocol

**Files**: `crates/runtimed/src/blob_store.rs`, `crates/runtimed/src/blob_server.rs`

### What it does

A content-addressed blob store persists notebook outputs (images, HTML) to disk, sharded by SHA-256 hash. An HTTP server on `127.0.0.1` (random port) serves blobs for the webview.

### Strengths

- **Hash validation**: `validate_hash()` enforces exact 64-char hex strings, preventing path traversal.
- **Localhost-only binding**: `TcpListener::bind("127.0.0.1:0")`.
- **Content-addressed**: 256-bit hashes are effectively unguessable.
- **Atomic writes**: Temp file + rename pattern; concurrent put race handled gracefully.
- **Size limits**: 100 MiB cap enforced at `put()` entry point before I/O.
- **Immutable caching**: `Cache-Control: public, max-age=31536000, immutable`.
- **MIME sniffing prevention**: `X-Content-Type-Options: nosniff` on all responses.
- **Method restriction**: Only `GET` accepted; all others return 405.
- **Idempotent puts**: If blob and meta already exist, returns immediately.
- **Orphan cleanup**: Failed metadata write cleans up the blob file.

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **No media type sanitization/allowlisting.** `media_type` from kernel output is served directly as `Content-Type`. A malicious kernel can set `text/html`, and the browser will honor it including `<script>` tags. `nosniff` only prevents MIME *sniffing*, not execution of the declared type. In a Tauri webview context, this could enable XSS if a blob URL is loaded directly. | `blob_server.rs:100`, `blob_store.rs:58` |
| **Medium** | **`Access-Control-Allow-Origin: *` on all responses.** Any website can make fetch requests to the blob server. The port is discoverable via localhost port scanning. Combined with blob hashes embedded in shared notebooks, this could enable cross-origin exfiltration. | `blob_server.rs:103,120` |
| **Medium** | **No `Content-Security-Policy` header on blob responses.** HTML blobs execute scripts without restriction. `Content-Security-Policy: sandbox` or `default-src 'none'` would prevent script execution. | `blob_server.rs:98-108` |
| **Low** | **No `Content-Disposition` header.** Blobs served inline by default. For HTML/SVG/XML types, `Content-Disposition: attachment` would prevent in-browser rendering. | `blob_server.rs:98-108` |
| **Low** | **No connection/rate limiting.** Unbounded task spawning per connection. | `blob_server.rs:40-59` |
| **Low** | **No graceful shutdown mechanism.** Server loop runs forever; in-flight requests dropped on daemon restart. | `blob_server.rs:14,40-59` |
| **Low** | **Full blob read into memory on serve.** `get()` reads entire blob into a `Vec` (up to 100 MiB) before sending. Streaming would be more memory-efficient. | `blob_store.rs:148`, `blob_server.rs:105` |
| **Info** | **Media type not included in hash.** Same bytes stored twice with different types keeps only the first type. Documented and deliberate. | `blob_store.rs:70,73-75` |

---

## 4. Daemon Singleton Protocol

**Files**: `crates/runtimed/src/singleton.rs`

### What it does

Uses `flock` (Unix) / `LockFileEx` (Windows) for file-based singleton enforcement. Writes daemon info (PID, socket path, blob port) to `daemon.json`.

### Strengths

- **Correct non-blocking flock**: `LOCK_EX | LOCK_NB` on Unix, `LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY` on Windows.
- **Survives SIGKILL**: OS releases flock on process death.
- **Separate lock and info files**: Avoids race of writing content before lock held.
- **Cleanup on Drop**: `DaemonLock::drop()` removes the info file.
- **Liveness ping on status**: Pings daemon after reading `daemon.json` rather than trusting info file alone.

### Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **Medium** | **`daemon.json` written with default file permissions.** `std::fs::write()` uses default umask (typically 0644). Contains blob server port, socket path, and PID. Other users can read these to access the blob server. | `singleton.rs:183` |
| **Low** | **`daemon.json` not cleaned up on SIGKILL/OOM kill.** `Drop` doesn't run on force kill. Stale file persists with old connection info. Clients attempt to connect to dead socket before discovering daemon is gone. | `singleton.rs:196-203` |
| **Low** | **`truncate(true)` on lock file before lock acquisition.** Every lock attempt truncates the file, even failed ones. Functionally harmless (lock file has no content) but surprising. | `singleton.rs:62-66` |
| **Info** | **`get_running_daemon_info` performs no PID validation.** Reads and deserializes without checking PID liveness. All callers must independently verify. | `singleton.rs:223` |
| **Info** | **Stale socket cleanup is unconditional.** Removes any existing file at socket path before binding, without verifying it's actually a socket. | `daemon.rs:427-429` |

---

## Summary of Recommendations (Priority Order)

### Should Fix

1. **Restrict `Access-Control-Allow-Origin` on blob server** — Replace `*` with the Tauri webview origin. Alternatively, add a shared secret or nonce to blob URLs.

2. **Add `Content-Security-Policy: sandbox` to blob responses** — Prevents script execution in served HTML blobs, closing the XSS vector from malicious kernel output.

3. **Add media type allowlisting on blob server** — Validate against safe types (image/png, image/jpeg, text/plain, etc.), fall back to `application/octet-stream`.

4. **Gate `RUNT_TRUST_KEY_PATH` to test/debug builds** — Use `#[cfg(any(test, debug_assertions))]` to prevent production override.

5. **Add server-side trust enforcement to `LaunchKernel`** — Daemon should verify trust before installing inline dependencies, not just the frontend.

6. **Restrict `daemon.json` permissions to 0600** — Contains exploitable info (blob port, socket path).

### Consider Fixing

7. **Use `recv_control_frame` (64 KiB) for post-handshake JSON requests** — Pool, blob, and settings channels don't need 100 MiB frame limits.

8. **Add connection semaphore to daemon accept loop** — Cap concurrent connections (e.g., 256) to prevent resource exhaustion.

9. **Validate `notebook_id` length** — Reject values longer than a reasonable maximum (e.g., 4096 bytes).

10. **Set parent directory permissions to 0700** — Defense-in-depth for socket directory.

### Low Priority

11. Add key rotation support to the trust system.
12. Validate `working_dir` is an absolute path within home directory.
13. Add protocol version validation in handshake.
14. Add Windows ACL protection for key file and named pipe.
15. Fix legacy metadata extraction in `get_raw_metadata_additional`.
