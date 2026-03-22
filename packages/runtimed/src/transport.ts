/**
 * Transport interface — the pluggable connection layer between
 * the notebook client and the daemon.
 *
 * Implementations adapt the raw frame protocol to different environments:
 *
 * - `TauriTransport` — Tauri IPC (`invoke("send_frame")` + `listen("notebook:frame")`)
 * - `DirectTransport` — for tests, two NotebookHandles syncing directly
 *
 * The transport deals only in raw bytes. Framing, demuxing, and sync
 * state management happen in the client layer above.
 *
 * @module
 */

// ── Frame types (mirrored from notebook-doc/src/frame_types.rs) ─────

export const FrameType = {
  /** Automerge sync message (binary). */
  AUTOMERGE_SYNC: 0x00,
  /** NotebookRequest (JSON). */
  REQUEST: 0x01,
  /** NotebookResponse (JSON). */
  RESPONSE: 0x02,
  /** NotebookBroadcast (JSON). */
  BROADCAST: 0x03,
  /** Presence (CBOR). */
  PRESENCE: 0x04,
  /** RuntimeStateDoc sync message (binary Automerge sync). */
  RUNTIME_STATE_SYNC: 0x05,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// ── Transport interface ─────────────────────────────────────────────

/**
 * A typed frame: one byte of frame type + the payload bytes.
 *
 * This is the unit of data that flows between the client and daemon.
 * On the wire it's `[type_byte, ...payload]`, but the transport may
 * present it in whatever shape is natural for the environment.
 */
export interface TypedFrame {
  readonly frameType: FrameTypeValue;
  readonly payload: Uint8Array;
}

/** Teardown function returned by subscriptions. */
export type Unsubscribe = () => void;

/**
 * Pluggable connection between the notebook client and the daemon.
 *
 * The transport is responsible for:
 * 1. Sending typed frames to the daemon
 * 2. Delivering inbound frames to subscribers
 * 3. Request/response for daemon commands (ExecuteCell, LaunchKernel, etc.)
 *
 * The transport is NOT responsible for:
 * - Automerge sync state (that's the client's job)
 * - Demuxing frame types (client reads `frameType` from `TypedFrame`)
 * - Retry/reconnection logic (transport-specific, not abstracted here)
 */
export interface NotebookTransport {
  /**
   * Send a typed frame to the daemon.
   *
   * The frame type byte is prepended to the payload by the transport
   * implementation — callers pass them separately for type safety.
   *
   * Rejects if the frame cannot be sent (transport closed, relay blocked, etc.).
   * The caller is responsible for rollback (e.g., `cancel_last_flush()`).
   */
  sendFrame(frameType: FrameTypeValue, payload: Uint8Array): Promise<void>;

  /**
   * Subscribe to inbound frames from the daemon.
   *
   * The callback receives the full frame bytes (type byte + payload) as
   * delivered by the daemon. The client is responsible for demuxing via
   * `NotebookHandle.receive_frame()`.
   *
   * Returns an unsubscribe function. Multiple subscribers are allowed;
   * each receives every frame.
   */
  onFrame(callback: (frame: Uint8Array) => void): Unsubscribe;

  /**
   * Send a JSON request to the daemon and wait for the JSON response.
   *
   * This is the request/response channel for daemon commands:
   * ExecuteCell, LaunchKernel, Interrupt, Shutdown, Save, etc.
   *
   * The transport handles framing (Request frame type 0x01, Response 0x02).
   * Inbound frames that arrive while waiting for the response (sync,
   * broadcast, presence) are still delivered to `onFrame` subscribers.
   *
   * Rejects on transport errors or timeout.
   */
  sendRequest<T = unknown>(request: unknown): Promise<T>;

  /**
   * Whether the transport is currently connected.
   *
   * This is advisory — a `true` return doesn't guarantee the next
   * `sendFrame` will succeed (the connection could drop at any time).
   */
  readonly connected: boolean;

  /**
   * Disconnect and release resources.
   *
   * After calling this, `sendFrame`, `sendRequest`, and `onFrame` will
   * throw or no-op. Existing `onFrame` subscriptions are cancelled.
   */
  disconnect(): void;
}
