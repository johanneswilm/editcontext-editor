/**
 * Renderer: turns the document model into DOM and maintains the "flat text" —
 * the plain-text view that is mirrored into the EditContext so the browser's
 * text input services (keyboard, IME, emoji picker, dictation…) can operate
 * on the document.
 *
 * Flat text layout:
 *   - inline text contributes its characters
 *   - inline leaves (inline image, hard break) contribute "\uFFFC"
 *   - tables and block images contribute "\uFFFC" (a "block leaf")
 *   - between consecutive top-level blocks there is one "\n" ("gap")
 *   - between paragraphs of different table cells there is one "\n"
 *
 * Gap deletion semantics (see editor.js):
 *   - "merge"     both sides are sibling text blocks  -> merge the blocks
 *   - "noop"      sides are in different table cells  -> nothing happens
 *   - "deleteblk" one side is a table / block image   -> delete that block
 *
 * The PositionMap translates between model locations { path, offset },
 * flat offsets and DOM points, and provides per-character rects for IME.
 */
import { MARKS, isInlineContainer } from "./schema.js";

const OBJECT_CHAR = "\uFFFC";

const MARK_TAGS = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strikethrough: "s",
  code: "code",
};

export class PositionMap {
  constructor() {
    this.flatText = "";
    /** Sorted, non-overlapping segments covering [start, end). */
    this.segments = [];
    /** Canonical DOM points: { flat, node, offset } sorted by flat. */
    this.points = [];
    this._textSegByNode = new Map();
    this._pointIndex = new Map(); // node -> Map(offset -> flat)
    this._blockEnds = new Map(); // element -> flat offset of its content end
  }

  addSegment(seg) {
    this.segments.push(seg);
  }

  addPoint(flat, node, offset) {
    let byOffset = this._pointIndex.get(node);
    if (!byOffset) {
      byOffset = new Map();
      this._pointIndex.set(node, byOffset);
    }
    if (byOffset.has(offset)) return;
    byOffset.set(offset, flat);
    this.points.push({ flat, node, offset });
  }

  finish() {
    this.points.sort((a, b) => a.flat - b.flat);
    this.segments.sort((a, b) => a.start - b.start);
  }

  segAt(o) {
    return this.segments.find((s) => s.start <= o && o < s.end) ?? null;
  }

  /**
   * Escape target for arrowing left out of a table: the flat offset of the
   * gap before the table's first content, where the caret lands at the end
   * of the block preceding the table. Null when there is no such gap.
   */
  escapeFlatBefore(blockleafSeg) {
    const first = this.segments.find(
      (s) =>
        (s.kind === "text" || s.kind === "leaf") &&
        s.path &&
        s.path.length > 1 &&
        s.path[0] === blockleafSeg.path[0]
    );
    if (!first) return null;
    let gap = this.segments.find((s) => s.kind === "gap" && s.end === first.start);
    if (!gap) return null;
    // Walk back across a run of consecutive gaps (the table's own noop gaps
    // precede its content) so the caret lands on the block before the table.
    for (;;) {
      const prev = this.segments.find((s) => s.kind === "gap" && s.end === gap.start);
      if (!prev) return gap.start;
      gap = prev;
    }
  }

  /** Model location -> flat offset (best effort; null when unmapped). */
  locToFlat(path, offset = 0) {
    const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
    for (const s of this.segments) {
      if ((s.kind === "text" || s.kind === "leaf") && eq(s.path, path)) {
        const flat = s.start + (offset - s.inlineOffset);
        if (flat >= s.start && flat <= s.end) return flat;
      }
    }
    for (const s of this.segments) {
      if (s.kind !== "gap") continue;
      if (s.action === "merge" && eq(s.prevPath, path)) return s.start;
      if (eq(s.nextPath, path)) return s.end;
    }
    return null;
  }

  /**
   * Flat offset -> model location { path, offset }.
   * loc(o) is the position after char o-1 / before char o, where gap and
   * object chars are real characters. Offsets adjacent to tables/block images
   * resolve to the nearest text container.
   */
  flatToLoc(o) {
    const seg = this.segAt(o);
    if (!seg) return this._locAtEnd(o);
    switch (seg.kind) {
      case "text":
      case "leaf":
        return { path: seg.path, offset: seg.inlineOffset + (o - seg.start) };
      case "gap":
        // Insertion at a gap position attaches to the END of the previous
        // container (the gap char itself is only deleted via Backspace).
        // "noop" gaps (between table cells) included: typing at the end of a
        // cell must stay in that cell.
        if (seg.prevPath && seg.prevInlineEnd != null) {
          return { path: seg.prevPath, offset: seg.prevInlineEnd };
        }
        return { path: seg.nextPath, offset: 0 };
      case "blockleaf":
        return this._nearbyContainerLoc(seg, o === seg.start ? "backward" : "forward");
      default:
        return { path: [0], offset: 0 };
    }
  }

