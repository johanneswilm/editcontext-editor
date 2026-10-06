/**
 * HTML -> document fragment parser (used for paste and setHTML).
 * Understands the subset the editor produces: paragraphs, headings 1-6,
 * bold/italic/underline/strikethrough/code, inline and block images,
 * hard breaks and tables. Unknown elements are unwrapped.
 */
import { sanitizeMarks, clampLevel, createLinkMark, getLinkMark } from "./schema.js";

/** Canonical mark order: simple marks sorted, link object last. */
function sortMarks(a, b) {
  const as = typeof a === "string" ? a : "￿";
  const bs = typeof b === "string" ? b : "￿";
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export { getLinkMark };

const MARK_ELEMENTS = {
  STRONG: "bold",
  B: "bold",
  EM: "italic",
  I: "italic",
  U: "underline",
  S: "strikethrough",
  STRIKE: "strikethrough",
  DEL: "strikethrough",
  CODE: "code",
};

const BLOCK_ELEMENTS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV",
  "BLOCKQUOTE", "PRE", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "FIGURE", "HR", "BR",
]);

/** Unknown elements that are phrasing-level: their content stays inline. */
const INLINE_ELEMENTS = new Set([
  "SPAN", "A", "FONT", "BDO", "BDI", "ABBR", "CITE", "Q", "SMALL", "BIG",
  "SUB", "SUP", "MARK", "TIME", "DATA", "KBD", "SAMP", "VAR", "OUTPUT",
  "RUBY", "RT", "RP", "WBR", "NOBR", "TT",
]);

/**
 * Parse an HTML string into an array of document nodes (blocks and/or
 * inlines) that can be inserted into a document.
 */
export function parseHTML(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return parseNodes(tpl.content, []);
}

/** Parse plain text (lines become paragraphs). */
export function parseText(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    out.push({
      type: "paragraph",
      children: line ? [{ type: "text", text: line, marks: [] }] : [],
    });
  }
  return out;
}

function parseNodes(parent, marks) {
  const out = [];
  for (const child of parent.childNodes) {
    const parsed = parseNode(child, marks);
    if (parsed) out.push(parsed);
  }
  return mergeAdjacent(out);
}

function parseNode(node, marks) {
  if (node.nodeType === 3) {
    const text = collapseWhitespace(node.nodeValue);
    if (!text) return null;
    return { type: "text", text, marks: [...marks] };
  }
  if (node.nodeType !== 1) return null; // comments, etc.

  const tag = node.tagName;

  if (tag === "BR") {
    return { type: "hard_break" };
  }

  if (tag === "A") {
    const href = node.getAttribute("href") ?? "";
    const nextMarks = [...marks.filter((m) => !(m && typeof m === "object" && m.type === "link")),
      createLinkMark({ href, title: node.getAttribute("title") ?? "" })].sort(sortMarks);
    return parseInlineList(node, nextMarks, false);
  }

  if (tag === "IMG") {
    return {
      type: "image",
      attrs: {
        src: node.getAttribute("src") ?? "",
        alt: node.getAttribute("alt") ?? "",
        width: numberOrNull(node.getAttribute("width")),
        height: numberOrNull(node.getAttribute("height")),
      },
    };
  }

  if (tag === "TABLE") {
    return parseTable(node);
  }

  if (tag === "FIGURE") {
    const img = node.tagName === "IMG" ? node : node.querySelector("img");
    if (!img) return null;
    return {
      type: "image",
      attrs: {
        src: img.getAttribute("src") ?? "",
        alt: img.getAttribute("alt") ?? "",
        width: numberOrNull(img.getAttribute("width")),
        height: numberOrNull(img.getAttribute("height")),
      },
    };
  }

  if (/^H[1-6]$/.test(tag)) {
    return {
      type: "heading",
      attrs: { level: clampLevel(Number(tag[1])) },
      children: parseInlineList(node, marks, true),
    };
  }

  if (tag === "P" || tag === "LI" || tag === "BLOCKQUOTE" || tag === "PRE") {
    return { type: "paragraph", children: parseInlineList(node, marks, true) };
  }

  if (tag === "HR") {
    return null;
  }

  const mark = MARK_ELEMENTS[tag];
  if (mark) {
    const nextMarks = [...new Set([...marks, mark])].sort();
    // A mark element at block level unwraps to its inline children.
    return parseInlineList(node, nextMarks, false);
  }

  if (INLINE_ELEMENTS.has(tag)) {
    // Phrasing-level unknown element (span, a, font…): content stays inline.
    // Real-world clipboard HTML expresses formatting via inline styles
    // ("<span style='font-weight: bold'>"), so map those to marks too.
    const nextMarks = [...new Set([...marks, ...marksFromStyle(node)])].sort();
    return parseInlineList(node, nextMarks, false);
  }

  // Unknown element: recurse — block children become blocks, inline content
  // becomes a paragraph.
  const hasBlockChildren = [...node.children].some((el) => BLOCK_ELEMENTS.has(el.tagName));
  if (hasBlockChildren) {
    return parseNodes(node, marks);
  }
  const inlines = parseInlineList(node, marks, true);
  if (inlines.length === 0) return null;
  return { type: "paragraph", children: inlines };
}

