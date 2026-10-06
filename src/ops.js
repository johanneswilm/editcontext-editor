/**
 * Document operations. Every operation mutates `doc` in place and expects
 * locations of the shape { path: number[], offset: number } where `offset`
 * counts inline steps inside the inline container at `path`
 * (a text node of length L contributes L steps, a leaf inline contributes 1).
 *
 * Callers obtain locations from a PositionMap (see render.js) and re-render
 * after each batch of operations.
 */
import {
  getNode,
  isInlineContainer,
  clampLevel,
  sanitizeMarks,
  createLinkMark,
  withoutLink,
} from "./schema.js";
import { inlineLength, comparePaths, samePath, findAncestor } from "./document.js";

function containerAt(doc, loc) {
  const node = getNode(doc, loc.path);
  if (!node || !isInlineContainer(node)) {
    throw new Error(`location path does not resolve to an inline container: ${JSON.stringify(loc.path)}`);
  }
  return node;
}

function spliceText(children, start, deleteCount, insert) {
  children.splice(start, deleteCount, ...insert);
}

/** Convert an inline-step offset to a child index + inner text offset. */
function childAtOffset(node, offset) {
  let remaining = offset;
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const len = child.type === "text" ? child.text.length : 1;
    if (remaining < len) return { index: i, inner: remaining, exact: false };
    if (remaining === len) return { index: i + 1, inner: 0, exact: true };
    remaining -= len;
  }
  return { index: children.length, inner: 0, exact: true };
}

/** Remove inline steps [from, to) inside a single container. */
function removeInlineRange(node, from, to) {
  const children = node.children;
  const start = childAtOffset(node, from);
  const end = childAtOffset(node, to);
  const removed = [];
  if (start.index === end.index && !start.exact && !end.exact) {
    // Mid-text deletion.
    const text = children[start.index];
    removed.push(text.text.slice(start.inner, end.inner));
    text.text = text.text.slice(0, start.inner) + text.text.slice(end.inner);
    if (text.text === "") children.splice(start.index, 1);
    return removed.join("");
  }
  let text = "";
  // Trim the first partial text node.
  if (!start.exact && start.index < children.length && children[start.index].type === "text") {
    const t = children[start.index];
    text += t.text.slice(start.inner);
    t.text = t.text.slice(0, start.inner);
  }
  // Remove whole children in between.
  const firstWhole = start.exact ? start.index : start.index + 1;
  for (let i = firstWhole; i < end.index; i++) {
    const c = children[i];
    text += c.type === "text" ? c.text : "";
  }
  children.splice(firstWhole, end.index - firstWhole);
  // Trim the last partial text node (index shifted by removals above).
  if (!end.exact && end.index < children.length && children[end.index]?.type === "text") {
    const t = children[end.index];
    text += t.text.slice(0, end.inner);
    t.text = t.text.slice(end.inner);
    if (t.text === "") children.splice(end.index, 1);
  }
  return text;
}

function normalizeContainer(node) {
  // Merge adjacent text nodes with identical marks; drop empty text nodes.
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c.type === "text" && c.text === "") {
      children.splice(i, 1);
      continue;
    }
    const next = children[i + 1];
    if (
      c.type === "text" &&
      next &&
      next.type === "text" &&
      JSON.stringify(c.marks) === JSON.stringify(next.marks)
    ) {
      next.text = c.text + next.text;
      children.splice(i, 1);
    }
  }
}

/** Insert plain text (single line, no "\n") at a location. */
export function insertText(doc, loc, text, marks = []) {
  if (text === "") return;
  const node = containerAt(doc, loc);
  const at = childAtOffset(node, loc.offset);
  const cleanMarks = sanitizeMarks(marks);
  const insertion = { type: "text", text, marks: cleanMarks };
  if (at.exact) {
    node.children.splice(at.index, 0, insertion);
  } else {
    const target = node.children[at.index];
    const after = { type: "text", text: target.text.slice(at.inner), marks: target.marks };
    target.text = target.text.slice(0, at.inner);
    node.children.splice(at.index + 1, 0, insertion, after);
  }
  normalizeContainer(node);
}

