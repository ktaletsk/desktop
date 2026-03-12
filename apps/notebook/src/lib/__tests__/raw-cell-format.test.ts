import { describe, expect, it } from "vitest";
import { getRawCellFormatInfo } from "../raw-cell-format";

describe("getRawCellFormatInfo", () => {
  it("detects YAML frontmatter in the first raw cell", () => {
    expect(
      getRawCellFormatInfo({
        source: "---\ntitle: Notebook\nformat: html\n---",
        metadata: {},
        isFirstCell: true,
      }),
    ).toEqual({
      language: "yaml",
      isFrontmatter: true,
    });
  });

  it("detects TOML frontmatter in the first raw cell", () => {
    expect(
      getRawCellFormatInfo({
        source: "+++\ntitle = 'Notebook'\n+++",
        metadata: {},
        isFirstCell: true,
      }),
    ).toEqual({
      language: "toml",
      isFrontmatter: true,
    });
  });

  it("does not treat later raw cells as frontmatter", () => {
    expect(
      getRawCellFormatInfo({
        source: "---\ntitle: Section\n---",
        metadata: {},
        isFirstCell: false,
      }),
    ).toEqual({
      language: "plain",
      isFrontmatter: false,
    });
  });

  it("uses metadata format hints when present", () => {
    expect(
      getRawCellFormatInfo({
        source: "title = 'Notebook'",
        metadata: { format: "text/x-toml" },
      }),
    ).toEqual({
      language: "toml",
      isFrontmatter: false,
    });
  });

  it("supports raw_mimetype metadata hints", () => {
    expect(
      getRawCellFormatInfo({
        source: "<div>hello</div>",
        metadata: { raw_mimetype: "text/html" },
      }),
    ).toEqual({
      language: "html",
      isFrontmatter: false,
    });
  });

  it("falls back to plain text when no format can be inferred", () => {
    expect(
      getRawCellFormatInfo({
        source: "untyped content",
        metadata: {},
      }),
    ).toEqual({
      language: "plain",
      isFrontmatter: false,
    });
  });
});
