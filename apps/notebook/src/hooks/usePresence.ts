/**
 * Presence hook — tracks remote cursors, selections, and publishes local cursor.
 *
 * Listens for `presence:from-daemon` Tauri events carrying CBOR-encoded
 * presence frames. Decodes them via WASM free functions and maintains
 * a React state map of remote peers' cursors and selections.
 *
 * Publishing local cursor/selection is throttled to avoid flooding
 * the daemon relay with updates during typing.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  decode_presence_message,
  encode_cursor_presence,
  encode_selection_presence,
} from "../wasm/runtimed-wasm/runtimed_wasm";

// ── Types ────────────────────────────────────────────────────────────

export interface RemoteCursor {
  peerId: string;
  peerLabel: string;
  cellId: string;
  line: number;
  column: number;
  /** Timestamp (ms) when this cursor was last updated. */
  lastUpdated: number;
}

export interface RemoteSelection {
  peerId: string;
  peerLabel: string;
  cellId: string;
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
  lastUpdated: number;
}

export interface KernelPresence {
  peerId: string;
  status: string;
  envSource: string;
}

export interface PresenceState {
  /** Remote cursors keyed by peer ID. */
  cursors: Map<string, RemoteCursor>;
  /** Remote selections keyed by peer ID. */
  selections: Map<string, RemoteSelection>;
  /** Kernel state from the daemon peer, if present. */
  kernelState: KernelPresence | null;
  /** Number of connected peers (including self). */
  peerCount: number;
}

interface DecodedPresenceUpdate {
  type: "update";
  peer_id: string;
  channel: "cursor" | "selection" | "kernel_state" | "custom";
  // Cursor fields
  cell_id?: string;
  line?: number;
  column?: number;
  // Selection fields
  anchor_line?: number;
  anchor_col?: number;
  head_line?: number;
  head_col?: number;
  // Kernel state fields
  status?: string;
  env_source?: string;
  // Custom
  data?: unknown;
}

interface DecodedPresenceSnapshot {
  type: "snapshot";
  peer_id: string;
  peers: Array<{
    peer_id: string;
    peer_label: string;
    channel_count: number;
  }>;
}

interface DecodedPresenceLeft {
  type: "left";
  peer_id: string;
}

interface DecodedPresenceHeartbeat {
  type: "heartbeat";
  peer_id: string;
}

type DecodedPresenceMessage =
  | DecodedPresenceUpdate
  | DecodedPresenceSnapshot
  | DecodedPresenceLeft
  | DecodedPresenceHeartbeat;

// ── Throttle helper ──────────────────────────────────────────────────

function throttle<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): T {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  }) as T;
}

// ── Local peer ID ────────────────────────────────────────────────────

// Stable for the lifetime of this webview. The daemon replaces it with
// a server-assigned ID before relaying, but we need a consistent local
// value so the daemon can track our presence.
const LOCAL_PEER_ID = `wasm-${crypto.randomUUID().slice(0, 8)}`;

// ── Hook ─────────────────────────────────────────────────────────────