/** Insert an inline leaf node (image / hard_break) at a location. */
export function insertLeaf(doc, loc, leaf) {
  const node = containerAt(doc, loc);
  const at = childAtOffset(node, loc.offset);
  if (at.exact) {
    node.children.splice(at.index, 0, leaf);
  } else {
    // Mid-text: split the text node so the leaf lands exactly at the offset.
    const target = node.children[at.index];
    const after = { type: "text", text: target.text.slice(at.inner), marks: [...target.marks] };
    target.text = target.text.slice(0, at.inner);
    node.children.splice(at.index + 1, 0, leaf, after);
  }
}

/**
 * Delete the range between two locations (tree order: from <= to).
 * Handles ranges spanning multiple blocks: in-between blocks are removed and
 * the boundary blocks are merged. Returns the location where content joined.
 */
export function deleteRange(doc, from, to) {
  if (comparePaths(from.path, to.path) > 0 || (samePath(from.path, to.path) && from.offset > to.offset)) {
    [from, to] = [to, from];
  }

  if (samePath(from.path, to.path)) {
    const node = containerAt(doc, from);
    if (to.offset > from.offset) removeInlineRange(node, from.offset, to.offset);
    normalizeContainer(node);
    return { path: from.path, offset: from.offset };
  }

  const containers = inlineContainersWithPaths(doc);
  const iFrom = containers.findIndex((c) => samePath(c.path, from.path));
  const iTo = containers.findIndex((c) => samePath(c.path, to.path));

  if (iFrom === -1 || iTo === -1) throw new Error("deleteRange: location not found");

  const fromNode = containers[iFrom].node;
  const toNode = containers[iTo].node;

  if (from.offset < inlineLength(fromNode)) {
    removeInlineRange(fromNode, from.offset, inlineLength(fromNode));
    normalizeContainer(fromNode);
  }
  if (to.offset > 0) {
    removeInlineRange(toNode, 0, to.offset);
    normalizeContainer(toNode);
  }

  // Merge the "to" container into the "from" container, then remove every
  // container in between plus the emptied shell. Removals happen deepest /
  // latest-first so positional shifts cannot corrupt later removals.
  fromNode.children.push(...toNode.children);
  normalizeContainer(fromNode);
  const removalPaths = containers
    .slice(iFrom + 1, iTo + 1)
    .map((c) => c.path)
    .sort((a, b) => comparePaths(b, a));
  for (const path of removalPaths) {
    removeBlockAt(doc, path);
  }

  return { path: from.path, offset: from.offset };
}

function inlineContainersWithPaths(doc) {
  const out = [];
  const visit = (node, path) => {
    if (isInlineContainer(node)) {
      out.push({ node, path });
      return;
    }
    (node.children ?? []).forEach((child, i) => visit(child, [...path, i]));
  };
  visit(doc, []);
  return out;
}

/** Remove a top-level block or a cell paragraph given its path. */
function removeBlockAt(doc, path) {
  const parent = getNode(doc, path.slice(0, -1));
  if (parent && parent.children) parent.children.splice(path[path.length - 1], 1);
  // A table cell must keep at least one paragraph.
  if (parent?.type === "table_cell" && parent.children.length === 0) {
    parent.children.push({ type: "paragraph", children: [] });
  }
  // A document must keep at least one block.
  if (parent?.type === "doc" && parent.children.length === 0) {
    parent.children.push({ type: "paragraph", children: [] });
  }
}

/**
 * Toggle a mark across the range. When the range is collapsed (`from` == `to`)
 * the operation reports back the mark that *should* apply to future typing via
 * the returned `storedMarks` field.
 */
