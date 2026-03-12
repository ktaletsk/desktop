import { describe, expect, it } from "vitest";
import type { NotebookCell } from "../../types";
import {
  buildFrontmatterSourceFromDraft,
  getDocumentFrontmatterState,
  isDocumentSettingsDraftEmpty,
} from "../frontmatter";

const rawCell = (source: string): NotebookCell => ({
  cell_type: "raw",
  id: "raw-1",
  source,
  metadata: {},
});

describe("getDocumentFrontmatterState", () => {
  it("parses YAML frontmatter from the first raw cell", () => {
    const state = getDocumentFrontmatterState([
      rawCell(
        "---\ntitle: Test notebook\nauthor:\n  - Alice\n  - Bob\nformat:\n  html: default\ncustom:\n  level: 2\n---",
      ),
    ]);

    expect(state.kind).toBe("yaml");
    expect(state.cellId).toBe("raw-1");
    expect(state.draft.title).toBe("Test notebook");
    expect(state.draft.author).toBe("Alice, Bob");
    expect(state.draft.formatYaml).toContain("html: default");
    expect(state.draft.additionalYaml).toContain("custom:");
  });

  it("keeps unsupported author shapes in additional YAML", () => {
    const state = getDocumentFrontmatterState([
      rawCell("---\nauthor:\n  - name: Alice\ncategories:\n  - notebooks\n---"),
    ]);

    expect(state.draft.author).toBe("");
    expect(state.draft.categories).toBe("notebooks");
    expect(state.draft.additionalYaml).toContain("author:");
  });

  it("reports TOML frontmatter separately", () => {
    const state = getDocumentFrontmatterState([
      rawCell("+++\ntitle = 'Test'\n+++"),
    ]);

    expect(state.kind).toBe("toml");
    expect(state.error).toContain("writes YAML");
  });

  it("surfaces invalid YAML frontmatter", () => {
    const state = getDocumentFrontmatterState([
      rawCell("---\ntitle: [unterminated\n---"),
    ]);

    expect(state.kind).toBe("invalid");
    expect(state.error).toBeTruthy();
  });

  it("returns none when the first cell is not frontmatter", () => {
    const state = getDocumentFrontmatterState([rawCell("plain raw text")]);
    expect(state.kind).toBe("none");
    expect(state.cellId).toBeNull();
  });
});

describe("buildFrontmatterSourceFromDraft", () => {
  it("builds YAML frontmatter from the dialog draft", () => {
    const result = buildFrontmatterSourceFromDraft({
      title: "Notebook",
      subtitle: "Experiment",
      description: "Testing frontmatter",
      author: "Alice, Bob",
      date: "2026-03-12",
      categories: "quarto, jupyter",
      browserRunnable: "false",
      formatYaml: "html: default",
      additionalYaml: "execute:\n  echo: false",
    });

    expect(result.error).toBeNull();
    expect(result.source).toContain("title: Notebook");
    expect(result.source).toContain("- Alice");
    expect(result.source).toContain("browser-runnable: false");
    expect(result.source).toContain("execute:");
  });

  it("rejects invalid additional YAML", () => {
    const result = buildFrontmatterSourceFromDraft({
      title: "",
      subtitle: "",
      description: "",
      author: "",
      date: "",
      categories: "",
      browserRunnable: "inherit",
      formatYaml: "",
      additionalYaml: "- not-an-object",
    });

    expect(result.source).toBeNull();
    expect(result.error).toContain("top-level keys");
  });
});

describe("isDocumentSettingsDraftEmpty", () => {
  it("detects an empty draft", () => {
    expect(
      isDocumentSettingsDraftEmpty({
        title: "",
        subtitle: "",
        description: "",
        author: "",
        date: "",
        categories: "",
        browserRunnable: "inherit",
        formatYaml: "",
        additionalYaml: "",
      }),
    ).toBe(true);
  });
});
