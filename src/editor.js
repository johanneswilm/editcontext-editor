/**
 * Editor: binds an EditContext to a DOM element and keeps three views in
 * sync:
 *
 *   JSON document model  <->  flat text (EditContext buffer)  <->  DOM
 *
 * Text input flows through the EditContext: the browser applies raw-text
 * edits (insertText, deleteContent…) to the buffer and reports them via
 * `textupdate`; we mirror them into the model through the PositionMap.
 * Non-text input (Enter, paste, cut, formatting, undo) arrives as
 * `beforeinput` on the element and is handled with model operations.
 *
 * IME composition is fully supported: composition events, textformatupdate
 * decorations (the underline), and characterboundsupdate responses that let
 * the IME position its candidate window correctly.
 */
import { normalizeDocument, cloneDoc, getNode, isInlineContainer, MARKS, getLinkMark } from "./schema.js";
import { inlineLength, findAncestor, comparePaths } from "./document.js";
import { render } from "./render.js";
import * as ops from "./ops.js";
import { History } from "./history.js";
import { parseHTML, parseText } from "./htmlparse.js";
import { serializeHTML } from "./serialize.js";
import { injectStyles } from "./styles.js";

const INPUT_TYPE_TO_MARK = {
  formatBold: "bold",
  formatItalic: "italic",
  formatUnderline: "underline",
  formatStrikethrough: "strikethrough",
};

export function isEditContextSupported() {
  return typeof EditContext !== "undefined";
}

export class Editor extends EventTarget {
  constructor(options = {}) {
    super();
    if (!options.element) throw new Error("Editor requires an `element` option");
    if (!isEditContextSupported()) {
      throw new Error("EditContext is not supported in this browser (requires Chrome/Edge 121+)");
    }
    if (options.injectStyles !== false) injectStyles(options.root ?? document);

    this.element = options.element;
    this.element.classList.add("ec-editor");
    this.element.setAttribute("tabindex", "0");
    this.element.setAttribute("role", "textbox");
    this.element.setAttribute("aria-multiline", "true");
    if (options.placeholder) {
      this.element.dataset.ecPlaceholder = options.placeholder;
    }
    if (options.enterKeyHint) {
      this.element.setAttribute("enterkeyhint", options.enterKeyHint);
    }

    this.doc = normalizeDocument(options.content ?? null);
    this.sel = { anchor: 0, head: 0 }; // flat offsets
    this.storedMarks = [];
    this.isComposing = false;
    this.imeFormats = [];
    this.focused = false;
    this._settingDomSelection = false;
    this._selectedNode = null;
    this._listeners = [];
    this.history = new History(options.history);

    this.caret = this.element.ownerDocument.createElement("div");
    this.caret.className = "ec-caret";
    this.caret.setAttribute("aria-hidden", "true");
    this.caret.style.display = "none";

    this.editContext = new EditContext({ text: "", selectionStart: 0, selectionEnd: 0 });
    this.element.editContext = this.editContext;

    this.map = render(this.doc, this.element, { imeFormats: this.imeFormats });
    this.element.appendChild(this.caret);
    this._syncBuffer(true);
    this.history.seed(this.doc, this.sel);
    this._updatePlaceholder();

    this._bindEvents();
  }

  // ------------------------------------------------------------------ events

