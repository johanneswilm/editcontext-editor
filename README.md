# editcontext-editor

***NOTE: This is a demo editor to test EditContext. EditContext is not supported by most browsers (status 2026-10).***

A rich text editing library built on the [EditContext API](https://w3c.github.io/edit-context/) instead of
`contenteditable`. The editable surface is a plain DOM element backed by its own JSON document model and
schema; all text input — physical keyboard, IME composition, emoji pickers, dictation — flows through the
EditContext, which is exactly what that API was designed for.

**[Live demo (GitHub Pages)](https://johanneswilm.github.io/editcontext-editor/)** — see `docs/`.
The demo has a **caret-mode switch**: *JS-managed* (the library draws and moves the caret) vs.
*browser-native* (the UA draws and moves the caret — `?caret=native` in the URL). Use it to compare
what the browser does on its own with what the library adds on top.

## Features

- **Not `contenteditable`.** The editor element is a regular focusable `<div>` with an `EditContext`
  attached. No browser editing behaviors fighting your model.
- **DOM-based rendering** (no canvas): paragraphs, headings 1–6, tables, inline and block images,
  hard breaks.
- **Text styling**: bold, italic, underline, strikethrough, code — via `beforeinput` format events
  (Ctrl/⌘+B etc. work out of the box), toolbar buttons, or the API.
- **Links**: set/unset via a toolbar dialog (URL + optional title for accessibility), applied to the
  selection or edited in place when the caret sits on a link. Rendered as `<a href title>`, exported
  and imported in HTML, and paste of `<a>` content keeps the link.
- **Own JSON document model + schema**, with validation/normalization, `getJSON()`/`setJSON()`,
  and `getHTML()`/`setHTML()` for import/export (HTML paste is parsed into the model too).
- **Full IME support**: composition events, IME underline decorations via `textformatupdate`,
  and per-character bounds via `characterboundsupdate` so candidate windows follow the caret.
- **Tables**: insert, add/remove rows and columns, Tab navigation between cells.
- **Undo/redo** with typing coalescing (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y).
- **Trivially embeddable** — the "blog comment box" use case is a few lines of code.

## Browser support

EditContext is a new technology. It ships in **Chrome/Edge 121+**; Safari and Firefox have not shipped
it yet. The library throws a clear error (and `isEditContextSupported()` returns `false`) when the API
is missing, so you can feature-detect and fall back. See
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/EditContext#browser_compatibility).

**Firefox (experimental, `dom.editcontext.enabled`):** rendering, typing, and IME work, but the UA's
caret navigation on EditContext hosts is non-functional — ArrowLeft never moves, ArrowRight jumps
block to block and wraps from the last table cell back to the first. The editor therefore detects
Firefox and moves the caret/selection in its own model on arrow keys (`preventDefault` in `keydown`,
`src/editor.js` `_arrowMoveModel`), reproducing the same semantics as Chromium: per-grapheme walks,
object selection when stepping onto images/tables, cell-by-cell table traversal, and escapes. Override
with the `uaBrokenArrows` option (also useful for testing the model path in other browsers).
Both the model movement and all other caret interception are off in `caretMode: "native"` — there the
browser is fully in charge of the caret, broken navigation included.

## Known Chromium issues and spec divergences

Findings from building this library against Chrome/Edge 121+ (observe them live in the demo's
**Events** pane — element vs. EditContext vs. document events are tagged there):

- **Enter produces no `beforeinput`.** The [spec](https://w3c.github.io/edit-context/) says the editing
  host receives `beforeinput` as in UI Events, but pressing Enter delivers only `keydown`. The editor
  handles Enter/Shift+Enter directly in `keydown` (the `beforeinput(insertParagraph)` branch remains as
  a fallback for user agents that do fire it).
- **Undo/redo produces no `beforeinput`.** `historyUndo`/`historyRedo` never fire on EditContext hosts,
  so Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y are handled in `keydown` with the editor's own history stack.
- **`beforeinput` for formatting *does* fire** (`formatBold`, `formatItalic`, …), as do the clipboard
  inputTypes (`insertFromPaste`, `deleteByCut`) — those are handled from `beforeinput`.
- **`beforeinput(insertCompositionText)` intentionally does not fire** on the element (per spec) —
  composition arrives exclusively through the EditContext's `compositionstart`/`textupdate`/
  `textformatupdate`/`compositionend` events.
- **No native object selection** for images/tables (spec design): the editor implements
  click-to-select with its own highlight, so Backspace/Delete and typing-over work on selected objects.
  Arrow keys select an object when stepping onto it (stepping off collapses the caret beside it), and
  Backspace/Delete *next to* a block object (table, block image) also selects it first — Word-style —
  with only a second press deleting it (`src/editor.js` `_removeBlockLeaves`). Object selections cover
  the block's DOM contents, so the browser paints a highlight over the object instead of a boundary bar.
- **Object selections don't survive in the EditContext** (Chromium quirk, verified in Chrome 154):
  pushing `updateSelection(start, end)` over an object character works, but after an author
  `updateText()` call Chrome asynchronously collapses the selection to its start. The editor therefore
  never relies on the UA seeing an object-char selection: deleting a selected block object is handled
  in `keydown` as a model transaction instead of via the `textupdate` mirroring.
- **Event shapes changed during development.** Current Chrome exposes
  `textupdate.updateRangeStart/updateRangeEnd/text` and `textformatupdate.getTextFormats()`; older
  builds used `updateTextStart/updateTextEnd/updateText` and direct `rangeStart/underlineStyle`
  properties. The library accepts both.
- **`beforeinput` on the host *is* cancelable — `preventDefault()` genuinely blocks the edit**
  (verified in Chrome 154). `beforeinput` fires on the editing host *element* (not the EditContext
  object) with `cancelable: true` for `insertText`, `insertFromPaste`, `deleteContent*`, formats,
  etc.; canceling leaves the EditContext buffer untouched and no `textupdate` follows. What you
  *cannot* cancel this way is composition: `compositionstart`/`textupdate`/`compositionend` fire on
  the EditContext object after its buffer is already updated (`textupdate.cancelable` is true, but
  canceling is a no-op — revert with `editContext.updateText()` if needed). Also, no `input` event
  fires at all on EditContext hosts; `textupdate` is the only after-the-fact notification.

## Quick start

The library is plain ES modules with zero dependencies — no build step.

```html
<div id="toolbar"></div>
<div id="editor"></div>
<script type="module">
  import { Editor, createToolbar, COMMENT_FEATURES } from "./src/index.js";

  const editor = new Editor({
    element: document.getElementById("editor"),
    placeholder: "Leave a comment…",
  });
  document.getElementById("toolbar").appendChild(
    createToolbar(editor, { features: COMMENT_FEATURES, blockTypes: [2, 3] })
  );

  // On submit:
  const doc = editor.getJSON();      // internal JSON format -> POST to your server
</script>
```

Full-featured editor:

```js
import { Editor, createToolbar, FULL_FEATURES } from "editcontext-editor";

const editor = new Editor({
  element: document.getElementById("editor"),
  content: { type: "doc", children: [ … ] },  // or an HTML string via setHTML()
});
document.getElementById("toolbar").appendChild(createToolbar(editor));

editor.toggleBold();
editor.setHeading(2);
editor.insertTable(3, 3);
editor.insertImage({ src: "cat.png", inline: false });
console.log(editor.getHTML());
```

## API overview

### `new Editor(options)`

| Option | Description |
| --- | --- |
| `element` | The DOM element to make editable (required). |
| `content` | Initial document: JSON object, JSON string, or HTML string. |
| `placeholder` | Placeholder text shown when the document is empty. |
| `enterKeyHint` | Value for the `enterkeyhint` attribute. |
| `caretMode` | `"custom"` (default) — the library draws the caret and manages caret movement; `"native"` — the browser draws and moves the caret, no arrow interception. |
| `injectStyles` | Set `false` to skip injecting the default stylesheet (use `EDITOR_CSS` yourself). |

### Content IO

`getJSON()` / `setJSON(doc)` — the internal format. `getHTML()` / `setHTML(html)`. `getText()`.
`setContent(x)` auto-detects JSON vs HTML.

### Commands

`toggleBold()` `toggleItalic()` `toggleUnderline()` `toggleStrikethrough()` `toggleCode()`
`setParagraph()` `setHeading(level)` `splitBlock()` `insertHardBreak()` `deleteSelection()`
`insertImage({src, alt, inline, width, height})` `insertTable(rows, cols)`
`tableInsertRow(after?)` `tableInsertColumn(after?)` `tableDeleteRow()` `tableDeleteColumn()`
`setLink({href, title?})` `unsetLink()` `getActiveLink()`
`undo()` `redo()` `selectAll()` `focus()`

### State

`getSelection()` / `setSelection(anchor, head)` (offsets in the flat text),
`getActiveMarks()`, `getBlockType()`, `getHeadingLevel()`, `isSelectionInTable()`,
`isComposing`, `history.canUndo` / `canRedo`.

### Events

`on(type, fn)` with `change`, `selectionchange`, `compositionstart`, `compositionend`,
`focus`, `blur`, `destroy`.

## Document format

```jsonc
{
  "type": "doc",
  "children": [
    { "type": "heading", "attrs": { "level": 1 }, "children": [
      { "type": "text", "text": "Title", "marks": ["bold"] }
    ]},
    { "type": "paragraph", "children": [
      { "type": "text", "text": "Hello " },
      { "type": "image", "attrs": { "src": "a.png", "alt": "", "width": null, "height": null } },
      { "type": "hard_break" }
    ]},
    { "type": "table", "children": [
      { "type": "table_row", "children": [
        { "type": "table_cell", "children": [ /* paragraphs */ ] }
      ]}
    ]},
    { "type": "image", "attrs": { "src": "big.png", "alt": "block-level image" } }
  ]
}
```

An `image` is inline inside paragraphs/headings/cells and a block at the document root.
Marks: `bold`, `italic`, `underline`, `strikethrough`, `code`, plus at most one link object:

```json
{ "type": "text", "text": "example", "marks": [
  "bold",
  { "type": "link", "attrs": { "href": "https://example.com", "title": "Example site" } }
]}
```

`title` maps to the `<a>` title attribute (accessibility).
`normalizeDocument()` repairs arbitrary input into this schema; `validateDocument()` reports problems.

## How it works (and why IME works)

```
JSON document model  <->  flat text (EditContext buffer)  <->  DOM
```

1. The renderer walks the document and produces DOM plus a **flat text**: every block boundary
   becomes `\n`, every inline leaf (image, hard break) and every table/block image becomes an object
   character. This flat text is mirrored into the `EditContext`, so the browser's text input
   services see one continuous plain-text view of the document.
2. **Raw-text input** (`insertText`, `deleteContentBackward`, …) is applied to the EditContext buffer
   by the browser and reported as `textupdate`; the library mirrors the same edit into the JSON
   model through a position map and re-renders the DOM.
3. **Everything else** — Enter, Shift+Enter, paste, cut, formatting, undo — arrives as cancelable
   `beforeinput` on the element and is handled with model operations.
4. During **IME composition**, `textformatupdate` ranges are rendered as underline decorations and
   `characterboundsupdate` is answered with real per-character rects from the DOM, so the candidate
   window tracks the caret. Because the IME talks to the buffer (not the DOM), re-rendering the DOM
   mid-composition is safe.
5. The caret is drawn by the library (`caret-color: transparent` suppresses the native caret
   Chromium would otherwise paint for the focused host — see "Known Chromium issues"); text
   selection uses the native selection over the rendered DOM, mapped back to buffer offsets
   via the position map. With `caretMode: "native"` the library steps aside: no caret drawing,
   no arrow-key interception, no arrow-driven object selection — the browser paints the caret
   for the DOM selection and moves it natively (including its current quirks, which is exactly
   what that mode is for: demonstrating raw EditContext caret behavior to browser developers).

**Third-party input events.** Synthetic events dispatched by external code (e.g. browser extensions)
never reach the EditContext buffer, so the `textupdate` mirroring never sees them. The editor therefore
also listens for `paste` and `beforeinput(deleteContentBackward/Forward)`: a synthetic `paste` is
inserted through the same path as `beforeinput(insertFromPaste)` (a guard plus event cancellation keep
the pair from inserting twice), and a synthetic `deleteContent*` performs a grapheme-aware model
deletion. Trusted events keep flowing through the UA buffer, so real keyboard and clipboard input is
never executed twice.

## Development & demo

```bash
npm run build:demo   # copies src/ into docs/lib (the demo imports ./lib/index.js)
npm run demo         # serves the repo at http://localhost:8080 — open /docs/
```

`docs/` is self-contained, so GitHub Pages can be enabled straight from the repository settings:
*Settings → Pages → Build and deployment → Deploy from a branch → `main` → `/docs`*. Commit the
`docs/lib` folder (it is produced by `npm run build:demo`).

## License

MIT
