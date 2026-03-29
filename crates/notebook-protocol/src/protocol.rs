//! Notebook-specific protocol types extracted from runtimed.
//!
//! Pure data definitions (structs and enums) for the notebook sync protocol.
//! No `impl` blocks — just shapes + serde derives.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ── Data structs referenced by protocol enums ───────────────────────────────

/// A snapshot of a comm channel's state.
///
/// Stored in the daemon and sent to newly connected clients so they can
/// reconstruct widget models that were created before they connected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommSnapshot {
    /// The comm_id (unique identifier for this comm channel).
    pub comm_id: String,

    /// Target name (e.g., "jupyter.widget", "jupyter.widget.version").
    pub target_name: String,

    /// Current state snapshot (merged from all updates).
    /// For widgets, this contains the full model state.
    pub state: serde_json::Value,

    /// Model module (e.g., "@jupyter-widgets/controls", "anywidget").
    /// Extracted from `_model_module` in state for convenience.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_module: Option<String>,

    /// Model name (e.g., "IntSliderModel", "AnyModel").
    /// Extracted from `_model_name` in state for convenience.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,

    /// Binary buffers associated with this comm (e.g., for images, arrays).
    /// Stored inline for simplicity; large buffers could be moved to blob store.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buffers: Vec<Vec<u8>>,
}

/// Environment configuration captured at kernel launch time.
/// Used to detect when notebook metadata has drifted from the running kernel.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LaunchedEnvConfig {
    /// UV inline deps (if env_source is "uv:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv_deps: Option<Vec<String>>,

    /// Conda inline deps (if env_source is "conda:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_deps: Option<Vec<String>>,

    /// Conda channels (if env_source is "conda:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_channels: Option<Vec<String>>,

    /// Deno config (if kernel_type is "deno")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deno_config: Option<DenoLaunchedConfig>,

    /// Path to the venv used by the kernel (for hot-sync into running env)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venv_path: Option<PathBuf>,

    /// Path to python executable (for hot-sync, avoids hardcoding bin/python vs Scripts/python.exe)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_path: Option<PathBuf>,

    /// Unique identifier for this kernel launch session.
    /// Used to detect if kernel was swapped during async operations (e.g., hot-sync).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
}

/// Deno configuration captured at kernel launch time.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DenoLaunchedConfig {
    /// Deno permission flags
    #[serde(default)]
    pub permissions: Vec<String>,

    /// Path to import_map.json
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_map: Option<String>,

    /// Path to deno.json config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,

    /// Whether npm: imports auto-install packages
    #[serde(default = "default_flexible_npm")]
    pub flexible_npm_imports: bool,
}

fn default_flexible_npm() -> bool {
    true
}

/// Error information for a pool that is failing to warm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolError {
    /// Human-readable error message.
    pub message: String,
    /// Package that failed to install (if identified).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_package: Option<String>,
    /// Number of consecutive failures.
    pub consecutive_failures: u32,
    /// Seconds until next retry (0 if retry is imminent).
    pub retry_in_secs: u64,
}

/// An entry in the execution queue, pairing a cell with its execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueueEntry {
    pub cell_id: String,
    pub execution_id: String,
}

// ── Helper structs ──────────────────────────────────────────────────────────

/// A single entry from kernel input history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// Session number (0 for current session)
    pub session: i32,
    /// Line number within the session
    pub line: i32,
    /// The source code that was executed
    pub source: String,
}

/// A single completion item (LSP-ready structure).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionItem {
    /// The completion text
    pub label: String,
    /// Kind: "function", "variable", "class", "module", etc.
    /// Populated by LSP later; kernel completions leave this as None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Short type annotation (e.g. "def read_csv(filepath_or_buffer, ...)")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Source: "kernel" now, "ruff"/"basedpyright" later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Difference between launched environment config and current metadata.
/// Used to show the user what packages would be added/removed on restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSyncDiff {
    /// Packages to add (in current metadata but not in launched config).
    #[serde(default)]
    pub added: Vec<String>,
    /// Packages to remove (in launched config but not in current metadata).
    #[serde(default)]
    pub removed: Vec<String>,
    /// Conda channels changed (requires restart to use new channels).
    #[serde(default)]
    pub channels_changed: bool,
    /// Deno config changed (permissions, import_map, etc.)
    #[serde(default)]
    pub deno_changed: bool,
}

// ── Notebook protocol enums ─────────────────────────────────────────────────

