import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseIcs } from "./ics";
import "./settings.css";

export default function Settings() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    invoke<{ calendar_url: string }>("get_settings").then((s) => setUrl(s.calendar_url));
    invoke<boolean>("autostart_enabled").then(setAutostart);
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus({ text: "Loading calendar…" });
    try {
      const text = await invoke<string>("set_calendar", { url });
      setStatus({
        text: url.trim() ? `Connected. ${parseIcs(text).length} events found.` : "Calendar removed.",
      });
    } catch (err) {
      setStatus({ text: String(err), error: true });
    }
    setBusy(false);
  };

  return (
    <main className="settings">
      <h1>Pulo settings</h1>

      <form onSubmit={save}>
        <label htmlFor="cal">Calendar link</label>
        <div className="row">
          <input
            id="cal"
            type="url"
            placeholder="https://… .ics or webcal://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            aria-describedby="cal-help cal-status"
          />
          <button type="submit" disabled={busy}>
            Save
          </button>
        </div>
        <p id="cal-status" className={`status${status?.error ? " error" : ""}`} role="status">
          {status?.text}
        </p>
        <p id="cal-help" className="help">
          Paste your calendar's private iCal address. It's read-only and refreshes every 10 minutes.
          <br />
          <b>Google Calendar:</b> Settings → your calendar → Integrate calendar → Secret address in iCal format.
          <br />
          <b>Outlook:</b> Settings → Calendar → Shared calendars → Publish a calendar → ICS link.
        </p>
      </form>

      <label className="check">
        <input
          type="checkbox"
          checked={autostart}
          onChange={(e) => {
            setAutostart(e.target.checked);
            invoke("set_autostart", { on: e.target.checked });
          }}
        />
        Start Pulo with Windows
      </label>
    </main>
  );
}
