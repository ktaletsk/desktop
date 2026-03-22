import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../lib/logger";

/** Trust status from the backend */
export type TrustStatusType =
  | "trusted"
  | "untrusted"
  | "signature_invalid"
  | "no_dependencies";

export interface TrustInfo {
  status: TrustStatusType;
  uv_dependencies: string[];
  conda_dependencies: string[];
  conda_channels: string[];
}

export interface TyposquatWarning {
  package: string;
  similar_to: string;
  distance: number;
}

export function useTrust() {
  const [trustInfo, setTrustInfo] = useState<TrustInfo | null>(null);
  const [typosquatWarnings, setTyposquatWarnings] = useState<
    TyposquatWarning[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check trust status
  const checkTrust = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await invoke<TrustInfo>("verify_notebook_trust");
      setTrustInfo(info);

      // Check for typosquats in all dependencies
      const allDeps = [...info.uv_dependencies, ...info.conda_dependencies];
      if (allDeps.length > 0) {
        const warnings = await invoke<TyposquatWarning[]>("check_typosquats", {
          packages: allDeps,
        });
        setTyposquatWarnings(warnings);
      } else {
        setTyposquatWarnings([]);
      }

      return info;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (message === "Not connected to daemon") {
        logger.debug("Trust check deferred: daemon not yet connected");
      } else {
        logger.error("Failed to check trust:", e);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Approve the notebook (sign dependencies)
  const approveTrust = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("approve_notebook_trust");
      // Re-check trust status after approval
      await checkTrust();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      logger.error("Failed to approve trust:", e);
      return false;
    } finally {
      setLoading(false);
    }
  }, [checkTrust]);

  // Check trust on mount
  useEffect(() => {
    checkTrust();
  }, [checkTrust]);

  // Use needs_trust_approval from daemon:ready payload as the authoritative
  // initial trust state. The daemon computes this from the .ipynb file during
  // room creation — before the Automerge doc is populated via streaming load.
  // Without this, checkTrust() queries the Automerge doc which may still be
  // empty, returning NoDependencies and skipping the trust dialog.
  const hasReceivedDaemonReady = useRef(false);
  useEffect(() => {
    const webview = getCurrentWebview();
    const unlistenReady = webview.listen<{
      notebook_id: string;
      cell_count: number;
      needs_trust_approval: boolean;
    }>("daemon:ready", (event) => {
      const { needs_trust_approval } = event.payload;
      hasReceivedDaemonReady.current = true;

      if (needs_trust_approval) {
        // The daemon says this notebook has untrusted deps — set a provisional
        // "untrusted" state immediately so the dialog appears, then do the full
        // check to get dependency details (dep names, typosquat warnings, etc.)
        logger.info(
          "[trust] daemon:ready says needs_trust_approval=true, showing dialog",
        );
        setTrustInfo({
          status: "untrusted",
          uv_dependencies: [],
          conda_dependencies: [],
          conda_channels: [],
        });
      }

      // Full check to populate dependency lists and typosquat warnings.
      // This reads from the Automerge doc which may now have metadata
      // (streaming load may have completed by the time this runs).
      checkTrust();
    });
    return () => {
      unlistenReady.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [checkTrust]);

  // Computed properties
  const isTrusted =
    trustInfo?.status === "trusted" || trustInfo?.status === "no_dependencies";
  const needsApproval =
    trustInfo?.status === "untrusted" ||
    trustInfo?.status === "signature_invalid";
  const hasDependencies = trustInfo?.status !== "no_dependencies";

  // Total dependency count
  const totalDependencies =
    (trustInfo?.uv_dependencies.length ?? 0) +
    (trustInfo?.conda_dependencies.length ?? 0);

  return {
    trustInfo,
    typosquatWarnings,
    loading,
    error,
    isTrusted,
    needsApproval,
    hasDependencies,
    totalDependencies,
    checkTrust,
    approveTrust,
  };
}
