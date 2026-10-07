/**
 * Selection logic — everything about where the caret and selection are and
 * how they move.
 *
 * In custom caret mode (`caretMode: "custom"`, the default) the browser never
 * moves the caret: arrow keys are intercepted, the target is computed in the
 * editor's own flat model (per-grapheme steps, object selection when stepping
 * onto an image/table, cell-by-cell table traversal, table escapes), and the
 * DOM selection + drawn caret are placed there by this code. Clicks, drags,
 * Home/End and word moves still arrive as DOM `selectionchange` events and are
 * mapped back to buffer offsets here (margin clicks beside a block object
 * select the object, so tables and block images are selectable without arrow
 * keys). In `caretMode: "native"` only the external-placement mapping and the
 * click-to-select paths run; caret movement is left to the browser.
 *
 */

export class SelectionController {
  constructor(editor) {
    this.ed = editor;
    this._mouseAt = null; // last mousedown point, consumed by the next selectionchange
    this._segmenter = null;
  }

  // ------------------------------------------------------------- state

  get() {
    return { ...this.ed.sel };
  }

  /** Set the model selection and mirror it into the EditContext (no DOM/caret). */
  set(anchor, head) {
    this.ed.sel = { anchor, head };
    const start = Math.min(anchor, head);
    const end = Math.max(anchor, head);
    if (!this.ed.isComposing) {
      this.ed.editContext.updateSelection(start, end);
    }
  }

  /** Set the model selection and render it: DOM selection, highlight, caret. */
  apply(anchor, head) {
    this.ed.sel = { anchor, head };
    this.ed.storedMarks = [];
    const start = Math.min(anchor, head);
    const end = Math.max(anchor, head);
    if (!this.ed.isComposing) {
      this.ed.editContext.updateSelection(start, end);
    }
    this.restoreDom();
    this.ed._updateSelectedNode();
    this.ed._updateCaretAndBounds();
    this.ed._emit("selectionchange");
  }

