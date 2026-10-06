/** Default stylesheet, injected once per document. */

export const EDITOR_CSS = `
.ec-editor {
  position: relative;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  -webkit-user-select: text;
  user-select: text;
  touch-action: manipulation;
  caret-color: transparent; /* we render our own caret */
  line-height: 1.5;
}
.ec-editor p, .ec-editor h1, .ec-editor h2, .ec-editor h3,
.ec-editor h4, .ec-editor h5, .ec-editor h6 {
  margin: 0 0 0.5em;
  line-height: 1.4;
}
.ec-editor h1 { font-size: 1.9em; font-weight: 700; }
.ec-editor h2 { font-size: 1.5em; font-weight: 700; }
.ec-editor h3 { font-size: 1.2em; font-weight: 600; }
.ec-editor h4 { font-size: 1.05em; font-weight: 600; }
.ec-editor h5 { font-size: 0.95em; font-weight: 600; }
.ec-editor h6 { font-size: 0.85em; font-weight: 600; }
.ec-editor code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  background: color-mix(in srgb, currentColor 8%, transparent);
  border-radius: 4px;
  padding: 0.05em 0.3em;
}
.ec-editor a {
  color: #4f6ef7;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: text;
}
.ec-link-dialog {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 10px;
  padding: 1em 1.1em;
  background: Canvas;
  color: CanvasText;
  min-width: 320px;
}
.ec-link-dialog::backdrop {
  background: rgb(0 0 0 / 0.25);
}
.ec-link-dialog form {
  display: grid;
  gap: 0.6em;
  margin: 0;
}
.ec-link-dialog input {
  font: inherit;
  padding: 0.35em 0.5em;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.ec-link-hint {
  margin: 0;
  font-size: 0.82em;
  color: color-mix(in srgb, CanvasText 60%, transparent);
}
.ec-link-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5em;
}
.ec-link-buttons button {
  font: inherit;
  padding: 0.3em 0.9em;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ec-link-buttons button[type="submit"] {
  background: #4f6ef7;
  border-color: #4f6ef7;
  color: white;
}
.ec-link-buttons button:first-child {
  margin-right: auto;
}
.ec-ime {
  /* IME composition underline decorations come from textformatupdate. */
}
.ec-caret {
  position: absolute;
  top: 0;
  left: 0;
  width: 1.5px;
  background: currentColor;
  pointer-events: none;
  z-index: 2;
}
.ec-focused .ec-caret {
  animation: ec-caret-blink 1.1s step-end infinite;
}
@keyframes ec-caret-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.ec-show-placeholder::before {
  content: attr(data-ec-placeholder);
  position: absolute;
  color: color-mix(in srgb, currentColor 38%, transparent);
  pointer-events: none;
}
.ec-table {
  border-collapse: collapse;
  margin: 0.5em 0;
  width: 100%;
}
.ec-table td {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.35em 0.6em;
  vertical-align: top;
  min-width: 3em;
}
.ec-table td > p:last-child { margin-bottom: 0; }
.ec-block-image {
  margin: 0.6em 0;
}
.ec-block-image img { max-width: 100%; height: auto; display: block; }
.ec-inline-image {
  max-width: 100%;
  height: auto;
  vertical-align: text-bottom;
}
.ec-editor .ec-selected {
  outline: 2px solid #4f6ef7;
  outline-offset: 1px;
  border-radius: 2px;
}
.ec-empty-br {
  /* placeholder <br> that gives empty blocks height */
}
`;

let injected = new WeakSet();

export function injectStyles(root = document) {
  if (injected.has(root)) return;
  injected.add(root);
  const style = root.createElement("style");
  style.dataset.ecStyles = "";
  style.textContent = EDITOR_CSS;
  (root.head ?? root.documentElement).appendChild(style);
}
