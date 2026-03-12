import { AlertTriangle, Beaker, FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  buildFrontmatterSourceFromDraft,
  type DocumentSettingsDraft,
  getDocumentFrontmatterState,
  isDocumentSettingsDraftEmpty,
} from "../lib/frontmatter";
import type { NotebookCell } from "../types";

interface DocumentSettingsDialogProps {
  open: boolean;
  cells: NotebookCell[];
  onOpenChange: (open: boolean) => void;
  onSaveFrontmatter: (source: string, cellId?: string | null) => void;
}

function Notice({
  title,
  body,
  variant = "default",
}: {
  title: string;
  body: string;
  variant?: "default" | "warning";
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        variant === "warning"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-border/60 bg-muted/40 text-muted-foreground"
      }`}
    >
      <div className="flex items-start gap-2">
        {variant === "warning" ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        ) : (
          <FileText className="mt-0.5 h-4 w-4 shrink-0" />
        )}
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 leading-5">{body}</p>
        </div>
      </div>
    </div>
  );
}

export function DocumentSettingsDialog({
  open,
  cells,
  onOpenChange,
  onSaveFrontmatter,
}: DocumentSettingsDialogProps) {
  const frontmatterState = useMemo(
    () => getDocumentFrontmatterState(cells),
    [cells],
  );
  const [draft, setDraft] = useState<DocumentSettingsDraft>(
    frontmatterState.draft,
  );

  useEffect(() => {
    if (open) {
      setDraft(frontmatterState.draft);
    }
  }, [open, frontmatterState]);

  const preview = useMemo(
    () => buildFrontmatterSourceFromDraft(draft),
    [draft],
  );

  const saveLabel =
    frontmatterState.kind === "yaml"
      ? "Update frontmatter"
      : frontmatterState.kind === "none"
        ? "Create frontmatter"
        : "Replace with YAML";

  const saveDisabled =
    preview.source === null ||
    (frontmatterState.kind !== "yaml" && isDocumentSettingsDraftEmpty(draft));

  const updateDraft = <K extends keyof DocumentSettingsDraft>(
    key: K,
    value: DocumentSettingsDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-0">
        <DialogHeader className="border-b px-6 py-5">
          <div className="flex items-center gap-2">
            <DialogTitle>Document Settings</DialogTitle>
            <Badge variant="outline" className="gap-1 text-[10px] uppercase">
              <Beaker className="h-3 w-3" />
              Experimental
            </Badge>
            {frontmatterState.kind === "yaml" && (
              <Badge variant="secondary" className="text-[10px] uppercase">
                YAML
              </Badge>
            )}
          </div>
          <DialogDescription>
            Edit Quarto-style document frontmatter from a native UI. The dialog
            writes a first raw cell using common YAML frontmatter conventions.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[75vh] gap-0 overflow-hidden lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-4 overflow-y-auto px-6 py-5">
            {frontmatterState.kind === "none" && (
              <Notice
                title="No frontmatter detected yet"
                body="Saving here will insert a raw cell at the top of the notebook and store document settings as YAML frontmatter."
              />
            )}

            {frontmatterState.kind === "toml" && (
              <Notice
                title="TOML frontmatter detected"
                body="This experimental editor currently writes YAML. Saving will replace the existing TOML frontmatter cell with YAML."
                variant="warning"
              />
            )}

            {frontmatterState.kind === "invalid" && (
              <Notice
                title="Frontmatter could not be parsed"
                body={
                  frontmatterState.error ??
                  "The first raw cell is not valid YAML frontmatter. Saving here will replace it with a clean YAML block."
                }
                variant="warning"
              />
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="document-title">Title</Label>
                <Input
                  id="document-title"
                  value={draft.title}
                  onChange={(event) => updateDraft("title", event.target.value)}
                  placeholder="Notebook title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="document-subtitle">Subtitle</Label>
                <Input
                  id="document-subtitle"
                  value={draft.subtitle}
                  onChange={(event) =>
                    updateDraft("subtitle", event.target.value)
                  }
                  placeholder="Optional subtitle"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="document-description">Description</Label>
              <Textarea
                id="document-description"
                value={draft.description}
                onChange={(event) =>
                  updateDraft("description", event.target.value)
                }
                placeholder="Short summary for the document"
                className="min-h-24"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="document-author">Author</Label>
                <Input
                  id="document-author"
                  value={draft.author}
                  onChange={(event) =>
                    updateDraft("author", event.target.value)
                  }
                  placeholder="Alice, Bob"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="document-date">Date</Label>
                <Input
                  id="document-date"
                  value={draft.date}
                  onChange={(event) => updateDraft("date", event.target.value)}
                  placeholder="2026-03-12"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="document-categories">Categories</Label>
                <Input
                  id="document-categories"
                  value={draft.categories}
                  onChange={(event) =>
                    updateDraft("categories", event.target.value)
                  }
                  placeholder="bayesian, hierarchical, mcmc"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="document-browser-runnable">
                  Browser Runnable
                </Label>
                <Select
                  value={draft.browserRunnable}
                  onValueChange={(value) =>
                    updateDraft(
                      "browserRunnable",
                      value as DocumentSettingsDraft["browserRunnable"],
                    )
                  }
                >
                  <SelectTrigger id="document-browser-runnable">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Leave unset</SelectItem>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="document-format">Format YAML</Label>
              <Textarea
                id="document-format"
                value={draft.formatYaml}
                onChange={(event) =>
                  updateDraft("formatYaml", event.target.value)
                }
                placeholder={"html: default\npdf: default"}
                className="min-h-24 font-mono text-xs"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="document-additional">Additional YAML</Label>
              <Textarea
                id="document-additional"
                value={draft.additionalYaml}
                onChange={(event) =>
                  updateDraft("additionalYaml", event.target.value)
                }
                placeholder={"execute:\n  echo: false"}
                className="min-h-32 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Unsupported top-level keys stay here so the common fields can
                stay focused.
              </p>
            </div>
          </div>

          <div className="border-t bg-muted/20 px-6 py-5 lg:border-l lg:border-t-0">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Preview</p>
                <p className="text-xs text-muted-foreground">
                  This is the raw frontmatter cell that will be written.
                </p>
              </div>

              {preview.error ? (
                <Notice
                  title="Preview unavailable"
                  body={preview.error}
                  variant="warning"
                />
              ) : (
                <pre className="overflow-x-auto rounded-lg border bg-background p-4 text-xs leading-6 text-foreground">
                  {preview.source}
                </pre>
              )}

              {frontmatterState.source && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Current cell
                  </p>
                  <pre className="max-h-56 overflow-auto rounded-lg border bg-background/70 p-4 text-xs leading-6 text-muted-foreground">
                    {frontmatterState.source}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saveDisabled}
            onClick={() => {
              if (!preview.source) return;
              onSaveFrontmatter(preview.source, frontmatterState.cellId);
              onOpenChange(false);
            }}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