  on(type, fn) {
    this.addEventListener(type, fn);
    return () => this.removeEventListener(type, fn);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bindEvents() {
    const ownerDoc = this.element.ownerDocument;
    this._listen(this.element, "beforeinput", (e) => this._onBeforeInput(e));
    this._listen(this.element, "keydown", (e) => this._onKeyDown(e));
    this._listen(this.element, "mousedown", (e) => this._onMouseDown(e));
    this._listen(this.element, "click", (e) => this._onMouseDown(e));
    this._listen(this.element, "focus", () => this._onFocus());
    this._listen(this.element, "blur", () => this._onBlur());
    this._listen(ownerDoc, "selectionchange", () => this._onSelectionChange());
    this._listen(this.editContext, "textupdate", (e) => this._onTextUpdate(e));
    this._listen(this.editContext, "textformatupdate", (e) => this._onTextFormatUpdate(e));
    this._listen(this.editContext, "characterboundsupdate", (e) => this._onCharacterBoundsUpdate(e));
    this._listen(this.editContext, "compositionstart", () => this._onCompositionStart());
    this._listen(this.editContext, "compositionend", () => this._onCompositionEnd());
    this._listen(ownerDoc.defaultView, "resize", () => this._updateCaretAndBounds());
    this._listen(ownerDoc.defaultView, "scroll", () => this._updateCaretAndBounds(), {
      capture: true,
      passive: true,
    });
  }

  destroy() {
    for (const [target, type, fn, opts] of this._listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this._listeners = [];
    this.element.editContext = null;
    this.caret.remove();
    this._selectedNode?.classList?.remove("ec-selected");
    this._selectedNode = null;
    this.element.classList.remove("ec-editor", "ec-focused", "ec-show-placeholder", "ec-is-empty");
    this._emit("destroy");
  }

  // ------------------------------------------------------- selection helpers

  getSelection() {
    return { ...this.sel };
  }

  /** Set the selection from flat offsets (clamped to the document). */
  setSelection(anchor, head = anchor) {
    const max = this.map.flatText.length;
    this._setSelection(clamp(anchor, max), clamp(head, max));
    this._afterRender();
  }

  _setSelection(anchor, head) {
    this.sel = { anchor, head };
    const start = Math.min(anchor, head);
    const end = Math.max(anchor, head);
    this.editContext.updateSelection(start, end);
  }

  _collapsed() {
    return this.sel.anchor === this.sel.head;
  }

  _orderedSelection() {
    return {
      from: Math.min(this.sel.anchor, this.sel.head),
      to: Math.max(this.sel.anchor, this.sel.head),
    };
  }

  _restoreDomSelection() {
    const anchorPoint = this.map.flatToDomPoint(this.sel.anchor);
    const focusPoint = this.map.flatToDomPoint(this.sel.head);
    if (!anchorPoint || !focusPoint) return;
    const domSel = this.element.ownerDocument.getSelection();
    if (!domSel) return;
    const { anchor, head } = this.sel;
    this._settingDomSelection = true;
    try {
      if (anchor <= head) {
        domSel.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset);
      } else {
        domSel.setBaseAndExtent(focusPoint.node, focusPoint.offset, anchorPoint.node, anchorPoint.offset);
      }
    } catch {
      // Points may be briefly stale during re-render; ignore.
    } finally {
      this._settingDomSelection = false;
    }
  }

  _onSelectionChange() {
    if (this._settingDomSelection || !this.focused) return;
    const domSel = this.element.ownerDocument.getSelection();
    if (!domSel || domSel.rangeCount === 0) return;
    const anchorFlat = this.map.domPointToFlat(domSel.anchorNode, domSel.anchorOffset);
    const focusFlat = this.map.domPointToFlat(domSel.focusNode, domSel.focusOffset);
    if (anchorFlat == null || focusFlat == null) return;
    if (anchorFlat === this.sel.anchor && focusFlat === this.sel.head) return;
    this.sel = { anchor: anchorFlat, head: focusFlat };
    this.storedMarks = [];
    const start = Math.min(anchorFlat, focusFlat);
    const end = Math.max(anchorFlat, focusFlat);
    this.editContext.updateSelection(start, end);
    this._updateSelectedNode();
    this._updateCaretAndBounds();
    this._emit("selectionchange");
  }

  // ------------------------------------------------------------ caret & IME

  _updateCaretAndBounds() {
    this._updateCaret();
    this._updateBounds();
  }

  _updateCaret() {
    const show = this.focused && this._collapsed();
    if (!show) {
      this.caret.style.display = "none";
      return;
    }
    const rect = this.map.rectForOffset(Math.min(this.sel.anchor, this.sel.head));
    if (!rect) {
      this.caret.style.display = "none";
      return;
    }
    const containerRect = this.element.getBoundingClientRect();
    this.caret.style.display = "block";
    this.caret.style.height = `${rect.height}px`;
    this.caret.style.transform = `translate(${rect.left - containerRect.left}px, ${rect.top - containerRect.top}px)`;
  }

  _updateBounds() {
    const ec = this.editContext;
    if (typeof ec.updateControlBounds !== "function") return;
    const containerRect = this.element.getBoundingClientRect();
    try {
      ec.updateControlBounds(containerRect);
      let selectionRect = null;
      if (!this._collapsed()) {
        const start = this.map.flatToDomPoint(Math.min(this.sel.anchor, this.sel.head));
        const end = this.map.flatToDomPoint(Math.max(this.sel.anchor, this.sel.head));
        if (start && end) {
          const range = this.element.ownerDocument.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          selectionRect = range.getBoundingClientRect();
        }
      }
      selectionRect ??= this.map.rectForOffset(Math.min(this.sel.anchor, this.sel.head));
      ec.updateSelectionBounds(selectionRect && selectionRect.height > 0 ? selectionRect : containerRect);
    } catch {
      // Bounds are advisory; never crash on them.
    }
  }

  _onCharacterBoundsUpdate(e) {
    const rects = [];
    const text = this.map.flatText;
    let o = e.rangeStart;
    while (o < e.rangeEnd && rects.length < 1000) {
      const cpLen = o < text.length && text.codePointAt(o) > 0xffff ? 2 : 1;
      rects.push(this.map.rectForOffset(o) ?? this.element.getBoundingClientRect());
      o += cpLen;
    }
    try {
      this.editContext.updateCharacterBounds(e.rangeStart, rects);
    } catch {
      // Advisory only.
    }
  }

  _onTextFormatUpdate(e) {
    let formats = [];
    if (typeof e.getTextFormats === "function") {
      formats = e.getTextFormats() ?? [];
    } else if (e.rangeStart != null || e.formatRangeStart != null) {
      formats = [
        {
          rangeStart: e.rangeStart ?? e.formatRangeStart,
          rangeEnd: e.rangeEnd ?? e.formatRangeEnd,
          underlineStyle: e.underlineStyle,
          underlineThickness: e.underlineThickness,
        },
      ];
    }
    this.imeFormats = formats
      .filter((f) => f && f.rangeEnd > f.rangeStart)
      .map((f) => ({
        rangeStart: f.rangeStart,
        rangeEnd: f.rangeEnd,
        underlineStyle: f.underlineStyle,
        underlineThickness: f.underlineThickness,
      }));
    // Re-render decorations only; the text is unchanged.
    this.map = render(this.doc, this.element, { imeFormats: this.imeFormats });
    this.element.appendChild(this.caret);
    this._restoreDomSelection();
    this._updateCaretAndBounds();
  }

  _onCompositionStart() {
    this.isComposing = true;
    this._emit("compositionstart");
  }

  _onCompositionEnd() {
    this.isComposing = false;
    this.imeFormats = [];
    this._afterMutation();
    this._afterRender();
    this._emit("compositionend");
  }

  // -------------------------------------------------------------- input path

  _onBeforeInput(e) {
    const inputType = e.inputType;

    const mark = INPUT_TYPE_TO_MARK[inputType];
    if (mark) {
      e.preventDefault();
      this.toggleMark(mark);
      return;
    }

    switch (inputType) {
      case "insertParagraph":
        e.preventDefault();
        this.splitBlock();
        return;
      case "insertLineBreak":
        e.preventDefault();
        this.insertHardBreak();
        return;
      case "insertFromPaste":
      case "insertFromDrop": {
        e.preventDefault();
        this._insertFromDataTransfer(e.dataTransfer);
        return;
      }
      case "deleteByCut":
        e.preventDefault();
        this._cutSelection();
        return;
      case "deleteByDrag":
        e.preventDefault();
        this.deleteSelection();
        return;
      case "insertReplacementText": {
        e.preventDefault();
        this._replaceSelectionWithText(e.data ?? "", null);
        return;
      }
      case "historyUndo":
        e.preventDefault();
        this.undo();
        return;
      case "historyRedo":
        e.preventDefault();
        this.redo();
        return;
      default:
        // EditContext-handled inputTypes (insertText, deleteContent*, …) are
        // applied to the buffer by the UA and mirrored in textupdate.
        return;
    }
  }

  /**
   * Link targets for setLink/unsetLink: the selection when expanded, or the
   * contiguous link run around a collapsed caret.
   */
  _resolveLinkRange() {
    const { from, to } = this._orderedSelection();
    if (from !== to) {
      return { from: this.map.flatToLoc(from), to: this.map.flatToLoc(to) };
    }
    const loc = this.map.flatToLoc(from);
    const node = getNode(this.doc, loc.path);
    if (!node || !isInlineContainer(node)) return null;
    let idx = -1;
    let acc = 0;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      const len = c.type === "text" ? c.text.length : 1;
      if (acc + len >= loc.offset) {
        idx = i;
        break;
      }
      acc += len;
    }
    if (idx === -1) idx = node.children.length - 1;
    // At a boundary, prefer a linked run on the right over plain text on the
    // left (and a linked run on the left over anything — handled naturally).
    const target0 = node.children[idx];
    if (target0 && idx + 1 < node.children.length) {
      const len0 = target0.type === "text" ? target0.text.length : 1;
      const next = node.children[idx + 1];
      if (
        acc + len0 === loc.offset &&
        target0.type === "text" &&
        !getLinkMark(target0.marks) &&
        next.type === "text" &&
        getLinkMark(next.marks)
      ) {
        idx += 1;
      }
    }
    const target = node.children[idx];
    if (!target || target.type !== "text") return null;
    const link = getLinkMark(target.marks);
    if (!link) return null;
    const same = (marks) => JSON.stringify(getLinkMark(marks)) === JSON.stringify(link);
    let startIdx = idx;
    while (startIdx > 0) {
      const c = node.children[startIdx - 1];
      if (c.type !== "text" || !same(c.marks)) break;
      startIdx--;
    }
    let endIdx = idx;
    while (endIdx < node.children.length - 1) {
      const c = node.children[endIdx + 1];
      if (c.type !== "text" || !same(c.marks)) break;
      endIdx++;
    }
    const offsetOf = (i) =>
      node.children.slice(0, i).reduce((s, c) => s + (c.type === "text" ? c.text.length : 1), 0);
    return {
      from: { path: loc.path, offset: offsetOf(startIdx) },
      to: { path: loc.path, offset: offsetOf(endIdx + 1) },
    };
  }

