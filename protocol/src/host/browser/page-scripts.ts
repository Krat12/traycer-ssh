/**
 * The page-side half of the browser's mobile page signals, as source strings.
 *
 * One copy, two runtimes: the host installs these on a headless page through
 * `Page.addScriptToEvaluateOnNewDocument` on the page's raw CDP session, and the
 * desktop installs the SAME strings on a `<webview>` guest through
 * `installScriptBeforeNavigation`. They are strings rather than functions
 * because they are evaluated in the page, not in this process - nothing here
 * may close over a value from this module at runtime.
 *
 * Every script is idempotent (it installs a flag and returns early on a second
 * run) because both install paths can fire more than once for one document: a
 * renderer reattach re-installs, and an on-new-document script also runs in
 * every child frame.
 */
import {
  BROWSER_DESCRIBED_TEXT_MAX,
  BROWSER_SELECTION_TEXT_MAX,
} from "@traycer/protocol/host/browser/contracts";

/**
 * The `Runtime.addBinding` name the editable-focus observer pushes through.
 * {@link BROWSER_EDITABLE_FOCUS_SCRIPT} interpolates it,
 * so the two cannot drift.
 *
 * A CDP binding rather than a poll for the same reason the capture helper's
 * input binding is one: `Runtime.bindingCalled` is an unsolicited, ordered push
 * with no round trip, its lifetime is the CDP session's, and it exists only
 * inside the page's own contexts - so a visited site cannot reach it and it
 * cannot outlive the session that added it. The alternative, an evaluate per
 * focus change, costs a round trip on exactly the event a keyboard is waiting
 * on.
 *
 * The payload is a JSON string, not an object: a binding takes one string
 * argument. It parses to the `editableFocus` frame's fields verbatim
 * (`{ focused, inputMode, multiline, rect }`).
 */
export const BROWSER_EDITABLE_FOCUS_BINDING = "__traycerEditableFocus";

/**
 * The global {@link BROWSER_DESCRIBE_POINT_SCRIPT} installs. The caller
 * evaluates `window.__traycerDescribePoint(x, y)` with page CSS pixels and gets
 * `{ link, image, text }` back by value.
 */
export const BROWSER_DESCRIBE_POINT_GLOBAL = "__traycerDescribePoint";

/**
 * The global {@link BROWSER_SELECTION_SCRIPT} installs, holding the four
 * selection verbs: `selectAt(x, y)`, `expand(unit)`, `read()`, `clear()`.
 */
export const BROWSER_SELECTION_GLOBAL = "__traycerSelection";

/**
 * Editable-focus observer.
 *
 * Reports the focused editable (or its absence) on `focusin` / `focusout` /
 * `selectionchange`, deduplicated by the serialized payload so a caret blink or
 * a repeated `selectionchange` costs nothing. On `resize` while an editable is
 * focused it also scrolls that element into view - a phone keyboard shrinks the
 * visual viewport, and the page's own scroll anchoring routinely leaves the
 * caret under the keyboard.
 *
 * `focusout` is reported on a macrotask rather than inline: the browser fires it
 * BEFORE the new element is focused, so `document.activeElement` reads as
 * `<body>` mid-event and a focus move between two inputs would otherwise emit a
 * spurious blur.
 */
export const BROWSER_EDITABLE_FOCUS_SCRIPT = `(() => {
  if (window.${BROWSER_EDITABLE_FOCUS_BINDING}Installed === true) return;
  window.${BROWSER_EDITABLE_FOCUS_BINDING}Installed = true;

  const INPUT_MODES = new Set([
    "none", "text", "decimal", "numeric", "tel", "search", "email", "url",
  ]);
  const NON_EDITABLE_INPUT_TYPES = new Set([
    "button", "checkbox", "color", "file", "hidden", "image", "radio",
    "range", "reset", "submit",
  ]);
  const INPUT_TYPE_MODES = {
    email: "email",
    number: "decimal",
    search: "search",
    tel: "tel",
    url: "url",
  };

  const describe = (node) => {
    if (node === null || node === undefined) return null;
    if (typeof node.tagName !== "string") return null;
    const tag = node.tagName.toUpperCase();
    const declared = typeof node.inputMode === "string"
      ? node.inputMode.toLowerCase()
      : "";
    const fromAttribute = INPUT_MODES.has(declared) ? declared : null;
    if (tag === "TEXTAREA") {
      return { inputMode: fromAttribute, multiline: true };
    }
    if (tag === "INPUT") {
      const type = (typeof node.type === "string" ? node.type : "text")
        .toLowerCase();
      if (NON_EDITABLE_INPUT_TYPES.has(type)) return null;
      const fromType = INPUT_TYPE_MODES[type] ?? "text";
      return { inputMode: fromAttribute ?? fromType, multiline: false };
    }
    if (node.isContentEditable === true) {
      return { inputMode: fromAttribute, multiline: true };
    }
    return null;
  };

  const focusedEditable = () => {
    const active = document.activeElement;
    const info = describe(active);
    return info === null ? null : { element: active, info: info };
  };

  let lastPayload = "";
  const post = (payload) => {
    const send = window.${BROWSER_EDITABLE_FOCUS_BINDING};
    if (typeof send !== "function") return;
    const json = JSON.stringify(payload);
    if (json === lastPayload) return;
    lastPayload = json;
    try {
      send(json);
    } catch (error) {
      // The binding goes away with its CDP session; a detached page must not
      // throw out of an event listener it installed on the document.
      void error;
    }
  };

  const emit = () => {
    const focused = focusedEditable();
    if (focused === null) {
      post({ focused: false, inputMode: null, multiline: false, rect: null });
      return;
    }
    const box = focused.element.getBoundingClientRect();
    post({
      focused: true,
      inputMode: focused.info.inputMode,
      multiline: focused.info.multiline,
      rect: {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    });
  };

  document.addEventListener("focusin", emit, true);
  document.addEventListener("focusout", () => {
    // Deferred: focusout precedes the new focus, so reading activeElement now
    // would report a blur that never happened.
    setTimeout(emit, 0);
  }, true);
  document.addEventListener("selectionchange", emit, true);
  window.addEventListener("resize", () => {
    const focused = focusedEditable();
    if (focused === null) return;
    if (typeof focused.element.scrollIntoView === "function") {
      focused.element.scrollIntoView({ block: "center", inline: "nearest" });
    }
    emit();
  });
  emit();
})();`;

