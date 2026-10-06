import { getNode, isInlineContainer } from "./schema.js";

/** Inline-step length of a container's content (text length + 1 per leaf). */
export function inlineLength(node) {
  let len = 0;
  for (const child of node.children ?? []) {
    len += child.type === "text" ? child.text.length : 1;
  }
  return len;
}

/** All inline-container blocks (paragraph/heading) in document order, with paths. */
export function inlineContainers(doc) {
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

/** All top-level block indices in document order (paragraphs, headings, tables, images). */
export function topLevelBlockEntries(doc) {
  return (doc.children ?? []).map((node, index) => ({ node, path: [index] }));
}

/**
 * Compare two paths by tree position. Returns negative, 0 (same), or positive.
 * A path is "before" another if its node comes first in depth-first order.
 * Prefix paths sort before their descendants.
 */
export function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function samePath(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Ancestor paths of `path`, from the root's child down to `path` itself. */
export function ancestorPaths(path) {
  const out = [];
  for (let i = 1; i <= path.length; i++) out.push(path.slice(0, i));
  return out;
}

/** Find the nearest ancestor (including self) matching `predicate`. */
export function findAncestor(doc, path, predicate) {
  const paths = ancestorPaths(path);
  for (let i = paths.length - 1; i >= 0; i--) {
    const node = getNode(doc, paths[i]);
    if (node && predicate(node)) return { node, path: paths[i] };
  }
  return null;
}

/** Plain-text content of an inline container. */
export function containerText(node) {
  return (node.children ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export { getNode };
