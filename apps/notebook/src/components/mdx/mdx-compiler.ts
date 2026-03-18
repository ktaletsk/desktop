/**
 * MDX Compiler — RFC 001: MDX-Capable Jupyter Notebook
 *
 * Browser-side MDX compilation using @mdx-js/mdx.
 * Compiles MDX source → React component with data binding scope.
 *
 * This module is the compilation layer. It:
 * 1. Takes MDX source + scope ($ namespace + built-in components)
 * 2. Compiles to a React component via evaluate()
 * 3. Returns the component or an error
 *
 * Future: Replace with WASM-based mdxjs-rs for better performance.
 */

import type { ComponentType } from "react";
import { logger } from "../../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MDXCompileResult {
  /** The compiled React component, or null if compilation failed */
  Content: ComponentType | null;
  /** Compilation error, if any */
  error: Error | null;
  /** Compilation time in milliseconds */
  compileTimeMs: number;
}

export type MDXScope = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Compilation cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  source: string;
  scopeKeys: string;
  result: MDXCompileResult;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50;

function cacheKey(source: string, scopeKeys: string): string {
  // Simple hash for cache lookup — not cryptographic
  let hash = 0;
  const str = source + scopeKeys;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile MDX source to a React component.
 *
 * This is the primary entry point. It handles:
 * - Cache hit fast path
 * - Dynamic import of @mdx-js/mdx (lazy loaded, ~200KB)
 * - Error wrapping with source context
 * - Scope injection ($ namespace, built-in components)
 *
 * @param source - Raw MDX source string
 * @param scope - Variables and components available in MDX expressions
 * @returns Compiled component or error
 */
export async function compileMDX(
  source: string,
  scope: MDXScope,
): Promise<MDXCompileResult> {
  const start = performance.now();

  // Empty source → no component
  if (!source.trim()) {
    return { Content: null, error: null, compileTimeMs: 0 };
  }

  // Cache check
  const scopeKeys = Object.keys(scope).sort().join(",");
  const key = cacheKey(source, scopeKeys);
  const cached = cache.get(key);
  if (cached && cached.source === source && cached.scopeKeys === scopeKeys) {
    return cached.result;
  }

  try {
    // Dynamic import — @mdx-js/mdx is ~200KB, load on first use
    const { evaluate } = await import("@mdx-js/mdx");
    const runtime = await import("react/jsx-runtime");

    const { default: Content } = await evaluate(source, {
      ...runtime,
      // Development mode for better error messages
      development: process.env.NODE_ENV !== "production",
      // Inject scope as useMDXComponents
      useMDXComponents: () => scope,
    });

    const result: MDXCompileResult = {
      Content: Content as ComponentType,
      error: null,
      compileTimeMs: performance.now() - start,
    };

    // Cache the result
    if (cache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, { source, scopeKeys, result });

    logger.debug(
      `[MDXCompiler] Compiled in ${result.compileTimeMs.toFixed(1)}ms`,
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    logger.warn("[MDXCompiler] Compilation failed:", error.message);

    return {
      Content: null,
      error,
      compileTimeMs: performance.now() - start,
    };
  }
}

/**
 * Precompile a set of MDX sources (e.g., on notebook load).
 * Runs compilations in parallel, populating the cache.
 */
export async function precompileMDX(
  sources: { id: string; source: string }[],
  scope: MDXScope,
): Promise<void> {
  await Promise.allSettled(
    sources.map(({ source }) => compileMDX(source, scope)),
  );
}

/** Clear the compilation cache (e.g., on kernel restart when $ changes) */
export function clearMDXCache(): void {
  cache.clear();
}
