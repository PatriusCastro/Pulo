import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ICONS, Icon } from "./icons";

// The To Do tab: a checklist kept in this window's localStorage. Ticking and removing are
// clicks; adding needs the keyboard, which the island only takes while the box is in use
// (island_keyboard in lib.rs).

type Todo = { id: number; text: string; done: boolean };
const KEY = "todos";

function load(): Todo[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t) => t && typeof t.text === "string") : [];
  } catch {
    return [];
  }
}

const PLUS = "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z";
const TICK = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z";

/** `open`: the island is open. `onTyping`: while true the island must stay open. */
export function TodoTab({ open, onTyping }: { open: boolean; onTyping: (on: boolean) => void }) {
  const [items, setItems] = useState<Todo[]>(load);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const typing = useRef(false);

  // Every change works on the latest list, so quick clicks in a row don't undo each other.
  const save = (change: (list: Todo[]) => Todo[]) => setItems(change);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {}
  }, [items]);
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    save((l) => [...l, { id: Date.now(), text, done: false }]);
    setDraft("");
  };
  const toggle = (id: number) => save((l) => l.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id: number) => save((l) => l.filter((t) => t.id !== id));

  const startTyping = () => {
    if (typing.current) return;
    typing.current = true;
    onTyping(true);
    invoke("island_keyboard", { on: true }).then(() => input.current?.focus());
  };
  const stopTyping = () => {
    // The window becoming active can blur the box for a moment: only stop if it stays blurred.
    setTimeout(() => {
      if (document.activeElement === input.current && document.hasFocus()) return;
      endTyping();
    }, 120);
  };
  const endTyping = () => {
    if (!typing.current) return;
    typing.current = false;
    invoke("island_keyboard", { on: false });
    onTyping(false);
  };
  // The island closed (the shortcut, or a click elsewhere): give the keyboard back.
  useEffect(() => {
    if (!open) input.current?.blur();
  }, [open]);
  useEffect(() => endTyping, []); // eslint-disable-line react-hooks/exhaustive-deps -- leaving the tab

  // Open ones first, in the order added; ticked ones sink to the bottom.
  const list = [...items.filter((t) => !t.done), ...items.filter((t) => t.done)];
  const left = items.length - items.filter((t) => t.done).length;
  const doneCount = items.length - left;

  return (
    <>
      <label className="todo-add">
        <Icon d={PLUS} size={16} />
        <input
          ref={input}
          value={draft}
          placeholder="Add a to-do"
          aria-label="Add a to-do"
          maxLength={200}
          spellCheck={false}
          tabIndex={open ? 0 : -1}
          onPointerDown={startTyping}
          onFocus={startTyping}
          onBlur={stopTyping}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            else if (e.key === "Escape") {
              setDraft("");
              input.current?.blur();
            }
          }}
        />
        {draft.trim() && (
          <button className="todo-enter" onMouseDown={(e) => e.preventDefault()} onClick={add}>
            Add
          </button>
        )}
      </label>
      <ul className="todo-list">
        {list.map((t) => (
          <li key={t.id} className={`todo-row${t.done ? " done" : ""}`}>
            <button className="todo-main" role="checkbox" aria-checked={t.done} tabIndex={open ? 0 : -1} onClick={() => toggle(t.id)}>
              <span className="todo-box" aria-hidden="true">
                {t.done && <Icon d={TICK} size={12} />}
              </span>
              <span className="todo-text">{t.text}</span>
            </button>
            <button className="recent-x" aria-label={`Remove ${t.text}`} title="Remove" tabIndex={open ? 0 : -1} onClick={() => remove(t.id)}>
              <Icon d={ICONS.close} size={12} />
            </button>
          </li>
        ))}
        {!items.length && (
          <li className="empty-note">
            <Icon d={ICONS.checklist} size={22} />
            Nothing to do. Add one above.
          </li>
        )}
      </ul>
      {items.length > 0 && (
        <div className="bar">
          <span>{left ? `${left} left` : "All done"}</span>
          {doneCount > 0 && (
            <button className="chip" tabIndex={open ? 0 : -1} onClick={() => save((l) => l.filter((t) => !t.done))}>
              Clear done
            </button>
          )}
        </div>
      )}
    </>
  );
}