/// Requests sent from notebook app to daemon for notebook operations.
///
/// These are sent as JSON over the notebook sync connection alongside
/// Automerge sync messages. The daemon handles kernel lifecycle and
/// execution, becoming the single source of truth for outputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum NotebookRequest {
    /// Launch a kernel for this notebook room.
    /// If a kernel is already running, returns info about the existing kernel.
    LaunchKernel {
        /// Kernel type: "python" or "deno"
        kernel_type: String,
        /// Environment source: "uv:inline", "conda:prewarmed", etc.
        env_source: String,
        /// Path to the notebook file (for working directory)
        notebook_path: Option<String>,
    },

    /// Queue a cell for execution.
    /// Daemon adds to queue and executes when previous cells complete.
    #[deprecated(
        since = "0.1.0",
        note = "Use ExecuteCell instead - reads source from synced document"
    )]
    QueueCell { cell_id: String, code: String },

    /// Execute a cell by reading its source from the automerge doc.
    /// This is the preferred method - ensures execution matches synced document state.
    ExecuteCell { cell_id: String },

    /// Clear outputs for a cell (before re-execution).
    ClearOutputs { cell_id: String },

    /// Interrupt the currently executing cell.
    InterruptExecution {},

    /// Shutdown the kernel for this room.
    ShutdownKernel {},

    /// Get info about the current kernel (if any).
    GetKernelInfo {},

    /// Get the execution queue state.
    GetQueueState {},

    /// Run all code cells from the synced document.
    /// Daemon reads cell sources from the Automerge doc and queues them.
    RunAllCells {},

    /// Send a comm message to the kernel (widget interactions).
    /// Accepts the full Jupyter message envelope to preserve header/session.
    SendComm {
        /// The full Jupyter message (header, content, buffers, etc.)
        /// Preserves frontend session/msg_id for proper widget protocol.
        message: serde_json::Value,
    },

    /// Search the kernel's input history.
    /// Returns matching history entries via HistoryResult response.
    GetHistory {
        /// Pattern to search for (glob-style, optional)
        pattern: Option<String>,
        /// Maximum number of entries to return
        n: i32,
        /// Only return unique entries (deduplicate)
        unique: bool,
    },

    /// Request code completions from the kernel.
    /// Returns matching completions via CompletionResult response.
    Complete {
        /// The code to complete
        code: String,
        /// Cursor position in the code
        cursor_pos: usize,
    },

    /// Save the notebook to disk.
    /// The daemon reads cells and metadata from the Automerge doc, merges
    /// with any existing .ipynb on disk (to preserve unknown metadata keys),
    /// and writes the result.
    ///
    /// If `path` is provided, saves to that path (with .ipynb appended if needed).
    /// If `path` is None, saves to the room's notebook_path (original file location).
    SaveNotebook {
        /// If true, format code cells before saving (e.g., with ruff).
        format_cells: bool,
        /// Optional target path. If None, uses the room's notebook_path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },

    /// Clone the notebook to a new path with fresh env_id and cleared outputs.
    /// Used for "Save As Copy" functionality - creates a new independent notebook
    /// without affecting the current document.
    CloneNotebook {
        /// Target path for the cloned notebook (absolute, .ipynb appended if needed).
        path: String,
    },

    /// Sync environment with current metadata (hot-install new packages).
    /// Only supported for UV inline deps. Falls back to restart for removals/conda.
    SyncEnvironment {},

    /// Get the full Automerge document bytes from the daemon's canonical doc.
    /// Used by the frontend to bootstrap its WASM Automerge peer.
    GetDocBytes {},

    /// Get raw metadata JSON from the daemon's Automerge doc.
    /// Returns the value stored at the given key.
    GetRawMetadata {
        /// Metadata key to read.
        key: String,
    },

    /// Set raw metadata JSON in the daemon's Automerge doc.
    /// Writes the JSON string at the given key, then syncs to all peers.
    SetRawMetadata {
        /// Metadata key to write.
        key: String,
        /// JSON string value to store.
        value: String,
    },

    /// Get the typed notebook metadata snapshot from native Automerge keys.
    /// Returns the serialized NotebookMetadataSnapshot, or None if not available.
    GetMetadataSnapshot {},

    /// Set the typed notebook metadata snapshot using native Automerge keys.
    /// Takes a serialized NotebookMetadataSnapshot JSON string.
    SetMetadataSnapshot {
        /// JSON string of NotebookMetadataSnapshot.
        snapshot: String,
    },

    /// Check if a runtime tool is available (e.g., "deno").
    /// The daemon checks without triggering bootstrap — safe for UI hints.
    CheckToolAvailable { tool: String },
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    // ── Helpers ────────────────────────────────────────────────────────

    /// Parse JSON → T → JSON and assert the value round-trips cleanly.
    fn assert_json_roundtrip<T: serde::Serialize + serde::de::DeserializeOwned>(json_str: &str) {
        let parsed: T = serde_json::from_str(json_str).unwrap();
        let reserialized = serde_json::to_value(&parsed).unwrap();
        let expected: Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(reserialized, expected, "roundtrip mismatch for: {json_str}");
    }

    // ════════════════════════════════════════════════════════════════════
    // NotebookRequest — wire format
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn request_discriminator_is_action() {
        // The daemon dispatches on `action` — if this key name changes,
        // every client breaks.
        let req = NotebookRequest::ExecuteCell {
            cell_id: "c1".into(),
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["action"], "execute_cell");
        assert!(v.get("result").is_none(), "request must not have `result`");
        assert!(v.get("event").is_none(), "request must not have `event`");
    }

    #[test]
    fn request_launch_kernel_wire_shape() {
        let json = r#"{"action":"launch_kernel","kernel_type":"python","env_source":"uv:inline","notebook_path":"/tmp/nb.ipynb"}"#;
        assert_json_roundtrip::<NotebookRequest>(json);

        // notebook_path is optional — None serializes as null (no skip_serializing_if)
        let req = NotebookRequest::LaunchKernel {
            kernel_type: "deno".into(),
            env_source: "system".into(),
            notebook_path: None,
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        assert!(v["notebook_path"].is_null());
    }

    #[test]
    fn request_execute_cell_minimal() {
        let json = r#"{"action":"execute_cell","cell_id":"abc-123"}"#;
        assert_json_roundtrip::<NotebookRequest>(json);
    }

    #[test]
    fn request_all_unit_variants_serialize_without_extra_fields() {
        // These request variants carry no data beyond the action tag.
        // Verify they produce exactly `{"action":"..."}` and nothing else.
        let unit_variants: Vec<(NotebookRequest, &str)> = vec![
            (
                NotebookRequest::InterruptExecution {},
                "interrupt_execution",
            ),
            (NotebookRequest::ShutdownKernel {}, "shutdown_kernel"),
            (NotebookRequest::GetKernelInfo {}, "get_kernel_info"),
            (NotebookRequest::GetQueueState {}, "get_queue_state"),
            (NotebookRequest::RunAllCells {}, "run_all_cells"),
            (NotebookRequest::SyncEnvironment {}, "sync_environment"),
            (NotebookRequest::GetDocBytes {}, "get_doc_bytes"),
            (
                NotebookRequest::GetMetadataSnapshot {},
                "get_metadata_snapshot",
            ),
        ];
        for (req, expected_action) in unit_variants {
            let v: Value = serde_json::to_value(&req).unwrap();
            let obj = v.as_object().unwrap();
            assert_eq!(obj.get("action").unwrap(), expected_action);
            assert_eq!(
                obj.len(),
                1,
                "{expected_action} should only have the `action` field, got: {v}"
            );
        }
    }

    #[test]
    fn request_save_notebook_defaults() {
        // format_cells is required; path is optional and skip_serializing_if
        let req = NotebookRequest::SaveNotebook {
            format_cells: false,
            path: None,
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["format_cells"], false);
        assert!(v.get("path").is_none(), "None path must be omitted");

        // With path present
        let req = NotebookRequest::SaveNotebook {
            format_cells: true,
            path: Some("/tmp/out.ipynb".into()),
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["path"], "/tmp/out.ipynb");
    }

    #[test]
    fn request_save_notebook_path_defaults_on_missing() {
        // A client that omits `path` entirely — serde(default) should fill in None
        let json = r#"{"action":"save_notebook","format_cells":true}"#;
        let req: NotebookRequest = serde_json::from_str(json).unwrap();
        match req {
            NotebookRequest::SaveNotebook { path, format_cells } => {
                assert!(path.is_none());
                assert!(format_cells);
            }
            other => panic!("expected SaveNotebook, got: {other:?}"),
        }
    }

    #[test]
    fn request_complete_wire_shape() {
        let json = r#"{"action":"complete","code":"import pa","cursor_pos":9}"#;
        assert_json_roundtrip::<NotebookRequest>(json);
    }

    #[test]
    fn request_get_history_wire_shape() {
        let json = r#"{"action":"get_history","pattern":"import*","n":50,"unique":true}"#;
        assert_json_roundtrip::<NotebookRequest>(json);

        // pattern is optional
        let json = r#"{"action":"get_history","pattern":null,"n":10,"unique":false}"#;
        let req: NotebookRequest = serde_json::from_str(json).unwrap();
        match req {
            NotebookRequest::GetHistory { pattern, n, unique } => {
                assert!(pattern.is_none());
                assert_eq!(n, 10);
                assert!(!unique);
            }
            other => panic!("expected GetHistory, got: {other:?}"),
        }
    }

    #[test]
    fn request_send_comm_preserves_arbitrary_json() {
        let msg = json!({"header": {"msg_id": "x"}, "content": {"comm_id": "w1"}});
        let req = NotebookRequest::SendComm {
            message: msg.clone(),
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["message"], msg);
    }

    #[test]
    fn request_set_raw_metadata() {
        let json = r#"{"action":"set_raw_metadata","key":"custom_key","value":"{\"foo\":1}"}"#;
        assert_json_roundtrip::<NotebookRequest>(json);
    }

    #[test]
    fn request_check_tool_available() {
        let json = r#"{"action":"check_tool_available","tool":"deno"}"#;
        assert_json_roundtrip::<NotebookRequest>(json);
    }

    #[test]
    fn request_unknown_action_is_rejected() {
        let json = r#"{"action":"do_magic","cell_id":"c1"}"#;
        let result = serde_json::from_str::<NotebookRequest>(json);
        assert!(result.is_err(), "unknown action must not silently succeed");
    }

    #[test]
    fn request_missing_action_is_rejected() {
        let json = r#"{"cell_id":"c1"}"#;
        let result = serde_json::from_str::<NotebookRequest>(json);
        assert!(result.is_err());
    }

    #[test]
    fn request_missing_required_field_is_rejected() {
        // ExecuteCell needs cell_id
        let json = r#"{"action":"execute_cell"}"#;
        let result = serde_json::from_str::<NotebookRequest>(json);
        assert!(result.is_err());
    }

    #[test]
    fn request_wrong_field_type_is_rejected() {
        // cursor_pos should be usize, not string
        let json = r#"{"action":"complete","code":"x","cursor_pos":"not_a_number"}"#;
        let result = serde_json::from_str::<NotebookRequest>(json);
        assert!(result.is_err());
    }

    // ════════════════════════════════════════════════════════════════════
    // NotebookResponse — wire format
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn response_discriminator_is_result() {
        let resp = NotebookResponse::NoKernel {};
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["result"], "no_kernel");
        assert!(v.get("action").is_none());
        assert!(v.get("event").is_none());
    }

    #[test]
    fn response_kernel_launched_wire_shape() {
        let resp = NotebookResponse::KernelLaunched {
            kernel_type: "python".into(),
            env_source: "uv:inline".into(),
            launched_config: LaunchedEnvConfig::default(),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["result"], "kernel_launched");
        assert_eq!(v["kernel_type"], "python");
        assert_eq!(v["env_source"], "uv:inline");
        // default LaunchedEnvConfig should omit all optional fields
        assert!(v.get("uv_deps").is_none());
        assert!(v.get("conda_deps").is_none());
        assert!(v.get("venv_path").is_none());
    }

    #[test]
    fn response_kernel_already_running_has_config() {
        let config = LaunchedEnvConfig {
            uv_deps: Some(vec!["numpy".into(), "pandas".into()]),
            venv_path: Some("/tmp/venv".into()),
            launch_id: Some("launch-001".into()),
            ..Default::default()
        };
        let resp = NotebookResponse::KernelAlreadyRunning {
            kernel_type: "python".into(),
            env_source: "uv:inline".into(),
            launched_config: config,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["result"], "kernel_already_running");
        assert_eq!(v["launched_config"]["uv_deps"], json!(["numpy", "pandas"]));
        assert_eq!(v["launched_config"]["venv_path"], "/tmp/venv");
        assert_eq!(v["launched_config"]["launch_id"], "launch-001");
    }

    #[test]
    fn response_cell_queued() {
        let json = r#"{"result":"cell_queued","cell_id":"c1","execution_id":"ex1"}"#;
        assert_json_roundtrip::<NotebookResponse>(json);
    }

    #[test]
    fn response_queue_state() {
        let resp = NotebookResponse::QueueState {
            executing: Some(QueueEntry {
                cell_id: "c1".into(),
                execution_id: "ex1".into(),
            }),
            queued: vec![QueueEntry {
                cell_id: "c2".into(),
                execution_id: "ex2".into(),
            }],
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["executing"]["cell_id"], "c1");
        assert_eq!(v["queued"][0]["cell_id"], "c2");

        // Empty queue
        let resp = NotebookResponse::QueueState {
            executing: None,
            queued: vec![],
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert!(v["executing"].is_null());
        assert_eq!(v["queued"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn response_notebook_saved_wire_shape() {
        // Without re-key
        let resp = NotebookResponse::NotebookSaved {
            path: "/home/user/nb.ipynb".into(),
            new_notebook_id: None,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["path"], "/home/user/nb.ipynb");
        assert!(
            v.get("new_notebook_id").is_none(),
            "None new_notebook_id must be omitted"
        );

        // With re-key (ephemeral → file-path)
        let resp = NotebookResponse::NotebookSaved {
            path: "/home/user/nb.ipynb".into(),
            new_notebook_id: Some("/home/user/nb.ipynb".into()),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["new_notebook_id"], "/home/user/nb.ipynb");
    }

    #[test]
    fn response_error_carries_message() {
        let json = r#"{"result":"error","error":"kernel crashed"}"#;
        assert_json_roundtrip::<NotebookResponse>(json);
    }

    #[test]
    fn response_history_result() {
        let resp = NotebookResponse::HistoryResult {
            entries: vec![
                HistoryEntry {
                    session: 0,
                    line: 1,
                    source: "import os".into(),
                },
                HistoryEntry {
                    session: 0,
                    line: 2,
                    source: "os.getcwd()".into(),
                },
            ],
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 2);
        assert_eq!(v["entries"][0]["source"], "import os");
        assert_eq!(v["entries"][1]["line"], 2);
    }

    #[test]
    fn response_completion_result() {
        let resp = NotebookResponse::CompletionResult {
            items: vec![CompletionItem {
                label: "pandas".into(),
                kind: Some("module".into()),
                detail: None,
                source: Some("kernel".into()),
            }],
            cursor_start: 7,
            cursor_end: 9,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["items"][0]["label"], "pandas");
        assert_eq!(v["items"][0]["kind"], "module");
        assert!(
            v["items"][0].get("detail").is_none(),
            "None detail must be omitted"
        );
        assert_eq!(v["cursor_start"], 7);
    }

    #[test]
    fn response_sync_environment_failed() {
        let json =
            r#"{"result":"sync_environment_failed","error":"pip failed","needs_restart":true}"#;
        assert_json_roundtrip::<NotebookResponse>(json);
    }

    #[test]
    fn response_doc_bytes_carries_raw_bytes() {
        let resp = NotebookResponse::DocBytes {
            bytes: vec![0x00, 0x85, 0xFF],
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        // serde_json serializes Vec<u8> as an array of numbers
        assert_eq!(v["bytes"], json!([0, 133, 255]));
    }

    #[test]
    fn response_all_unit_variants() {
        let variants: Vec<(NotebookResponse, &str)> = vec![
            (
                NotebookResponse::OutputsCleared {
                    cell_id: "c1".into(),
                },
                "outputs_cleared",
            ),
            (NotebookResponse::InterruptSent {}, "interrupt_sent"),
            (
                NotebookResponse::KernelShuttingDown {},
                "kernel_shutting_down",
            ),
            (NotebookResponse::NoKernel {}, "no_kernel"),
            (NotebookResponse::Ok {}, "ok"),
            (NotebookResponse::MetadataSet {}, "metadata_set"),
            (
                NotebookResponse::ToolAvailable { available: true },
                "tool_available",
            ),
        ];
        for (resp, expected_result) in variants {
            let v: Value = serde_json::to_value(&resp).unwrap();
            assert_eq!(v["result"], expected_result);
        }
    }

    #[test]
    fn response_unknown_result_is_rejected() {
        let json = r#"{"result":"quantum_state","data":42}"#;
        assert!(serde_json::from_str::<NotebookResponse>(json).is_err());
    }

    #[test]
    fn response_missing_result_tag_is_rejected() {
        let json = r#"{"error":"something broke"}"#;
        assert!(serde_json::from_str::<NotebookResponse>(json).is_err());
    }

    // ════════════════════════════════════════════════════════════════════
    // NotebookBroadcast — wire format
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn broadcast_discriminator_is_event() {
        let bc = NotebookBroadcast::KernelStatus {
            status: "idle".into(),
            cell_id: None,
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["event"], "kernel_status");
        assert!(v.get("action").is_none());
        assert!(v.get("result").is_none());
    }

    #[test]
    fn broadcast_kernel_status_with_and_without_cell() {
        let bc = NotebookBroadcast::KernelStatus {
            status: "busy".into(),
            cell_id: Some("c1".into()),
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["status"], "busy");
        assert_eq!(v["cell_id"], "c1");

        let bc = NotebookBroadcast::KernelStatus {
            status: "idle".into(),
            cell_id: None,
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert!(v["cell_id"].is_null());
    }

    #[test]
    fn broadcast_execution_started() {
        let json = r#"{"event":"execution_started","cell_id":"c1","execution_id":"ex1","execution_count":42}"#;
        assert_json_roundtrip::<NotebookBroadcast>(json);
    }

    #[test]
    fn broadcast_output_wire_shape() {
        // Without output_index (new output — append)
        let bc = NotebookBroadcast::Output {
            cell_id: "c1".into(),
            execution_id: "ex1".into(),
            output_type: "stream".into(),
            output_json: r#"{"name":"stdout","text":"hello\n"}"#.into(),
            output_index: None,
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["event"], "output");
        assert_eq!(v["output_type"], "stream");
        assert!(
            v.get("output_index").is_none(),
            "None output_index must be omitted (skip_serializing_if)"
        );

        // With output_index (update in place)
        let bc = NotebookBroadcast::Output {
            cell_id: "c1".into(),
            execution_id: "ex1".into(),
            output_type: "display_data".into(),
            output_json: "{}".into(),
            output_index: Some(3),
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["output_index"], 3);
    }

    #[test]
    fn broadcast_output_index_defaults_to_none_on_missing() {
        // Client sends output without output_index field — serde(default) fills None
        let json = r#"{"event":"output","cell_id":"c1","execution_id":"ex1","output_type":"stream","output_json":"{}"}"#;
        let bc: NotebookBroadcast = serde_json::from_str(json).unwrap();
        match bc {
            NotebookBroadcast::Output { output_index, .. } => {
                assert!(output_index.is_none());
            }
            other => panic!("expected Output, got: {other:?}"),
        }
    }

    #[test]
    fn broadcast_display_update() {
        let bc = NotebookBroadcast::DisplayUpdate {
            display_id: "d1".into(),
            data: json!({"text/plain": "updated"}),
            metadata: serde_json::Map::new(),
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["event"], "display_update");
        assert_eq!(v["display_id"], "d1");
        assert_eq!(v["data"]["text/plain"], "updated");
    }

    #[test]
    fn broadcast_queue_changed_empty_and_populated() {
        let bc = NotebookBroadcast::QueueChanged {
            executing: None,
            queued: vec![],
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert!(v["executing"].is_null());
        assert!(v["queued"].as_array().unwrap().is_empty());

        let bc = NotebookBroadcast::QueueChanged {
            executing: Some(QueueEntry {
                cell_id: "c1".into(),
                execution_id: "ex1".into(),
            }),
            queued: vec![
                QueueEntry {
                    cell_id: "c2".into(),
                    execution_id: "ex2".into(),
                },
                QueueEntry {
                    cell_id: "c3".into(),
                    execution_id: "ex3".into(),
                },
            ],
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["executing"]["cell_id"], "c1");
        assert_eq!(v["queued"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn broadcast_comm_with_buffers() {
        let bc = NotebookBroadcast::Comm {
            msg_type: "comm_open".into(),
            content: json!({"comm_id": "w1", "target_name": "jupyter.widget"}),
            buffers: vec![vec![1, 2, 3], vec![4, 5]],
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["msg_type"], "comm_open");
        assert_eq!(v["buffers"], json!([[1, 2, 3], [4, 5]]));
    }

    #[test]
    fn broadcast_comm_empty_buffers_included_by_default() {
        // `buffers` has `#[serde(default)]` for deserialization but NO
        // skip_serializing_if — verify empty buffers are present in output.
        let bc = NotebookBroadcast::Comm {
            msg_type: "comm_msg".into(),
            content: json!({}),
            buffers: vec![],
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["buffers"], json!([]));
    }

    #[test]
    fn broadcast_comm_buffers_default_when_missing() {
        // A message from an older daemon that omits buffers entirely
        let json = r#"{"event":"comm","msg_type":"comm_msg","content":{}}"#;
        let bc: NotebookBroadcast = serde_json::from_str(json).unwrap();
        match bc {
            NotebookBroadcast::Comm { buffers, .. } => {
                assert!(buffers.is_empty());
            }
            other => panic!("expected Comm, got: {other:?}"),
        }
    }

    #[test]
    fn broadcast_comm_sync() {
        let bc = NotebookBroadcast::CommSync {
            comms: vec![CommSnapshot {
                comm_id: "w1".into(),
                target_name: "jupyter.widget".into(),
                state: json!({"value": 42}),
                model_module: Some("@jupyter-widgets/controls".into()),
                model_name: Some("IntSliderModel".into()),
                buffers: vec![],
            }],
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["comms"][0]["comm_id"], "w1");
        assert_eq!(v["comms"][0]["model_module"], "@jupyter-widgets/controls");
        // empty buffers should be omitted (skip_serializing_if Vec::is_empty)
        assert!(v["comms"][0].get("buffers").is_none());
    }

    #[test]
    fn broadcast_env_progress_flattens_phase() {
        // EnvProgress uses #[serde(flatten)] on the phase field.
        // This means the phase's tag ("phase":"starting") merges into
        // the broadcast object alongside "event":"env_progress".
        let bc = NotebookBroadcast::EnvProgress {
            env_type: "uv".into(),
            phase: kernel_env::EnvProgressPhase::Starting {
                env_hash: "abc123".into(),
            },
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["event"], "env_progress");
        assert_eq!(v["env_type"], "uv");
        // Flattened phase fields appear at the top level
        assert_eq!(v["phase"], "starting");
        assert_eq!(v["env_hash"], "abc123");
    }

    #[test]
    fn broadcast_env_sync_state_in_sync() {
        let bc = NotebookBroadcast::EnvSyncState {
            in_sync: true,
            diff: None,
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["in_sync"], true);
        assert!(v.get("diff").is_none(), "None diff must be omitted");
    }

    #[test]
    fn broadcast_env_sync_state_out_of_sync() {
        let bc = NotebookBroadcast::EnvSyncState {
            in_sync: false,
            diff: Some(EnvSyncDiff {
                added: vec!["requests".into()],
                removed: vec!["flask".into()],
                channels_changed: false,
                deno_changed: false,
            }),
        };
        let v: Value = serde_json::to_value(&bc).unwrap();
        assert_eq!(v["in_sync"], false);
        assert_eq!(v["diff"]["added"], json!(["requests"]));
        assert_eq!(v["diff"]["removed"], json!(["flask"]));
    }

    #[test]
    fn broadcast_room_renamed() {
        let json = r#"{"event":"room_renamed","new_notebook_id":"/home/user/saved.ipynb"}"#;
        assert_json_roundtrip::<NotebookBroadcast>(json);
    }

    #[test]
    fn broadcast_notebook_autosaved() {
        let json = r#"{"event":"notebook_autosaved","path":"/tmp/nb.ipynb"}"#;
        assert_json_roundtrip::<NotebookBroadcast>(json);
    }

    #[test]
    fn broadcast_unknown_event_is_rejected() {
        let json = r#"{"event":"wormhole_opened","target":"dimension_c137"}"#;
        assert!(serde_json::from_str::<NotebookBroadcast>(json).is_err());
    }

    #[test]
    fn broadcast_missing_event_tag_is_rejected() {
        let json = r#"{"status":"idle"}"#;
        assert!(serde_json::from_str::<NotebookBroadcast>(json).is_err());
    }

    // ════════════════════════════════════════════════════════════════════
    // Data structs — wire format
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn launched_env_config_all_none_is_empty_object() {
        let config = LaunchedEnvConfig::default();
        let v: Value = serde_json::to_value(&config).unwrap();
        let obj = v.as_object().unwrap();
        assert!(
            obj.is_empty(),
            "default LaunchedEnvConfig should serialize to {{}}, got: {v}"
        );
    }

    #[test]
    fn launched_env_config_populated() {
        let config = LaunchedEnvConfig {
            uv_deps: Some(vec!["numpy>=1.24".into()]),
            conda_deps: None,
            conda_channels: None,
            deno_config: Some(DenoLaunchedConfig {
                permissions: vec!["--allow-read".into(), "--allow-net".into()],
                import_map: Some("import_map.json".into()),
                config: None,
                flexible_npm_imports: false,
            }),
            venv_path: Some("/tmp/.venv".into()),
            python_path: Some("/tmp/.venv/bin/python".into()),
            launch_id: Some("lid-1".into()),
        };
        let v: Value = serde_json::to_value(&config).unwrap();
        assert_eq!(v["uv_deps"], json!(["numpy>=1.24"]));
        assert!(v.get("conda_deps").is_none());
        assert_eq!(
            v["deno_config"]["permissions"],
            json!(["--allow-read", "--allow-net"])
        );
        assert_eq!(v["deno_config"]["flexible_npm_imports"], false);
    }

    #[test]
    fn deno_launched_config_defaults() {
        // flexible_npm_imports defaults to true
        let json = r#"{}"#;
        let config: DenoLaunchedConfig = serde_json::from_str(json).unwrap();
        assert!(config.flexible_npm_imports);
        assert!(config.permissions.is_empty());
        assert!(config.import_map.is_none());
        assert!(config.config.is_none());
    }

    #[test]
    fn pool_error_wire_shape() {
        let err = PoolError {
            message: "pip install failed".into(),
            failed_package: Some("broken-pkg".into()),
            consecutive_failures: 3,
            retry_in_secs: 30,
        };
        let v: Value = serde_json::to_value(&err).unwrap();
        assert_eq!(v["message"], "pip install failed");
        assert_eq!(v["failed_package"], "broken-pkg");
        assert_eq!(v["consecutive_failures"], 3);
        assert_eq!(v["retry_in_secs"], 30);
    }

    #[test]
    fn pool_error_no_failed_package() {
        let err = PoolError {
            message: "timeout".into(),
            failed_package: None,
            consecutive_failures: 1,
            retry_in_secs: 0,
        };
        let v: Value = serde_json::to_value(&err).unwrap();
        assert!(v.get("failed_package").is_none());
    }

    #[test]
    fn comm_snapshot_minimal() {
        let snap = CommSnapshot {
            comm_id: "w1".into(),
            target_name: "jupyter.widget".into(),
            state: json!({}),
            model_module: None,
            model_name: None,
            buffers: vec![],
        };
        let v: Value = serde_json::to_value(&snap).unwrap();
        assert!(v.get("model_module").is_none());
        assert!(v.get("model_name").is_none());
        assert!(v.get("buffers").is_none(), "empty buffers must be omitted");
    }

    #[test]
    fn comm_snapshot_with_buffers() {
        let snap = CommSnapshot {
            comm_id: "w1".into(),
            target_name: "jupyter.widget".into(),
            state: json!({"value": [1, 2, 3]}),
            model_module: None,
            model_name: None,
            buffers: vec![vec![0xFF, 0x00]],
        };
        let v: Value = serde_json::to_value(&snap).unwrap();
        assert!(v.get("buffers").is_some());
        assert_eq!(v["buffers"][0], json!([255, 0]));
    }

    #[test]
    fn env_sync_diff_defaults() {
        // All fields have serde(default) — empty JSON object should work
        let json = r#"{}"#;
        let diff: EnvSyncDiff = serde_json::from_str(json).unwrap();
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert!(!diff.channels_changed);
        assert!(!diff.deno_changed);
    }

    #[test]
    fn completion_item_skip_serializing_if_none() {
        let item = CompletionItem {
            label: "foo".into(),
            kind: None,
            detail: None,
            source: None,
        };
        let v: Value = serde_json::to_value(&item).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1, "only `label` should be present: {v}");
    }

    // ════════════════════════════════════════════════════════════════════
    // Cross-type: discriminator tags are mutually exclusive
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn request_json_does_not_parse_as_response_or_broadcast() {
        let req_json = r#"{"action":"execute_cell","cell_id":"c1"}"#;
        assert!(serde_json::from_str::<NotebookResponse>(req_json).is_err());
        assert!(serde_json::from_str::<NotebookBroadcast>(req_json).is_err());
    }

    #[test]
    fn response_json_does_not_parse_as_request_or_broadcast() {
        let resp_json = r#"{"result":"ok"}"#;
        assert!(serde_json::from_str::<NotebookRequest>(resp_json).is_err());
        assert!(serde_json::from_str::<NotebookBroadcast>(resp_json).is_err());
    }

    #[test]
    fn broadcast_json_does_not_parse_as_request_or_response() {
        let bc_json = r#"{"event":"kernel_status","status":"idle","cell_id":null}"#;
        assert!(serde_json::from_str::<NotebookRequest>(bc_json).is_err());
        assert!(serde_json::from_str::<NotebookResponse>(bc_json).is_err());
    }

    // ════════════════════════════════════════════════════════════════════
    // Forward compatibility: extra fields are tolerated
    // ════════════════════════════════════════════════════════════════════

    #[test]
    fn request_ignores_unknown_fields() {
        // An older client receiving a request with new fields shouldn't fail
        let json = r#"{"action":"execute_cell","cell_id":"c1","new_field_from_future":true}"#;
        let req: NotebookRequest = serde_json::from_str(json).unwrap();
        match req {
            NotebookRequest::ExecuteCell { cell_id } => assert_eq!(cell_id, "c1"),
            other => panic!("expected ExecuteCell, got: {other:?}"),
        }
    }

    #[test]
    fn response_ignores_unknown_fields() {
        let json = r#"{"result":"ok","extra":42}"#;
        let resp: NotebookResponse = serde_json::from_str(json).unwrap();
        assert!(matches!(resp, NotebookResponse::Ok {}));
    }

    #[test]
    fn broadcast_ignores_unknown_fields() {
        let json = r#"{"event":"kernel_error","error":"boom","stack_trace":"..."}"#;
        let bc: NotebookBroadcast = serde_json::from_str(json).unwrap();
        match bc {
            NotebookBroadcast::KernelError { error } => assert_eq!(error, "boom"),
            other => panic!("expected KernelError, got: {other:?}"),
        }
    }
}

/// Responses from daemon to notebook app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum NotebookResponse {
    /// Kernel launched successfully.
    KernelLaunched {
        kernel_type: String,
        env_source: String,
        /// Environment config used at launch (for sync detection).
        launched_config: LaunchedEnvConfig,
    },

    /// Kernel was already running (returned existing info).
    KernelAlreadyRunning {
        kernel_type: String,
        env_source: String,
        /// Environment config used at launch (for sync detection).
        launched_config: LaunchedEnvConfig,
    },

    /// Cell queued for execution.
    CellQueued {
        cell_id: String,
        execution_id: String,
    },

    /// Outputs cleared.
    OutputsCleared { cell_id: String },

    /// Interrupt sent to kernel.
    InterruptSent {},

    /// Kernel shutdown initiated.
    KernelShuttingDown {},

    /// No kernel is running.
    NoKernel {},

    /// Kernel info response.
    KernelInfo {
        kernel_type: Option<String>,
        env_source: Option<String>,
        status: String, // "idle", "busy", "not_started"
    },

    /// Queue state response.
    QueueState {
        executing: Option<QueueEntry>,
        queued: Vec<QueueEntry>,
    },

    /// All cells queued for execution.
    AllCellsQueued { queued: Vec<QueueEntry> },

    /// Notebook saved successfully to disk.
    NotebookSaved {
        /// The absolute path where the notebook was written.
        path: String,
        /// If the notebook was ephemeral (UUID-keyed) and has been re-keyed to a
        /// file-path room, this contains the new canonical notebook_id.
        /// Clients should update their local notebook_id to this value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_notebook_id: Option<String>,
    },

    /// Notebook cloned successfully to a new file.
    NotebookCloned {
        /// The absolute path where the cloned notebook was written.
        path: String,
    },

    /// Generic success.
    Ok {},

    /// Error response.
    Error { error: String },

    /// History search result.
    HistoryResult { entries: Vec<HistoryEntry> },

    /// Code completion result.
    CompletionResult {
        items: Vec<CompletionItem>,
        cursor_start: usize,
        cursor_end: usize,
    },

    /// Environment sync started (installing new packages).
    SyncEnvironmentStarted {
        /// Packages being installed
        packages: Vec<String>,
    },

    /// Environment sync completed successfully.
    SyncEnvironmentComplete {
        /// Packages that were installed
        synced_packages: Vec<String>,
    },

    /// Environment sync failed (fall back to restart).
    SyncEnvironmentFailed {
        /// Error message explaining why sync failed
        error: String,
        /// Whether the user should restart instead
        needs_restart: bool,
    },

    /// Full Automerge document bytes from the daemon's canonical doc.
    DocBytes {
        /// Raw Automerge document bytes, encoded as a Vec for JSON transport.
        bytes: Vec<u8>,
    },

    /// Raw metadata JSON value from the daemon's Automerge doc.
    RawMetadata {
        /// The metadata JSON string, or None if the key doesn't exist.
        value: Option<String>,
    },

    /// Metadata was set successfully.
    MetadataSet {},

    /// Typed notebook metadata snapshot from native Automerge keys.
    MetadataSnapshot {
        /// Serialized NotebookMetadataSnapshot JSON, or None if not available.
        snapshot: Option<String>,
    },

    /// Tool availability result.
    ToolAvailable { available: bool },
}

/// Broadcast messages from daemon to all peers in a room.
///
/// These are sent proactively when kernel events occur, not as responses
/// to specific requests. All connected windows receive these.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum NotebookBroadcast {
    /// Kernel status changed.
    KernelStatus {
        status: String,          // "starting", "idle", "busy", "error", "shutdown"
        cell_id: Option<String>, // which cell triggered status change
    },

    /// Execution started for a cell.
    ExecutionStarted {
        cell_id: String,
        execution_id: String,
        execution_count: i64,
    },

    /// Output produced by a cell.
    Output {
        cell_id: String,
        execution_id: String,
        output_type: String, // "stream", "display_data", "execute_result", "error"
        output_json: String, // Serialized Jupyter output content
        /// If Some, this is an update to an existing output at the given index.
        /// If None, this is a new output to append.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_index: Option<usize>,
    },

    /// Display output updated in place (update_display_data).
    DisplayUpdate {
        display_id: String,
        data: serde_json::Value,
        metadata: serde_json::Map<String, serde_json::Value>,
    },

    /// Execution completed for a cell.
    ExecutionDone {
        cell_id: String,
        execution_id: String,
    },

    /// Queue state changed.
    QueueChanged {
        executing: Option<QueueEntry>,
        queued: Vec<QueueEntry>,
    },

    /// Kernel error (failed to launch, crashed, etc.)
    KernelError { error: String },

    /// Outputs cleared for a cell.
    OutputsCleared { cell_id: String },

    /// Comm message from kernel (ipywidgets protocol).
    /// Broadcast to all connected peers so all windows can display widgets.
    Comm {
        /// Message type: "comm_open", "comm_msg", "comm_close"
        msg_type: String,
        /// Message content (comm_id, data, target_name, etc.)
        content: serde_json::Value,
        /// Binary buffers (base64-encoded when serialized to JSON)
        #[serde(default)]
        buffers: Vec<Vec<u8>>,
    },

    /// Initial comm state sync sent to newly connected clients.
    /// Contains all active comm channels so new windows can reconstruct widgets.
    CommSync {
        /// All active comm snapshots
        comms: Vec<CommSnapshot>,
    },

    /// Environment progress update during kernel launch.
    ///
    /// Carries rich progress phases (repodata, solve, download, link)
    /// from `kernel_env` so the frontend can display detailed status.
    EnvProgress {
        env_type: String,
        #[serde(flatten)]
        phase: kernel_env::EnvProgressPhase,
    },

    /// Environment sync state changed.
    ///
    /// Broadcast when notebook metadata changes and differs from the
    /// kernel's launched configuration. All connected windows can show
    /// the sync UI in response.
    EnvSyncState {
        /// Whether the current metadata matches the launched config.
        in_sync: bool,
        /// What's different (for UI display). None if in_sync is true.
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<EnvSyncDiff>,
    },

    /// The room was re-keyed from an ephemeral UUID to a file-path ID.
    ///
    /// Broadcast to all peers when an untitled notebook is saved so they can
    /// update their local notebook_id. Without this, peers that disconnect
    /// and reconnect would use the stale UUID and end up in a new empty room.
    RoomRenamed {
        /// The new canonical notebook_id (file path).
        new_notebook_id: String,
    },

    /// Notebook was autosaved to disk by the daemon.
    NotebookAutosaved { path: String },

    /// Eager RuntimeState snapshot sent during connection setup.
    ///
    /// Bypasses the Automerge sync handshake so the client has kernel
    /// status immediately (prevents "not_started" → "idle" jump).
    RuntimeStateSnapshot {
        state: notebook_doc::runtime_state::RuntimeState,
    },
}
