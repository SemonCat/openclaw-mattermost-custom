import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { applyMarkdownTextEdits, type MarkdownTextEdit } from "openclaw/plugin-sdk/text-chunking";

function isLocalFileLink(url: string): boolean {
  return /^(?:file:|\/(?!\/)|[a-z]:[\\/])/iu.test(url);
}

export function stripMattermostLocalFileLinks(markdown: string): string {
  if (!/(?:\]\(\s*|<)(?:file:|\/(?!\/)|[a-z]:[\\/])/iu.test(markdown)) {
    return markdown;
  }
  const edits: MarkdownTextEdit[] = [];
  const pending: Nodes[] = [fromMarkdown(markdown)];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.type === "link") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const labelStart = node.children[0]?.position?.start.offset;
      const labelEnd = node.children.at(-1)?.position?.end.offset;
      if (
        isLocalFileLink(node.url) &&
        start !== undefined && end !== undefined &&
        labelStart !== undefined && labelEnd !== undefined
      ) {
        const label = markdown.slice(labelStart, labelEnd);
        if (markdown[start] === "<") {
          const width = label.match(/`+/gu)?.reduce((max, run) => Math.max(max, run.length + 1), 1);
          const fence = "`".repeat(width ?? 1);
          edits.push({ start, end, text: `${fence} ${label} ${fence}` });
        } else {
          edits.push({ start, end, text: label });
        }
      }
    } else if ("children" in node) {
      for (const child of node.children) pending.push(child);
    }
  }
  return edits.length ? applyMarkdownTextEdits(markdown, edits).text : markdown;
}
