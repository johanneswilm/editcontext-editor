import { cloneDoc } from "./schema.js";

/**
 * Snapshot-based undo history. States are captured *after* each mutation;
 * `record()` may be given a `mergeKey` to coalesce rapid sequences (typing)
 * into a single undo step.
 */
export class History {
  constructor({ limit = 200 } = {}) {
    this.limit = limit;
    this.states = [];
    this.index = -1;
    this.lastKey = null;
    this.lastTime = 0;
  }

  seed(doc, selection) {
    this.states = [{ doc: cloneDoc(doc), selection: { ...selection } }];
    this.index = 0;
    this.lastKey = null;
    this.lastTime = 0;
  }

  record(doc, selection, mergeKey = null) {
    const now = Date.now();
    const canMerge =
      mergeKey != null &&
      mergeKey === this.lastKey &&
      now - this.lastTime < 1000 &&
      this.index === this.states.length - 1;

    const state = { doc: cloneDoc(doc), selection: { ...selection } };
    if (canMerge) {
      this.states[this.index] = state;
    } else {
      this.states.length = this.index + 1;
      this.states.push(state);
      if (this.states.length > this.limit) this.states.shift();
      this.index = this.states.length - 1;
    }
    this.lastKey = mergeKey;
    this.lastTime = now;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.states.length - 1;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    this.lastKey = null;
    return this.states[this.index];
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    this.lastKey = null;
    return this.states[this.index];
  }
}
