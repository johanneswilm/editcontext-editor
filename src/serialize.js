/**
 * Document -> HTML serializer (used for getHTML / export).
 */
import { MARKS } from "./schema.js";

const MARK_TAGS = {
  bold: ["<strong>", "</strong>"],
  italic: ["<em>", "</em>"],
  underline: ["<u>", "</u>"],
  strikethrough: ["<s>", "</s>"],
  code: ["<code>", "</code>"],
};

export function serializeHTML(doc) {
  return (doc.children ?? []).map(serializeBlock).join("");
}

function serializeBlock(block) {
  switch (block.type) {
    case "paragraph":
      return `<p>${serializeInlines(block.children ?? [])}</p>`;
    case "heading":
      return `<h${block.attrs?.level ?? 1}>${serializeInlines(block.children ?? [])}</h${block.attrs?.level ?? 1}>`;
    case "image":
      return `<figure>${serializeImage(block.attrs)}</figure>`;
    case "table":
      return serializeTable(block);
    default:
      return "";
  }
}

function serializeTable(table) {
  const rows = (table.children ?? [])
    .map((row) => {
      const cells = (row.children ?? [])
        .map((cell) => `<td>${(cell.children ?? []).map(serializeBlock).join("")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table><tbody>${rows}</tbody></table>`;
}

function serializeInlines(children) {
  return (children ?? []).map(serializeInline).join("");
}

function serializeInline(node) {
  if (node.type === "text") {
    let html = escapeHTML(node.text).replace(/\n/g, "<br>");
    for (const mark of MARKS) {
      if (node.marks?.includes(mark)) {
        const [open, close] = MARK_TAGS[mark];
        html = open + html + close;
      }
    }
    const link = (node.marks ?? []).find((m) => m && typeof m === "object" && m.type === "link");
    if (link) {
      const title = link.attrs?.title ? ` title="${escapeAttribute(link.attrs.title)}"` : "";
      html = `<a href="${escapeAttribute(link.attrs?.href ?? "")}"${title}>${html}</a>`;
    }
    return html;
  }
  if (node.type === "image") {
    return serializeImage(node.attrs);
  }
  if (node.type === "hard_break") {
    return "<br>";
  }
  return "";
}

function serializeImage(attrs = {}) {
  const parts = [`src="${escapeAttribute(attrs.src ?? "")}"`];
  if (attrs.alt) parts.push(`alt="${escapeAttribute(attrs.alt)}"`);
  if (attrs.width) parts.push(`width="${Number(attrs.width)}"`);
  if (attrs.height) parts.push(`height="${Number(attrs.height)}"`);
  return `<img ${parts.join(" ")}>`;
}

function escapeHTML(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
  return escapeHTML(text).replace(/"/g, "&quot;");
}