export function usePresence() {
  const [state, setState] = useState<PresenceState>({
    cursors: new Map(),
    selections: new Map(),
    kernelState: null,
    peerCount: 0,
  });

  // Track peer labels from snapshots (not in the per-update messages)
  const peerLabelsRef = useRef<Map<string, string>>(new Map());

  // ── Incoming presence from daemon ────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const webview = getCurrentWebviewWindow();

    const unlistenPromise = webview.listen<number[]>(
      "presence:from-daemon",
      (event) => {
        if (cancelled) return;

        const bytes = new Uint8Array(event.payload);
        const json = decode_presence_message(bytes);
        if (!json) return;

        let msg: DecodedPresenceMessage;
        try {
          msg = JSON.parse(json);
        } catch {
          return;
        }

        setState((prev) =>
          applyPresenceMessage(prev, msg, peerLabelsRef.current),
        );
      },
    );

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // ── Publish local cursor (throttled to 50ms) ─────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const setCursor = useCallback(
    throttle((cellId: string, line: number, column: number) => {
      const bytes = encode_cursor_presence(LOCAL_PEER_ID, cellId, line, column);
      invoke("send_presence", { presenceData: Array.from(bytes) }).catch(() => {
        // Silently ignore — not connected yet or relay down
      });
    }, 50),
    [],
  );

  // ── Publish local selection (throttled to 100ms) ──────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const setSelection = useCallback(
    throttle(
      (
        cellId: string,
        anchorLine: number,
        anchorCol: number,
        headLine: number,
        headCol: number,
      ) => {
        const bytes = encode_selection_presence(
          LOCAL_PEER_ID,
          cellId,
          anchorLine,
          anchorCol,
          headLine,
          headCol,
        );
        invoke("send_presence", { presenceData: Array.from(bytes) }).catch(
          () => {},
        );
      },
      100,
    ),
    [],
  );

  // ── Convenience: cursors for a specific cell ──────────────────────

  const cursorsForCell = useCallback(
    (cellId: string): RemoteCursor[] => {
      return Array.from(state.cursors.values()).filter(
        (c) => c.cellId === cellId,
      );
    },
    [state.cursors],
  );

  const selectionsForCell = useCallback(
    (cellId: string): RemoteSelection[] => {
      return Array.from(state.selections.values()).filter(
        (s) => s.cellId === cellId,
      );
    },
    [state.selections],
  );

  return {
    /** All remote cursors keyed by peer ID. */
    cursors: state.cursors,
    /** All remote selections keyed by peer ID. */
    selections: state.selections,
    /** Kernel state from daemon presence, if available. */
    kernelState: state.kernelState,
    /** Number of peers the daemon knows about. */
    peerCount: state.peerCount,
    /** Get cursors for a specific cell. */
    cursorsForCell,
    /** Get selections for a specific cell. */
    selectionsForCell,
    /** Publish local cursor position (throttled 50ms). */
    setCursor,
    /** Publish local selection range (throttled 100ms). */
    setSelection,
    /** This peer's local ID (for filtering self in renderers). */
    localPeerId: LOCAL_PEER_ID,
  };
}

// ── State reducer ────────────────────────────────────────────────────

function applyPresenceMessage(
  prev: PresenceState,
  msg: DecodedPresenceMessage,
  peerLabels: Map<string, string>,
): PresenceState {
  const now = Date.now();

  switch (msg.type) {
    case "update": {
      const label = peerLabels.get(msg.peer_id) ?? "peer";

      if (msg.channel === "cursor" && msg.cell_id != null) {
        const next = new Map(prev.cursors);
        next.set(msg.peer_id, {
          peerId: msg.peer_id,
          peerLabel: label,
          cellId: msg.cell_id,
          line: msg.line ?? 0,
          column: msg.column ?? 0,
          lastUpdated: now,
        });
        return { ...prev, cursors: next };
      }

      if (msg.channel === "selection" && msg.cell_id != null) {
        const next = new Map(prev.selections);
        next.set(msg.peer_id, {
          peerId: msg.peer_id,
          peerLabel: label,
          cellId: msg.cell_id,
          anchorLine: msg.anchor_line ?? 0,
          anchorCol: msg.anchor_col ?? 0,
          headLine: msg.head_line ?? 0,
          headCol: msg.head_col ?? 0,
          lastUpdated: now,
        });
        return { ...prev, selections: next };
      }

      if (msg.channel === "kernel_state") {
        return {
          ...prev,
          kernelState: {
            peerId: msg.peer_id,
            status: msg.status ?? "not_started",
            envSource: msg.env_source ?? "",
          },
        };
      }

      return prev;
    }

    case "snapshot": {
      // Update peer labels from the snapshot
      for (const peer of msg.peers) {
        peerLabels.set(peer.peer_id, peer.peer_label);
      }
      return {
        ...prev,
        peerCount: msg.peers.length,
      };
    }

    case "left": {
      const nextCursors = new Map(prev.cursors);
      const nextSelections = new Map(prev.selections);
      nextCursors.delete(msg.peer_id);
      nextSelections.delete(msg.peer_id);
      peerLabels.delete(msg.peer_id);
      return {
        ...prev,
        cursors: nextCursors,
        selections: nextSelections,
        peerCount: Math.max(0, prev.peerCount - 1),
      };
    }

    case "heartbeat":
      // Heartbeats keep peers alive on the daemon side.
      // No state change needed on the frontend.
      return prev;

    default:
      return prev;
  }
}
