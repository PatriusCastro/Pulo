import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseIcs } from "./ics";
import { EMPTY_SETTINGS, FEATURES, MAX_SHORTCUTS, prefsOf, SHORTCUTS, type Prefs, type Settings as Saved } from "./prefs";
import "./settings.css";

/** Minutes fields: whole numbers in a sane range, or the field is left as it was. */
const minutes = (v: string, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
};

export default function Settings() {
  const [saved, setSaved] = useState<Saved>(EMPTY_SETTINGS);
  const prefs = useMemo(() => prefsOf(saved), [saved]);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [hotkeyOk, setHotkeyOk] = useState(true);

  useEffect(() => {
    invoke<boolean>("hotkey_ok").then(setHotkeyOk);
    invoke<Saved>("get_settings").then((s) => {
      setSaved(s);
      setUrl(s.calendar_url);
    });
    invoke<boolean>("autostart_enabled").then(setAutostart);
    const un = listen<Saved>("settings", (e) => setSaved(e.payload));
    return () => void un.then((f) => f());
  }, []);

  const savePrefs = (patch: Partial<Prefs>) => {
    const ui = { ...prefs, ...patch };
    setSaved((s) => ({ ...s, ui }));
    invoke("set_prefs", { ui });
  };
  const setFeature = (f: string, on: boolean) => {
    const off = on ? saved.off.filter((x) => x !== f) : [...saved.off, f];
    setSaved((s) => ({ ...s, off }));
    invoke("set_prefs", { off });
  };
  const setShortcut = (side: "left" | "right", slot: number, target: string) => {
    const list = [...prefs[side]];
    list[slot] = target;
    savePrefs({ [side]: list.filter(Boolean) });
  };

  const saveCalendar = async (e: React.FormEvent) => {
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

  const pomo = prefs.pomodoro;
  const pomoField = (key: "focus" | "short" | "long" | "every", label: string, max: number) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        max={max}
        defaultValue={pomo[key]}
        key={pomo[key]} // follow saved changes
        onBlur={(e) => {
          const n = minutes(e.target.value, max);
          if (n === null) e.target.value = String(pomo[key]);
          else if (n !== pomo[key]) savePrefs({ pomodoro: { ...pomo, [key]: n } });
        }}
      />
    </label>
  );

  return (
    <main className="settings">
      <h1>Pulo settings</h1>

      <section aria-labelledby="general">
        <h2 id="general">General</h2>
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
        <label className="check">
          <input
            type="checkbox"
            checked={!!saved.click_through}
            aria-describedby="through-help"
            onChange={(e) => {
              setSaved((s) => ({ ...s, click_through: e.target.checked }));
              invoke("set_window", { clickThrough: e.target.checked });
            }}
          />
          Click through the island
        </label>
        <p id="through-help" className="help indent">
          Clicks go to whatever is under the closed island, like your browser's tabs, and it fades while the mouse is over it. Hold Ctrl to use the island, or press Ctrl+Alt+Space.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={!!saved.show_in_screenshots}
            aria-describedby="capture-help"
            onChange={(e) => {
              setSaved((s) => ({ ...s, show_in_screenshots: e.target.checked }));
              invoke("set_window", { showInScreenshots: e.target.checked });
            }}
          />
          Show the island in screenshots
        </label>
        <p id="capture-help" className="help indent">
          Off: screenshots, screen recordings and screen sharing leave it out.
        </p>
        <fieldset className="radio">
          <legend>Open the island</legend>
          <label className="check">
            <input type="radio" name="open" checked={prefs.openOn === "click"} onChange={() => savePrefs({ openOn: "click" })} />
            On click (hovering shows a preview)
          </label>
          <label className="check">
            <input type="radio" name="open" checked={prefs.openOn === "hover"} onChange={() => savePrefs({ openOn: "hover" })} />
            On hover
          </label>
        </fieldset>
      </section>

      <section aria-labelledby="features">
        <h2 id="features">Features</h2>
        <p className="help">Turning a feature off removes it from the island right away. Its background work stops the next time Pulo starts.</p>
        {FEATURES.map(([id, label, help]) => (
          <div key={id}>
            <label className="check">
              <input type="checkbox" checked={!saved.off.includes(id)} onChange={(e) => setFeature(id, e.target.checked)} aria-describedby={`f-${id}`} />
              {label}
            </label>
            <p id={`f-${id}`} className="help indent">
              {help}
              {id === "hotkey" && !hotkeyOk && <span className="warn"> Another app is already using this shortcut, so it won't work until that app lets go of it and Pulo restarts.</span>}
            </p>
            {id === "media" && (
              <>
                <label className="check indent">
                  <input
                    type="checkbox"
                    checked={saved.lyrics}
                    aria-describedby="lyrics-help"
                    disabled={saved.off.includes("media")}
                    onChange={(e) => {
                      setSaved((s) => ({ ...s, lyrics: e.target.checked }));
                      invoke("set_lyrics", { on: e.target.checked });
                    }}
                  />
                  Show synced lyrics
                </label>
                <p id="lyrics-help" className="help indent2">
                  Looks up each song on lrclib.net, which receives the song's title, artist and length. Nothing else is sent.
                </p>
              </>
            )}
          </div>
        ))}
      </section>

      <section aria-labelledby="shortcuts">
        <h2 id="shortcuts">Shortcuts beside the open island</h2>
        <div className="columns">
          {(["left", "right"] as const).map((side) => (
            <div key={side}>
              <h3>{side === "left" ? "Left" : "Right"}</h3>
              {Array.from({ length: MAX_SHORTCUTS }, (_, slot) => {
                const cur = prefs[side][slot] ?? "";
                // Slots fill top-down, so only offer the next empty one.
                if (slot > prefs[side].length) return null;
                return (
                  <select key={slot} aria-label={`${side} shortcut ${slot + 1}`} value={cur} onChange={(e) => setShortcut(side, slot, e.target.value)}>
                    <option value="">None</option>
                    {Object.entries(SHORTCUTS).map(([id, label]) => (
                      <option key={id} value={id} disabled={id !== cur && (prefs.left.includes(id) || prefs.right.includes(id))}>
                        {label}
                      </option>
                    ))}
                  </select>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="focus">
        <h2 id="focus">Focus timer</h2>
        <div className="fields">
          {pomoField("focus", "Focus (min)", 180)}
          {pomoField("short", "Short break (min)", 60)}
          {pomoField("long", "Long break (min)", 120)}
          {pomoField("every", "Long break every (rounds)", 12)}
        </div>
        <label className="check">
          <input type="checkbox" checked={pomo.auto} onChange={(e) => savePrefs({ pomodoro: { ...pomo, auto: e.target.checked } })} />
          Start the next phase automatically
        </label>
      </section>

      <section aria-labelledby="calendar">
        <h2 id="calendar">Calendar</h2>
        <form onSubmit={saveCalendar}>
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
      </section>
    </main>
  );
}
