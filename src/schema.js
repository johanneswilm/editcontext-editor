/**
 * Schema for the editcontext-editor document model.
 *
 * The document is a JSON tree:
 *
 *   { type: "doc", children: [block…] }
 *
 * Blocks:    paragraph, heading (attrs.level 1-6), table, image
 * Inlines:   text (attrs: text, marks), image, hard_break
 * Tables:    table > table_row > table_cell > paragraph…
 *
 * An `image` node is a block when it sits in the document root and inline
 * when it sits inside a paragraph/heading/table cell.
 */

export const MARKS = ["bold", "italic", "underline", "strikethrough", "code"];

/**
 * Marks on a text node are simple mark strings plus at most one link object:
 *
 *   { type: "link", attrs: { href: string, title: string } }
 *
 * `title` maps to the <a> title attribute for accessibility.
 */
export function createLinkMark(attrs = {}) {
  return {
    type: "link",
    attrs: {
      href: String(attrs.href ?? ""),
      title: String(attrs.title ?? ""),
    },
  };
}

/** The link object in a marks array, or null. */
export function getLinkMark(marks) {
  return (marks ?? []).find((m) => m && typeof m === "object" && m.type === "link") ?? null;
}

/** Marks without any link object. */
export function withoutLink(marks) {
  return (marks ?? []).filter((m) => !(m && typeof m === "object" && m.type === "link"));
}

/** Block node types allowed at the document root. */
export const TOP_LEVEL_BLOCKS = ["paragraph", "heading", "table", "image"];

/** Node types whose children are inline nodes. */
export const INLINE_CONTAINERS = ["paragraph", "heading"];

export const NODE_TYPES = [
  "doc",
  "paragraph",
  "heading",
  "text",
  "image",
  "hard_break",
  "table",
  "table_row",
  "table_cell",
];

const NODE_DEFAULTS = {
  doc: () => ({ type: "doc", children: [] }),
  paragraph: () => ({ type: "paragraph", children: [] }),
  heading: (attrs = {}) => ({ type: "heading", attrs: { level: clampLevel(attrs.level) }, children: [] }),
  text: (attrs = {}) => ({ type: "text", text: String(attrs.text ?? ""), marks: sanitizeMarks(attrs.marks) }),
  image: (attrs = {}) => ({
    type: "image",
    attrs: {
      src: String(attrs.src ?? ""),
      alt: String(attrs.alt ?? ""),
      width: attrs.width != null ? Number(attrs.width) : null,
      height: attrs.height != null ? Number(attrs.height) : null,
    },
  }),
  hard_break: () => ({ type: "hard_break" }),
  table: () => ({ type: "table", children: [] }),
  table_row: () => ({ type: "table_row", children: [] }),
  table_cell: () => ({ type: "table_cell", children: [] }),
};

export function clampLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.round(n)));
}

export function sanitizeMarks(marks) {
  if (!Array.isArray(marks)) return [];
  const simple = [];
  let link = null;
  for (const m of marks) {
    if (typeof m === "string") {
      if (MARKS.includes(m) && !simple.includes(m)) simple.push(m);
    } else if (m && typeof m === "object" && m.type === "link") {
      const href = typeof m.attrs?.href === "string" ? m.attrs.href : String(m.attrs?.href ?? "");
      link = createLinkMark({ href, title: m.attrs?.title ?? "" });
    }
  }
  simple.sort();
  return link ? [...simple, link] : simple;
}

export function isInlineContainer(node) {
  return node && INLINE_CONTAINERS.includes(node.type);
}

export function isBlockContainer(node) {
  return node && (node.type === "doc" || node.type === "table_cell");
}

/** True when `node` is an image that should render as a block (direct child of doc). */
export function isBlockImage(node, parent) {
  return node && node.type === "image" && (!parent || parent.type === "doc");
}

function validChildrenFor(parentType) {
  switch (parentType) {
    case "doc":
      return TOP_LEVEL_BLOCKS;
    case "paragraph":
    case "heading":
      return ["text", "image", "hard_break"];
    case "table":
      return ["table_row"];
    case "table_row":
      return ["table_cell"];
    case "table_cell":
      return ["paragraph", "heading"];
    default:
      return [];
  }
}

/**
 * Deep-normalize an arbitrary value into a schema-conforming document.
 * Unknown nodes are unwrapped or dropped, text is coerced, marks filtered,
 * heading levels clamped. The result always has at least one paragraph.
 */
export function normalizeDocument(input) {
  const doc = normalizeNode(input, null) ?? NODE_DEFAULTS.doc();
  if (doc.type !== "doc") return NODE_DEFAULTS.doc();
  if (doc.children.length === 0) {
    doc.children.push(withChildren(NODE_DEFAULTS.paragraph(), []));
  }
  return doc;
}

function withChildren(node, children) {
  node.children = children;
  return node;
}