/**
 * `describePoint(x, y)` - what a long press landed on.
 *
 * `closest()` from the hit element rather than the hit element itself, because
 * the thing under a finger is almost never the anchor: it is a `<span>` inside
 * it, or an `<img>` wrapped in one. The text is the nearest ANCESTOR block with
 * any text, not the whole page and not the bare hit node, which is what makes
 * "copy the paragraph I pressed" mean something.
 */
export const BROWSER_DESCRIBE_POINT_SCRIPT = `(() => {
  if (typeof window.${BROWSER_DESCRIBE_POINT_GLOBAL} === "function") return;

  const TEXT_MAX = ${BROWSER_DESCRIBED_TEXT_MAX};
  const URL_MAX = 2048;
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "TD", "TH", "DD", "DT", "PRE", "BLOCKQUOTE",
    "FIGCAPTION", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "MAIN",
    "H1", "H2", "H3", "H4", "H5", "H6", "BODY",
  ]);

  const cap = (value, limit) =>
    typeof value === "string" && value.length > 0
      ? value.slice(0, limit)
      : null;

  const nearestBlockText = (start) => {
    for (let node = start; node !== null; node = node.parentElement) {
      if (typeof node.tagName !== "string") continue;
      if (!BLOCK_TAGS.has(node.tagName.toUpperCase())) continue;
      const raw = typeof node.innerText === "string"
        ? node.innerText
        : node.textContent;
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > 0) return text.slice(0, TEXT_MAX);
    }
    return null;
  };

  window.${BROWSER_DESCRIBE_POINT_GLOBAL} = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return { link: null, image: null, text: null };
    const anchor = hit.closest("a[href]");
    const image = hit.closest("img[src]");
    return {
      link: anchor === null ? null : cap(anchor.href, URL_MAX),
      image: image === null
        ? null
        : cap(image.currentSrc, URL_MAX) ?? cap(image.src, URL_MAX),
      text: nearestBlockText(hit),
    };
  };
})();`;

/**
 * Selection helpers: place, expand, read, clear.
 *
 * `document.caretPositionFromPoint` is the standard; `caretRangeFromPoint` is
 * the older WebKit/Blink spelling and is kept as the fallback because the
 * standard one is still missing in shipping Chromium builds this code runs on.
 *
 * Expansion goes through `Selection.modify`, which is the only API that knows
 * where a word, sentence or paragraph ends in the page's own layout - a
 * hand-rolled version would have to reimplement text segmentation and would get
 * it wrong in every language that is not English. `all` uses
 * `documentboundary`, `modify`'s name for the same idea.
 */
export const BROWSER_SELECTION_SCRIPT = `(() => {
  if (window.${BROWSER_SELECTION_GLOBAL} !== undefined) return;

  const TEXT_MAX = ${BROWSER_SELECTION_TEXT_MAX};
  const GRANULARITY = {
    word: "word",
    sentence: "sentence",
    paragraph: "paragraph",
    all: "documentboundary",
  };

  const caretRangeAt = (x, y) => {
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(x, y);
      if (position === null || position === undefined) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    if (typeof document.caretRangeFromPoint === "function") {
      return document.caretRangeFromPoint(x, y) ?? null;
    }
    return null;
  };

  const read = () => {
    const selection = window.getSelection();
    if (selection === null) return "";
    return selection.toString().slice(0, TEXT_MAX);
  };

  const expand = (unit) => {
    const granularity = GRANULARITY[unit];
    if (granularity === undefined) return read();
    const selection = window.getSelection();
    if (selection === null || typeof selection.modify !== "function") {
      return read();
    }
    // Collapse to the unit's start, then extend to its end. Two calls rather
    // than one "extend both ways" call, which Selection.modify has no verb for.
    selection.modify("move", "backward", granularity);
    selection.modify("extend", "forward", granularity);
    return read();
  };

  window.${BROWSER_SELECTION_GLOBAL} = {
    selectAt: (x, y) => {
      const range = caretRangeAt(x, y);
      if (range === null) return "";
      const selection = window.getSelection();
      if (selection === null) return "";
      selection.removeAllRanges();
      selection.addRange(range);
      return expand("word");
    },
    expand: expand,
    read: read,
    clear: () => {
      const selection = window.getSelection();
      if (selection !== null) selection.removeAllRanges();
    },
  };
})();`;
