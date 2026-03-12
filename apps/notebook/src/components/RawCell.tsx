import type { KeyBinding } from "@codemirror/view";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import {
  CodeMirrorEditor,
  type CodeMirrorEditorRef,
} from "@/components/editor/codemirror-editor";
import {
  languageDisplayNames,
  type SupportedLanguage,
} from "@/components/editor/languages";
import { searchHighlight } from "@/components/editor/search-highlight";
import { useCellKeyboardNavigation } from "../hooks/useCellKeyboardNavigation";
import { useEditorRegistry } from "../hooks/useEditorRegistry";
import { getRawCellFormatInfo } from "../lib/raw-cell-format";
import type { RawCell as RawCellType } from "../types";

interface RawCellProps {
  cell: RawCellType;
  isFocused: boolean;
  isFirstCell: boolean;
  searchQuery?: string;
  onFocus: () => void;
  onUpdateSource: (source: string) => void;
  onDelete: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  isPreviousCellFromFocused?: boolean;
}

function getLanguageBadgeLabel(language: SupportedLanguage): string {
  return languageDisplayNames[language] ?? "Plain Text";
}

export function RawCell({
  cell,
  isFocused,
  isFirstCell,
  searchQuery,
  onFocus,
  onUpdateSource,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  isPreviousCellFromFocused,
}: RawCellProps) {
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const { registerEditor, unregisterEditor } = useEditorRegistry();

  const formatInfo = useMemo(
    () =>
      getRawCellFormatInfo({
        source: cell.source,
        metadata: cell.metadata,
        isFirstCell,
      }),
    [cell.source, cell.metadata, isFirstCell],
  );

  useEffect(() => {
    if (editorRef.current) {
      registerEditor(cell.id, {
        focus: () => editorRef.current?.focus(),
        setCursorPosition: (position) =>
          editorRef.current?.setCursorPosition(position),
      });
    }

    return () => unregisterEditor(cell.id);
  }, [cell.id, registerEditor, unregisterEditor]);

  const moveToNextCell = useCallback(() => {
    onFocusNext?.("start");
  }, [onFocusNext]);

  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: onFocusNext ?? (() => {}),
    onDelete,
  });

  const keyMap: KeyBinding[] = useMemo(
    () => [
      ...navigationKeyMap,
      {
        key: "Shift-Enter",
        run: () => {
          moveToNextCell();
          return true;
        },
      },
    ],
    [navigationKeyMap, moveToNextCell],
  );

  const editorExtensions = useMemo(
    () => searchHighlight(searchQuery || ""),
    [searchQuery],
  );

  const placeholder = formatInfo.isFrontmatter
    ? "---\ntitle: Untitled\n---"
    : isFirstCell
      ? "Use --- ... --- for YAML frontmatter or +++ ... +++ for TOML."
      : "Enter raw cell content...";

  const rightGutterContent = (
    <button
      type="button"
      tabIndex={-1}
      onClick={onDelete}
      className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-destructive"
      title="Delete cell"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <CellContainer
      id={cell.id}
      cellType="raw"
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      onFocus={onFocus}
      rightGutterContent={rightGutterContent}
      codeContent={
        <>
          <div className="flex items-center gap-2 py-1">
            <span className="text-xs font-mono text-muted-foreground">
              {formatInfo.isFrontmatter ? "frontmatter" : "raw"}
            </span>
            <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {getLanguageBadgeLabel(formatInfo.language)}
            </span>
          </div>
          <div>
            <CodeMirrorEditor
              ref={editorRef}
              value={cell.source}
              language={formatInfo.language}
              onValueChange={onUpdateSource}
              keyMap={keyMap}
              extensions={editorExtensions}
              placeholder={placeholder}
              className="min-h-[2rem]"
              lineWrapping
              autoFocus={isFocused}
            />
          </div>
        </>
      }
    />
  );
}