  /**
   * Render the current model selection into the DOM. Selections covering
   * whole block objects cover their contents, so the browser paints a
   * highlight over the object; a bare element-boundary selection only draws
   * a tall bar at the edge.
   */
  restoreDom() {
    const ed = this.ed;
    const domSel = ed.element.ownerDocument.getSelection();
    if (!domSel) return;
    // During composition the DOM selection highlights the preedit range so
    // the user sees what is being composed; the model selection tracks the
    // composition cursor separately.
    const comp = ed.isComposing && ed.compositionRange ? ed.compositionRange : null;
    const from = comp ? comp.start : Math.min(ed.sel.anchor, ed.sel.head);
    const to = comp ? comp.end : Math.max(ed.sel.anchor, ed.sel.head);
    let anchorPoint = null;
    let focusPoint = null;
    const blockSegs = ed.map.segments.filter(
      (s) => s.kind === "blockleaf" && s.start >= from && s.end <= to
    );
    if (!comp && blockSegs.length && blockSegs[0].start === from && blockSegs[blockSegs.length - 1].end === to) {
      const first = blockSegs[0];
      const last = blockSegs[blockSegs.length - 1];
      anchorPoint =
        ed.sel.anchor <= ed.sel.head
          ? { node: first.dom, offset: 0 }
          : { node: last.dom, offset: last.dom.childNodes.length };
      focusPoint =
        ed.sel.anchor <= ed.sel.head
          ? { node: last.dom, offset: last.dom.childNodes.length }
          : { node: first.dom, offset: 0 };
    } else {
      anchorPoint = ed.map.flatToDomPoint(from);
      focusPoint = ed.map.flatToDomPoint(to);
    }
    if (!anchorPoint || !focusPoint) return;
    const forward = comp ? true : ed.sel.anchor <= ed.sel.head;
    ed._settingDomSelection = true;
    try {
      if (forward) {
        domSel.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset);
      } else {
        domSel.setBaseAndExtent(focusPoint.node, focusPoint.offset, anchorPoint.node, anchorPoint.offset);
      }
    } catch {
      // Points may be briefly stale during re-render; ignore.
    } finally {
      ed._settingDomSelection = false;
    }
  }

  // ------------------------------------------------- external placements

  /**
   * The DOM selection changed without the editor placing it (clicks, drags,
   * Home/End, word moves — arrow keys never reach this in custom mode).
   * Map it back to the model. A click in the margin beside a table or block
   * image selects the object instead of parking the caret at a corner.
   */
  onChange() {
    const ed = this.ed;
    if (ed._settingDomSelection || !ed.focused) return;
    // While composing, the IME owns the selection; transient DOM selection
    // changes caused by our own re-renders must not feed back into the model
    // (a detached-node selectionchange would land the caret at offset 0).
    if (ed.isComposing) return;
    const domSel = ed.element.ownerDocument.getSelection();
    if (!domSel || domSel.rangeCount === 0) return;
    const anchorFlat = ed.map.domPointToFlat(domSel.anchorNode, domSel.anchorOffset);
    const focusFlat = ed.map.domPointToFlat(domSel.focusNode, domSel.focusOffset);
    if (anchorFlat == null || focusFlat == null) return;
    const mouse =
      this._mouseAt && Date.now() - this._mouseAt.time < 1000 ? this._mouseAt : null;
    if (!mouse) this._mouseAt = null;
    if (anchorFlat === focusFlat && mouse) {
      const obj = this._marginObject(anchorFlat, mouse);
      if (obj) {
        // Promoted: the click cascade is done.
        this._mouseAt = null;
        this.apply(obj.start, obj.end);
        return;
      }
      // Not beside an object after all: keep the point — the browser may
      // adjust the caret once more before the click settles (a keypress
      // discards it via discardMouse()).
    }
    if (anchorFlat === ed.sel.anchor && focusFlat === ed.sel.head) return;
    ed.sel = { anchor: anchorFlat, head: focusFlat };
    ed.storedMarks = [];
    ed.editContext.updateSelection(Math.min(anchorFlat, focusFlat), Math.max(anchorFlat, focusFlat));
    ed._updateSelectedNode();
    ed._updateCaretAndBounds();
    ed._emit("selectionchange");
  }

  /** A keypress or blur ends the click context (see _mouseAt). */
  discardMouse() {
    this._mouseAt = null;
  }

  /** Block object (table / block image) a margin click beside `f` should select. */
  _marginObject(f, pt) {
    const segs = this.ed.map.segments;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.kind !== "blockleaf" || !s.dom) continue;
      const before = segs[i - 1];
      const after = segs[i + 1];
      const besideLeft = before?.kind === "gap" && f >= before.start && f <= s.start;
      const besideRight = after?.kind === "gap" && f >= s.end && f <= after.end;
      if (!besideLeft && !besideRight) continue;
      const r = (s.dom.querySelector("img") ?? s.dom).getBoundingClientRect();
      if (pt.y < r.top - 4 || pt.y > r.bottom + 4) continue;
      const dist = pt.x < r.left ? r.left - pt.x : pt.x - r.right;
      if (dist > 2 && dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    return best;
  }

  onMouseDown(e) {
    const ed = this.ed;
    if (!(e.target instanceof Element)) return;
    const anchor = e.target.closest("a");
    if (anchor && ed.element.contains(anchor)) {
      if (e.type === "click") e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (e.target.tagName !== "IMG" || !ed.element.contains(e.target)) {
      // Remember the point: if the click lands beside a block object and out
      // in the margin, the selectionchange promotes it to an object selection.
      this._mouseAt = { x: e.clientX, y: e.clientY, time: Date.now() };
      return;
    }
    const figure = e.target.closest("figure");
    const seg =
      ed.map.segments.find((s) => s.dom === e.target) ??
      (figure ? ed.map.segments.find((s) => s.kind === "blockleaf" && s.dom === figure) : null);
    if (!seg) return;
    e.preventDefault();
    ed.element.focus();
    ed._setSelection(seg.start, seg.end);
    this.restoreDom();
    ed._updateSelectedNode();
    ed._updateCaretAndBounds();
    ed._emit("selectionchange");
  }

  // -------------------------------------------- model-based arrow movement

  _selectedObjectSeg() {
    const ed = this.ed;
    const lo = Math.min(ed.sel.anchor, ed.sel.head);
    const hi = Math.max(ed.sel.anchor, ed.sel.head);
    return (
      ed.map.segments.find(
        (s) => (s.kind === "leaf" || s.kind === "blockleaf") && s.start === lo && s.end === hi
      ) ?? null
    );
  }

  _graphemeStep(f, seg, forward) {
    const text = this.ed.map.flatText.slice(seg.start, seg.end);
    try {
      this._segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const local = f - seg.start;
      for (const { index, segment } of this._segmenter.segment(text)) {
        if (forward && index === local) return seg.start + index + segment.length;
        if (!forward && index + segment.length === local) return seg.start + index;
      }
    } catch {
      // no segmenter: fall through to code-unit stepping
    }
    return forward ? Math.min(f + 1, seg.end) : Math.max(f - 1, seg.start);
  }

  _objectAtStart(f) {
    return (
      this.ed.map.segments.find(
        (s) => (s.kind === "leaf" || s.kind === "blockleaf") && s.start === f
      ) ?? null
    );
  }

  /** A table's object char directly continues its cell text (no gap between). */
  _tableAbuts(obj) {
    return obj.kind === "blockleaf" && this.ed.map.contentEndsAt(obj.start);
  }

  /** One ArrowRight step in flat space. */
  _stepRight(f) {
    const segs = this.ed.map.segments;
    const text = segs.find((s) => s.kind === "text" && s.start <= f && f < s.end);
    if (text) {
      const g = this._graphemeStep(f, text, true);
      const obj = this._objectAtStart(g);
      // Stepping onto an inline object selects it — except an abutting
      // table, which is visited collapsed first.
      if (obj && !(obj.kind === "blockleaf" && this._tableAbuts(obj))) {
        return { t: "select", seg: obj };
      }
      return { t: "rest", f: g };
    }
    const endSeg = segs.find((s) => s.kind === "text" && s.end === f);
    const obj = this._objectAtStart(f);
    if (endSeg) {
      if (obj) return { t: "select", seg: obj }; // end of cell text: object char
      const next = segs[segs.indexOf(endSeg) + 1];
      if (next?.kind === "gap") {
        const after = segs[segs.indexOf(next) + 1];
        if (!after) return { t: "stay" };
        if (after.kind === "leaf" || after.kind === "blockleaf") return { t: "select", seg: after };
        return { t: "rest", f: after.start };
      }
      if (next && next.kind === "text") return { t: "rest", f: next.start };
      return { t: "stay" };
    }
    if (obj) return { t: "select", seg: obj }; // beside an object
    const gap = segs.find((s) => s.kind === "gap" && s.start <= f && f < s.end);
    if (gap) {
      const after = segs[segs.indexOf(gap) + 1];
      if (!after) return { t: "stay" };
      if (after.kind === "leaf" || after.kind === "blockleaf") return { t: "select", seg: after };
      return { t: "rest", f: after.start };
    }
    return { t: "stay" };
  }

  /** One ArrowLeft step in flat space. */
  _stepLeft(f) {
    const segs = this.ed.map.segments;
    // Walking left goes through a table's contents cell by cell and escapes
    // only from its first cell — never out of the table's far end.
    const text = segs.find((s) => s.kind === "text" && s.start < f && f <= s.end);
    if (text) return { t: "rest", f: this._graphemeStep(f, text, false) };
    const startSeg = segs.find((s) => s.kind === "text" && s.start === f);
    if (startSeg) {
      const i = segs.indexOf(startSeg);
      const prev = segs[i - 1];
      if (prev?.kind === "gap") {
        const before = segs[i - 2];
        if (prev.action === "noop" || !before || before.kind === "text") {
          if (!before) return { t: "stay" };
          return { t: "rest", f: before.kind === "gap" ? before.start : before.end };
        }
        if (before.kind === "leaf") return { t: "select", seg: before };
        if (before.kind === "blockleaf") {
          // A block after a table: visit the position after it; an image:
          // select it.
          if (this._tableAbuts(before)) return { t: "rest", f: before.end };
          return { t: "select", seg: before };
        }
        return { t: "stay" };
      }
      if (prev?.kind === "leaf") return { t: "select", seg: prev }; // after inline image
      return { t: "stay" };
    }
    const obj = this._objectAtStart(f);
    if (obj) return { t: "rest", f: Math.max(f - 1, 0) }; // walk past a block object
    const gap = segs.find((s) => s.kind === "gap" && s.start <= f && f < s.end);
    if (gap) {
      const before = segs[segs.indexOf(gap) - 1];
      if (!before) return { t: "stay" };
      if (before.kind === "gap") return { t: "rest", f: before.start };
      if (before.kind === "leaf") return { t: "select", seg: before };
      if (before.kind === "blockleaf") {
        if (this._tableAbuts(before)) return { t: "rest", f: before.start }; // into the cells
        return { t: "select", seg: before };
      }
      if (before.kind === "text") return { t: "rest", f: before.end };
      return { t: "stay" };
    }
    return { t: "stay" };
  }

  arrowMove(key, extend) {
    const ed = this.ed;
    const right = key === "ArrowRight";
    const left = key === "ArrowLeft";
    const selObj = this._selectedObjectSeg();
    let edge;
    if (selObj) {
      if (right || left) {
        // Stepping away from a selected object: the press crosses the gap
        // beside the object — an object on the far side gets selected
        // directly (symmetric both ways), a text block on the right lands
        // the caret at its start, and anything else (or nothing) collapses
        // beside the object. For a table, "beside" on the left is its last
        // cell's end: arrowing left walks into the table and continues
        // through its contents.
        const segs = ed.map.segments;
        const i = segs.indexOf(selObj);
        const gap = segs[i + (right ? 1 : -1)];
        const beyond = gap?.kind === "gap" ? segs[i + (right ? 2 : -2)] : null;
        if (beyond && (beyond.kind === "leaf" || beyond.kind === "blockleaf")) {
          if (extend) {
            this.apply(ed.sel.anchor, left ? beyond.start : beyond.end);
          } else {
            this.apply(beyond.start, beyond.end);
          }
          return;
        }
        if (right && beyond?.kind === "text") {
          this.apply(extend ? ed.sel.anchor : beyond.start, beyond.start);
          return;
        }
        const beside = left ? selObj.start : selObj.end;
        this.apply(extend ? ed.sel.anchor : beside, beside);
        return;
      }
      edge = key === "ArrowUp" ? selObj.start : selObj.end - 1;
    } else {
      const lo = Math.min(ed.sel.anchor, ed.sel.head);
      const hi = Math.max(ed.sel.anchor, ed.sel.head);
      if (key === "ArrowUp") edge = lo;
      else if (key === "ArrowDown") edge = hi;
      else if (extend) edge = ed.sel.head;
      else edge = right ? hi : lo;
    }
    let result = null;
    if (right || left) {
      result = right ? this._stepRight(edge) : this._stepLeft(edge);
    } else {
      // Vertical: ask the UA's hit testing for the point above/below the caret.
      const r = ed.map.caretRectAt(edge);
      const doc = ed.element.ownerDocument;
      if (r && typeof doc.caretRangeFromPoint === "function") {
        const y = key === "ArrowUp" ? r.top - 1 : r.bottom + 1;
        try {
          const range = doc.caretRangeFromPoint(r.left, y);
          const nf = range && ed.map.domPointToFlat(range.startContainer, range.startOffset);
          if (nf != null && nf !== edge) result = { t: "rest", f: nf };
        } catch {
          // ignore and stay
        }
      }
    }
    if (!result || result.t === "stay") return;
    if (result.t === "select") {
      // Stepping onto an object selects it — the same state as click-select.
      const seg = result.seg;
      if (extend) this.apply(ed.sel.anchor, seg.end);
      else this.apply(seg.start, seg.end);
      return;
    }
    if (extend) this.apply(ed.sel.anchor, result.f);
    else this.apply(result.f, result.f);
  }
}
