# nteract Stable QA Bug Report

## Build under test
- Release: `v1.4.1-stable.202603052018`
- Platform: Linux x64 (VM)
- Install method:
  - Downloaded release assets from GitHub release tag
  - Installed `nteract-stable-linux-x64.deb` via `dpkg -i`
- Installed package version evidence:
  - `Version: 1.4.1-stable.202603052018`
- Checksum evidence:
  - AppImage: `72213f1efbc86beaf2d1911e4db23d06c1e4665e25e903f217be6455d2543548`
  - DEB: `88ee8bf09499357a827c11f99c65fc7863d769536040f03c9cf6902c6f3009a6`

## Test scope covered
- Onboarding and first-run setup
- Opening notebooks from filesystem and fixtures
- Python kernel start + execute
- UV inline trust flow
- Conda inline trust flow
- Rich outputs and error outputs
- Multi-window usage
- Keyboard shortcuts (`Ctrl+S`, `Ctrl+O`, `Ctrl+F`, zoom shortcuts)
- Settings panel and theme switching

> Note: first-run daemon startup failed in this VM environment until I manually started `runtimed run`, after which most core notebook functionality worked well.

---

## Issues found

## 1) Onboarding can get stuck indefinitely on **“Setting up…”**
- Severity: **High**
- Confidence: **High**

### Reproduction
1. Start app with fresh state (new user / first launch).
2. Select runtime (Python) and Python env (UV).
3. Observe CTA/button text becomes **“Setting up…”**.
4. Wait.

### Expected
- Setup completes, or fails with a clear terminal state and recovery options.
- A timeout/failure state should replace endless waiting.

### Actual
- UI remains in “Setting up…” with no completion.
- User is effectively blocked unless using “Continue anyway”.

### Evidence
- `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/02-onboarding-stuck-setting-up.webp`
- `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/03-onboarding-no-progress-indicator.webp`

### Suspected root cause
- Onboarding state depends on daemon readiness + pool readiness and can wait without a hard timeout in this failure path.
- In `apps/notebook/onboarding/App.tsx`, setup progression is gated by `daemonReady` / `poolReady` and can remain stuck in a non-terminal waiting UI when daemon startup fails.

---

## 2) Daemon auto-install failure surfaces as generic runtime unavailability
- Severity: **High**
- Confidence: **High**

### Reproduction
1. First-launch onboarding path attempts daemon install automatically.
2. Continue to notebook window.
3. Runtime banner shows unavailable; retry still fails.

### Expected
- Either successful daemon start, or actionable error details in UI.
- If install fails, UI should expose root cause (not just generic reconnect failure).

### Actual
- App shows generic “Runtime unavailable” / reconnect error.
- Logs show daemon install exit code only.

### Evidence
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/04-runtime-daemon-unavailable-banner.webp`
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/05-retry-connection-error.webp`
- App log:
  - `[startup] runtimed install failed with code Some(1)`
  - `[autolaunch] Daemon sync failed after ...`
- Manual reproduction command:
  - `runtimed install` output: `Failed to start service: Failed to connect to bus: No medium found`

### Suspected root cause
- In `crates/notebook/src/lib.rs` (`ensure_daemon_via_sidecar`), sidecar install failure is reduced to exit code + generic guidance.
- Onboarding/runtime UI does not propagate full stderr details (service manager/DBus failure context) to end user.

---

## 3) Opening the same notebook again provides no user feedback (no second window)
- Severity: **Medium**
- Confidence: **High**

### Reproduction
1. Open notebook A.
2. Use File → Open and select the same notebook A again.
3. Confirm no visible success/failure feedback.

### Expected
- Either:
  - open second window for same file, or
  - focus existing window with explicit notification, or
  - show clear “already open” dialog/toast.

### Actual
- Operation appears to do nothing from user perspective.
- No obvious UI feedback that the action was handled.

### Evidence
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/06-open-same-notebook-no-feedback.webp`

### Suspected root cause
- `create_notebook_window_with_label` in `crates/notebook/src/lib.rs` derives a deterministic window label from notebook path hash (`notebook-<hash>`).
- Re-opening same path likely collides on window label; creation fails and frontend (`useNotebook.ts` `openNotebook`) only logs error, no visible UI error.

---

## 4) Daemon error banner dismissal is window-local, causing cross-window inconsistency
- Severity: **Low**
- Confidence: **Medium**

### Reproduction
1. Open multiple notebook windows while daemon is unavailable.
2. Dismiss error banner in one window.
3. Observe banner remains in other windows.

### Expected
- Either globally synchronized dismissal behavior, or clearer per-window semantics.

### Actual
- Banner state appears inconsistent across windows, which is confusing during multi-window workflows.

### Evidence
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/04-runtime-daemon-unavailable-banner.webp`

### Suspected root cause
- `daemonStatus` is local React state per window in `apps/notebook/src/App.tsx`, with no cross-window synchronization for dismissal.

---

## 5) Onboarding setup step lacks meaningful progress detail
- Severity: **Medium**
- Confidence: **High**

### Reproduction
1. Start onboarding and choose runtime/env.
2. Observe setup phase.

### Expected
- Clear progress state (spinner/progress messages/error transitions).

### Actual
- Static “Setting up...” UX with limited explanatory signal.

### Evidence
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/03-onboarding-no-progress-indicator.webp`

### Suspected root cause
- Onboarding UI in `apps/notebook/onboarding/App.tsx` has limited state granularity for long-running setup and does not surface detailed daemon install errors/progress in the primary CTA area.

---

## 6) Native file picker direct typed absolute path fails for valid notebook path
- Severity: **Medium**
- Confidence: **Medium**

### Reproduction
1. Open File → Open.
2. Type full absolute notebook path directly in location field.
3. Press Enter.

### Expected
- Dialog navigates to file or opens it.

### Actual
- Error dialog appears claiming missing directory for an otherwise valid path.

### Evidence
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/07-file-picker-direct-path-entry.webp`
- Screenshot: `qa/nteract-stable-v1.4.1-stable.202603052018/screenshots/08-file-picker-path-error-dialog.webp`

### Suspected root cause
- Likely interaction between platform-native GTK file chooser behavior and dialog integration layer; may be external/native dialog handling rather than notebook core logic.

---

## Additional observations (working behavior)
- UV trust dialog and startup worked after daemon was running:
  - `.../09-uv-trust-dialog-working-reference.webp`
- Kernel execution worked:
  - `.../10-kernel-idle-working-reference.webp`
  - `.../11-uv-execution-output-working-reference.webp`
- Rich outputs and error rendering worked:
  - `.../12-rich-output-working-reference.webp`
  - `.../13-error-output-working-reference.webp`

