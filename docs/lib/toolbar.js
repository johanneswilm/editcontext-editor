/**
 * A ready-made toolbar. Deliberately plain: a row of buttons + a block-type
 * select, styled via classes so apps can restyle. Mousedown is prevented so
 * clicking the toolbar does not steal focus from the editor.
 *
 *   const toolbar = createToolbar(editor, { features: ["bold", "italic", …] });
 *   container.appendChild(toolbar);
 *
 * Default feature set targets a "blog comment box": bold, italic, underline,
 * strike, code, block types, undo/redo. Add "image" / "table" for the full set.
 */

const BUTTONS = {
  bold: { label: "B", title: "Bold (Ctrl+B)", mark: "bold", style: "font-weight:700" },
  italic: { label: "I", title: "Italic (Ctrl+I)", mark: "italic", style: "font-style:italic" },
  underline: { label: "U", title: "Underline (Ctrl+U)", mark: "underline", style: "text-decoration:underline" },
  strike: { label: "S", title: "Strikethrough", mark: "strikethrough", style: "text-decoration:line-through" },
  code: { label: "<>", title: "Code", mark: "code", style: "font-family:monospace" },
  undo: { label: "↺", title: "Undo (Ctrl+Z)" },
  redo: { label: "↻", title: "Redo (Ctrl+Y)" },
  image: { label: "🖼", title: "Insert image" },
  table: { label: "⊞", title: "Insert table" },
  link: { label: "🔗", title: "Insert link" },
};

export const COMMENT_FEATURES = ["bold", "italic", "underline", "strike", "code"];
export const FULL_FEATURES = [
  "undo", "redo",
  "bold", "italic", "underline", "strike", "code",
  "link", "image", "table",
];

export function createToolbar(editor, { features = FULL_FEATURES, blockTypes = [1, 2, 3] } = {}) {
  const doc = editor.element.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "ec-toolbar";
  bar.setAttribute("role", "toolbar");

  const preventFocus = (e) => e.preventDefault(); // keep editor focus

  const buttons = new Map();
  const addButton = (key, onClick) => {
    const def = BUTTONS[key];
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = `ec-btn ec-btn-${key}`;
    btn.title = def.title;
    btn.setAttribute("aria-label", def.title);
    btn.textContent = def.label;
    if (def.style) btn.style.cssText = def.style;
    btn.addEventListener("mousedown", preventFocus);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
      editor.focus();
    });
    bar.appendChild(btn);
    buttons.set(key, btn);
    return btn;
  };

  for (const feature of features) {
    switch (feature) {
      case "undo":
        addButton("undo", () => editor.undo());
        break;
      case "redo":
        addButton("redo", () => editor.redo());
        break;
      case "bold":
        addButton("bold", () => editor.toggleBold());
        break;
      case "italic":
        addButton("italic", () => editor.toggleItalic());
        break;
      case "underline":
        addButton("underline", () => editor.toggleUnderline());
        break;
      case "strike":
        addButton("strike", () => editor.toggleStrikethrough());
        break;
      case "code":
        addButton("code", () => editor.toggleCode());
        break;
      case "image":
        addButton("image", () => {
          const src = promptImageUrl();
          if (!src) return;
          editor.insertImage({ src, inline: true });
        });
        break;
      case "table":
        addButton("table", () => editor.insertTable(2, 2));
        break;
      case "link":
        addButton("link", () => openLinkDialog(editor));
        break;
    }
  }

  if (blockTypes?.length) {
    const select = doc.createElement("select");
    select.className = "ec-block-select";
    select.setAttribute("aria-label", "Block type");
    // Note: no mousedown prevention here — unlike the buttons, a select
    // needs its default mousedown behavior to open the native dropdown.
    const options = [
      ["paragraph", "Paragraph"],
      ...blockTypes.map((level) => [`h${level}`, `Heading ${level}`]),
    ];
    for (const [value, label] of options) {
      const opt = doc.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      if (select.value === "paragraph") editor.setParagraph();
      else editor.setHeading(Number(select.value.slice(1)));
      editor.focus();
    });
    bar.appendChild(select);
    buttons.set("block", select);
  }

  const refresh = () => {
    const marks = new Set(editor.getActiveMarks());
    for (const [key, btn] of buttons) {
      const def = BUTTONS[key];
      if (def?.mark) {
        const active = marks.has(def.mark);
        btn.classList.toggle("ec-active", active);
        btn.setAttribute("aria-pressed", String(active));
      }
    }
    if (buttons.has("block")) {
      const select = buttons.get("block");
      const type = editor.getBlockType();
      const level = editor.getHeadingLevel();
      select.value = type === "heading" && level ? `h${level}` : "paragraph";
    }
    const undoBtn = buttons.get("undo");
    if (undoBtn) undoBtn.disabled = !editor.history.canUndo;
    const redoBtn = buttons.get("redo");
    if (redoBtn) redoBtn.disabled = !editor.history.canRedo;
  };

  editor.on("selectionchange", refresh);
  editor.on("change", refresh);
  refresh();

  return bar;
}

function promptImageUrl() {
  try {
    return window.prompt("Image URL:", "https://")?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Link dialog: URL + optional title (accessibility). Prefilled when the
 * caret/selection is on an existing link, which can then also be removed.
 * Uses a native <dialog> when available.
 */
function openLinkDialog(editor) {
  const doc = editor.element.ownerDocument;
  let ui = editor.__linkDialog;
  if (!ui) {
    const dlg = doc.createElement("dialog");
    dlg.className = "ec-link-dialog";
    const form = doc.createElement("form");
    form.method = "dialog";

    const url = doc.createElement("input");
    url.type = "url";
    url.required = true;
    url.placeholder = "https://…";
    url.setAttribute("aria-label", "Link URL");
    url.className = "ec-link-url";

    const title = doc.createElement("input");
    title.type = "text";
    title.placeholder = "Title (accessibility, optional)";
    title.setAttribute("aria-label", "Link title");
    title.className = "ec-link-title";

    const hint = doc.createElement("p");
    hint.className = "ec-link-hint";
    hint.textContent = "Select the text to link first, or place the caret on an existing link to edit it.";

    const buttons = doc.createElement("div");
    buttons.className = "ec-link-buttons";
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove link";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const apply = doc.createElement("button");
    apply.type = "submit";
    apply.textContent = "Apply";
    buttons.append(remove, cancel, apply);

    form.append(url, title, hint, buttons);
    dlg.append(form);
    doc.body.append(dlg);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!url.value.trim()) return;
      editor.setLink({ href: url.value.trim(), title: title.value.trim() });
      dlg.close();
    });
    remove.addEventListener("click", () => {
      editor.unsetLink();
      dlg.close();
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => editor.focus());

    ui = editor.__linkDialog = { dlg, url, title, hint, remove };
  }

  const link = editor.getActiveLink();
  const { from, to } = editor.getSelection();
  ui.url.value = link?.href ?? "";
  ui.title.value = link?.title ?? "";
  ui.remove.hidden = !link;
  ui.hint.hidden = !(from === to && !link);
  if (typeof ui.dlg.showModal === "function") ui.dlg.showModal();
  else ui.dlg.setAttribute("open", "");
  (link?.href ? ui.title : ui.url).focus();
}