export function toggleMark(doc, from, to, mark) {
  if (samePath(from.path, to.path) && from.offset === to.offset) {
    return { changed: false, collapsed: true };
  }

  const range = orderedLocs(from, to);
  const containers = inlineContainersWithPaths(doc);
  let allHaveMark = true;
  let anyText = false;

  for (const { node, path } of containers) {
    const cmpFrom = comparePaths(path, range.from.path);
    const cmpTo = comparePaths(path, range.to.path);
    if (cmpFrom < 0 || cmpTo > 0) continue;
    const start = cmpFrom === 0 ? range.from.offset : 0;
    const end = cmpTo === 0 ? range.to.offset : inlineLength(node);
    if (start >= end) continue;
    const { first, last } = textRangeBounds(node, start, end);
    for (let i = first; i <= last; i++) {
      const child = node.children[i];
      if (child.type !== "text" || child.text.length === 0) continue;
      anyText = true;
      if (!child.marks.includes(mark)) allHaveMark = false;
    }
  }
  const add = !(allHaveMark && anyText);

  for (const { node, path } of containers) {
    const cmpFrom = comparePaths(path, range.from.path);
    const cmpTo = comparePaths(path, range.to.path);
    if (cmpFrom < 0 || cmpTo > 0) continue;
    const start = cmpFrom === 0 ? range.from.offset : 0;
    const end = cmpTo === 0 ? range.to.offset : inlineLength(node);
    if (start >= end) continue;
    splitAtBoundaries(node, start, end);
    const { first, last } = textRangeBounds(node, start, end);
    for (let i = first; i <= last; i++) {
      const child = node.children[i];
      if (child.type !== "text") continue;
      child.marks = add
        ? sanitizeMarks([...child.marks, mark])
        : child.marks.filter((m) => m !== mark);
    }
    normalizeContainer(node);
  }
  return { changed: true, collapsed: false, markAdded: add };
}

/**
 * Set (or replace) the link mark across the range. `attrs.href` is required;
 * `attrs.title` maps to the <a> title attribute for accessibility.
 */
export function setLink(doc, from, to, attrs = {}) {
  const range = orderedLocs(from, to);
  const link = createLinkMark(attrs);
  forEachTextInRange(doc, range, (node) => {
    node.marks = sanitizeMarks([...withoutLink(node.marks), link]);
  });
  return true;
}

/** Remove link marks across the range. */
export function unsetLink(doc, from, to) {
  const range = orderedLocs(from, to);
  let changed = false;
  forEachTextInRange(doc, range, (node) => {
    const next = withoutLink(node.marks);
    if (next.length !== node.marks.length) {
      node.marks = next;
      changed = true;
    }
  });
  return changed;
}

/** Split boundary text nodes and call `visit` on every text node in the range. */
function forEachTextInRange(doc, range, visit) {
  for (const { node, path } of inlineContainersWithPaths(doc)) {
    const cmpFrom = comparePaths(path, range.from.path);
    const cmpTo = comparePaths(path, range.to.path);
    if (cmpFrom < 0 || cmpTo > 0) continue;
    const start = cmpFrom === 0 ? range.from.offset : 0;
    const end = cmpTo === 0 ? range.to.offset : inlineLength(node);
    if (start >= end) continue;
    splitAtBoundaries(node, start, end);
    const { first, last } = textRangeBounds(node, start, end);
    for (let i = first; i <= last; i++) {
      const child = node.children[i];
      if (child.type === "text") visit(child);
    }
    normalizeContainer(node);
  }
}

function orderedLocs(from, to) {
  const cmp = comparePaths(from.path, to.path);
  if (cmp < 0 || (cmp === 0 && from.offset <= to.offset)) return { from, to };
  return { from: to, to: from };
}

/** Split text nodes so that inline-step offsets `start` and `end` fall on child boundaries. */
function splitAtBoundaries(node, start, end) {
  for (const offset of [end, start]) {
    const at = childAtOffset(node, offset);
    if (!at.exact && node.children[at.index]?.type === "text") {
      const target = node.children[at.index];
      const after = { type: "text", text: target.text.slice(at.inner), marks: [...target.marks] };
      target.text = target.text.slice(0, at.inner);
      node.children.splice(at.index + 1, 0, after);
    }
  }
}

