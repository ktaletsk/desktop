//! Shared kernel state management for Session and AsyncSession.
//!
//! Provides a trait and helper function to sync kernel state from the daemon,
//! avoiding code duplication between sync and async session implementations.

use runtimed::notebook_sync_client::NotebookSyncHandle;
use runtimed::protocol::{NotebookRequest, NotebookResponse};

/// Trait for session state types that track kernel status.
///
/// Both `SessionState` and `AsyncSessionState` implement this trait,
/// allowing shared helper functions to update kernel state.
pub trait KernelState {
    fn set_kernel_started(&mut self, started: bool);
    fn set_env_source(&mut self, source: Option<String>);
}

/// Sync kernel state from daemon after connecting.
///
/// Queries `GetKernelInfo` to check if a kernel is already running
/// (e.g., started by the desktop app) and updates local state accordingly.
pub async fn sync_kernel_state_from_daemon<S: KernelState>(
    handle: &NotebookSyncHandle,
    state: &mut S,
) {
    if let Ok(NotebookResponse::KernelInfo {
        env_source, status, ..
    }) = handle.send_request(NotebookRequest::GetKernelInfo {}).await
    {
        let is_running = matches!(status.as_str(), "idle" | "busy" | "starting");
        state.set_kernel_started(is_running);
        if is_running {
            state.set_env_source(env_source);
        }
    }
}

/// Query the daemon for current kernel status string.
///
/// Returns the status string ("idle", "busy", "starting", "not_started", etc.)
/// or None if the query fails.
pub async fn query_kernel_status(handle: &NotebookSyncHandle) -> Option<String> {
    if let Ok(NotebookResponse::KernelInfo { status, .. }) =
        handle.send_request(NotebookRequest::GetKernelInfo {}).await
    {
        return Some(status);
    }
    None
}