function parseInlineList(el, marks, trim = false) {
  const nodes = [];
  for (const child of el.childNodes) {
    const parsed = parseNode(child, marks);
    if (!parsed) continue;
    if (parsed.type === "text" || parsed.type === "image" || parsed.type === "hard_break") {
      nodes.push(parsed);
    } else if (parsed.type === "paragraph" || parsed.type === "heading") {
      nodes.push(...parsed.children);
    } else {
      nodes.push(parsed);
    }
  }
  const merged = mergeAdjacent(nodes);
  return trim ? trimTextEdges(merged) : merged.filter((n) => !(n.type === "text" && n.text === ""));
}

function parseTable(tableEl) {
  const rows = [];
  const rowEls = tableEl.querySelectorAll("tr");
  for (const tr of rowEls) {
    const cells = [];
    for (const td of tr.children) {
      if (td.tagName !== "TD" && td.tagName !== "TH") continue;
      const blocks = parseNodes(td, []).filter(
        (n) => n.type === "paragraph" || n.type === "heading"
      );
      cells.push({
        type: "table_cell",
        children: blocks.length ? blocks : [{ type: "paragraph", children: [] }],
      });
    }
    if (cells.length) rows.push({ type: "table_row", children: cells });
  }
  if (rows.length === 0) return null;
  return { type: "table", children: rows };
}

function collapseWhitespace(text) {
  return text.replace(/[\t\n\f\r ]+/g, " ");
}

/** Marks implied by an element's inline style (clipboard HTML uses these). */
function marksFromStyle(el) {
  const marks = [];
  const style = el.style;
  if (!style) return marks;
  const weight = style.fontWeight;
  if (weight === "bold" || weight === "bolder" || (Number(weight) >= 600 && weight !== "")) marks.push("bold");
  if (style.fontStyle === "italic" || style.fontStyle === "oblique") marks.push("italic");
  const decoration = `${style.textDecoration || ""} ${style.textDecorationLine || ""}`;
  if (decoration.includes("underline")) marks.push("underline");
  if (decoration.includes("line-through")) marks.push("strikethrough");
  return marks;
}

function trimTextEdges(nodes) {
  const out = [...nodes];
  const first = out[0];
  if (first?.type === "text") first.text = first.text.replace(/^ +/, "");
  const last = out[out.length - 1];
  if (last?.type === "text") last.text = last.text.replace(/ +$/, "");
  return out.filter((n) => !(n.type === "text" && n.text === ""));
}

/** Merge adjacent text nodes with identical marks. */
function mergeAdjacent(nodes) {
  const out = [];
  for (const node of nodes) {
    if (Array.isArray(node)) {
      out.push(...mergeAdjacent(node));
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && sameMarks(last.marks, node.marks)) {
      last.text += node.text;
    } else {
      out.push(node);
    }
  }
  return out;
}

function sameMarks(a, b) {
  const norm = (marks) =>
    JSON.stringify([...(marks ?? [])].sort((x, y) => {
      const xs = typeof x === "string" ? x : "￿" + JSON.stringify(x);
      const ys = typeof y === "string" ? y : "￿" + JSON.stringify(y);
      return xs < ys ? -1 : xs > ys ? 1 : 0;
    }));
  return norm(a) === norm(b);
}

function numberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export { sanitizeMarks };