function normalizeNode(input, parentType) {
  if (typeof input === "string") {
    return parentType && INLINE_CONTAINERS.includes(parentType)
      ? NODE_DEFAULTS.text({ text: input })
      : null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const type = NODE_TYPES.includes(input.type) ? input.type : null;
  const attrs = input.attrs && typeof input.attrs === "object" ? input.attrs : {};

  if (type === "text") {
    return NODE_DEFAULTS.text({ text: input.text ?? "", marks: input.marks });
  }

  if (type === "image") {
    return NODE_DEFAULTS.image(attrs);
  }

  if (type === "hard_break") {
    return NODE_DEFAULTS.hard_break();
  }

  if (type === "heading") {
    return withChildren(NODE_DEFAULTS.heading(attrs), normalizeChildren(input, "heading"));
  }

  if (type === "paragraph" || type === "table_cell" || type === "table_row" || type === "table" || type === "doc") {
    const node = NODE_DEFAULTS[type]();
    if (type === "table") {
      node.children = normalizeChildren(input, "table");
    } else if (type === "table_row") {
      node.children = normalizeChildren(input, "table_row");
    } else if (type === "table_cell") {
      node.children = normalizeChildren(input, "table_cell");
    } else {
      node.children = normalizeChildren(input, type);
    }
    return node;
  }

  return null;
}

function normalizeChildren(input, parentType) {
  const allowed = validChildrenFor(parentType);
  const out = [];
  const raw = Array.isArray(input.children) ? input.children : [];
  for (const child of raw) {
    if (child && typeof child === "object" && !Array.isArray(child) && child.type && !NODE_TYPES.includes(child.type)) {
      // Unknown node type: salvage its content. Inline content inside a
      // block-level parent is wrapped into paragraphs.
      const salvaged = normalizeChildren({ children: child.children }, "paragraph");
      if (parentType === "doc" || parentType === "table_cell") {
        let inlineRun = [];
        const flush = () => {
          if (inlineRun.length) {
            out.push({ type: "paragraph", children: inlineRun });
            inlineRun = [];
          }
        };
        for (const n of salvaged) {
          if (n.type === "text" || n.type === "image" || n.type === "hard_break") {
            inlineRun.push(n);
          } else {
            flush();
            out.push(n);
          }
        }
        flush();
      } else {
        out.push(...salvaged.filter((c) => allowed.includes(c.type)));
      }
      continue;
    }
    const node = normalizeNode(child, parentType);
    if (!node) continue;
    if (!allowed.includes(node.type)) {
      if ((parentType === "doc" || parentType === "table_cell") && (node.type === "text" || node.type === "hard_break")) {
        // Stray inline content at block level: kept and wrapped into
        // paragraphs by wrapInlineRuns below.
        out.push(node);
      } else if (INLINE_CONTAINERS.includes(node.type)) {
        // A paragraph/heading where an inline was expected: lift its inlines.
        out.push(...node.children.filter((c) => allowed.includes(c.type)));
      } else if (node.children) {
        out.push(...node.children.filter((c) => allowed.includes(c.type)));
      }
      continue;
    }
    out.push(node);
  }

  if (parentType === "table") {
    return out.filter((c) => c.type === "table_row");
  }
  if (parentType === "table_row") {
    return out.filter((c) => c.type === "table_cell");
  }
  if (parentType === "table_cell") {
    const wrapped = wrapInlineRuns(out);
    const blocks = wrapped.filter((c) => c.type === "paragraph" || c.type === "heading");
    return blocks.length ? blocks : [NODE_DEFAULTS.paragraph()];
  }
  if (parentType === "doc") {
    return wrapInlineRuns(out);
  }
  return out;
}

/** Group consecutive inline nodes (text / hard_break) into paragraphs. */
function wrapInlineRuns(nodes) {
  const result = [];
  let run = [];
  const flush = () => {
    if (run.length) {
      result.push({ type: "paragraph", children: run });
      run = [];
    }
  };
  for (const node of nodes) {
    if (node.type === "text" || node.type === "hard_break") {
      run.push(node);
    } else {
      flush();
      result.push(node);
    }
  }
  flush();
  return result;
}

/**
 * Validate a document; returns an array of problem strings (empty = valid).
 * Does not mutate. Use normalizeDocument() to repair.
 */
export function validateDocument(doc) {
  const problems = [];
  if (!doc || doc.type !== "doc") return ["root must be a doc node"];
  walk(doc, null, (node, parent) => {
    if (parent) {
      const allowed = validChildrenFor(parent.type);
      if (!allowed.includes(node.type)) {
        problems.push(`<${node.type}> is not allowed inside <${parent.type}>`);
      }
    }
    if (node.type === "heading") {
      const lvl = node.attrs?.level;
      if (!(lvl >= 1 && lvl <= 6)) problems.push("heading level must be 1-6");
    }
    if (node.type === "text") {
      if (typeof node.text !== "string") problems.push("text node requires string `text`");
      if (node.marks && !Array.isArray(node.marks)) problems.push("text marks must be an array");
    }
    if (node.type === "image" && typeof node.attrs?.src !== "string") {
      problems.push("image requires string attrs.src");
    }
  });
  return problems;
}

/** Depth-first walk over every node, including the root. */
export function walk(node, parent, visit, path = []) {
  visit(node, parent, path);
  if (node.children) {
    node.children.forEach((child, i) => walk(child, node, visit, [...path, i]));
  }
}

/** Resolve a path (array of child indices) to a node. */
export function getNode(doc, path) {
  let node = doc;
  for (const index of path) {
    if (!node.children || !node.children[index]) return null;
    node = node.children[index];
  }
  return node;
}

/** Deep clone a document (plain JSON). */
export function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}
