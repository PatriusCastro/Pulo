import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseIcs } from "./ics";
import { ACCENTS, accentOf, COST, EMPTY_SETTINGS, FEATURES, GROUPS, MATERIALS, MAX_SHORTCUTS, MOVES, PRESETS, prefsOf, SHORTCUTS, STYLES, TAB_LABEL, type Prefs, type Settings as Saved } from "./prefs";
import { ICONS, Icon } from "./icons";
import { Pet } from "./extras";
import "./settings.css";

// The pages in the sidebar. The words after the title are what the search box also matches.
const PAGES = [
  ["look", "Appearance", ICONS.palette, "look style pill notch bubble space gap top open hover click animation motion move screen monitor slide fade pop material glass frosted translucent black rest time clock dot pet accent color colour white green preview"],
  ["behavior", "Behavior", ICONS.gear, "start windows startup login hide mouse near tuck idle away fullscreen full-screen video youtube browser chrome edge firefox maximized apps click through ctrl screenshots recording sharing"],
  ["features", "Features", ICONS.apps, [...FEATURES, ...PRESETS].map((f) => `${f[1]} ${f[2]}`).join(" ") + ` ${Object.values(GROUPS).join(" ")} lyrics lrclib sets presets all`],
  ["tabs", "Tab order", ICONS.tabs, "tabs order now recent focus agents to do todo tools"],
  ["shortcuts", "Shortcuts", ICONS.calculator, "shortcuts buttons beside left right " + Object.values(SHORTCUTS).join(" ")],
  ["focus", "Focus timer", ICONS.timer, "pomodoro focus break long rounds minutes automatically stopwatch timer"],
  ["calendar", "Calendar", ICONS.calendar, "calendar ics ical google outlook events link"],
  ["about", "About", ICONS.info, "version github source problem bug update updates check install"],
] as const;
type Page = (typeof PAGES)[number][0];
const load = (): Page => {
  try {
    const p = localStorage.getItem("settings-page");
    return PAGES.some((x) => x[0] === p) ? (p as Page) : "look";
  } catch {
    return "look";
  }
};

/** Minutes fields: whole numbers in a sane range, or the field is left as it was. */
const minutes = (v: string, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
};

/** A row of a settings card: what it is on the left, its control on the right. */
function Row({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="item">
      <span className="item-text">
        <span className="item-label">{label}</span>
        {help && <span className="item-help">{help}</span>}
      </span>
      {children}
    </div>
  );
}

