import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { copyText } from "../lib/clipboard";

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function inlineMarkdown(value: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^) \n]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) parts.push(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] ? safeLink(link[2]) : undefined;
      parts.push(
        href ? (
          <a key={index} href={href} target="_blank" rel="noreferrer">
            {link?.[1]}
          </a>
        ) : (
          token
        ),
      );
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

const COPY_LABELS = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
} as const;

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [status, setStatus] = useState<keyof typeof COPY_LABELS>("idle");
  return (
    <div className="markdown-code">
      <div>
        <span>{language || "code"}</span>
        <button
          type="button"
          onClick={() => {
            void copyText(code).then((copiedToClipboard) => {
              setStatus(copiedToClipboard ? "copied" : "failed");
              window.setTimeout(() => setStatus("idle"), 1_500);
            });
          }}
          aria-label="Copy code"
        >
          {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
          <span aria-live="polite">{COPY_LABELS[status]}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function MarkdownMessage({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      blocks.push(
        <CodeBlock
          key={`code-${index}`}
          code={code.join("\n")}
          {...(fence[1] ? { language: fence[1] } : {})}
        />,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 1, 4);
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(
        <Heading key={`heading-${index}`}>
          {inlineMarkdown(heading[2] ?? "")}
        </Heading>,
      );
      index += 1;
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")
    ) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inlineMarkdown(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      {inlineMarkdown(row[cellIndex] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listMatch) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(
          ordered
            ? /^\s*\d+[.)]\s+(.+)$/
            : /^\s*[-*+]\s+(.+)$/,
        );
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inlineMarkdown(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {inlineMarkdown(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^```|^#{1,6}\s|^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(
        lines[index] ?? "",
      )
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex > 0 ? " " : null}
            {inlineMarkdown(part)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="markdown-message">{blocks}</div>;
}
