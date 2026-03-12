import type { SupportedLanguage } from "@/components/editor/languages";
import type { CellMetadata } from "../types";

type RawCellLanguage = Extract<
  SupportedLanguage,
  "yaml" | "toml" | "markdown" | "html" | "json" | "plain"
>;

export interface RawCellFormatInfo {
  language: RawCellLanguage;
  isFrontmatter: boolean;
}

const FORMAT_HINT_KEYS = [
  "format",
  "raw_mimetype",
  "mimetype",
  "mimeType",
] as const;

function detectFrontmatterLanguage(
  source: string,
  isFirstCell: boolean,
): "yaml" | "toml" | null {
  if (!isFirstCell) return null;

  const normalized = source.replace(/^\uFEFF/, "");
  const firstContentLine = normalized
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();

  if (firstContentLine === "---") {
    return "yaml";
  }
  if (firstContentLine === "+++") {
    return "toml";
  }
  return null;
}

function mapFormatHintToLanguage(formatHint: string): RawCellLanguage | null {
  const normalized = formatHint.trim().toLowerCase();

  if (
    normalized === "yaml" ||
    normalized === "yml" ||
    normalized.includes("yaml") ||
    normalized.includes("yml")
  ) {
    return "yaml";
  }

  if (normalized === "toml" || normalized.includes("toml")) {
    return "toml";
  }

  if (
    normalized === "md" ||
    normalized === "markdown" ||
    normalized.includes("markdown")
  ) {
    return "markdown";
  }

  if (normalized === "html" || normalized.includes("html")) {
    return "html";
  }

  if (normalized === "json" || normalized.includes("json")) {
    return "json";
  }

  if (
    normalized === "plain" ||
    normalized === "text" ||
    normalized === "txt" ||
    normalized.includes("plain")
  ) {
    return "plain";
  }

  return null;
}

function detectLanguageFromMetadata(
  metadata: CellMetadata | undefined,
): RawCellLanguage | null {
  if (!metadata) return null;

  for (const key of FORMAT_HINT_KEYS) {
    const rawValue = metadata[key];
    if (typeof rawValue !== "string") continue;

    const language = mapFormatHintToLanguage(rawValue);
    if (language) {
      return language;
    }
  }

  return null;
}

export function getRawCellFormatInfo({
  source,
  metadata,
  isFirstCell = false,
}: {
  source: string;
  metadata?: CellMetadata;
  isFirstCell?: boolean;
}): RawCellFormatInfo {
  // Quarto/Pandoc-style document frontmatter lives in the first raw cell.
  const frontmatterLanguage = detectFrontmatterLanguage(source, isFirstCell);
  if (frontmatterLanguage) {
    return { language: frontmatterLanguage, isFrontmatter: true };
  }

  const metadataLanguage = detectLanguageFromMetadata(metadata);
  if (metadataLanguage) {
    return { language: metadataLanguage, isFrontmatter: false };
  }

  return { language: "plain", isFrontmatter: false };
}