  _locAtEnd(o) {
    if (this.segments.length === 0) return { path: [0], offset: 0 };
    if (o <= 0) {
      const first = this.segments[0];
      if (first.kind === "blockleaf") return this._nearbyContainerLoc(first, "forward");
      if (first.kind === "gap") return { path: first.nextPath, offset: 0 };
      return { path: first.path, offset: first.inlineOffset };
    }
    const last = this.segments[this.segments.length - 1];
    if (last.end === o) {
      switch (last.kind) {
        case "text":
        case "leaf":
          return { path: last.path, offset: last.inlineOffset + (last.end - last.start) };
        case "gap":
          if (last.prevPath && last.prevInlineEnd != null) {
            return { path: last.prevPath, offset: last.prevInlineEnd };
          }
          return { path: last.nextPath, offset: 0 };
        case "blockleaf":
          return this._nearbyContainerLoc(last, "forward");
      }
    }
    return { path: [0], offset: 0 };
  }

  _nearbyContainerLoc(seg, dir) {
    const idx = this.segments.indexOf(seg);
    const step = dir === "forward" ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < this.segments.length; i += step) {
      const s = this.segments[i];
      if (s.kind === "text" || s.kind === "leaf") {
        return dir === "forward"
          ? { path: s.path, offset: s.inlineOffset }
          : { path: s.path, offset: s.inlineOffset + (s.end - s.start) };
      }
      if (s.kind === "gap") {
        if (s.action === "noop") {
          if (dir === "forward") return { path: s.nextPath, offset: 0 };
          continue; // walk further back to the previous cell's text
        }
        if (s.prevPath && s.prevInlineEnd != null) {
          return { path: s.prevPath, offset: s.prevInlineEnd };
        }
        // deleteblk next to a block leaf: keep walking
      }
      // blockleaf: keep walking
    }
    return { path: [0], offset: 0 };
  }

  /** Flat offset -> DOM point { node, offset } (best effort). */
  flatToDomPoint(o) {
    for (const p of this.points) {
      if (p.flat === o) return { node: p.node, offset: p.offset };
    }
    const seg = this.segments.find((s) => s.kind === "text" && s.start <= o && o <= s.end);
    if (seg) return { node: seg.dom, offset: o - seg.start };
    // First point at or after o (covers gaps and block leaves).
    for (const p of this.points) {
      if (p.flat >= o) return { node: p.node, offset: p.offset };
    }
    const last = this.points[this.points.length - 1];
    return last ? { node: last.node, offset: last.offset } : null;
  }

  /** DOM point -> flat offset, or null when the point is outside the render. */
  domPointToFlat(node, offset) {
    if (node.nodeType === 3) {
      const seg = this._textSegByNode.get(node);
      if (seg) return seg.start + Math.min(offset, seg.end - seg.start);
      return null;
    }
    const direct = this._pointIndex.get(node)?.get(offset);
    if (direct != null) return direct;
    if (node.children && offset < node.children.length) {
      const inner = this.domPointToFlat(node.children[offset], 0);
      if (inner != null) return inner;
      return null;
    }
    const end = this._blockEnds.get(node);
    if (end != null) return end;
    const kids2 = node.children ?? [];
    if (kids2.length > 0 && offset >= kids2.length) {
      // "Past the end" of an intermediate container (e.g. a table cell <td>):
      // map to the end of its last content instead of walking past an
      // enclosing block object.
      const last = kids2[kids2.length - 1];
      const inner = this.domPointToFlat(last, last.nodeType === 3 ? last.nodeValue.length : last.childNodes.length);
      if (inner != null) return inner;
    }
    const parent = node.parentNode;
    if (parent) {
      const idx = Array.prototype.indexOf.call(parent.children, node);
      if (idx !== -1) return this.domPointToFlat(parent, idx + 1);
    }
    return null;
  }

  /** DOM rect for the character starting at flat offset `o` (IME support). */
  rectForOffset(o) {
    const seg = this.segAt(o);
    if (seg?.kind === "blockleaf" && seg.dom) {
      return seg.dom.getBoundingClientRect();
    }
    const point = this.flatToDomPoint(o);
    return this.rectForPoint(point);
  }

  /** DOM rect for a DOM point (text offset or element boundary). */
  rectForPoint(point) {
    if (!point || !point.node.ownerDocument) return null;
    const doc = point.node.ownerDocument;
    const range = doc.createRange();
    try {
      if (point.node.nodeType === 3) {
        const len = point.node.nodeValue.length;
        if (len > 0 && point.offset < len) {
          range.setStart(point.node, point.offset);
          range.setEnd(point.node, point.offset + 1);
        } else if (len > 0) {
          range.setStart(point.node, point.offset - 1);
          range.setEnd(point.node, point.offset);
          const r = range.getBoundingClientRect();
          return new DOMRect(r.right, r.top, 0, r.height);
        } else {
          range.setStart(point.node, 0);
          range.collapse(true);
        }
      } else {
        // Element boundary (paragraph start, inline-leaf edge): a range
        // collapsed here spans the whole container box, so measure the
        // nearest real character instead — the first following one
        // (left-edge caret), else the last preceding one (right edge).
        const charRect = charBoundaryRect(doc, point.node, point.offset);
        if (charRect) return charRect;
        range.setStart(point.node, Math.min(point.offset, point.node.childNodes.length));
        range.collapse(true);
      }
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) return rect;
      const el = point.node.nodeType === 1 ? point.node : point.node.parentElement;
      if (el) {
        const r = el.getBoundingClientRect();
        return new DOMRect(r.left, r.top, 0, r.height);
      }
      return rect;
    } catch {
      return null;
    }
  }

  /**
   * Rect for a collapsed caret at flat offset `o`. Next to a block object
   * the caret is one line tall at the block's top-left — not as tall as
   * the block itself.
   */
  caretRectAt(o) {
    const seg = this.segAt(o);
    if (seg?.kind === "blockleaf" && seg.dom) {
      // Table: the last cell's content abuts the object char in the flat text
      // (no gap in between), so a caret at the object char's start is really
      // "end of the last cell" — draw it after that content, not at the
      // table's top-left corner. Block images are preceded by a gap segment,
      // so they keep the beside-the-block caret below.
      const i = this.segments.indexOf(seg);
      const prev = this.segments[i - 1];
      if (prev && prev.end === o && (prev.kind === "text" || prev.kind === "leaf")) {
        const r = this.rectForPoint(this.flatToDomPoint(o));
        if (r) return r;
      }
      const r = seg.dom.getBoundingClientRect();
      const parent = seg.dom.parentElement;
      if (parent) {
        const idx = Array.prototype.indexOf.call(parent.childNodes, seg.dom);
        const line = charBoundaryRect(seg.dom.ownerDocument, parent, idx);
        if (line && line.height > 0 && line.height < r.height) {
          return new DOMRect(r.left, r.top, 0, line.height);
        }
      }
      return new DOMRect(r.left, r.top, 0, r.height);
    }
    return this.rectForOffset(o);
  }
}