  /** Link attrs if the caret/selection is uniformly inside one link, else null. */
  getActiveLink() {
    const range = this._resolveLinkRange();
    if (!range) return null;
    const containers = [];
    const visit = (node, path) => {
      if (isInlineContainer(node)) {
        containers.push({ node, path });
        return;
      }
      (node.children ?? []).forEach((c, i) => visit(c, [...path, i]));
    };
    visit(this.doc, []);
    let link = null;
    let seen = false;
    for (const { node, path } of containers) {
      const cmpFrom = comparePaths(path, range.from.path);
      const cmpTo = comparePaths(path, range.to.path);
      if (cmpFrom < 0 || cmpTo > 0) continue;
      const start = cmpFrom === 0 ? range.from.offset : 0;
      const end = cmpTo === 0 ? range.to.offset : inlineLength(node);
      let acc = 0;
      for (const child of node.children) {
        const len = child.type === "text" ? child.text.length : 1;
        const s = Math.max(start, acc);
        const e = Math.min(end, acc + len);
        if (s < e && child.type === "text") {
          const l = getLinkMark(child.marks);
          if (!l) return null;
          if (!seen) {
            link = l;
            seen = true;
          } else if (JSON.stringify(l) !== JSON.stringify(link)) {
            return null;
          }
        }
        acc += len;
      }
    }
    return link ? { ...link.attrs } : null;
  }

