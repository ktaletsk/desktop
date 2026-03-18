/**
 * MDXCell — RFC 001: MDX-Capable Jupyter Notebook
 *
 * A cell that renders MDX (Markdown + JSX) with live data bindings from
 * Jupyter kernel execution. Supports edit mode (CodeMirror) and preview
 * mode (compiled React output).
 *
 * Key differences from MarkdownCell:
 * - Renders inline (React tree), not in an iframe
 * - Has access to the `$` data binding namespace
 * - Supports JSX component syntax (charts, tables, etc.)
 * - Uses @mdx-js/mdx for browser-side compilation
 */

import { AlertTriangle, Code2, Eye, Pencil, Trash2 } from "lucide-react";
import {
  type ErrorInfo,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import {
  CodeMirrorEditor,
  type CodeMirrorEditorRef,
} from "@/components/editor/codemirror-editor";
import { cn } from "@/lib/utils";
import { useDataBindings } from "../../lib/data-bindings";
import type { MDXCell as MDXCellType } from "../../types";
import { builtInComponents } from "./built-in-components";
import { compileMDX, type MDXCompileResult } from "./mdx-compiler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MDXCellProps {
  cell: MDXCellType;
  isFocused: boolean;
  searchQuery?: string;
  onFocus: () => void;
  onUpdateSource: (source: string) => void;
  onDelete: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  onInsertCellAfter?: () => void;
  isLastCell?: boolean;
  isPreviousCellFromFocused?: boolean;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}

// ---------------------------------------------------------------------------
// Error Boundary (inline, since MDX renders in the React tree)
// ---------------------------------------------------------------------------

interface ErrorFallbackProps {
  error: Error;
  source: string;
  onRetry: () => void;
}

function MDXErrorFallback({ error, source, onRetry }: ErrorFallbackProps) {
  const isCompileError = error.message.includes("Could not parse");
  return (
    <div className="mdx-error">
      <div className="mdx-error-header">
        <AlertTriangle className="h-4 w-4" />
        <span>{isCompileError ? "MDX Syntax Error" : "Render Error"}</span>
        <button onClick={onRetry} className="mdx-error-retry">
          Retry
        </button>
      </div>
      <pre className="mdx-error-message">{error.message}</pre>
      {!isCompileError && (
        <details className="mdx-error-source">
          <summary>Source</summary>
          <pre>{source}</pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MDXCell Component
// ---------------------------------------------------------------------------

export const MDXCell = memo(function MDXCell({
  cell,
  isFocused,
  onFocus,
  onUpdateSource,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  onInsertCellAfter,
  isLastCell = false,
  isPreviousCellFromFocused,
  dragHandleProps,
  isDragging,
}: MDXCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [compileResult, setCompileResult] = useState<MDXCompileResult | null>(
    null,
  );
  const [renderError, setRenderError] = useState<Error | null>(null);
  const editorRef = useRef<CodeMirrorEditorRef>(null);

  // Data bindings from kernel exports
  const $ = useDataBindings();

  // ---- Compile MDX on source change ----

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await compileMDX(cell.source, {
        $,
        ...builtInComponents,
      });
      if (!cancelled) {
        setCompileResult(result);
        if (result.error) {
          setRenderError(result.error);
        } else {
          setRenderError(null);
        }
      }
    }, 100); // 100ms debounce

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cell.source, $]);

  // ---- Edit/Preview toggle ----

  const enterEdit = useCallback(() => {
    setIsEditing(true);
    // Focus the editor after React renders it
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const exitEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (!isEditing) enterEdit();
  }, [isEditing, enterEdit]);

  // ---- Keyboard handling ----

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        exitEdit();
        e.preventDefault();
      }
    },
    [exitEdit],
  );

  // ---- Render ----

  const ribbonColor = "bg-violet-400 dark:bg-violet-500";

  return (
    <CellContainer
      cellId={cell.id}
      cellType="mdx"
      isFocused={isFocused}
      onClick={onFocus}
      onDoubleClick={handleDoubleClick}
      ribbonColor={ribbonColor}
      isLastCell={isLastCell}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      actions={
        <>
          <button
            className="cell-action-button"
            onClick={() => (isEditing ? exitEdit() : enterEdit())}
            title={isEditing ? "Preview (Esc)" : "Edit"}
          >
            {isEditing ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <Pencil className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            className="cell-action-button"
            onClick={onDelete}
            title="Delete cell"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      }
    >
      {isEditing ? (
        /* ── Editor Mode ── */
        <div className="mdx-editor" onKeyDown={handleEditorKeyDown}>
          <div className="mdx-editor-toolbar">
            <span className="mdx-editor-label">
              <Code2 className="h-3 w-3" />
              MDX
            </span>
            <span className="mdx-editor-hint">Esc to preview</span>
          </div>
          <CodeMirrorEditor
            ref={editorRef}
            value={cell.source}
            onChange={onUpdateSource}
            language="markdown"
            minHeight={60}
          />
          {/* Live preview below editor */}
          {compileResult?.Content && !renderError && (
            <div className="mdx-editor-preview">
              <div className="mdx-editor-preview-label">Preview</div>
              <div className="mdx-rendered">
                <compileResult.Content />
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── Preview Mode ── */
        <div className="mdx-preview">
          {renderError ? (
            <MDXErrorFallback
              error={renderError}
              source={cell.source}
              onRetry={() => {
                setRenderError(null);
                setCompileResult(null);
              }}
            />
          ) : compileResult?.Content ? (
            <div className="mdx-rendered">
              <compileResult.Content />
            </div>
          ) : cell.source.trim() === "" ? (
            <div className="mdx-empty" onClick={enterEdit}>
              <Code2 className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Double-click to add MDX content
              </span>
            </div>
          ) : (
            <div className="mdx-compiling">Compiling...</div>
          )}
        </div>
      )}
    </CellContainer>
  );
});