/** First (or last) non-empty text node inside `node`, descending recursively. */
function deepText(node, forward) {
  if (node.nodeType === 3) return node.nodeValue.length > 0 ? node : null;
  const kids = node.childNodes;
  if (forward) {
    for (let i = 0; i < kids.length; i++) {
      const found = deepText(kids[i], true);
      if (found) return found;
    }
  } else {
    for (let i = kids.length - 1; i >= 0; i--) {
      const found = deepText(kids[i], false);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Caret rect at an element-boundary DOM point: the left edge of the first
 * character at/after child offset `offset`, or — when no text follows — the
 * right edge of the last character before it. When an inline leaf (image,
 * hard break) sits right at the boundary, the caret hugs its near edge.
 * Returns null when there is no text to measure (empty paragraphs fall back
 * to a collapsed range, which correctly reports the single line box).
 */
function charBoundaryRect(doc, el, offset) {
  const kids = el.childNodes;
  const from = Math.max(0, Math.min(offset, kids.length));
  const rectAt = (text, first) => {
    const range = doc.createRange();
    if (first) {
      range.setStart(text, 0);
      range.setEnd(text, 1);
    } else {
      const end = text.nodeValue.length;
      range.setStart(text, end - 1);
      range.setEnd(text, end);
    }
    const r = range.getBoundingClientRect();
    if (!r || r.height <= 0) return null;
    return first ? new DOMRect(r.left, r.top, 0, r.height) : new DOMRect(r.right, r.top, 0, r.height);
  };
  const search = (begin, end, step, first) => {
    for (let i = begin; i !== end; i += step) {
      const text = deepText(kids[i], first);
      if (text) {
        const r = rectAt(text, first);
        if (r) return r;
      }
    }
    return null;
  };
  const at = from < kids.length ? kids[from] : null;
  const preferBackward = !!at && at.nodeType !== 3 && deepText(at, true) == null;
  if (!preferBackward) {
    return search(from, kids.length, 1, true) ?? search(from - 1, -1, -1, false);
  }
  return search(from - 1, -1, -1, false) ?? search(from, kids.length, 1, true);
}

/**
 * Render a document into `container`. Returns a PositionMap whose flatText
 * must be mirrored into the EditContext by the caller.
 */
export function render(doc, container, { imeFormats = [] } = {}) {
  const map = new PositionMap();
  const ownerDoc = container.ownerDocument;
  container.textContent = "";
  let flat = 0;
  /** Previous rendered block: { kind, path, inlineEnd, inlineLen, el } */
  let prev = null;

  const gapAction = (prevBlock, nextBlock) => {
    const prevIsText = isInlineContainer(prevBlock.node);
    const nextIsText = isInlineContainer(nextBlock.node);
    if (prevIsText && nextIsText) {
      const sameParent =
        prevBlock.path.length === nextBlock.path.length &&
        prevBlock.path.slice(0, -1).every((v, i) => v === nextBlock.path.slice(0, -1)[i]);
      return sameParent ? "merge" : "noop";
    }
    return "deleteblk";
  };

  const emitGap = (nextBlock) => {
    if (!prev) return;
    const action = gapAction(prev, nextBlock);
    const start = flat;
    const seg = {
      kind: "gap",
      start,
      end: start + 1,
      action,
      prevPath: prev.kind === "container" ? prev.path : null,
      prevInlineEnd: prev.kind === "container" ? prev.inlineLen : null,
      nextPath: nextBlock.path,
      prevEl: prev.el ?? null,
    };
    if (action === "deleteblk") {
      seg.blockPath = prev.kind === "blockleaf" ? prev.path : nextBlock.path;
    }
    map.flatText += "\n";
    map.addSegment(seg);
    if (action === "merge" && prev.el) {
      map.addPoint(start, prev.el, prev.el.childNodes.length);
    }
    flat += 1;
  };

  const renderContainer = (block, path, parentEl) => {
    const el = ownerDoc.createElement(block.type === "heading" ? `h${block.attrs?.level ?? 1}` : "p");
    parentEl.appendChild(el);
    map.addPoint(flat, el, 0);

    let inlineOffset = 0;
    for (const child of block.children ?? []) {
      if (child.type === "text") {
        const seg = {
          kind: "text",
          start: flat,
          end: flat + child.text.length,
          path,
          inlineOffset,
          dom: null,
        };
        const textNode = applyTextRun(ownerDoc, el, child, imeFormats, seg);
        seg.dom = textNode;
        map._textSegByNode.set(textNode, seg);
        map.addSegment(seg);
        map.flatText += child.text;
        for (let i = 0; i <= child.text.length; i++) map.addPoint(flat + i, textNode, i);
        flat += child.text.length;
        inlineOffset += child.text.length;
      } else if (child.type === "image" || child.type === "hard_break") {
        const seg = { kind: "leaf", start: flat, end: flat + 1, path, inlineOffset, dom: null };
        let node;
        if (child.type === "image") {
          node = makeImage(ownerDoc, child.attrs, "ec-image ec-inline-image");
        } else {
          node = ownerDoc.createElement("br");
          node.className = "ec-hard-break";
        }
        el.appendChild(node);
        seg.dom = node;
        map.addSegment(seg);
        map.flatText += OBJECT_CHAR;
        map.addPoint(flat, el, el.childNodes.length - 1);
        map.addPoint(flat + 1, el, el.childNodes.length);
        flat += 1;
        inlineOffset += 1;
      }
    }

    if (el.childNodes.length === 0) {
      const br = ownerDoc.createElement("br");
      br.className = "ec-empty-br";
      el.appendChild(br);
    }
    map.addPoint(flat, el, el.childNodes.length);
    map._blockEnds.set(el, flat);
    prev = { kind: "container", path, inlineLen: inlineOffset, el, node: block };
  };

  const renderBlockLeaf = (block, path, parentEl) => {
    let dom;
    if (block.type === "table") {
      const table = ownerDoc.createElement("table");
      table.className = "ec-table";
      const tbody = ownerDoc.createElement("tbody");
      table.appendChild(tbody);
      // Cell text precedes the table's object char in the flat text, so the
      // position map flows through every cell paragraph before the table's
      // own segment is added below.
      block.children.forEach((row, r) => {
        const tr = ownerDoc.createElement("tr");
        row.children.forEach((cell, c) => {
          const td = ownerDoc.createElement("td");
          cell.children.forEach((cellBlock, b) => {
            if (!isInlineContainer(cellBlock)) return;
            const cellPath = [...path, r, c, b];
            emitGap({ node: cellBlock, path: cellPath });
            renderContainer(cellBlock, cellPath, td);
          });
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      dom = table;
    } else {
      const figure = ownerDoc.createElement("figure");
      figure.className = "ec-block-image";
      figure.appendChild(makeImage(ownerDoc, block.attrs, "ec-image"));
      dom = figure;
    }
    parentEl.appendChild(dom);
    map.addSegment({ kind: "blockleaf", start: flat, end: flat + 1, path, dom });
    map.flatText += OBJECT_CHAR;
    map.addPoint(flat, parentEl, parentEl.childNodes.length - 1);
    map.addPoint(flat + 1, parentEl, parentEl.childNodes.length);
    // Content-boundary points: a DOM selection can cover the block's
    // contents (highlighting the object instead of drawing a boundary
    // bar) and maps back to these offsets exactly.
    map.addPoint(flat, dom, 0);
    map.addPoint(flat + 1, dom, dom.childNodes.length);
    flat += 1;
    prev = { kind: "blockleaf", path, el: null, node: block };
  };

  doc.children.forEach((block, i) => {
    const path = [i];
    const pseudo = { node: block, path };
    emitGap(pseudo);
    if (isInlineContainer(block)) renderContainer(block, path, container);
    else renderBlockLeaf(block, path, container);
  });

  map.finish();
  return map;
}

function applyTextRun(ownerDoc, el, child, imeFormats, seg) {
  const marks = MARKS.filter((m) => child.marks?.includes(m));
  const link = (child.marks ?? []).find((m) => m && typeof m === "object" && m.type === "link");
  const inner = ownerDoc.createTextNode(child.text);
  let top = inner;
  for (let i = marks.length - 1; i >= 0; i--) {
    const wrap = ownerDoc.createElement(MARK_TAGS[marks[i]]);
    wrap.appendChild(top);
    top = wrap;
  }
  if (link) {
    const a = ownerDoc.createElement("a");
    a.href = link.attrs?.href ?? "";
    if (link.attrs?.title) a.title = link.attrs.title;
    a.appendChild(top);
    top = a;
  }
  el.appendChild(top);
  decorateIme(ownerDoc, el, inner, seg, imeFormats);
  return inner;
}

/** Split a text node where IME composition formats apply and wrap those parts. */
function decorateIme(ownerDoc, el, textNode, seg, imeFormats) {
  const spans = [];
  for (const f of imeFormats) {
    const s = Math.max(f.rangeStart, seg.start);
    const e = Math.min(f.rangeEnd, seg.end);
    if (s < e) spans.push([s - seg.start, e - seg.start, f]);
  }
  if (spans.length === 0) return;
  spans.sort((a, b) => a[0] - b[0]);

  const text = textNode.nodeValue;
  const parts = [];
  let cursor = 0;
  for (const [s, e, f] of spans) {
    if (s > cursor) parts.push({ text: text.slice(cursor, s), format: null });
    parts.push({ text: text.slice(s, e), format: f });
    cursor = Math.max(cursor, e);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), format: null });

  const parent = textNode.parentNode;
  const anchor = ownerDoc.createComment("ime");
  parent.insertBefore(anchor, textNode);
  parent.removeChild(textNode);
  for (const part of parts) {
    if (part.text === "") continue;
    const node = ownerDoc.createTextNode(part.text);
    if (part.format) {
      const span = ownerDoc.createElement("span");
      span.className = "ec-ime";
      const style = part.format.underlineStyle || "solid";
      const thickness = part.format.underlineThickness || "thin";
      span.style.textDecoration = "underline";
      span.style.textDecorationStyle = ["solid", "double", "dotted", "dashed", "wavy"].includes(style)
        ? style
        : "solid";
      span.style.textDecorationThickness = thickness === "thin" ? "1px" : thickness === "thick" ? "2.5px" : thickness;
      span.appendChild(node);
      parent.insertBefore(span, anchor);
    } else {
      parent.insertBefore(node, anchor);
    }
  }
  parent.removeChild(anchor);
}

function makeImage(ownerDoc, attrs, className) {
  const img = ownerDoc.createElement("img");
  img.className = className;
  img.src = attrs?.src ?? "";
  img.alt = attrs?.alt ?? "";
  img.draggable = false;
  if (attrs?.width) img.width = Number(attrs.width);
  if (attrs?.height) img.height = Number(attrs.height);
  return img;
}
