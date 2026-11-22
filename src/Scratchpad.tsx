import { useEffect, useRef, useState } from "react";
import { ICONS, Icon } from "./icons";
import { toMarkdown } from "./markdown";
import "./settings.css";

// A note with light formatting, kept as you type (localStorage) and saveable to a Markdown or
// text file. Its own window because the island never takes focus.
// Formatting uses the browser's built-in editing commands (execCommand): old, but the one
// thing that gives undo, Ctrl+B and lists for free in a contentEditable.

const KEY = "scratchpad-html";

/** The saved note; the plain-text note from before formatting comes along as lines. */
function initialHtml() {
  try {
    const html = localStorage.getItem(KEY);
    if (html !== null) return html;
    const old = localStorage.getItem("scratchpad");
    if (!old) return "";
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return old
      .split("\n")
      .map((l) => `<div>${esc(l) || "<br>"}</div>`)
      .join("");
  } catch {
    return "";
  }
}

// The File System Access API (Chromium, so WebView2): pick a file once, then Ctrl+S saves to it.
type Writable = { write: (s: string) => Promise<void>; close: () => Promise<void> };
type FileHandle = { name: string; createWritable: () => Promise<Writable> };
type Picker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>;

type Active = Record<"bold" | "italic" | "underline" | "strike" | "heading" | "bullets" | "numbers" | "checks", boolean>;
const NONE: Active = { bold: false, italic: false, underline: false, strike: false, heading: false, bullets: false, numbers: false, checks: false };

