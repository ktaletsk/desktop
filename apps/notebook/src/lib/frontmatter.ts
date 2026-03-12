import { parse, parseDocument, stringify } from "yaml";
import type { NotebookCell } from "../types";
import { getRawCellFormatInfo } from "./raw-cell-format";

export type DocumentFrontmatterKind = "none" | "yaml" | "toml" | "invalid";

export interface DocumentSettingsDraft {
  title: string;
  subtitle: string;
  description: string;
  author: string;
  date: string;
  categories: string;
  browserRunnable: "inherit" | "true" | "false";
  formatYaml: string;
  additionalYaml: string;
}

export interface DocumentFrontmatterState {
  kind: DocumentFrontmatterKind;
  cellId: string | null;
  source: string;
  draft: DocumentSettingsDraft;
  error: string | null;
}

const EMPTY_DRAFT: DocumentSettingsDraft = {
  title: "",
  subtitle: "",
  description: "",
  author: "",
  date: "",
  categories: "",
  browserRunnable: "inherit",
  formatYaml: "",
  additionalYaml: "",
};

const KNOWN_KEYS = new Set([
  "title",
  "subtitle",
  "description",
  "author",
  "date",
  "categories",
  "format",
  "browser-runnable",
]);

function stringifyYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...(value as Record<string, unknown>) };
}

function extractFrontmatterBody(
  source: string,
  delimiter: "---" | "+++",
): { body: string; error: string | null } {
  const normalized = source.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().length > 0);

  if (startIndex === -1 || lines[startIndex].trim() !== delimiter) {
    return {
      body: "",
      error: `Expected ${delimiter} on the first non-empty line.`,
    };
  }

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === delimiter,
  );

  if (endIndex === -1) {
    return {
      body: "",
      error: `Missing closing ${delimiter} delimiter.`,
    };
  }

  return {
    body: lines.slice(startIndex + 1, endIndex).join("\n"),
    error: null,
  };
}

