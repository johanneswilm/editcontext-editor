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
 * Synthetic `paste` and `beforeinput(deleteContent*)` events — e.g.
 * dispatched by third-party code such as browser extensions — never reach
 * the EditContext buffer, so they are handled there as model operations too
 * (without double-executing the real keyboard/clipboard flows).
 *
 * IME composition is fully supported: composition events, textformatupdate
 * decorations (the underline), and characterboundsupdate responses that let
 * the IME position its candidate window correctly.
 *
 * All selection logic — caret movement in the flat model, object selection,
 * click-to-select, DOM-selection mapping — lives in selection.js
 * (SelectionController).
 */
import { normalizeDocument, cloneDoc, getNode, isInlineContainer, MARKS, getLinkMark } from "./schema.js";
import { inlineLength, findAncestor, comparePaths } from "./document.js";
import { render } from "./render.js";
import * as ops from "./ops.js";
import { History } from "./history.js";
import { parseHTML, parseText } from "./htmlparse.js";
import { serializeHTML } from "./serialize.js";
import { injectStyles } from "./styles.js";
import { SelectionController } from "./selection.js";

const INPUT_TYPE_TO_MARK = {
  formatBold: "bold",
  formatItalic: "italic",
  formatUnderline: "underline",
  formatStrikethrough: "strikethrough",
};

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Start offset of the grapheme whose end is at (or spans across) `offset`. */
function previousGraphemeBoundary(text, offset) {
  if (offset <= 0) return 0;
  if (graphemeSegmenter) {
    for (const seg of graphemeSegmenter.segment(text)) {
      if (seg.index + seg.segment.length >= offset) return seg.index;
    }
    return 0;
  }
  const code = text.charCodeAt(offset - 1);
  return offset - (code >= 0xdc00 && code <= 0xdfff && offset >= 2 ? 2 : 1);
}

