import { useState } from "react";
import "./settings.css";

// A plain note, saved as you type. Its own window because the island never takes focus.
// ponytail: one note in localStorage. Tabs, Markdown or a file on disk when someone asks.
export default function Scratchpad() {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem("scratchpad") ?? "";
    } catch {
      return "";
    }
  });
  return (
    <main className="scratch">
      <textarea
        autoFocus
        aria-label="Scratchpad"
        placeholder="Notes, saved as you type"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            localStorage.setItem("scratchpad", e.target.value);
          } catch {}
        }}
      />
    </main>
  );
}