function scalarToInput(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function arrayOfScalarsToInput(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;

  const strings = value
    .map((item) => scalarToInput(item))
    .filter((item): item is string => item !== null);

  return strings.length === value.length ? strings.join(", ") : null;
}

function objectToDraft(data: Record<string, unknown>): DocumentSettingsDraft {
  const additional = { ...data };
  const draft: DocumentSettingsDraft = { ...EMPTY_DRAFT };

  const title = scalarToInput(additional.title);
  if (title !== null) {
    draft.title = title;
    delete additional.title;
  }

  const subtitle = scalarToInput(additional.subtitle);
  if (subtitle !== null) {
    draft.subtitle = subtitle;
    delete additional.subtitle;
  }

  const description = scalarToInput(additional.description);
  if (description !== null) {
    draft.description = description;
    delete additional.description;
  }

  const author = arrayOfScalarsToInput(additional.author);
  if (author !== null) {
    draft.author = author;
    delete additional.author;
  }

  const date = scalarToInput(additional.date);
  if (date !== null) {
    draft.date = date;
    delete additional.date;
  }

  const categories = arrayOfScalarsToInput(additional.categories);
  if (categories !== null) {
    draft.categories = categories;
    delete additional.categories;
  }

  if ("browser-runnable" in additional) {
    const browserRunnable = additional["browser-runnable"];
    if (typeof browserRunnable === "boolean") {
      draft.browserRunnable = browserRunnable ? "true" : "false";
      delete additional["browser-runnable"];
    }
  }

  if ("format" in additional) {
    draft.formatYaml = stringifyYaml(additional.format);
    delete additional.format;
  }

  draft.additionalYaml =
    Object.keys(additional).length > 0 ? stringifyYaml(additional) : "";

  return draft;
}

function listFromInput(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAdditionalYaml(source: string): {
  data: Record<string, unknown>;
  error: string | null;
} {
  if (!source.trim()) return { data: {}, error: null };

  try {
    const parsed = parse(source);
    const asObject = toPlainObject(parsed);
    if (!asObject) {
      return {
        data: {},
        error: "Additional settings must be a YAML object with top-level keys.",
      };
    }
    return { data: asObject, error: null };
  } catch (error) {
    return {
      data: {},
      error:
        error instanceof Error
          ? error.message
          : "Failed to parse additional settings.",
    };
  }
}

function parseYamlValue(source: string): {
  value: unknown;
  error: string | null;
} {
  if (!source.trim()) return { value: undefined, error: null };

  try {
    return { value: parse(source), error: null };
  } catch (error) {
    return {
      value: undefined,
      error:
        error instanceof Error ? error.message : "Failed to parse YAML value.",
    };
  }
}

function normalizeAdditionalKeys(data: Record<string, unknown>) {
  for (const key of KNOWN_KEYS) {
    delete data[key];
  }
}

export function buildFrontmatterSourceFromDraft(draft: DocumentSettingsDraft): {
  source: string | null;
  error: string | null;
} {
  const { data: additional, error: additionalError } = parseAdditionalYaml(
    draft.additionalYaml,
  );
  if (additionalError) {
    return { source: null, error: additionalError };
  }

  normalizeAdditionalKeys(additional);

  const frontmatter: Record<string, unknown> = {};

  if (draft.title.trim()) frontmatter.title = draft.title.trim();
  if (draft.subtitle.trim()) frontmatter.subtitle = draft.subtitle.trim();
  if (draft.description.trim()) {
    frontmatter.description = draft.description.trim();
  }

  if (draft.author.trim()) {
    const authors = listFromInput(draft.author);
    frontmatter.author = authors.length <= 1 ? authors[0] : authors;
  }

  if (draft.date.trim()) frontmatter.date = draft.date.trim();

  if (draft.categories.trim()) {
    frontmatter.categories = listFromInput(draft.categories);
  }

  if (draft.browserRunnable === "true") {
    frontmatter["browser-runnable"] = true;
  } else if (draft.browserRunnable === "false") {
    frontmatter["browser-runnable"] = false;
  }

  const { value: formatValue, error: formatError } = parseYamlValue(
    draft.formatYaml,
  );
  if (formatError) {
    return {
      source: null,
      error: `Format YAML is invalid: ${formatError}`,
    };
  }
  if (formatValue !== undefined) {
    frontmatter.format = formatValue;
  }

  const payload = {
    ...frontmatter,
    ...additional,
  };

  if (Object.keys(payload).length === 0) {
    return {
      source: "---\n---",
      error: null,
    };
  }

  return {
    source: `---\n${stringifyYaml(payload)}\n---`,
    error: null,
  };
}

export function isDocumentSettingsDraftEmpty(
  draft: DocumentSettingsDraft,
): boolean {
  return (
    draft.title.trim() === "" &&
    draft.subtitle.trim() === "" &&
    draft.description.trim() === "" &&
    draft.author.trim() === "" &&
    draft.date.trim() === "" &&
    draft.categories.trim() === "" &&
    draft.browserRunnable === "inherit" &&
    draft.formatYaml.trim() === "" &&
    draft.additionalYaml.trim() === ""
  );
}

export function getDocumentFrontmatterState(
  cells: NotebookCell[],
): DocumentFrontmatterState {
  const firstCell = cells[0];

  if (!firstCell || firstCell.cell_type !== "raw") {
    return {
      kind: "none",
      cellId: null,
      source: "",
      draft: { ...EMPTY_DRAFT },
      error: null,
    };
  }

  const formatInfo = getRawCellFormatInfo({
    source: firstCell.source,
    metadata: firstCell.metadata,
    isFirstCell: true,
  });

  if (!formatInfo.isFrontmatter) {
    return {
      kind: "none",
      cellId: null,
      source: "",
      draft: { ...EMPTY_DRAFT },
      error: null,
    };
  }

  if (formatInfo.language === "toml") {
    return {
      kind: "toml",
      cellId: firstCell.id,
      source: firstCell.source,
      draft: { ...EMPTY_DRAFT },
      error:
        "TOML frontmatter is detected. This experimental editor currently writes YAML.",
    };
  }

  const { body, error: bodyError } = extractFrontmatterBody(
    firstCell.source,
    "---",
  );
  if (bodyError) {
    return {
      kind: "invalid",
      cellId: firstCell.id,
      source: firstCell.source,
      draft: { ...EMPTY_DRAFT },
      error: bodyError,
    };
  }

  try {
    const document = body.trim() ? parseDocument(body) : null;
    if (document && document.errors.length > 0) {
      return {
        kind: "invalid",
        cellId: firstCell.id,
        source: firstCell.source,
        draft: { ...EMPTY_DRAFT },
        error:
          document.errors[0]?.message ?? "Failed to parse YAML frontmatter.",
      };
    }

    const parsed = document ? document.toJS() : {};
    const data = toPlainObject(parsed);
    if (!data) {
      return {
        kind: "invalid",
        cellId: firstCell.id,
        source: firstCell.source,
        draft: { ...EMPTY_DRAFT },
        error: "Frontmatter must be a YAML object with top-level keys.",
      };
    }

    return {
      kind: "yaml",
      cellId: firstCell.id,
      source: firstCell.source,
      draft: objectToDraft(data),
      error: null,
    };
  } catch (error) {
    return {
      kind: "invalid",
      cellId: firstCell.id,
      source: firstCell.source,
      draft: { ...EMPTY_DRAFT },
      error:
        error instanceof Error
          ? error.message
          : "Failed to parse YAML frontmatter.",
    };
  }
}