  /** Apply a link to the selection (or edit the link under a collapsed caret). */
  setLink({ href, title = "" } = {}) {
    if (!href || this.isComposing) return false;
    const range = this._resolveLinkRange();
    if (!range) return false;
    return this._transact((doc) => ops.setLink(doc, range.from, range.to, { href, title }));
  }

  /** Remove the link from the selection (or the link under a collapsed caret). */
  unsetLink() {
    if (this.isComposing) return false;
    const range = this._resolveLinkRange();
    if (!range) return false;
    return this._transact((doc) => {
      ops.unsetLink(doc, range.from, range.to);
    });
  }

  /**
   * Clicking an image selects it (the position range covering its object
   * character), so Backspace/Delete remove it and typing replaces it.
   * Clicking a link must not navigate.
   */
  _onMouseDown(e) {
    if (!(e.target instanceof Element)) return;
    const anchor = e.target.closest("a");
    if (anchor && this.element.contains(anchor)) {
      if (e.type === "click") e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (e.target.tagName !== "IMG" || !this.element.contains(e.target)) return;
    const figure = e.target.closest("figure");
    const seg =
      this.map.segments.find((s) => s.dom === e.target) ??
      (figure ? this.map.segments.find((s) => s.kind === "blockleaf" && s.dom === figure) : null);
    if (!seg) return;
    e.preventDefault();
    this.element.focus();
    this._setSelection(seg.start, seg.end);
    this._restoreDomSelection();
    this._updateSelectedNode();
    this._updateCaretAndBounds();
    this._emit("selectionchange");
  }

  _onKeyDown(e) {
    // Undo/redo: Chrome does not translate Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on
    // an EditContext editing host into beforeinput(history*) events, so
    // handle the keys directly. (The beforeinput branch stays as a fallback
    // for user agents that do fire them.)
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && !e.altKey && e.code === "KeyY") {
      e.preventDefault();
      this.redo();
      return;
    }
    // Enter is not translated to a text update by the EditContext; Chrome
    // also doesn't fire beforeinput(insertParagraph) on editing hosts, so
    // handle the key directly. (The beforeinput branch stays as a fallback
    // for input sources that produce it without a keydown.)
    if (e.key === "Enter" && !this.isComposing && !e.defaultPrevented) {
      e.preventDefault();
      if (e.shiftKey) this.insertHardBreak();
      else this.splitBlock();
      return;
    }
    if (e.key === "Tab") {
      const moved = this._moveTableSelection(e.shiftKey ? "prev" : "next");
      if (moved) e.preventDefault();
    }
  }

  _moveTableSelection(direction) {
    const { from } = this._orderedSelection();
    const loc = this.map.flatToLoc(from);
    const ctx = ops.tableContext(this.doc, { path: loc.path });
    if (!ctx) return false;
    const table = ctx.table.node;
    const rowCount = table.children.length;
    const colCount = table.children[0]?.children.length ?? 1;
    let r = ctx.row.index;
    let c = ctx.cell.index;
    if (direction === "next") {
      c += 1;
      if (c >= colCount) {
        c = 0;
        r += 1;
        if (r >= rowCount) r = 0;
      }
    } else {
      c -= 1;
      if (c < 0) {
        c = colCount - 1;
        r -= 1;
        if (r < 0) r = rowCount - 1;
      }
    }
    const flat = this.map.locToFlat([...ctx.table.path, r, c, 0], 0);
    if (flat == null) return false;
    this._setSelection(flat, flat);
    this._restoreDomSelection();
    this._updateCaretAndBounds();
    this._emit("selectionchange");
    return true;
  }

  // --------------------------------------------------------------- textupdate

  _onTextUpdate(e) {
    const a = e.updateRangeStart ?? e.updateTextStart ?? 0;
    const b = e.updateRangeEnd ?? e.updateTextEnd ?? a;
    const text = e.text ?? e.updateText ?? "";
    const selA = e.selectionStart ?? a + text.length;
    const selB = e.selectionEnd ?? selA;

    const changed = this._applyFlatEdit(a, b, text);
    this._afterMutation();
    const max = this.map.flatText.length;
    this._setSelection(clamp(selA, max), clamp(selB, max));
    if (changed) this.history.record(this.doc, this.sel, "typing");
    this._afterRender();
    if (changed) this._emit("change");
  }

