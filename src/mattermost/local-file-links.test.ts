import { describe, expect, it } from "vitest";
import { stripMattermostLocalFileLinks } from "./local-file-links.js";

describe("Mattermost local file links", () => {
  it("keeps inline labels and their Markdown while dropping local destinations", () => {
    expect(stripMattermostLocalFileLinks([
      "- [**Build report**](</workspace/build output/results.json>)",
      "- [Log](file:///workspace/results.log) · [`report.txt`](/tmp/report.txt)",
      "- [Windows](<C:/Build Output/report.txt>)",
    ].join("\n"))).toBe([
      "- **Build report**",
      "- Log · `report.txt`",
      "- Windows",
    ].join("\n"));
  });

  it("renders a file autolink as a code literal", () => {
    expect(stripMattermostLocalFileLinks("<file:///tmp/report.json>")).toBe(
      "` file:///tmp/report.json `",
    );
  });

  it("preserves HTTPS, network and relative links, escaped brackets and code literals", () => {
    const markdown = [
      "[PR](https://example.com/owner/project/pull/1) [Network](//example.com/file.json)",
      "[Relative](reports/today.json) \\[escaped](/tmp/example)",
      "",
      "`[inline](/tmp/inline)` and `/workspace/build output/results.json`",
      "",
      "```markdown",
      "[fenced](</tmp/has space>)",
      "```",
      "",
      "    [indented](file:///tmp/indented)",
    ].join("\n");
    expect(stripMattermostLocalFileLinks(markdown)).toBe(markdown);
  });
});