function textRangeBounds(node, start, end) {
  splitAtBoundaries(node, start, end);
  const first = childAtOffset(node, start).index;
  const last = childAtOffset(node, end).index - 1;
  return { first, last: Math.max(first, last) };
}

/** Set the block type (paragraph / heading level) for every block the range touches. */
export function setBlockType(doc, from, to, type, attrs = {}) {
  const containers = inlineContainersWithPaths(doc);
  const range = orderedLocs(from, to);
  let changed = false;
  for (const { node, path } of containers) {
    const cmpFrom = comparePaths(path, range.from.path);
    const cmpTo = comparePaths(path, range.to.path);
    if (cmpFrom < 0 || cmpTo > 0) continue;
    if (node.type === type && (type !== "heading" || node.attrs?.level === clampLevel(attrs.level))) continue;
    const next = { type, children: node.children };
    if (type === "heading") next.attrs = { level: clampLevel(attrs.level) };
    const parent = getNode(doc, path.slice(0, -1));
    parent.children[path[path.length - 1]] = next;
    changed = true;
  }
  return changed;
}

/**
 * Split the block at `loc`. Headings convert to paragraphs on split (like
 * Enter); pass `keepType: true` to preserve the block type (used when
 * splitting for paste). Returns the path of the new block.
 */
export function splitBlock(doc, loc, { keepType = false } = {}) {
  const node = containerAt(doc, loc);
  const at = childAtOffset(node, loc.offset);
  const parent = getNode(doc, loc.path.slice(0, -1));
  const index = loc.path[loc.path.length - 1];

  let rightChildren;
  if (at.exact) {
    rightChildren = node.children.splice(at.index);
  } else {
    const target = node.children[at.index];
    const after = { type: "text", text: target.text.slice(at.inner), marks: [...target.marks] };
    target.text = target.text.slice(0, at.inner);
    rightChildren = [after, ...node.children.splice(at.index + 1)];
  }

  const newType = keepType ? node.type : node.type === "heading" ? "paragraph" : node.type;
  const newBlock = { type: newType, children: rightChildren };
  if (newType === "heading") newBlock.attrs = { ...(node.attrs ?? {}) };
  parent.children.splice(index + 1, 0, newBlock);
  normalizeContainer(node);
  return { newPath: [...loc.path.slice(0, -1), index + 1] };
}

/** Insert a hard break (rendered <br>) at a location. */
export function insertHardBreak(doc, loc) {
  insertLeaf(doc, loc, { type: "hard_break" });
}

/** Insert an inline image at a location. */
export function insertImageInline(doc, loc, attrs) {
  insertLeaf(doc, loc, {
    type: "image",
    attrs: {
      src: String(attrs.src ?? ""),
      alt: String(attrs.alt ?? ""),
      width: attrs.width ?? null,
      height: attrs.height ?? null,
    },
  });
}

/**
 * Insert a block-level fragment at a location:
 * inline nodes extend the current block, block nodes are inserted after it.
 * Returns the path of the block holding the end of the insertion.
 */
export function insertFragment(doc, loc, fragment) {
  const inlines = [];
  const blocks = [];
  for (const node of fragment) {
    if (node.type === "text" || node.type === "image" || node.type === "hard_break") {
      inlines.push(node);
    } else if (node.type === "paragraph" || node.type === "heading") {
      if (inlines.length === 0 && blocks.length === 0) blocks.push(node);
      else blocks.push(node);
    } else {
      blocks.push(node);
    }
  }

  let cursor = { path: loc.path, offset: loc.offset };
  if (inlines.length) {
    for (const node of inlines) {
      if (node.type === "text") insertText(doc, cursor, node.text, node.marks);
      else insertLeaf(doc, cursor, node);
      cursor = { path: cursor.path, offset: cursor.offset + (node.type === "text" ? node.text.length : 1) };
    }
  }

  let lastPath = loc.path;
  if (blocks.length) {
    const node = containerAt(doc, loc);
    const parent = getNode(doc, loc.path.slice(0, -1));
    const index = loc.path[loc.path.length - 1];
    // An untouched empty block is replaced by the pasted blocks.
    if (inlineLength(node) === 0 && inlines.length === 0) {
      parent.children.splice(index, 1, ...blocks);
      lastPath = [...loc.path.slice(0, -1), index + blocks.length - 1];
    } else {
      parent.children.splice(index + 1, 0, ...blocks);
      lastPath = [...loc.path.slice(0, -1), index + blocks.length];
    }
  }
  return { endPath: lastPath };
}