export default function Scratchpad() {
  const ed = useRef<HTMLDivElement>(null);
  const file = useRef<FileHandle | null>(null);
  const [active, setActive] = useState<Active>(NONE);
  const [words, setWords] = useState(0);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [empty, setEmpty] = useState(true);

  const count = () => {
    const text = ed.current?.innerText ?? "";
    setWords(text.trim() ? text.trim().split(/\s+/).length : 0);
    setEmpty(!text.trim() && !ed.current?.querySelector("li"));
  };
  const persist = () => {
    try {
      localStorage.setItem(KEY, ed.current?.innerHTML ?? "");
    } catch {}
    count();
  };
  /** The block or list the caret is in. */
  const at = (sel: string) => {
    const n = document.getSelection()?.anchorNode;
    const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
    const hit = el?.closest(sel);
    return hit && ed.current?.contains(hit) ? (hit as HTMLElement) : null;
  };
  const refresh = () => {
    if (!ed.current?.contains(document.getSelection()?.anchorNode ?? null)) return;
    const q = (c: string) => document.queryCommandState(c);
    const checks = !!at("ul.checks");
    setActive({
      bold: q("bold"),
      italic: q("italic"),
      underline: q("underline"),
      strike: q("strikeThrough"),
      heading: !!at("h2"),
      bullets: q("insertUnorderedList") && !checks,
      numbers: q("insertOrderedList"),
      checks,
    });
  };

  useEffect(() => {
    if (ed.current) ed.current.innerHTML = initialHtml();
    count();
    ed.current?.focus();
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (cmd: string, arg?: string) => {
    ed.current?.focus();
    document.execCommand(cmd, false, arg);
    persist();
    refresh();
  };
  const heading = () => run("formatBlock", at("h2") ? "div" : "h2");
  const bullets = () => {
    const checks = at("ul.checks");
    if (checks) {
      checks.classList.remove("checks"); // a checklist becomes plain bullets
      persist();
      refresh();
    } else run("insertUnorderedList");
  };
  const checklist = () => {
    if (at("ul.checks")) return run("insertUnorderedList"); // off again
    if (!at("ul")) run("insertUnorderedList");
    at("ul")?.classList.add("checks");
    persist();
    refresh();
  };

  const save = async (as: boolean) => {
    if (!ed.current) return;
    const md = toMarkdown(ed.current);
    const pick = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
    try {
      if (!pick) {
        // No file picker: hand it over as a download instead.
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: "Notes.md" });
        a.click();
        URL.revokeObjectURL(a.href);
        return setStatus({ text: "Saved to Downloads" });
      }
      if (as || !file.current)
        file.current = await pick({
          suggestedName: file.current?.name ?? "Notes.md",
          types: [
            { description: "Markdown", accept: { "text/markdown": [".md"] } },
            { description: "Text", accept: { "text/plain": [".txt"] } },
          ],
        });
      const w = await file.current.createWritable();
      await w.write(md);
      await w.close();
      setStatus({ text: `Saved to ${file.current.name}` });
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") setStatus({ text: `Couldn't save: ${(e as Error).message}`, error: true });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "s") {
      e.preventDefault();
      save(e.shiftKey);
    } else if (e.ctrlKey && e.shiftKey && ["7", "8", "9", "&", "*", "("].includes(k)) {
      // As in Google Docs: Ctrl+Shift+7 numbers, 8 bullets, 9 checklist.
      e.preventDefault();
      ({ "7": () => run("insertOrderedList"), "&": () => run("insertOrderedList"), "8": bullets, "*": bullets, "9": checklist, "(": checklist } as Record<string, () => void>)[k]?.();
    } else if (e.ctrlKey && e.altKey && k === "2") {
      e.preventDefault();
      heading();
    } else if (e.key === "Tab" && at("li")) {
      e.preventDefault();
      run(e.shiftKey ? "outdent" : "indent"); // nest or un-nest a list item
    } else if (e.key === "Enter" && at("ul.checks li")) {
      // A new checklist item starts unticked (Chrome copies the class of the one before).
      requestAnimationFrame(() => {
        at("li")?.classList.remove("done");
        persist();
      });
    }
  };
  // Clicking a checklist box (the space left of the text) ticks it.
  const onClick = (e: React.MouseEvent) => {
    const li = (e.target as Element).closest("ul.checks > li");
    if (li && e.clientX < li.getBoundingClientRect().left + 22) {
      li.classList.toggle("done");
      persist();
    }
  };

  const tools: [keyof Active | "clear", string, string, () => void][] = [
    ["bold", "Bold (Ctrl+B)", ICONS.bold, () => run("bold")],
    ["italic", "Italic (Ctrl+I)", ICONS.italic, () => run("italic")],
    ["underline", "Underline (Ctrl+U)", ICONS.underline, () => run("underline")],
    ["strike", "Strikethrough", ICONS.strike, () => run("strikeThrough")],
    ["heading", "Heading (Ctrl+Alt+2)", ICONS.heading, heading],
    ["bullets", "Bulleted list (Ctrl+Shift+8)", ICONS.bullets, bullets],
    ["numbers", "Numbered list (Ctrl+Shift+7)", ICONS.numbers, () => run("insertOrderedList")],
    ["checks", "Checklist (Ctrl+Shift+9)", ICONS.checklist, checklist],
    ["clear", "Clear formatting", ICONS.clearFormat, () => run("removeFormat")],
  ];

  return (
    <main className="pad">
      <div className="pad-bar" role="toolbar" aria-label="Formatting">
        {tools.map(([id, label, icon, act], i) => (
          <span key={id} className="pad-group">
            {(i === 4 || i === 5 || i === 8) && <span className="pad-sep" aria-hidden="true" />}
            <button
              type="button"
              className={`pad-btn${id !== "clear" && active[id] ? " on" : ""}`}
              aria-label={label}
              aria-pressed={id === "clear" ? undefined : active[id]}
              title={label}
              onMouseDown={(e) => e.preventDefault()} // keep the selection in the note
              onClick={act}
            >
              <Icon d={icon} size={18} />
            </button>
          </span>
        ))}
        <button type="button" className="pad-save" title="Save to a file (Ctrl+S; Ctrl+Shift+S for a new one)" onMouseDown={(e) => e.preventDefault()} onClick={() => save(false)}>
          <Icon d={ICONS.save} size={16} />
          Save
        </button>
      </div>
      <div className="pad-page">
        <div
          ref={ed}
          className={`pad-editor${empty ? " empty" : ""}`}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Scratchpad"
          data-placeholder="Write something. It's kept as you type."
          spellCheck
          onInput={persist}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPaste={(e) => {
            // Pasted text comes in plain, not with the page's fonts and colours.
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
        />
      </div>
      <footer className="pad-foot">
        <span>
          {words} {words === 1 ? "word" : "words"}
        </span>
        <span className={status?.error ? "warn" : ""} role="status">
          {status?.text ?? "Kept as you type"}
        </span>
      </footer>
    </main>
  );
}
