/**
 * Data Binding Store — RFC 001: MDX-Capable Jupyter Notebook
 *
 * Manages the `$` namespace that MDX cells use to reference kernel data.
 * Code cells export variables via `#| export: name1, name2` directives.
 * After execution, the daemon serializes those variables and writes them here.
 * MDX cells subscribe to binding changes and re-render reactively.
 */

import { useSyncExternalStore } from "react";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BindingEntry {
  /** The code cell that produced this binding */
  cellId: string;
  /** JSON-deserialized value from the kernel */
  value: unknown;
  /** When the binding was last updated (Date.now()) */
  updatedAt: number;
}

/** The full binding namespace: variable name → entry */
export type BindingNamespace = Record<string, BindingEntry>;

// ---------------------------------------------------------------------------
// Export directive parsing
// ---------------------------------------------------------------------------

const EXPORT_DIRECTIVE_RE = /^#\|\s*export:\s*(.+)$/m;

/**
 * Parse `#| export: name1, name2` from cell source.
 * Returns the list of exported variable names, or empty array if none.
 */
export function parseExportDirective(source: string): string[] {
  const match = source.match(EXPORT_DIRECTIVE_RE);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z_]\w*$/.test(s));
}

/**
 * Generate Python code that serializes exported variables to JSON.
 * This runs as a silent execute_request after the user's code completes.
 */
export function generateSerializationCode(names: string[]): string {
  const namesList = names.map((n) => `"${n}"`).join(", ");
  // Using _nteract_ prefix to avoid polluting the user's namespace
  return `
import json as _nteract_json

def _nteract_serialize(obj):
    """Best-effort JSON serialization for common data types."""
    if hasattr(obj, 'to_dict'):
        # pandas DataFrame / Series
        if hasattr(obj, 'columns'):
            return obj.to_dict(orient='records')
        return obj.to_dict()
    if hasattr(obj, 'tolist'):
        # numpy array
        return obj.tolist()
    if hasattr(obj, '__dataclass_fields__'):
        # dataclass
        from dataclasses import asdict
        return asdict(obj)
    return obj

_nteract_exports = {}
for _nteract_name in [${namesList}]:
    try:
        _nteract_exports[_nteract_name] = _nteract_serialize(eval(_nteract_name))
    except Exception as _nteract_err:
        _nteract_exports[_nteract_name] = {"__error__": str(_nteract_err)}

_nteract_json.dumps(_nteract_exports)
`.trim();
}

// ---------------------------------------------------------------------------
// Store (singleton per notebook)
// ---------------------------------------------------------------------------

type Listener = () => void;

class DataBindingStore {
  private bindings: BindingNamespace = {};
  private listeners = new Set<Listener>();
  private version = 0;

  /** Get the full binding namespace (for MDX scope injection) */
  getNamespace(): BindingNamespace {
    return this.bindings;
  }

  /** Get a proxy object that MDX templates use as `$` */
  getScope(): Record<string, unknown> {
    const scope: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(this.bindings)) {
      scope[name] = entry.value;
    }
    return scope;
  }

  /** Get a single binding by name */
  get(name: string): unknown | undefined {
    return this.bindings[name]?.value;
  }

  /** Update bindings from a code cell execution result */
  setFromExecution(cellId: string, exports: Record<string, unknown>): void {
    const now = Date.now();
    let changed = false;

    for (const [name, value] of Object.entries(exports)) {
      const existing = this.bindings[name];
      // Skip if value hasn't changed (shallow compare for primitives)
      if (existing?.cellId === cellId && existing.value === value) continue;

      this.bindings[name] = { cellId, value, updatedAt: now };
      changed = true;
    }

    if (changed) {
      this.version++;
      logger.debug(
        `[DataBindings] Updated from cell ${cellId}:`,
        Object.keys(exports),
      );
      this.notify();
    }
  }

  /** Remove all bindings from a specific cell (e.g., cell deleted) */
  clearCell(cellId: string): void {
    let changed = false;
    for (const [name, entry] of Object.entries(this.bindings)) {
      if (entry.cellId === cellId) {
        delete this.bindings[name];
        changed = true;
      }
    }
    if (changed) {
      this.version++;
      this.notify();
    }
  }

  /** Clear all bindings (e.g., kernel restart) */
  clear(): void {
    if (Object.keys(this.bindings).length === 0) return;
    this.bindings = {};
    this.version++;
    this.notify();
  }

  /** Get current version (for useSyncExternalStore snapshot) */
  getVersion(): number {
    return this.version;
  }

  // --- useSyncExternalStore integration ---

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BindingNamespace => {
    return this.bindings;
  };

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton + React hook
// ---------------------------------------------------------------------------

/** Global data binding store (one per notebook window) */
export const dataBindingStore = new DataBindingStore();

/**
 * React hook: subscribe to the full data binding namespace.
 * Returns the `$` scope object for MDX injection.
 *
 * Usage in MDXCell:
 * ```tsx
 * const $ = useDataBindings();
 * // Pass $ into MDX scope so {$revenue} works
 * ```
 */
export function useDataBindings(): Record<string, unknown> {
  const bindings = useSyncExternalStore(
    dataBindingStore.subscribe,
    dataBindingStore.getSnapshot,
  );

  // Build scope object — memoized by store version
  const scope: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(bindings)) {
    scope[name] = entry.value;
  }
  return scope;
}

/**
 * React hook: subscribe to a single binding by name.
 * Only re-renders when this specific binding changes.
 */
export function useBinding(name: string): unknown | undefined {
  const bindings = useSyncExternalStore(
    dataBindingStore.subscribe,
    dataBindingStore.getSnapshot,
  );
  return bindings[name]?.value;
}
