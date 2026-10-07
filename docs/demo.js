import {
  Editor,
  createToolbar,
  COMMENT_FEATURES,
  isEditContextSupported,
} from "./lib/index.js";

const $ = (id) => document.getElementById(id);

if (!isEditContextSupported()) {
  $("support-banner").hidden = false;
}

// Caret mode: "custom" (default) has the library draw and move the caret;
// "native" leaves caret drawing and movement entirely to the browser.
// Selected via the header switch, persisted in the URL (?caret=native).
const caretMode =
  new URLSearchParams(location.search).get("caret") === "native" ? "native" : "custom";
{
  const select = $("caret-mode");
  select.value = caretMode;
  select.addEventListener("change", () => {
    const url = new URL(location.href);
    if (select.value === "native") url.searchParams.set("caret", "native");
    else url.searchParams.delete("caret");
    location.href = url.href;
  });
}

const EXAMPLE_DOC = {
  type: "doc",
  children: [
    {
      type: "heading",
      attrs: { level: 1 },
      children: [{ type: "text", text: "editcontext-editor", marks: [] }],
    },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "A rich text editor built on ", marks: [] },
        { type: "text", text: "EditContext", marks: ["bold"] },
        { type: "text", text: " — not ", marks: [] },
        { type: "text", text: "contenteditable", marks: ["code"] },
        { type: "text", text: ". Try typing here, including with an ", marks: [] },
        { type: "text", text: "IME", marks: ["italic"] },
        { type: "text", text: " if you have one installed.", marks: [] },
      ],
    },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "This paragraph has an inline image ", marks: [] },
        {
          type: "image",
          attrs: { src: "https://picsum.photos/seed/ec-inline/96/48", alt: "inline sample", width: 96, height: 48 },
        },
        { type: "text", text: " right in the middle of the text.", marks: [] },
      ],
    },
    {
      type: "table",
      children: [
        {
          type: "table_row",
          children: [
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "Feature", marks: ["bold"] }] }] },
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "Status", marks: ["bold"] }] }] },
          ],
        },
        {
          type: "table_row",
          children: [
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "Keyboard input", marks: [] }] }] },
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "✔", marks: [] }] }] },
          ],
        },
        {
          type: "table_row",
          children: [
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "IME composition", marks: [] }] }] },
            { type: "table_cell", children: [{ type: "paragraph", children: [{ type: "text", text: "✔", marks: [] }] }] },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: { src: "https://picsum.photos/seed/ec-block/640/240", alt: "block image sample", width: 640, height: 240 },
    },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Below the surface, everything is stored as a JSON document ", marks: [] },
        { type: "text", text: "with its own schema", marks: ["underline"] },
        { type: "text", text: " — inspect it in the panes underneath the editor.", marks: [] },
      ],
    },
  ],
};

// ---------------------------------------------------------------- full editor

const full = new Editor({
  element: $("editor-full"),
  content: EXAMPLE_DOC,
  placeholder: "Type something…",
  enterKeyHint: "enter",
  caretMode,
});
$("toolbar-full").appendChild(createToolbar(full));

const jsonOut = $("json-out");
const htmlOut = $("html-out");
let lastJSON = "";
let lastHTML = "";

function refreshExports() {
  lastJSON = JSON.stringify(full.getJSON(), null, 2);
  lastHTML = full.getHTML();
  jsonOut.textContent = lastJSON;
  htmlOut.textContent = lastHTML;
}
full.on("change", refreshExports);
refreshExports();

$("copy-json").addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastJSON);
});
$("copy-html").addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastHTML);
});

$("load-example").addEventListener("click", () => {
  full.setJSON(EXAMPLE_DOC);
  $("import-input").value = "";
});

$("import-load").addEventListener("click", () => {
  const value = $("import-input").value.trim();
  if (!value) return;
  try {
    full.setContent(value);
  } catch (err) {
    alert(`Could not load content: ${err.message}`);
  }
});

// ------------------------------------------------------------- events pane
//
// Live monitor of the events the full editor sees. Listeners are registered
// after the editor's own, so `defaultPrevented` already reflects whether the
// editor handled the event (shown as the "canceled" tag).

const eventsOut = $("events-out");
const MAX_EVENT_ROWS = 300;
const SRC_ELEMENT = { label: "element", cls: "ev-el" };
const SRC_EDITCONTEXT = { label: "EditContext", cls: "ev-ec" };
const SRC_DOCUMENT = { label: "document", cls: "ev-doc" };

function showEventsEmpty() {
  const empty = document.createElement("div");
  empty.className = "events-empty";
  empty.textContent =
    "No events yet — click into the editor above, then type, paste, undo, use an IME…";
  eventsOut.replaceChildren(empty);
}