/** A row that is one on/off switch; the whole row toggles it. */
function Switch(p: { label: string; help?: React.ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; sub?: boolean }) {
  const id = useId();
  return (
    <label className={`item${p.sub ? " sub" : ""}${p.disabled ? " disabled" : ""}`}>
      <span className="item-text">
        <span className="item-label">{p.label}</span>
        {p.help && (
          <span className="item-help" id={id}>
            {p.help}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={p.checked}
        disabled={p.disabled}
        aria-describedby={p.help ? id : undefined}
        onChange={(e) => p.onChange(e.target.checked)}
      />
    </label>
  );
}

/** How many of a list are on, as a thin bar. The count beside it is the text version. */
const Bar = ({ n, of }: { n: number; of: number }) => (
  <span className="bar" aria-hidden="true">
    <span style={{ width: `${(100 * n) / of}%` }} />
  </span>
);

const Chevron = ({ up }: { up?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The island at rest, drawn as the choices below set it, over half a picture and half a white
 *  window. Play runs the move to another screen. */
function Preview({ style, prefs, pet }: { style: string; prefs: Prefs; pet: boolean }) {
  const [run, setRun] = useState(0);
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const bubble = style === "bubble";
  return (
    <div className="preview" style={{ "--accent": accentOf(prefs.accent) } as React.CSSProperties}>
      <div key={run} className={`pv-pill ${style} m-${prefs.material}${run ? ` pv-${prefs.move}` : ""}`} aria-label="Preview of the island" role="img">
        {!bubble && <span className="pv-slot">{pet && <Pet mood="idle" />}</span>}
        {!bubble && <span className="pv-time">{prefs.showTime ? time : ""}</span>}
        <span className="pv-slot">{prefs.showDot && <span className="pv-dot" />}</span>
      </div>
      <button className="pv-play" onClick={() => setRun((n) => n + 1)}>
        <Icon d={ICONS.play} size={12} /> Play the move
      </button>
    </div>
  );
}

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
  // The switches before the last bulk change (a set, all on, all off), for its Undo.
  const [undo, setUndo] = useState<string[] | null>(null);
  const saveOff = (off: string[]) => {
    setSaved((s) => ({ ...s, off }));
    invoke("set_prefs", { off });
  };
  const setFeature = (f: string, on: boolean) => {
    setUndo(null);
    saveOff(on ? saved.off.filter((x) => x !== f) : [...saved.off, f]);
  };
  const setAll = (off: string[]) => {
    setUndo(saved.off);
    saveOff(off);
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
  const pomoField = (key: "focus" | "short" | "long" | "every", label: string, unit: string, max: number) => (
    <label className="item">
      <span className="item-label">{label}</span>
      <span className="unit">
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
        {unit}
      </span>
    </label>
  );

  const style = saved.style || "pill";
  const hideApps = saved.hide_apps ?? [];
  const setWindow = (patch: Partial<Saved>, args: Record<string, unknown>) => {
    setSaved((s) => ({ ...s, ...patch }));
    invoke("set_window", args);
  };

  const [page, setPage] = useState<Page>(load);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  // The tray's update item, mirrored: [text, clickable]. null: the Store updates this copy.
  const [update, setUpdate] = useState<[string, boolean] | null | undefined>(undefined);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
    invoke<[string, boolean] | null>("update_status").then(setUpdate, () => setUpdate(null));
    const un = listen<[string, boolean]>("update_status", (e) => setUpdate(e.payload));
    return () => void un.then((f) => f());
  }, []);
  const go = (p: Page) => {
    setPage(p);
    try {
      localStorage.setItem("settings-page", p);
    } catch {}
  };
  // Searching narrows the sidebar to the pages that mention it, and shows the first of them.
  const q = query.trim().toLowerCase();
  const found = q ? PAGES.filter(([, title, , words]) => `${title} ${words}`.toLowerCase().includes(q)) : PAGES;
  const shown = found.some((p) => p[0] === page) ? page : found[0]?.[0];
  const title = PAGES.find((p) => p[0] === shown)?.[1];

  const onCount = FEATURES.filter((f) => !saved.off.includes(f[0])).length;
  const pages: Record<Page, React.ReactNode> = {
    look: (
      <>
        <Preview style={style} prefs={prefs} pet={!saved.off.includes("pet")} />
        <div className="looks" role="radiogroup" aria-label="Look">
          {STYLES.map(([id, label, help]) => (
            <label key={id} className={`look${style === id ? " on" : ""}`}>
              <input type="radio" name="style" className="sr" checked={style === id} onChange={() => setWindow({ style: id }, { style: id })} />
              <span className={`look-art ${id}`} aria-hidden="true">
                <span />
              </span>
              <span className="item-label">{label}</span>
              <span className="item-help">{help}</span>
            </label>
          ))}
        </div>
        <h3 className="group-title">Material</h3>
        {/* Each over a busy and a white backdrop: see-through looks differ most between the two. */}
        <div className="looks" role="radiogroup" aria-label="Material">
          {MATERIALS.map(([id, label, help]) => (
            <label key={id} className={`look${prefs.material === id ? " on" : ""}`}>
              <input type="radio" name="material" className="sr" checked={prefs.material === id} onChange={() => savePrefs({ material: id })} />
              <span className={`look-art mat-art ${style} m-${id}`} aria-hidden="true">
                <span />
              </span>
              <span className="item-label">{label}</span>
              <span className="item-help">{help}</span>
            </label>
          ))}
        </div>
        <div className="card">
          <Row label="Space above the island" help={style === "notch" ? "None: the notch sits on the edge" : `${saved.top_gap ?? 6} px`}>
            <input
              type="range"
              min={0}
              max={40}
              aria-label="Space above the island"
              disabled={style === "notch"}
              value={saved.top_gap ?? 6}
              onChange={(e) => setWindow({ top_gap: Number(e.target.value) }, { topGap: Number(e.target.value) })} // moves within a second
            />
          </Row>
          <Row label="Open the island" help={prefs.openOn === "click" ? "Hovering shows a preview first" : "Hovering opens it all the way"}>
            <div className="seg" role="radiogroup" aria-label="Open the island">
              {(["click", "hover"] as const).map((o) => (
                <label key={o} className={prefs.openOn === o ? "on" : ""}>
                  <input type="radio" name="open" className="sr" checked={prefs.openOn === o} onChange={() => savePrefs({ openOn: o })} />
                  {o === "click" ? "On click" : "On hover"}
                </label>
              ))}
            </div>
          </Row>
          <Row
            label="At rest, show"
            help={
              prefs.showTime || prefs.showDot || !saved.off.includes("pet")
                ? "Music, a muted mic and alerts show either way"
                : "Plain black. Music, a muted mic and alerts show either way"
            }
          >
            <div className="seg multi" role="group" aria-label="At rest, show">
              {(
                [
                  ["Time", prefs.showTime, (on: boolean) => savePrefs({ showTime: on })],
                  ["Dot", prefs.showDot, (on: boolean) => savePrefs({ showDot: on })],
                  ["Pet", !saved.off.includes("pet"), (on: boolean) => setFeature("pet", on)],
                ] as const
              ).map(([label, on, set]) => (
                <label key={label} className={on ? "on" : ""}>
                  <input type="checkbox" className="sr" checked={on} onChange={(e) => set(e.target.checked)} />
                  {label}
                </label>
              ))}
            </div>
          </Row>
          <Row label="Accent" help="The dot, switches and buttons in the island">
            <div className="swatches" role="radiogroup" aria-label="Accent">
              {ACCENTS.map(([id, label, color]) => (
                <label key={id} className={prefs.accent === id ? "on" : ""} title={label}>
                  <input type="radio" name="accent" className="sr" checked={prefs.accent === id} onChange={() => savePrefs({ accent: id })} aria-label={label} />
                  <span style={{ background: color }} />
                </label>
              ))}
            </div>
          </Row>
          <Row label="Moving to another screen" help="How the island follows the mouse to another screen">
            <div className="seg" role="radiogroup" aria-label="Moving to another screen">
              {MOVES.map(([id, label]) => (
                <label key={id} className={prefs.move === id ? "on" : ""}>
                  <input type="radio" name="move" className="sr" checked={prefs.move === id} onChange={() => savePrefs({ move: id })} />
                  {label}
                </label>
              ))}
            </div>
          </Row>
        </div>
      </>
    ),
    behavior: (
      <div className="card">
        <Switch
          label="Start Pulo with Windows"
          checked={autostart}
          onChange={(on) => {
            setAutostart(on);
            invoke("set_autostart", { on });
          }}
        />
        <Switch
          label="Hide until the mouse comes near"
          help="Tucks into the top edge, leaving a thin line. It does this on its own over fullscreen videos too."
          checked={!!saved.auto_hide}
          onChange={(on) => setWindow({ auto_hide: on }, { autoHide: on })}
        />
        {!saved.auto_hide && (
          <Switch
            label="Tuck away when idle"
            help="After a minute without the mouse on it, it slides into the top edge until you point at it. Alerts still come out."
            checked={prefs.idleTuck}
            onChange={(on) => savePrefs({ idleTuck: on })}
          />
        )}
        <Switch
          label="Hide over full-screen videos"
          help="And other full-screen apps. Off, it tucks into the top edge over them instead. It always hides during a slideshow. Either way, Ctrl+Alt+Space brings it out."
          checked={!!saved.hide_fullscreen}
          onChange={(on) => setWindow({ hide_fullscreen: on }, { hideFullscreen: on })}
        />
        <Switch
          label="Hide over browsers"
          help="While Chrome, Edge, Firefox, Brave, Opera, Vivaldi or another browser is in front, so it never covers your tabs. Ctrl+Alt+Space still brings it out."
          checked={!!saved.hide_browsers}
          onChange={(on) => setWindow({ hide_browsers: on }, { hideBrowsers: on })}
        />
        <Switch
          label="Hide over maximized windows"
          help="While the app in front fills the screen the island is on."
          checked={!!saved.hide_maximized}
          onChange={(on) => setWindow({ hide_maximized: on }, { hideMaximized: on })}
        />
        <Row label="Hide over other apps" help="To add one, right-click the island while that app is in front, then Hide → Over that app.">
          <span />
        </Row>
        {hideApps.map((a) => (
          <Row key={a.exe} label={a.name} help={`${a.exe}.exe`}>
            <button
              type="button"
              onClick={() => {
                const list = hideApps.filter((x) => x.exe !== a.exe);
                setWindow({ hide_apps: list }, { hideApps: list });
              }}
            >
              Remove
            </button>
          </Row>
        ))}
        <Switch
          label="Click through the island"
          help="Clicks go to what's under the closed island, and it fades while the mouse is over it. Hold Ctrl to use it, or press Ctrl+Alt+Space."
          checked={!!saved.click_through}
          onChange={(on) => setWindow({ click_through: on }, { clickThrough: on })}
        />
        <Switch
          label="Show in screenshots"
          help="Off: screenshots, recordings and screen sharing leave it out."
          checked={!!saved.show_in_screenshots}
          onChange={(on) => setWindow({ show_in_screenshots: on }, { showInScreenshots: on })}
        />
      </div>
    ),
    features: (
      <>
        <p className="help">Turning one off removes it from the island right away. Its background work stops the next time Pulo starts.</p>
        <div className="card">
          <Row label={`${onCount} of ${FEATURES.length} on`} help={<Bar n={onCount} of={FEATURES.length} />}>
            <span className="buttons">
              {undo && (
                <button type="button" onClick={() => {
                    saveOff(undo);
                    setUndo(null);
                  }}
                >
                  Undo
                </button>
              )}
              <button type="button" disabled={onCount === FEATURES.length} onClick={() => setAll([])}>
                Turn all on
              </button>
              <button type="button" disabled={onCount === 0} onClick={() => setAll(FEATURES.map((f) => f[0]))}>
                Turn all off
              </button>
            </span>
          </Row>
        </div>
        <h3 className="group-title">Start from a set</h3>
        <div className="looks">
          {PRESETS.map(([id, label, help, on]) => {
            const off = FEATURES.map((f) => f[0]).filter((f) => !on.includes(f));
            const current = off.length === saved.off.length && off.every((f) => saved.off.includes(f));
            return (
              <button key={id} type="button" className={`look preset${current ? " on" : ""}`} aria-pressed={current} onClick={() => setAll(off)}>
                <span className="item-label">{label}</span>
                <span className="item-help">{help}</span>
              </button>
            );
          })}
        </div>
        <p className="help">A set turns on what it lists and turns off the rest. Every feature stays a switch away below.</p>
        {Object.entries(GROUPS).map(([group, name]) => {
          const list = FEATURES.filter((f) => f[3] === group);
          const n = list.filter((f) => !saved.off.includes(f[0])).length;
          return (
            <div key={group} className="card">
              <div className="item group-head">
                <span className="item-label">{name}</span>
                <span className="count">
                  {n}/{list.length}
                </span>
                <Bar n={n} of={list.length} />
              </div>
              {list.map(([id, label, help, , cost]) => (
                <Fragment key={id}>
                  <Switch
                    label={label}
                    help={
                      <>
                        {help}
                        {id === "hotkey" && !hotkeyOk && <span className="warn"> Another app is using this shortcut, so it won't work until that app lets go of it and Pulo restarts.</span>}
                        <span className="cost">{COST[cost]}</span>
                      </>
                    }
                    checked={!saved.off.includes(id)}
                    onChange={(on) => setFeature(id, on)}
                  />
                  {id === "media" && (
                    <Switch
                      sub
                      label="Show synced lyrics"
                      help="Looks up each song on lrclib.net, which receives its title, artist and length. Nothing else is sent."
                      checked={saved.lyrics}
                      disabled={saved.off.includes("media")}
                      onChange={(on) => {
                        setSaved((s) => ({ ...s, lyrics: on }));
                        invoke("set_lyrics", { on });
                      }}
                    />
                  )}
                </Fragment>
              ))}
            </div>
          );
        })}
      </>
    ),
    tabs: (
      <>
        <p className="help">The order of the tabs in the open island. Tabs of features that are off are left out.</p>
        <ol className="card order">
          {prefs.tabs.map((t, i) => {
            const move = (by: number) => {
              const tabs = [...prefs.tabs];
              [tabs[i], tabs[i + by]] = [tabs[i + by], tabs[i]];
              savePrefs({ tabs });
            };
            return (
              <li key={t} className="item">
                <span className="order-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="item-label">{TAB_LABEL[t]}</span>
                <button type="button" className="ghost" aria-label={`Move ${TAB_LABEL[t]} up`} disabled={i === 0} onClick={() => move(-1)}>
                  <Chevron up />
                </button>
                <button type="button" className="ghost" aria-label={`Move ${TAB_LABEL[t]} down`} disabled={i === prefs.tabs.length - 1} onClick={() => move(1)}>
                  <Chevron />
                </button>
              </li>
            );
          })}
        </ol>
      </>
    ),
    shortcuts: (
      <>
        <p className="help">Buttons on either side of the open island. Clipboard, Calculator, Volume mixer and Screenshot open inside the island.</p>
        <div className="card columns">
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
      </>
    ),
    focus: (
      <div className="card">
        {pomoField("focus", "Focus", "minutes", 180)}
        {pomoField("short", "Short break", "minutes", 60)}
        {pomoField("long", "Long break", "minutes", 120)}
        {pomoField("every", "Long break every", "rounds", 12)}
        <Switch label="Start the next phase automatically" checked={pomo.auto} onChange={(on) => savePrefs({ pomodoro: { ...pomo, auto: on } })} />
      </div>
    ),
    calendar: (
      <form className="card pad" onSubmit={saveCalendar}>
        <label htmlFor="cal" className="item-label">
          Calendar link
        </label>
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
          <button type="submit" className="primary" disabled={busy}>
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
    ),
    about: (
      <div className="card">
        <Row label="Pulo" help={version ? `Version ${version}` : undefined}>
          <span />
        </Row>
        {update !== undefined && (
          <Row
            label="Updates"
            help={
              update === null
                ? "The Microsoft Store keeps Pulo up to date"
                : update[0].startsWith("Install")
                  ? "A new version is ready. Pulo restarts to install it."
                  : update[0].startsWith("Update failed")
                    ? "The update didn't install"
                    : update[0] === "Check for updates"
                      ? "Pulo checks once a day"
                      : update[0] // Checking… / Pulo is up to date / Updating…
            }
          >
            {update && (
              <button type="button" disabled={!update[1]} onClick={() => invoke("update_click")}>
                {update[0].startsWith("Install") ? update[0] : update[0].startsWith("Update failed") ? "Retry" : update[0] === "Updating…" ? "Updating…" : "Check now"}
              </button>
            )}
          </Row>
        )}
        <Row label="Source code" help="github.com/PatriusCastro/pulo">
          <button type="button" onClick={() => invoke("open_path", { path: "https://github.com/PatriusCastro/pulo" })}>
            Open
          </button>
        </Row>
        <Row label="Report a problem" help="Opens a new issue on GitHub">
          <button type="button" onClick={() => invoke("open_path", { path: "https://github.com/PatriusCastro/pulo/issues/new" })}>
            Report
          </button>
        </Row>
      </div>
    ),
  };

  return (
    <div className="shell">
      <nav className="nav" aria-label="Settings pages">
        <div className="nav-head">Pulo settings</div>
        <label className="search">
          <Icon d={ICONS.search} size={14} />
          <input type="search" placeholder="Find a setting" aria-label="Find a setting" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {found.map(([id, label, icon]) => (
          <button key={id} type="button" className={`nav-item${id === shown ? " on" : ""}`} aria-current={id === shown ? "page" : undefined} onClick={() => go(id)}>
            <Icon d={icon} size={16} />
            {label}
          </button>
        ))}
        {!found.length && <p className="nav-none">No settings match “{query.trim()}”</p>}
      </nav>
      <main className="pane" key={shown}>
        {shown && (
          <>
            <h1>{title}</h1>
            {pages[shown]}
          </>
        )}
      </main>
    </div>
  );
}