/** Insert a block image after the block containing `loc`. Returns the image path. */
export function insertImageBlock(doc, loc, attrs) {
  const parent = getNode(doc, loc.path.slice(0, -1));
  const index = loc.path[loc.path.length - 1];
  const image = {
    type: "image",
    attrs: {
      src: String(attrs.src ?? ""),
      alt: String(attrs.alt ?? ""),
      width: attrs.width ?? null,
      height: attrs.height ?? null,
    },
  };
  parent.children.splice(index + 1, 0, image);
  return { path: [...loc.path.slice(0, -1), index + 1] };
}

/** Create an empty table node with the given size. */
export function createTable(rows, cols) {
  const table = { type: "table", children: [] };
  for (let r = 0; r < rows; r++) {
    const row = { type: "table_row", children: [] };
    for (let c = 0; c < cols; c++) {
      row.children.push({ type: "table_cell", children: [{ type: "paragraph", children: [] }] });
    }
    table.children.push(row);
  }
  return table;
}

/** Insert a table after the block containing `loc`; returns the first cell's paragraph path. */
export function insertTable(doc, loc, rows, cols) {
  const table = createTable(rows, cols);
  const parent = getNode(doc, loc.path.slice(0, -1));
  const index = loc.path[loc.path.length - 1];
  const at = inlineLength(containerAt(doc, loc)) === 0 ? index : index + 1;
  if (at === index) {
    // Keep an empty paragraph after the table so the doc never ends on a table.
    parent.children.splice(at, 0, table, { type: "paragraph", children: [] });
  } else {
    parent.children.splice(at, 0, table);
  }
  const tablePath = [...loc.path.slice(0, -1), at];
  return { tablePath, firstCellPath: [...tablePath, 0, 0, 0] };
}

/** Locate the enclosing table and cell for a location. */
export function tableContext(doc, loc) {
  const cell = findAncestor(doc, loc.path, (n) => n.type === "table_cell");
  if (!cell) return null;
  const table = findAncestor(doc, loc.path, (n) => n.type === "table");
  const row = findAncestor(doc, loc.path, (n) => n.type === "table_row");
  return {
    table,
    row: { path: row.path, index: row.path[row.path.length - 1] },
    cell: { path: cell.path, index: cell.path[cell.path.length - 1] },
  };
}

export function tableInsertRow(doc, loc, { after = true } = {}) {
  const ctx = tableContext(doc, loc);
  if (!ctx) return null;
  const cols = ctx.table.node.children[0]?.children.length ?? 1;
  const row = { type: "table_row", children: [] };
  for (let c = 0; c < cols; c++) {
    row.children.push({ type: "table_cell", children: [{ type: "paragraph", children: [] }] });
  }
  const at = ctx.row.index + (after ? 1 : 0);
  ctx.table.node.children.splice(at, 0, row);
  return { rowIndex: at };
}

export function tableDeleteRow(doc, loc) {
  const ctx = tableContext(doc, loc);
  if (!ctx) return false;
  if (ctx.table.node.children.length <= 1) return deleteTable(doc, loc);
  ctx.table.node.children.splice(ctx.row.index, 1);
  return true;
}