function clip(text, max = 40) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One-line, human-readable summary of a DOM / EditContext event. */
function eventDetail(e) {
  const parts = [];
  switch (e.type) {
    case "keydown":
    case "keyup": {
      const mods = [e.ctrlKey && "Ctrl", e.metaKey && "⌘", e.altKey && "Alt", e.shiftKey && "Shift"]
        .filter(Boolean);
      parts.push(`key ${JSON.stringify(e.key)}`, e.code, ...mods);
      if (e.isComposing) parts.push("isComposing");
      break;
    }
    case "beforeinput": {
      parts.push(e.inputType);
      if (e.data != null) parts.push(`data ${JSON.stringify(e.data)}`);
      if (e.dataTransfer) parts.push(`transfer [${[...e.dataTransfer.types].join(", ")}]`);
      if (e.isComposing) parts.push("isComposing");
      break;
    }
    case "textupdate": {
      const a = e.updateRangeStart ?? e.updateTextStart ?? 0;
      const b = e.updateRangeEnd ?? e.updateTextEnd ?? a;
      parts.push(`range [${a}, ${b})`, `text ${JSON.stringify(clip(e.text ?? e.updateText ?? ""))}`);
      break;
    }
    case "characterboundsupdate":
      parts.push(`range [${e.rangeStart}, ${e.rangeEnd})`);
      break;
    case "textformatupdate": {
      let formats = [];
      if (typeof e.getTextFormats === "function") {
        formats = e.getTextFormats() ?? [];
      } else if (e.rangeStart != null || e.formatRangeStart != null) {
        formats = [{
          rangeStart: e.rangeStart ?? e.formatRangeStart,
          rangeEnd: e.rangeEnd ?? e.formatRangeEnd,
          underlineStyle: e.underlineStyle,
        }];
      }
      for (const f of formats) {
        parts.push(`[${f.rangeStart}, ${f.rangeEnd}) ${f.underlineStyle ?? "underline"}`);
      }
      break;
    }
    case "paste":
    case "copy":
    case "cut": {
      const types = e.clipboardData ? [...e.clipboardData.types] : [];
      if (types.length) parts.push(`clipboard [${types.join(", ")}]`);
      break;
    }
    case "selectionchange": {
      const sel = full.getSelection();
      parts.push(`model sel [${sel.anchor}, ${sel.head}]`);
      break;
    }
    default:
      if (e.data != null) parts.push(`data ${JSON.stringify(e.data)}`);
  }
  return parts.join("  ");
}

function logEvent(source, e) {
  eventsOut.querySelector(".events-empty")?.remove();
  const row = document.createElement("div");
  row.className = "ev-row";

  const time = document.createElement("span");
  time.className = "ev-time";
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  time.textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;

  const tag = document.createElement("span");
  tag.className = `ev-tag ${source.cls}`;
  tag.textContent = source.label;

  const name = document.createElement("span");
  name.className = "ev-name";
  name.textContent = e.type;

  row.append(time, tag, name);
  const detail = eventDetail(e);
  if (detail) {
    const el = document.createElement("span");
    el.className = "ev-detail";
    el.textContent = detail;
    row.append(el);
  }
  if (e.cancelable && e.defaultPrevented) {
    const canceled = document.createElement("span");
    canceled.className = "ev-tag ev-cancelled";
    canceled.textContent = "canceled";
    row.append(canceled);
  }

  eventsOut.prepend(row);
  while (eventsOut.children.length > MAX_EVENT_ROWS) eventsOut.lastChild.remove();
}

for (const type of [
  "keydown", "keyup", "beforeinput", "compositionstart", "compositionupdate",
  "compositionend", "paste", "copy", "cut", "focus", "blur",
]) {
  full.element.addEventListener(type, (e) => logEvent(SRC_ELEMENT, e));
}

const editContext = full.element.editContext;
for (const type of [
  "textupdate", "textformatupdate", "characterboundsupdate",
  "compositionstart", "compositionend",
]) {
  editContext.addEventListener(type, (e) => logEvent(SRC_EDITCONTEXT, e));
}

// Document-level selectionchange is only meaningful for the editor while it
// has focus (otherwise the pane fills up with selections elsewhere on the page).
document.addEventListener("selectionchange", (e) => {
  if (document.activeElement !== full.element) return;
  logEvent(SRC_DOCUMENT, e);
});

$("events-clear").addEventListener("click", showEventsEmpty);
showEventsEmpty();

// -------------------------------------------------------------- comment box

const comment = new Editor({
  element: $("editor-comment"),
  placeholder: "Leave a comment… (select text for formatting)",
  enterKeyHint: "enter",
  caretMode,
});
$("toolbar-comment").appendChild(
  createToolbar(comment, { features: COMMENT_FEATURES, blockTypes: [2, 3] })
);

$("comment-post").addEventListener("click", () => {
  const out = $("comment-out");
  const json = JSON.stringify(comment.getJSON(), null, 2);
  out.hidden = false;
  out.textContent = json;
  $("comment-status").textContent = "Posted! (not really — here's the JSON that would be sent)";
  comment.setJSON({ type: "doc", children: [{ type: "paragraph", children: [] }] });
});

// Demo hooks for automated testing / debugging.
window.__demo = { full, comment, caretMode };