/** End offset of the grapheme starting at (or spanning across) `offset`. */
function nextGraphemeBoundary(text, offset) {
  if (offset >= text.length) return text.length;
  if (graphemeSegmenter) {
    for (const seg of graphemeSegmenter.segment(text)) {
      if (seg.index >= offset) return seg.index + seg.segment.length;
    }
    return text.length;
  }
  const code = text.charCodeAt(offset);
  return offset + (code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length ? 2 : 1);
}

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
    // Caret handling: "custom" (default) draws the caret in JS and moves it
    // entirely in its own model — arrow keys are intercepted on every UA,
    // the target is computed in the flat model, translated to a DOM position,
    // and the caret drawn there. "native" leaves everything about the caret —
    // drawing and movement — to the browser.
    const caretMode = options.caretMode ?? "custom";
    if (caretMode !== "custom" && caretMode !== "native") {
      throw new Error(`Unknown caretMode ${JSON.stringify(caretMode)} — expected "custom" or "native"`);
    }
    this._nativeCaret = caretMode === "native";
    if (this._nativeCaret) this.element.classList.add("ec-native-caret");
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
    this.compositionRange = null; // { start, end } in flat offsets, set from textupdate
    this.imeFormats = [];
    this.focused = false;
    this._settingDomSelection = false;
    this._selectedNode = null;
    this._pendingSelectRange = null;
    this._pendingSelectDir = null;
    this._pendingCaretLoc = null;
    this._pasteGuard = false;
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
    this.selection = new SelectionController(this);

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
    this._listen(this.element, "paste", (e) => this._onPaste(e));
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
    this.element.classList.remove("ec-editor", "ec-focused", "ec-show-placeholder", "ec-is-empty", "ec-native-caret");
    this._emit("destroy");
  }

  // ------------------------------------------------------- selection helpers

  getSelection() {
    return this.selection.get();
  }

  /** Set the selection from flat offsets (clamped to the document). */
  setSelection(anchor, head = anchor) {
    const max = this.map.flatText.length;
    this._setSelection(clamp(anchor, max), clamp(head, max));
    this._afterRender();
  }

  _setSelection(anchor, head) {
    this.selection.set(anchor, head);
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
    this.selection.restoreDom();
  }

  _onSelectionChange() {
    this.selection.onChange();
  }

  // -------------------------------------------- model-based arrow movement
  // Implemented in selection.js (SelectionController.arrowMove) — arrow keys
  // are intercepted in _onKeyDown and the target is computed in the flat
  // model, so behavior is identical on every UA and immune to UA quirks.

  _arrowMoveModel(key, extend) {
    this.selection.arrowMove(key, extend);
  }

  _applySelection(anchor, head) {
    this.selection.apply(anchor, head);
  }

  // ------------------------------------------------------------ caret & IME

  _updateCaretAndBounds() {
    this._updateCaret();
    this._updateBounds();
  }

  _updateCaret() {
    if (this._nativeCaret) {
      // The browser paints the caret for the DOM selection; never ours.
      this.caret.style.display = "none";
      return;
    }
    const show = this.focused && (this._collapsed() || this.isComposing);
    if (!show) {
      this.caret.style.display = "none";
      return;
    }
    // While composing with a non-collapsed (selected) preedit — some IMEs on
    // Windows/macOS report one — the caret still sits at the focus end.
    const at = this.isComposing && !this._collapsed()
      ? Math.max(this.sel.anchor, this.sel.head)
      : Math.min(this.sel.anchor, this.sel.head);
    const rect = this.map.caretRectAt(at);
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
      // The IME anchors its candidate window to this rect (Linux IBus uses
      // nothing else), so a collapsed selection must resolve through the
      // caret geometry — including beside block objects — not a raw offset.
      selectionRect ??= this.map.caretRectAt(Math.min(this.sel.anchor, this.sel.head));
      ec.updateSelectionBounds(selectionRect && selectionRect.height > 0 ? selectionRect : containerRect);
    } catch {
      // Bounds are advisory; never crash on them.
    }
  }

  /**
   * Answer the IME's request for character rectangles. One rect per code
   * unit (grapheme clusters report the same rect for each unit), resolved
   * through the DOM points so decorated composition text measures correctly.
   */
  _onCharacterBoundsUpdate(e) {
    const rects = [];
    const text = this.map.flatText;
    let o = e.rangeStart;
    while (o < e.rangeEnd && rects.length < 1000) {
      const cpLen = o < text.length && text.codePointAt(o) > 0xffff ? 2 : 1;
      const rect =
        this.map.charRectAt(o) ??
        this.map.caretRectAt(o) ??
        this.element.getBoundingClientRect();
      rects.push(rect);
      if (cpLen === 2) rects.push(rect);
      o += cpLen;
    }
    try {
      this.editContext.updateCharacterBounds(e.rangeStart, rects);
    } catch {
      // Advisory only.
    }
  }

  /**
   * Re-render when the composition decorations change. Identical repeats
   * (typing-booster re-sends its formats on every keystroke) are skipped:
   * a mid-composition DOM teardown is the riskiest moment for the position
   * map, so it should not happen more often than necessary.
   */
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
    const next = formats
      .filter((f) => f && f.rangeEnd > f.rangeStart)
      .map((f) => ({
        rangeStart: f.rangeStart,
        rangeEnd: f.rangeEnd,
        underlineStyle: f.underlineStyle,
        underlineThickness: f.underlineThickness,
      }));
    if (JSON.stringify(next) === JSON.stringify(this.imeFormats)) return;
    this.imeFormats = next;
    // Re-render decorations only; the text is unchanged.
    this._ensureMapFresh();
    this.map = render(this.doc, this.element, { imeFormats: this.imeFormats });
    this.element.appendChild(this.caret);
    this._restoreDomSelection();
    this._updateCaretAndBounds();
  }

  /**
   * The map references DOM nodes; a mid-composition re-render that went
   * wrong (or a UA-side DOM mutation) can leave it pointing at detached
   * nodes, after which every measurement — caret, bounds, selection
   * restore — silently reports zeros. Detect that and rebuild.
   */
  _ensureMapFresh() {
    if (this.map.points.some((p) => !p.node.isConnected)) {
      this._afterMutation();
    }
  }

  _onCompositionStart() {
    this.isComposing = true;
    this.compositionRange = null;
    this._emit("compositionstart");
  }

  _onCompositionEnd() {
    this.isComposing = false;
    this.compositionRange = null;
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
        // Cancel the event so the UA does not also insert into the buffer
        // (and, for pastes, so no `paste` event follows); the shared guard
        // in _pasteFromDataTransfer deduplicates UAs that dispatch both.
        e.preventDefault();
        this._pasteFromDataTransfer(e.dataTransfer);
        return;
      }
      case "deleteContentBackward":
      case "deleteContentForward": {
        // Real key presses are applied to the buffer by the UA and mirrored
        // from textupdate — handling them here as well would delete twice.
        // Synthetic events (e.g. dispatched by browser extensions) never
        // reach the buffer, so the deletion is performed here instead.
        if (!e.isTrusted) {
          e.preventDefault();
          this._deleteFromBeforeInput(inputType);
        }
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
        // Remaining EditContext-handled inputTypes (insertText, …) are
        // applied to the buffer by the UA and mirrored in textupdate.
        return;
    }
  }

  /**
   * Handle `paste` events that never produce beforeinput(insertFromPaste) —
   * typically synthetic events dispatched by third-party code such as
   * browser extensions (real pastes are consumed, and canceled, by the
   * beforeinput handler before the paste event fires).
   */
  _onPaste(e) {
    e.preventDefault();
    this._pasteFromDataTransfer(e.clipboardData);
  }

  /**
   * Shared insertion path for beforeinput(insertFromPaste/insertFromDrop)
   * and the `paste` event. A real paste fires beforeinput first and is
   * canceled there, so no `paste` event follows; synthetic paste events
   * fire without beforeinput. The guard covers UAs that dispatch both for
   * the same content, so it is inserted only once.
   */
  _pasteFromDataTransfer(dt) {
    if (!dt || this._pasteGuard) return;
    this._pasteGuard = true;
    queueMicrotask(() => {
      this._pasteGuard = false;
    });
    this._insertFromDataTransfer(dt);
  }

  /**
   * Perform a deletion for a synthetic beforeinput(deleteContent*) event.
   * The range is computed the way the UA would compute it (the whole
   * selection, or one grapheme next to a collapsed caret) and then run
   * through the same flat-edit mirroring as a buffer deletion.
   */
  _deleteFromBeforeInput(inputType) {
    if (this.isComposing) return;
    const backward = inputType === "deleteContentBackward";
    const { from, to } = this._orderedSelection();
    if (to > from) {
      this._commitFlatEdit(from, to, "", from, from, null);
      return;
    }
    const flat = this.map.flatText;
    const a = backward ? previousGraphemeBoundary(flat, from) : from;
    const b = backward ? from : nextGraphemeBoundary(flat, from);
    if (a === b) return;
    this._commitFlatEdit(a, b, "", a, a, null);
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
    this.selection.onMouseDown(e);
  }

  _onKeyDown(e) {
    // A keypress ends any pending click context for margin-click selection.
    this.selection.discardMouse();
    // Custom caret mode: the browser never moves the caret. Intercept the
    // arrow keys on every UA, compute the target in the flat model, and
    // place the DOM selection + caret there ourselves (_arrowMoveModel).
    // Modifier combos (word/paragraph moves) and IME composition are left
    // to the browser and land here through selectionchange instead.
    if (
      !this._nativeCaret &&
      this.focused &&
      !this.isComposing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown")
    ) {
      e.preventDefault();
      this._arrowMoveModel(e.key, e.shiftKey);
      return;
    }
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
    // Backspace/Delete with the selection covering whole block objects
    // (table / block image) removes them in a transaction, leaving the
    // buffer untouched. Routing this through the textupdate mirroring is
    // unreliable: Chrome collapses EditContext selections that span object
    // characters after author updateText() calls, so by the time the second
    // keypress arrives the UA no longer sees the object selected.
    if (
      (e.key === "Backspace" || e.key === "Delete") &&
      !this.isComposing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.defaultPrevented
    ) {
      const { from, to } = this._orderedSelection();
      const segs = this.map.segments.filter(
        (s) => s.kind === "blockleaf" && s.start >= from && s.end <= to
      );
      if (segs.length && from === segs[0].start && to === segs[segs.length - 1].end) {
        e.preventDefault();
        this._removeBlockLeaves(segs, e.key === "Backspace" ? "backward" : "forward");
      }
    }
  }

  /**
   * Remove whole block leaves selected by the user. `dir` is the direction
   * of the key that triggered the removal: "backward" (Backspace) places the
   * caret at the start of the block that followed, "forward" (Delete) at the
   * end of the one before.
   */
  _removeBlockLeaves(segs, dir) {
    if (this.isComposing) return false;
    const seg = segs[0];
    const caretLoc =
      dir === "forward"
        ? this.map._nearbyContainerLoc(seg, "backward")
        : this.map._nearbyContainerLoc(seg, "forward");
    const removedTops = [...new Set(segs.map((s) => s.path[0]))];
    const ok = this._transact((doc) => {
      const paths = [...new Set(segs.map((s) => JSON.stringify(s.path)))]
        .map(JSON.parse)
        .sort((x, y) => comparePaths(y, x));
      for (const p of paths) ops.removeBlock(doc, p);
    });
    if (!ok) return false;
    const path = [...caretLoc.path];
    if (path.length) {
      // Blocks after a removed one shift down in the fresh position map.
      path[0] -= removedTops.filter((i) => i < path[0]).length;
    }
    const flat = this.map.locToFlat(path, caretLoc.offset);
    if (flat != null) {
      this._setSelection(flat, flat);
      // Render the new selection so the async DOM selectionchange round-trip
      // maps the fresh (not the pre-removal) DOM selection.
      this._afterRender();
    }
    return true;
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
    if (this.isComposing) {
      // The preedit range, for rendering the composition highlight; the
      // model selection itself tracks the composition cursor.
      this.compositionRange = { start: a, end: a + text.length };
    }
    this._commitFlatEdit(a, b, text, selA, selB, "typing");
  }

  /**
   * Apply a flat buffer-style edit [a, b) -> text to the model and finish
   * the update (render, caret, history). Shared by the textupdate mirroring
   * and by synthetic beforeinput events dispatched by third parties, which
   * never reach the EditContext buffer.
   */
  _commitFlatEdit(a, b, text, selA, selB, mergeKey) {
    const changed = this._applyFlatEdit(a, b, text);
    this._afterMutation();
    const max = this.map.flatText.length;
    const select = this._pendingSelectRange;
    const caretLoc = this._pendingCaretLoc;
    this._pendingSelectRange = null;
    this._pendingCaretLoc = null;
    if (select) {
      // The edit was deferred into a block selection (see _applyFlatEdit).
      this._setSelection(clamp(select[0], max), clamp(select[1], max));
    } else if (caretLoc) {
      // A deferred block removal: the UA's own selection refers to its
      // pre-resync buffer and cannot be used.
      const flat = this.map.locToFlat(caretLoc.path, caretLoc.offset);
      const at = flat == null ? clamp(selA, max) : clamp(flat, max);
      this._setSelection(at, at);
    } else {
      this._setSelection(clamp(selA, max), clamp(selB, max));
    }
    if (changed) this.history.record(this.doc, this.sel, mergeKey);
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

    // State deferred from the previous textupdate: a "select the block"
    // deferral (Backspace/Delete next to a table or block image) plus the
    // direction of the key that created it, so the follow-up keypress that
    // deletes the selected block can place the caret on the correct side.
    const deferredSelect = this._pendingSelectRange;
    const deferredDir = this._pendingSelectDir;
    const deferredRemoval =
      !!deferredSelect && !text && a === deferredSelect[0] && b === deferredSelect[1];
    this._pendingSelectRange = null;
    this._pendingSelectDir = null;
    this._pendingCaretLoc = null;

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
          // Backspace/Delete next to a table or block image selects that
          // block first (Word-style); pressing the key again with the block
          // selected deletes it. When the caret is inside the block, the
          // deletion is a no-op.
          const caretLoc = map.flatToLoc(b);
          const inside =
            caretLoc.path.length > gap.blockPath.length &&
            caretLoc.path.slice(0, gap.blockPath.length).every((v, i) => v === gap.blockPath[i]);
          if (inside) {
            joinLoc = caretLoc;
          } else {
            const seg = map.segments.find(
              (s) => s.kind === "blockleaf" && comparePaths(s.path, gap.blockPath) === 0
            );
            if (seg) {
              this._pendingSelectRange = [seg.start, seg.end];
              // The gap names the block as its "prev" when the gap sits after
              // the block — that is the Backspace side; otherwise Delete.
              this._pendingSelectDir =
                comparePaths(gap.blockPath, gap.nextPath) === 0 ? "forward" : "backward";
            } else {
              ops.removeBlock(this.doc, gap.blockPath);
            }
            joinLoc = map._nearbyContainerLoc(gap, "backward");
          }
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
          if (deferredRemoval) {
            // The UA reports the post-edit caret in *its* buffer coordinates,
            // which no longer match the model once a block is gone (the model
            // also drops the surrounding gaps and, for tables, the cell
            // text). Place the caret beside the removed block instead,
            // honoring the direction of the key that selected it.
            const seg = blockSegs[0];
            const loc =
              deferredDir === "forward"
                ? map._nearbyContainerLoc(seg, "backward")
                : map._nearbyContainerLoc(seg, "forward");
            const caretLoc = { path: [...loc.path], offset: loc.offset };
            if (caretLoc.path.length && caretLoc.path[0] > seg.path[0]) caretLoc.path[0] -= 1;
            this._pendingCaretLoc = caretLoc;
          }
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
    this._ensureMapFresh();
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
    // While composing the buffer selection belongs to the IME; pushing ours
    // would make Chromium adopt it mid-composition and derail the preedit.
    if (!this.isComposing) {
      this.editContext.updateSelection(start, end);
    }
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
    this.selection.discardMouse();
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