export function tableInsertColumn(doc, loc, { after = true } = {}) {
  const ctx = tableContext(doc, loc);
  if (!ctx) return null;
  const at = ctx.cell.index + (after ? 1 : 0);
  for (const row of ctx.table.node.children) {
    row.children.splice(at, 0, { type: "table_cell", children: [{ type: "paragraph", children: [] }] });
  }
  return { colIndex: at };
}

export function tableDeleteColumn(doc, loc) {
  const ctx = tableContext(doc, loc);
  if (!ctx) return false;
  const cols = ctx.table.node.children[0]?.children.length ?? 1;
  if (cols <= 1) return deleteTable(doc, loc);
  for (const row of ctx.table.node.children) {
    row.children.splice(ctx.cell.index, 1);
  }
  return true;
}

function deleteTable(doc, loc) {
  const ctx = tableContext(doc, loc);
  if (!ctx) return false;
  const parent = getNode(doc, ctx.table.path.slice(0, -1));
  parent.children.splice(ctx.table.path[ctx.table.path.length - 1], 1);
  if (parent.type === "doc" && parent.children.length === 0) {
    parent.children.push({ type: "paragraph", children: [] });
  }
  return true;
}

/**
 * Delete a range that may span non-text blocks (tables, block images).
 * `blockLeafPaths` are the top-level paths of such blocks whose object char
 * falls inside the deleted flat range. They are removed first, then the
 * remaining text range is deleted (merging boundary containers).
 */
export function deleteSpanning(doc, from, to, blockLeafPaths = []) {
  const ordered = [...blockLeafPaths].sort((a, b) => comparePaths(b, a));
  for (const p of ordered) {
    const parent = getNode(doc, p.slice(0, -1));
    if (parent?.children) parent.children.splice(p[p.length - 1], 1);
  }
  if (ordered.length && !samePath(from.path, to.path)) {
    let shift = 0;
    for (const p of ordered) {
      if (p[0] < to.path[0]) shift++;
    }
    to = { path: [to.path[0] - shift, ...to.path.slice(1)], offset: to.offset };
  }
  return deleteRange(doc, from, to);
}

/** Remove a top-level block (table / block image) by path. */
export function removeBlock(doc, path) {
  removeBlockAt(doc, path);
}

/**
 * Insert text that may contain newlines at a location: the first line extends
 * the current block, each further line splits off a new block. Returns the
 * end location.
 */
export function insertMultiline(doc, loc, text, marks = []) {
  const lines = String(text).split("\n");
  let cursor = loc;
  if (lines[0]) insertText(doc, cursor, lines[0], marks);
  cursor = { path: cursor.path, offset: cursor.offset + lines[0].length };
  for (let i = 1; i < lines.length; i++) {
    const { newPath } = splitBlock(doc, cursor);
    cursor = { path: newPath, offset: 0 };
    if (lines[i]) insertText(doc, cursor, lines[i], marks);
    cursor = { path: newPath, offset: lines[i].length };
  }
  return cursor;
}

/** The marks present at every character of the range (for toolbar state). Read-only. */
export function marksAcrossRange(doc, from, to) {
  const range = orderedLocs(from, to);
  const result = new Set();
  let first = true;
  for (const { node, path } of inlineContainersWithPaths(doc)) {
    const cmpFrom = comparePaths(path, range.from.path);
    const cmpTo = comparePaths(path, range.to.path);
    if (cmpFrom < 0 || cmpTo > 0) continue;
    const start = cmpFrom === 0 ? range.from.offset : 0;
    const end = cmpTo === 0 ? range.to.offset : inlineLength(node);
    if (start >= end) continue;
    let offset = 0;
    for (const child of node.children) {
      const len = child.type === "text" ? child.text.length : 1;
      const s = Math.max(start, offset);
      const e = Math.min(end, offset + len);
      if (s < e && child.type === "text") {
        const simple = child.marks.filter((m) => typeof m === "string");
        if (first) {
          simple.forEach((m) => result.add(m));
          first = false;
        } else {
          for (const m of [...result]) {
            if (!simple.includes(m)) result.delete(m);
          }
        }
      }
      offset += len;
    }
  }
  return result;
}