  /**
   * Mirror a buffer edit [a, b) -> text into the model via the position map.
   * Returns the end location of the edit (or null) and whether doc changed.
   */
  _applyFlatEdit(a, b, text) {
    const map = this.map;
    const before = JSON.stringify(this.doc);
    let joinLoc = null;

    if (b > a) {
      const segs = map.segments.filter((s) => s.start < b && s.end > a);
      const gapOnly =
        segs.length === 1 && segs[0].kind === "gap" && a === segs[0].start && b === segs[0].end;

      if (gapOnly) {
        const gap = segs[0];
        if (gap.action === "merge") {
          // Deleting a boundary char between sibling blocks merges them.
          joinLoc = ops.deleteRange(
            this.doc,
            { path: gap.prevPath, offset: gap.prevInlineEnd },
            { path: gap.nextPath, offset: 0 }
          );
        } else if (gap.action === "deleteblk" && gap.blockPath) {
          // Backspace next to a table / block image deletes that block —
          // unless the caret is inside it, in which case do nothing.
          const caretLoc = map.flatToLoc(b);
          const inside =
            caretLoc.path.length > gap.blockPath.length &&
            caretLoc.path.slice(0, gap.blockPath.length).every((v, i) => v === gap.blockPath[i]);
          if (!inside) {
            ops.removeBlock(this.doc, gap.blockPath);
          }
          joinLoc = inside ? caretLoc : map._nearbyContainerLoc(gap, "backward");
        } else {
          // "noop" (table cell boundary): nothing to delete in the model;
          // the buffer is resynced from the model afterwards.
          joinLoc = { path: gap.nextPath, offset: 0 };
        }
      } else {
        const textual = segs.some((s) => s.kind === "text" || s.kind === "leaf");
        const blockSegs = segs.filter((s) => s.kind === "blockleaf");
        if (blockSegs.length && !textual) {
          // The range covers only block leaves (and gaps around them): delete
          // the blocks without merging the surrounding paragraphs.
          const paths = [...blockSegs.map((s) => s.path)].sort((x, y) => comparePaths(y, x));
          for (const p of paths) ops.removeBlock(this.doc, p);
          joinLoc = map._nearbyContainerLoc(blockSegs[0], "backward");
        } else {
          const blockLeaves = blockSegs.map((s) => s.path);
          joinLoc = ops.deleteSpanning(this.doc, map.flatToLoc(a), map.flatToLoc(b), blockLeaves);
        }
      }
    } else {
      joinLoc = map.flatToLoc(a);
    }

    if (text && joinLoc) {
      const marks = this._effectiveMarks();
      joinLoc = ops.insertMultiline(this.doc, joinLoc, text, marks);
    }

    this._lastJoinLoc = joinLoc;
    return JSON.stringify(this.doc) !== before;
  }

  _effectiveMarks() {
    if (this._collapsed() && this.storedMarks.length) return this.storedMarks;
    if (this._collapsed()) {
      const { from } = this._orderedSelection();
      const loc = this.map.flatToLoc(from);
      const container = getNode(this.doc, loc.path);
      if (container && isInlineContainer(container)) {
        let offset = 0;
        for (const child of container.children) {
          const len = child.type === "text" ? child.text.length : 1;
          if (offset + len > loc.offset && child.type === "text") return child.marks ?? [];
          if (offset >= loc.offset) break;
          offset += len;
        }
      }
      return [];
    }
    return [];
  }

  // -------------------------------------------------------------- clipboard

  _insertFromDataTransfer(dt) {
    if (!dt) return;
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    if (html) {
      this._insertFragment(parseHTML(html));
    } else if (text) {
      if (text.includes("\n")) {
        this._insertFragment(parseText(text));
      } else {
        // Single-line plain text pastes inline at the caret.
        this._replaceSelectionWithText(text, null);
      }
    }
  }

  _spannedBlockLeaves(from, to) {
    if (to <= from) return [];
    return this.map.segments
      .filter((s) => s.kind === "blockleaf" && s.start >= from && s.end <= to)
      .map((s) => s.path);
  }

  _insertFragment(fragment) {
    if (this.isComposing || fragment.length === 0) return;
    const { from, to } = this._orderedSelection();
    const blockLeaves = this._spannedBlockLeaves(from, to);
    let joinLoc = this.map.flatToLoc(from);
    if (to > from) {
      joinLoc = ops.deleteSpanning(this.doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
    }

    const isInline = (n) => n.type === "text" || n.type === "image" || n.type === "hard_break";
    const insertInlinesAt = (loc, inlines) => {
      let cursor = loc;
      for (const node of inlines) {
        if (node.type === "text") ops.insertText(this.doc, cursor, node.text, node.marks ?? []);
        else ops.insertLeaf(this.doc, cursor, node);
        cursor = { path: cursor.path, offset: cursor.offset + (node.type === "text" ? node.text.length : 1) };
      }
      return cursor;
    };

    // Plan: alternating inline runs and blocks, in source order.
    const plan = [];
    let run = [];
    const flush = () => {
      if (run.length) {
        plan.push({ inlines: run });
        run = [];
      }
    };
    for (const node of fragment) {
      if (isInline(node)) run.push(node);
      else {
        flush();
        plan.push({ block: node });
      }
    }
    flush();

    const hasBlocks = plan.some((p) => p.block);
    const current = getNode(this.doc, joinLoc.path);
    let endPath = joinLoc.path;
    let endOffset = joinLoc.offset;

    if (!hasBlocks) {
      const cursor = insertInlinesAt(joinLoc, fragment);
      endPath = cursor.path;
      endOffset = cursor.offset;
    } else if (current && isInlineContainer(current) && inlineLength(current) > 0) {
      const parent = getNode(this.doc, joinLoc.path.slice(0, -1));
      const index = joinLoc.path[joinLoc.path.length - 1];
      const base = joinLoc.path.slice(0, -1);
      const leading = plan[0].inlines ? plan[0].inlines : null;
      const trailing = plan[plan.length - 1].inlines ? plan[plan.length - 1].inlines : null;
      const atStart = joinLoc.offset === 0 && !leading;
      const atEnd = joinLoc.offset === inlineLength(current) && !trailing;

      if (atStart) {
        // All blocks go before the current paragraph.
        let insertAt = index;
        for (const item of plan) {
          if (item.block) {
            parent.children.splice(insertAt, 0, item.block);
            endPath = [...base, insertAt];
            insertAt++;
          }
        }
        if (trailing) {
          const cursor = insertInlinesAt({ path: joinLoc.path, offset: 0 }, trailing);
          endPath = cursor.path;
          endOffset = cursor.offset;
        } else {
          const lastNode = getNode(this.doc, endPath);
          endOffset = lastNode && isInlineContainer(lastNode) ? inlineLength(lastNode) : 0;
        }
      } else if (atEnd) {
        if (leading) {
          const cursor = insertInlinesAt(joinLoc, leading);
          joinLoc = cursor;
        }
        let insertAt = index + 1;
        for (const item of plan) {
          if (item.block) {
            parent.children.splice(insertAt, 0, item.block);
            endPath = [...base, insertAt];
            insertAt++;
          } else if (item.inlines && item.inlines !== leading) {
            // inlines between blocks: fold into the previous block
            const prev = getNode(this.doc, endPath);
            if (prev && isInlineContainer(prev)) {
              prev.children.push(...item.inlines.map((n) => (n.type === "text" ? { ...n, marks: [...(n.marks ?? [])] } : { ...n })));
            } else {
              parent.children.splice(insertAt, 0, { type: "paragraph", children: item.inlines });
              insertAt++;
            }
          }
        }
        const lastNode = getNode(this.doc, endPath);
        endOffset = lastNode && isInlineContainer(lastNode) ? inlineLength(lastNode) : 0;
      } else {
        // Mid-block: leading inlines extend the block, blocks land between the
        // two halves of a split, trailing inlines continue in the right half.
        if (leading) joinLoc = insertInlinesAt(joinLoc, leading);
        const { newPath } = ops.splitBlock(this.doc, joinLoc, { keepType: true });
        const splitParent = getNode(this.doc, newPath.slice(0, -1));
        let insertAt = newPath[newPath.length - 1];
        for (const item of plan) {
          if (item.block) {
            splitParent.children.splice(insertAt, 0, item.block);
            endPath = [...newPath.slice(0, -1), insertAt];
            insertAt++;
          } else if (item.inlines && item.inlines !== leading && item.inlines !== trailing) {
            const prev = getNode(this.doc, endPath);
            if (prev && isInlineContainer(prev)) {
              prev.children.push(...item.inlines.map((n) => (n.type === "text" ? { ...n, marks: [...(n.marks ?? [])] } : { ...n })));
            } else {
              splitParent.children.splice(insertAt, 0, { type: "paragraph", children: item.inlines });
              insertAt++;
            }
          }
        }
        if (trailing) {
          const rightPath = [...newPath.slice(0, -1), insertAt];
          const cursor = insertInlinesAt({ path: rightPath, offset: 0 }, trailing);
          endPath = rightPath;
          endOffset = cursor.offset;
        } else {
          const lastNode = getNode(this.doc, endPath);
          endOffset = lastNode && isInlineContainer(lastNode) ? inlineLength(lastNode) : 0;
        }
      }
    } else {
      const result = ops.insertFragment(this.doc, joinLoc, fragment);
      const endNode = getNode(this.doc, result.endPath);
      endPath = result.endPath;
      endOffset = endNode && isInlineContainer(endNode) ? inlineLength(endNode) : 0;
    }

    this._afterMutation();
    const flat = this.map.locToFlat(endPath, endOffset);
    if (flat != null) this._setSelection(flat, flat);
    this.history.record(this.doc, this.sel, null);
    this._afterRender();
    this._emit("change");
  }

  _replaceSelectionWithText(text, marks) {
    if (this.isComposing) return;
    const { from, to } = this._orderedSelection();
    const blockLeaves = this._spannedBlockLeaves(from, to);
    let joinLoc = this.map.flatToLoc(from);
    if (to > from) {
      joinLoc = ops.deleteSpanning(this.doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
    }
    const endLoc = ops.insertMultiline(this.doc, joinLoc, text, marks ?? this._effectiveMarks());
    this._afterMutation();
    const flat = this.map.locToFlat(endLoc.path, endLoc.offset);
    if (flat != null) this._setSelection(flat, flat);
    this.history.record(this.doc, this.sel, null);
    this._afterRender();
    this._emit("change");
  }

  _cutSelection() {
    const { from, to } = this._orderedSelection();
    if (from === to) return;
    try {
      navigator.clipboard?.writeText(this._selectedPlainText(from, to));
    } catch {
      // Clipboard access may be denied; the deletion still happens.
    }
    this.deleteSelection();
  }

  _selectedPlainText(from, to) {
    return this.map.flatText.slice(from, to).replace(/￼/g, "");
  }

  // ----------------------------------------------------------------- commands

  /** Run a model mutation as one undoable transaction. Returns true if applied. */
  _transact(fn, { mergeKey = null } = {}) {
    if (this.isComposing) return false;
    const before = JSON.stringify(this.doc);
    fn(this.doc);
    if (JSON.stringify(this.doc) === before) return false;
    this.history.record(this.doc, this.sel, mergeKey);
    this._afterMutation();
    this._afterRender();
    this._emit("change");
    return true;
  }

  /** Select a freshly created model location after a transaction. */
  _selectLoc(path, offset = 0) {
    const flat = this.map.locToFlat(path, offset);
    if (flat != null) {
      this._setSelection(flat, flat);
      this._afterRender();
    }
  }

  /** Re-render after a mutation, resync the buffer and refresh decorations. */
  _afterMutation() {
    this.map = render(this.doc, this.element, { imeFormats: this.imeFormats });
    this.element.appendChild(this.caret);
    this._syncBuffer(false);
    this._updatePlaceholder();
  }

  _afterRender() {
    this._restoreDomSelection();
    this._updateSelectedNode();
    this._updateCaretAndBounds();
    this._emit("selectionchange");
  }

  /** Highlight an image (inline or block) when the selection covers its object char. */
  _updateSelectedNode() {
    const sel = this._orderedSelection();
    let node = null;
    if (sel.from < sel.to) {
      const seg = this.map.segments.find(
        (s) => (s.kind === "leaf" || s.kind === "blockleaf") && s.start === sel.from && s.end === sel.to
      );
      node = seg?.dom ?? null;
    }
    if (node === this._selectedNode) return;
    this._selectedNode?.classList?.remove("ec-selected");
    this._selectedNode = node;
    node?.classList?.add("ec-selected");
  }

  _syncBuffer(initial = false) {
    const current = this.editContext.text;
    const next = this.map.flatText;
    if (initial) {
      this.editContext.updateText(0, 0, next);
    } else if (!this.isComposing && current !== next) {
      this.editContext.updateText(0, current.length, next);
    }
    const max = next.length;
    const start = clamp(Math.min(this.sel.anchor, this.sel.head), max);
    const end = clamp(Math.max(this.sel.anchor, this.sel.head), max);
    this.editContext.updateSelection(start, end);
  }

  _updatePlaceholder() {
    const empty =
      this.doc.children.length === 1 &&
      this.doc.children[0].type === "paragraph" &&
      inlineLength(this.doc.children[0]) === 0;
    this.element.classList.toggle("ec-show-placeholder", empty && !!this.element.dataset.ecPlaceholder);
    this.element.classList.toggle("ec-is-empty", empty);
  }

  toggleMark(mark) {
    if (!MARKS.includes(mark)) return false;
    const { from, to } = this._orderedSelection();

    if (from === to) {
      // Collapsed selection: toggle the marks the next typed character gets.
      const marks = this.storedMarks.length ? [...this.storedMarks] : this._effectiveMarks();
      this.storedMarks = marks.includes(mark)
        ? marks.filter((m) => m !== mark)
        : [...marks, mark].sort();
      this._emit("selectionchange");
      return true;
    }

    const fromLoc = this.map.flatToLoc(from);
    const toLoc = this.map.flatToLoc(to);
    return this._transact((doc) => {
      ops.toggleMark(doc, fromLoc, toLoc, mark);
    });
  }

  toggleBold() { return this.toggleMark("bold"); }
  toggleItalic() { return this.toggleMark("italic"); }
  toggleUnderline() { return this.toggleMark("underline"); }
  toggleStrikethrough() { return this.toggleMark("strikethrough"); }
  toggleCode() { return this.toggleMark("code"); }

  splitBlock() {
    const { from } = this._orderedSelection();
    const loc = this.map.flatToLoc(from);
    let newPath = null;
    const ok = this._transact((doc) => {
      newPath = ops.splitBlock(doc, loc).newPath;
    });
    if (ok) this._selectLoc(newPath, 0);
    return ok;
  }

  insertHardBreak() {
    const { from, to } = this._orderedSelection();
    const blockLeaves = this._spannedBlockLeaves(from, to);
    let joinLoc = null;
    const ok = this._transact((doc) => {
      joinLoc = this.map.flatToLoc(from);
      if (to > from) {
        joinLoc = ops.deleteSpanning(doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
      }
      ops.insertHardBreak(doc, joinLoc);
    });
    if (ok && joinLoc) this._selectLoc(joinLoc.path, joinLoc.offset + 1);
    return ok;
  }

  deleteSelection() {
    const { from, to } = this._orderedSelection();
    if (from === to) return false;
    const blockLeaves = this._spannedBlockLeaves(from, to);
    return this._transact((doc) => {
      ops.deleteSpanning(doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
    });
  }

  setParagraph() {
    return this._setBlockType("paragraph");
  }

  setHeading(level) {
    return this._setBlockType("heading", { level });
  }

  _setBlockType(type, attrs = {}) {
    const { from, to } = this._orderedSelection();
    let fromLoc = this.map.flatToLoc(from);
    let toLoc = this.map.flatToLoc(to);
    if (from === to) {
      const node = getNode(this.doc, fromLoc.path);
      fromLoc = { path: fromLoc.path, offset: 0 };
      toLoc = { path: toLoc.path, offset: node ? inlineLength(node) : 0 };
    }
    return this._transact((doc) => {
      ops.setBlockType(doc, fromLoc, toLoc, type, attrs);
    });
  }

  insertImage({ src, alt = "", inline = true, width = null, height = null } = {}) {
    if (!src || this.isComposing) return false;
    const { from, to } = this._orderedSelection();
    const blockLeaves = this._spannedBlockLeaves(from, to);
    let selection = null;
    const ok = this._transact((doc) => {
      let joinLoc = this.map.flatToLoc(from);
      if (to > from) {
        joinLoc = ops.deleteSpanning(doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
      }
      if (inline) {
        ops.insertImageInline(doc, joinLoc, { src, alt, width, height });
        selection = { path: joinLoc.path, offset: joinLoc.offset + 1 };
      } else {
        const { path } = ops.insertImageBlock(doc, joinLoc, { src, alt, width, height });
        const nextPath = [...path.slice(0, -1), path[path.length - 1] + 1];
        const next = getNode(doc, nextPath);
        if (next && isInlineContainer(next)) selection = { path: nextPath, offset: 0 };
      }
    });
    if (ok && selection) this._selectLoc(selection.path, selection.offset);
    return ok;
  }

  insertTable(rows = 2, cols = 2) {
    const { from, to } = this._orderedSelection();
    const blockLeaves = this._spannedBlockLeaves(from, to);
    let selection = null;
    const ok = this._transact((doc) => {
      let joinLoc = this.map.flatToLoc(from);
      if (to > from) {
        joinLoc = ops.deleteSpanning(doc, this.map.flatToLoc(from), this.map.flatToLoc(to), blockLeaves);
      }
      selection = { path: ops.insertTable(doc, joinLoc, rows, cols).firstCellPath, offset: 0 };
    });
    if (ok && selection) this._selectLoc(selection.path, selection.offset);
    return ok;
  }

  _tableOp(fn) {
    const { from } = this._orderedSelection();
    const loc = this.map.flatToLoc(from);
    if (!ops.tableContext(this.doc, { path: loc.path })) return false;
    return this._transact((doc) => fn(doc, loc));
  }

  tableInsertRow(after = true) {
    return this._tableOp((doc, loc) => ops.tableInsertRow(doc, loc, { after }));
  }

  tableInsertColumn(after = true) {
    return this._tableOp((doc, loc) => ops.tableInsertColumn(doc, loc, { after }));
  }

  tableDeleteRow() {
    return this._tableOp((doc, loc) => ops.tableDeleteRow(doc, loc));
  }

  tableDeleteColumn() {
    return this._tableOp((doc, loc) => ops.tableDeleteColumn(doc, loc));
  }

  undo() {
    if (this.isComposing) return false;
    const state = this.history.undo();
    if (!state) return false;
    this.doc = cloneDoc(state.doc);
    this.sel = { ...state.selection };
    this.storedMarks = [];
    this._afterMutation();
    this._afterRender();
    this._emit("change");
    return true;
  }

  redo() {
    if (this.isComposing) return false;
    const state = this.history.redo();
    if (!state) return false;
    this.doc = cloneDoc(state.doc);
    this.sel = { ...state.selection };
    this.storedMarks = [];
    this._afterMutation();
    this._afterRender();
    this._emit("change");
    return true;
  }

  selectAll() {
    this._setSelection(0, this.map.flatText.length);
    this._afterRender();
  }

  focus() {
    this.element.focus();
  }

  _onFocus() {
    this.focused = true;
    this.element.classList.add("ec-focused");
    this._onSelectionChange();
    this._updateCaretAndBounds();
    this._emit("focus");
  }

  _onBlur() {
    this.focused = false;
    this.element.classList.remove("ec-focused");
    this.caret.style.display = "none";
    this._emit("blur");
  }

  // ------------------------------------------------------------ state queries

  /** Marks active across the selection (every selected character carries them). */
  getActiveMarks() {
    const { from, to } = this._orderedSelection();
    if (from === to) {
      return this.storedMarks.length ? [...this.storedMarks] : this._effectiveMarks();
    }
    const fromLoc = this.map.flatToLoc(from);
    const toLoc = this.map.flatToLoc(to);
    return [...ops.marksAcrossRange(this.doc, fromLoc, toLoc)];
  }

  /** "paragraph" | "heading" at the selection anchor, or null for other blocks. */
  getBlockType() {
    const loc = this.map.flatToLoc(Math.min(this.sel.anchor, this.sel.head));
    const node = getNode(this.doc, loc.path);
    if (!node) return null;
    return node.type === "heading" ? "heading" : node.type;
  }

  getHeadingLevel() {
    const loc = this.map.flatToLoc(Math.min(this.sel.anchor, this.sel.head));
    const node = getNode(this.doc, loc.path);
    return node?.type === "heading" ? node.attrs?.level ?? 1 : null;
  }

  isSelectionInTable() {
    const loc = this.map.flatToLoc(Math.min(this.sel.anchor, this.sel.head));
    return !!findAncestor(this.doc, loc.path, (n) => n.type === "table_cell");
  }

  // --------------------------------------------------------------- content IO

  getJSON() {
    return cloneDoc(this.doc);
  }

  setJSON(doc) {
    this.doc = normalizeDocument(doc);
    this.sel = { anchor: 0, head: 0 };
    this.storedMarks = [];
    this.history.seed(this.doc, this.sel);
    this._afterMutation();
    this._afterRender();
    this._emit("change");
  }

  getHTML() {
    return serializeHTML(this.doc);
  }

  setHTML(html) {
    this.setJSON(normalizeDocument({ type: "doc", children: parseHTML(html) }));
  }

  getText() {
    return this.map.flatText.replace(/￼/g, "");
  }

  setContent(content) {
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          this.setJSON(JSON.parse(trimmed));
          return;
        } catch {
          // fall through to HTML
        }
      }
      this.setHTML(content);
    } else if (content && typeof content === "object") {
      this.setJSON(content);
    }
  }
}

function clamp(v, max) {
  return Math.max(0, Math.min(v, max));
}

export function createEditor(options) {
  return new Editor(options);
}
