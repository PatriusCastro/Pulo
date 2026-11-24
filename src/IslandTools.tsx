// Pages that open in the island from its shortcut buttons, in place of the tabs: clipboard
// history, a calculator, the volume mixer, screenshots, performance, display, Wi-Fi and
// Bluetooth, power and a colour picker. The island never takes keyboard focus, so
// everything here works with the mouse.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ICONS, Icon } from "./icons";
import * as C from "./calc";
import { getVersion } from "@tauri-apps/api/app";
import { NOTES, newer } from "./whatsnew";

export const TOOL_TITLE = {
  clipboard: "Clipboard",
  calculator: "Calculator",
  mixer: "Volume mixer",
  screenshot: "Screenshot",
  task_manager: "Performance",
  display: "Display",
  network: "Wi-Fi & Bluetooth",
  power: "Power",
  color: "Color picker",
  camera: "Camera mirror",
  whatsnew: "What's new",
} as const;
export type ToolId = keyof typeof TOOL_TITLE;
export const isTool = (t: string): t is ToolId => t in TOOL_TITLE;

type Props = { tool: ToolId; onBack: () => void; onDone: () => void; ago: (ms: number) => string };

export function ToolPage(p: Props) {
  const Page = {
    clipboard: Clipboard,
    calculator: Calculator,
    mixer: Mixer,
    screenshot: Screenshot,
    task_manager: Performance,
    display: Display,
    network: Network,
    power: Power,
    color: ColorPicker,
    camera: Camera,
    whatsnew: WhatsNew,
  }[p.tool];
  return <Page {...p} />;
}

/** Opens a Windows Settings page (a `launch` target) and closes the island. */
const SettingsLink = ({ target, label, onDone }: { target: string; label: string; onDone: () => void }) => (
  <button className="icon-btn" aria-label={label} title={label} onClick={() => invoke("launch", { target }).then(onDone)}>
    <Icon d={ICONS.gear} size={16} />
  </button>
);

/** A row with an on/off switch, like Quick Settings. `on` undefined: still loading. */
function Toggle({ icon, label, sub, on, onClick }: { icon: string; label: string; sub?: string; on?: boolean; onClick: () => void }) {
  return (
    <button className={`toggle-row${on ? " on" : ""}`} role="switch" aria-checked={!!on} disabled={on === undefined} onClick={onClick}>
      <span className="mix-badge" aria-hidden="true">
        <Icon d={icon} size={14} />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

/** `tabs` sit beside the title; `children` (actions) at the far right. */
function Head({ title, hint, onBack, tabs, children }: { title: string; hint?: string; onBack: () => void; tabs?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="tool-head">
      <button className="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon d={ICONS.back} size={18} />
      </button>
      <span className="tool-title">{title}</span>
      {tabs}
      {hint && <span className="tool-hint">{hint}</span>}
      <span className="tool-actions">{children}</span>
    </div>
  );
}

// ---------- clipboard ----------

type Clip = { id: string; text: string | null; image: boolean; at: number };

function Clipboard({ onBack, onDone, ago }: Props) {
  // undefined: loading; null: history is off in Windows Settings
  const [items, setItems] = useState<Clip[] | null | undefined>(undefined);
  const [error, setError] = useState("");
  const load = () =>
    invoke<Clip[] | null>("clip_history")
      .then(setItems)
      .catch(() => setItems(null));
  useEffect(() => {
    load();
  }, []);
  const now = Date.now();
  return (
    <div className="tool">
      <Head title="Clipboard" hint={items?.length ? "Click one to paste it" : undefined} onBack={onBack}>
        {!!items?.length && (
          <button className="chip" onClick={() => invoke("clip_clear").then(load)}>
            Clear
          </button>
        )}
      </Head>
      {items === null ? (
        <div className="empty-note">
          <Icon d={ICONS.clipboard} size={22} />
          Clipboard history is off in Windows
          <button className="chip" onClick={() => invoke("launch", { target: "clipboard_settings" }).then(onDone)}>
            Turn it on
          </button>
        </div>
      ) : items && !items.length ? (
        <div className="empty-note">
          <Icon d={ICONS.clipboard} size={22} />
          Things you copy show up here
        </div>
      ) : (
        // Bento: the newest is a wide card; long text spans two columns, short text one; an
        // image is a tall tile showing the picture. Dense flow fills the gaps.
        <div className="clip-grid" role="list">
          {error && <div className="tool-error">{error}</div>}
          {items?.map((c, i) => {
            const text = c.text?.replace(/\s+/g, " ").trim();
            const link = !!text && /^https?:\/\/\S+$/.test(text);
            const size = c.image ? (i === 0 ? "wide tall" : "tall") : i === 0 || (text?.length ?? 0) > 48 ? "wide" : "";
            return (
              <div className={`clip-card ${size}${c.image ? " image" : ""}`} role="listitem" key={c.id}>
                <button
                  className="clip-main"
                  title={c.image ? "Paste the image" : "Paste"}
                  onClick={() => {
                    // Close first: the paste goes to the app that still has focus, as with Win+V.
                    onDone();
                    invoke("clip_paste", { id: c.id }).catch((e) => setError(String(e)));
                  }}
                >
                  {c.image ? <ClipImage id={c.id} /> : <span className={`clip-text${link ? " link" : ""}`}>{text || "(spaces)"}</span>}
                  <span className="clip-time">{ago(now - c.at)}</span>
                </button>
                <button className="clip-x" aria-label="Remove from the history" title="Remove" onClick={() => invoke("clip_delete", { id: c.id }).then(load)}>
                  <Icon d={ICONS.close} size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClipImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let alive = true;
    invoke<ArrayBuffer>("clip_image", { id })
      .then((buf) => {
        if (!alive) return;
        u = URL.createObjectURL(new Blob([buf]));
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [id]);
  return url ? <img src={url} alt="Copied image" decoding="async" /> : <Icon d={ICONS.image} size={22} />;
}

// ---------- calculator ----------

let kept: C.Calc = C.EMPTY; // the sum survives closing the island
const KEYS = ["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "⌫", "0", ".", "="];

function Calculator({ onBack }: Props) {
  const [calc, setCalc] = useState(kept);
  const [copied, setCopied] = useState(false);
  const press = (k: string) => {
    setCalc((c) => (kept = C.press(c, k)));
    setCopied(false);
  };
  const value = C.evaluate(calc.expr);
  const result = calc.done ? calc.expr : value === null ? "0" : String(Number(value.toPrecision(12)));
  return (
    <div className="tool">
      <Head title="Calculator" onBack={onBack}>
        <button
          className="icon-btn"
          aria-label="Copy the result"
          title={copied ? "Copied" : "Copy the result"}
          onClick={() => invoke("clip_copy", { text: result }).then(() => setCopied(true))}
        >
          <Icon d={copied ? ICONS.checklist : ICONS.copy} size={16} />
        </button>
      </Head>
      <div className="calc">
        <div className="calc-screen" aria-live="polite">
          <div className="calc-expr">{calc.done ? " " : C.pretty(calc.expr) || " "}</div>
          <div className={`calc-result mono${result.length > 10 ? " long" : ""}`}>{C.pretty(result)}</div>
        </div>
        <div className="calc-keys">
          {KEYS.map((k) => (
            <button
              key={k}
              className={`key${C.OPS.includes(k) || k === "=" ? " op" : ["C", "±", "%"].includes(k) ? " fn" : ""}${k === "=" ? " equals" : ""}`}
              aria-label={{ "⌫": "Delete", "±": "Plus or minus", C: "Clear" }[k] ?? k}
              onClick={() => press(k)}
            >
              {k === "⌫" ? <Icon d={ICONS.backspace} size={16} /> : k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- mixer ----------

type AppVol = { name: string; level: number; muted: boolean };
type Output = { id: string; name: string; on: boolean };

/** A name and a 0-1 slider. Volume rows also get a mute button; brightness rows don't. */
function LevelRow({ name, what = "volume", letter, icon = ICONS.volumeHigh, level, muted = false, onLevel, onMute }: { name: string; what?: string; letter?: string; icon?: string; level: number; muted?: boolean; onLevel: (v: number) => void; onMute?: () => void }) {
  return (
    <div className={`mix-row${muted ? " muted" : ""}`}>
      <span className="mix-badge" aria-hidden="true">
        {letter ?? <Icon d={icon} size={14} />}
      </span>
      <span className="mix-name" title={name}>
        {name}
      </span>
      <input
        type="range"
        className="slider"
        min={0}
        max={1}
        step={0.01}
        value={level}
        aria-label={`${name} ${what}`}
        aria-valuetext={muted ? "Muted" : `${Math.round(level * 100)}%`}
        style={{ "--pct": `${level * 100}%` } as React.CSSProperties}
        onChange={(e) => onLevel(+e.target.value)}
      />
      <span className="vol-pct mono">{Math.round(level * 100)}</span>
      {onMute && (
        <button className="icon-btn" aria-label={muted ? `Unmute ${name}` : `Mute ${name}`} aria-pressed={muted} onClick={onMute}>
          <Icon d={muted ? ICONS.mute : ICONS.volume} size={16} />
        </button>
      )}
    </div>
  );
}

/** "Speakers (Realtek(R) Audio)" -> "Speakers", unless another output has that name too. */
const outName = (o: Output, all: Output[]) => {
  const s = o.name.replace(/\s*\(.*\)\s*$/, "") || o.name;
  return all.filter((x) => x.name.startsWith(s)).length > 1 ? o.name : s;
};

function Mixer({ onBack, onDone }: Props) {
  const [master, setMaster] = useState<[number, boolean]>([0, false]);
  const [apps, setApps] = useState<AppVol[]>([]);
  const [outs, setOuts] = useState<Output[]>([]);
  const busy = useRef(0); // ms of the last change here: polling waits so it can't tug a slider back
  useEffect(() => {
    const get = () => {
      if (Date.now() - busy.current < 1500) return;
      invoke<[number, boolean]>("volume").then(setMaster);
      invoke<AppVol[]>("app_volumes").then(setApps);
      invoke<Output[]>("outputs").then(setOuts); // headphones come and go
    };
    get();
    const id = window.setInterval(get, 2000); // apps start and stop playing
    return () => clearInterval(id);
  }, []);
  const setApp = (name: string, patch: Partial<AppVol>) => {
    busy.current = Date.now();
    setApps((a) => a.map((x) => (x.name === name ? { ...x, ...patch } : x)));
    invoke("set_app_volume", { name, level: patch.level, muted: patch.muted });
  };
  const current = outs.find((o) => o.on);
  return (
    <div className="tool">
      <Head title="Volume mixer" onBack={onBack}>
        <button className="icon-btn" aria-label="Windows volume mixer" title="Windows volume mixer" onClick={() => invoke("open_mixer").then(onDone)}>
          <Icon d={ICONS.mixer} size={16} />
        </button>
      </Head>
      {outs.length > 1 && (
        <div className="out-row" role="radiogroup" aria-label="Play sound through">
          {outs.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={o.on}
              className={`chip${o.on ? " on" : ""}`}
              title={o.name}
              onClick={() => {
                setOuts(outs.map((x) => ({ ...x, on: x.id === o.id })));
                invoke<Output[]>("set_output", { id: o.id })
                  .then(setOuts)
                  .then(() => invoke<[number, boolean]>("volume").then(setMaster)); // each output keeps its own level
              }}
            >
              <Icon d={ICONS.volumeHigh} size={12} />
              {outName(o, outs)}
            </button>
          ))}
        </div>
      )}
      <div className="mix-list">
        <LevelRow
          name={current ? outName(current, outs) : "Speakers"}
          level={master[0]}
          muted={master[1]}
          onLevel={(v) => {
            busy.current = Date.now();
            setMaster([v, v <= 0]);
            invoke("set_volume", { level: v });
          }}
          onMute={() => {
            busy.current = Date.now();
            setMaster([master[0], !master[1]]);
            invoke("set_muted", { on: !master[1] });
          }}
        />
        {apps.length ? (
          apps.map((a) => (
            <LevelRow
              key={a.name}
              name={a.name}
              letter={a.name[0]?.toUpperCase()}
              level={a.level}
              muted={a.muted}
              onLevel={(v) => setApp(a.name, { level: v, muted: v <= 0 ? a.muted : false })}
              onMute={() => setApp(a.name, { muted: !a.muted })}
            />
          ))
        ) : (
          <div className="tool-hint pad">Apps show up here while they play sound</div>
        )}
      </div>
    </div>
  );
}

// ---------- performance (the gist of Task Manager's Performance tab) ----------

/** From the `stats` command. cpu and gpu are -1 when unknown. */
export type Stats = { cpu: number; mem: number; mem_used: number; mem_total: number; down: number; up: number; gpu: number };
export const fmtRate = (b: number) =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : b >= 1e3 ? `${Math.round(b / 1e3)} KB/s` : `${Math.round(b)} B/s`;
const gb = (b: number) => (b / 2 ** 30).toFixed(1);
const SPAN = 30; // samples per graph: a minute, at one every 2 s
const EASE_MS = 1400; // most of the 2 s between samples, so the number is rarely still for long

/** Glides from the shown number to `to`, starting at 0; also its speed (0 at rest, 1 at
 *  the fastest). Ease-in-out, so it never lurches off or stops dead. One run per sample,
 *  then nothing runs: looping animations are costly in the island. */
function useEased(to: number): [number, number] {
  const [[v, speed], setV] = useState([0, 0]);
  const at = useRef(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setV([(at.current = to), 0]);
      return;
    }
    const from = at.current;
    const t0 = performance.now();
    let id = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / EASE_MS);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - 4 * (1 - k) ** 3; // cubic in-out
      setV([(at.current = from + (to - from) * e), 4 * Math.min(k, 1 - k) ** 2]); // its slope, scaled to 0-1
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [to]);
  return [v, speed];
}

/** A number that glides to `value`, with motion blur that follows its speed (no jump in or out). */
function Num({ value, show, className }: { value: number; show: (v: number) => string; className?: string }) {
  const [v, speed] = useEased(value);
  const blur = show(v) === show(value) ? 0 : 2.5 * speed;
  return (
    <span className={className} style={blur ? { filter: `blur(${blur.toFixed(2)}px)` } : undefined}>
      {show(v)}
    </span>
  );
}

function Meter({ label, value, max, show, sub, history }: { label: string; value: number; max: number; show: (v: number) => string; sub: string; history: number[] }) {
  // Newest sample on the right edge, like Task Manager; the graph fills in from there.
  const pts = history.map((h, i) => `${SPAN - history.length + i},${100 - (100 * Math.min(h, max)) / max}`).join(" ");
  return (
    <div className="perf-card">
      <div className="perf-top">
        <span className="perf-label">{label}</span>
        <Num className="perf-value mono" value={value} show={show} />
      </div>
      <div className="perf-sub mono">{sub}</div>
      <svg className="perf-graph" viewBox={`0 0 ${SPAN} 100`} preserveAspectRatio="none" aria-hidden="true">
        {history.length > 1 && (
          <>
            <polygon points={`${SPAN - history.length},100 ${pts} ${SPAN},100`} />
            <polyline points={pts} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  );
}

type AppUse = { name: string; cpu: number; mem: number };
const size = (b: number) => (b >= 2 ** 30 ? `${gb(b)} GB` : `${Math.round(b / 2 ** 20)} MB`);

/** The busiest apps, like Task Manager's Processes tab. Plain numbers here: eight rows
 *  gliding at once would keep the island redrawing for as long as the list is open. */
function TopApps() {
  const [apps, setApps] = useState<AppUse[] | null>(null);
  const [by, setBy] = useState<"cpu" | "mem">("cpu");
  useEffect(() => {
    let first = true;
    const get = () =>
      invoke<AppUse[]>("top_apps").then((a) => {
        if (!first) setApps(a); // the first call only primes CPU times
        first = false;
      });
    get();
    const t = window.setTimeout(get, 500); // a quick second sample, so the list shows up at once
    const id = window.setInterval(get, 2000);
    return () => (clearTimeout(t), clearInterval(id));
  }, []);
  const list = apps && [...apps].sort((a, b) => b[by] - a[by]).slice(0, 7);
  const sortBtn = (k: "cpu" | "mem", label: string) => (
    <button className={`apps-sort${by === k ? " on" : ""}`} aria-pressed={by === k} onClick={() => setBy(k)}>
      {label}
    </button>
  );
  return (
    <div className="apps" role="table" aria-label="Apps by use">
      <div className="apps-row head" role="row">
        <span>App</span>
        {sortBtn("cpu", "CPU")}
        {sortBtn("mem", "Memory")}
      </div>
      {list ? (
        list.map((a) => (
          <div className="apps-row" role="row" key={a.name}>
            <span className="apps-name" title={a.name}>
              {a.name}
            </span>
            <span className="mono">{a.cpu < 0.1 ? "0%" : `${a.cpu.toFixed(1)}%`}</span>
            <span className="mono">{size(a.mem)}</span>
          </div>
        ))
      ) : (
        <div className="tool-hint pad">Measuring…</div>
      )}
    </div>
  );
}

function Performance({ onBack, onDone }: Props) {
  const [hist, setHist] = useState<Stats[]>([]);
  const [view, setView] = useState<"meters" | "apps">("meters");
  useEffect(() => {
    const get = () => invoke<Stats>("stats").then((s) => s.cpu >= 0 && setHist((h) => [...h.slice(1 - SPAN), s]));
    get(); // the first sample only primes the rates
    const id = window.setInterval(get, 2000);
    return () => clearInterval(id);
  }, []);
  const s = hist[hist.length - 1];
  const pct = (v: number) => `${Math.round(v)}%`;
  const net = hist.map((h) => h.down + h.up);
  return (
    <div className="tool">
      <Head
        title="Performance"
        onBack={onBack}
        tabs={
          <span className="chips" role="tablist" aria-label="Show">
          {(["meters", "apps"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={`chip${view === v ? " on" : ""}`} onClick={() => setView(v)}>
              {v === "meters" ? "Overview" : "Apps"}
            </button>
          ))}
          </span>
        }
      >
        <button className="icon-btn" aria-label="Open Task Manager" title="Open Task Manager" onClick={() => invoke("launch", { target: "task_manager" }).then(onDone)}>
          <Icon d={ICONS.activity} size={16} />
        </button>
      </Head>
      {view === "apps" ? (
        <TopApps />
      ) : (
        <div className="perf-grid">
          <Meter label="CPU" value={s?.cpu ?? 0} max={100} show={pct} sub="All cores" history={hist.map((h) => h.cpu)} />
          <Meter label="Memory" value={s?.mem ?? 0} max={100} show={pct} sub={s ? `${gb(s.mem_used)} / ${gb(s.mem_total)} GB` : "–"} history={hist.map((h) => h.mem)} />
          <Meter label="GPU" value={Math.max(0, s?.gpu ?? 0)} max={100} show={s && s.gpu < 0 ? () => "–" : pct} sub={s && s.gpu < 0 ? "No counters" : "Busiest engine"} history={hist.map((h) => Math.max(0, h.gpu))} />
          <Meter label="Network" value={s?.down ?? 0} max={Math.max(1e4, ...net)} show={(v) => `↓ ${fmtRate(v)}`} sub={s ? `↑ ${fmtRate(s.up)}` : "–"} history={net} />
        </div>
      )}
    </div>
  );
}

// ---------- screenshot ----------

type Shot = { name: string; at: number };

function Thumb({ name, onDone }: { name: string; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let alive = true;
    invoke<ArrayBuffer>("screenshot_image", { name })
      .then((buf) => {
        if (!alive) return;
        u = URL.createObjectURL(new Blob([buf]));
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [name]);
  return (
    <button className="shot" title={`Open ${name}`} onClick={() => invoke("open_screenshot", { name }).then(onDone)}>
      {url && <img src={url} alt={name} decoding="async" />}
    </button>
  );
}

function Screenshot({ onBack, onDone, ago }: Props) {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    invoke<Shot[]>("screenshots").then(setShots);
  }, []);
  return (
    <div className="tool">
      <Head title="Screenshot" onBack={onBack}>
        <button className="icon-btn" aria-label="Open the Screenshots folder" title="Open the Screenshots folder" onClick={() => invoke("open_screenshot", { name: null }).then(onDone)}>
          <Icon d={ICONS.folder} size={16} />
        </button>
      </Head>
      <div className="shot-modes">
        <button
          className="shot-mode"
          onClick={() => {
            onDone();
            invoke("launch", { target: "screenshot" });
          }}
        >
          <Icon d={ICONS.screenshot} size={20} />
          <span>
            <b>Snip</b>
            <small>Pick an area or a window</small>
          </span>
        </button>
        <button
          className="shot-mode"
          onClick={() => {
            onDone(); // out of the picture first; Rust waits for that
            invoke("screenshot_full");
          }}
        >
          <Icon d={ICONS.fullscreen} size={20} />
          <span>
            <b>Full screen</b>
            <small>Saved to Screenshots</small>
          </span>
        </button>
      </div>
      {shots.length ? (
        <>
          <div className="recent-day">Latest · {ago(Date.now() - shots[0].at)}</div>
          <div className="shots">
            {shots.map((s) => (
              <Thumb key={s.name} name={s.name} onDone={onDone} />
            ))}
          </div>
        </>
      ) : (
        <div className="tool-hint pad">Screenshots you take show up here</div>
      )}
    </div>
  );
}

// ---------- display ----------

type Screen = { id: string; name: string; level: number };
type DisplayState = { screens: Screen[]; night: boolean | null };

function Display({ onBack, onDone }: Props) {
  const [d, setD] = useState<DisplayState | null>(null);
  const queue = useRef(new Map<string, number>()); // newest level per screen while one is on its way: DDC/CI is slow
  useEffect(() => {
    invoke<DisplayState>("display").then(setD);
  }, []);
  const setLevel = (id: string, level: number) => {
    setD((x) => x && { ...x, screens: x.screens.map((s) => (s.id === id ? { ...s, level } : s)) });
    const busy = queue.current.has(id);
    queue.current.set(id, level);
    if (busy) return;
    const send = () => {
      const v = queue.current.get(id)!;
      invoke("set_brightness", { id, level: v }).finally(() => {
        if (queue.current.get(id) === v) queue.current.delete(id);
        else send();
      });
    };
    send();
  };
  return (
    <div className="tool">
      <Head title="Display" onBack={onBack}>
        <SettingsLink target="display" label="Display settings" onDone={onDone} />
      </Head>
      <div className="mix-list">
        {!d ? (
          <div className="tool-hint pad">Looking for screens…</div>
        ) : d.screens.length ? (
          d.screens.map((s) => <LevelRow key={s.id} name={s.name} what="brightness" icon={ICONS.brightness} level={s.level / 100} onLevel={(v) => setLevel(s.id, Math.round(v * 100))} />)
        ) : (
          <div className="tool-hint pad">These screens don't let apps change their brightness</div>
        )}
      </div>
      <Toggle
        icon={ICONS.night}
        label="Night light"
        sub={d?.night === null ? "Opens Windows Settings" : "Warmer colors, easier on the eyes at night"}
        on={d ? !!d.night : undefined}
        onClick={() =>
          invoke<boolean | null>("set_night_light", { on: !d?.night }).then((night) => {
            if (night === null) onDone(); // Settings opened instead
            setD((x) => x && { ...x, night });
          })
        }
      />
    </div>
  );
}

// ---------- Wi-Fi and Bluetooth ----------

type Radios = { wifi: boolean | null; bluetooth: boolean | null; network: string | null; devices: { name: string; battery: number | null }[] };

function Network({ onBack, onDone }: Props) {
  const [r, setR] = useState<Radios | null>(null);
  const busy = useRef(false); // a switch is flipping: polling waits so it can't flip it back
  useEffect(() => {
    const get = () => !busy.current && invoke<Radios>("radios").then(setR);
    get();
    const id = window.setInterval(get, 3000); // networks join, devices connect
    return () => clearInterval(id);
  }, []);
  const flip = (kind: "wifi" | "bluetooth") => {
    const on = !r?.[kind];
    busy.current = true;
    setR((x) => x && { ...x, [kind]: on });
    invoke<Radios>("set_radio", { kind, on })
      .then(setR)
      .finally(() => (busy.current = false));
  };
  const state = (on: boolean | null | undefined, onText: string) => (on === null ? "No adapter found" : on ? onText : "Off");
  const n = r?.devices.length ?? 0;
  return (
    <div className="tool">
      <Head title="Wi-Fi & Bluetooth" onBack={onBack}>
        <SettingsLink target="network" label="Network settings" onDone={onDone} />
      </Head>
      <Toggle icon={ICONS.wifi} label="Wi-Fi" sub={state(r?.wifi, r?.network ?? "Not connected")} on={r ? !!r.wifi : undefined} onClick={() => flip("wifi")} />
      <Toggle icon={ICONS.bluetooth} label="Bluetooth" sub={state(r?.bluetooth, n ? `${n} connected` : "Nothing connected")} on={r ? !!r.bluetooth : undefined} onClick={() => flip("bluetooth")} />
      <div className="mix-list">
        {r?.devices.map((d) => (
          <div className="bt-row" key={d.name}>
            <span className="mix-name">{d.name}</span>
            {d.battery !== null && (
              <span className="vol-pct mono">
                <Icon d={ICONS.battery} size={12} /> {d.battery}%
              </span>
            )}
          </div>
        ))}
        {r?.bluetooth && (
          <button className="chip pad-chip" onClick={() => invoke("launch", { target: "bluetooth" }).then(onDone)}>
            Manage devices
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- power ----------

type Mode = "efficiency" | "balanced" | "performance";
export type PowerTimer = { action: "sleep" | "shutdown"; at: number };
type PowerState = {
  mode: Mode | null; // null: the plan has no power modes
  battery: { percent: number; charging: boolean; left: number | null } | null;
  saver: boolean;
  timer: PowerTimer | null;
};
const MODES = [
  ["efficiency", "Efficiency", "Longer battery life, cooler and quieter"],
  ["balanced", "Balanced", "Windows balances speed and power use"],
  ["performance", "Performance", "Fastest, uses more power"],
] as const;
const ACTIONS = [
  ["screen_off", "Screen off", ICONS.screen],
  ["sleep", "Sleep", ICONS.sleep],
  ["lock", "Lock", ICONS.lock],
  ["signout", "Sign out", ICONS.signout],
  ["restart", "Restart", ICONS.reset],
  ["shutdown", "Shut down", ICONS.shutdown],
] as const;
/** Ending the session: these wait for a second click. */
const ASK = ["signout", "restart", "shutdown"];
const TIMER_PRESETS = [15, 30, 60, 120];
const hm = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(1, Math.floor(s / 60))}m`);
/** 1:05:09 or 4:09 */
export const clockLeft = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
};

function Power({ onBack, onDone }: Props) {
  const [p, setP] = useState<PowerState | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [then, setThen] = useState<PowerTimer["action"]>("shutdown"); // what a new timer does
  const [now, setNow] = useState(Date.now());
  const armTimer = useRef(0);
  useEffect(() => {
    const get = () => invoke<PowerState>("power").then(setP);
    get();
    const id = window.setInterval(get, 10_000);
    return () => (clearInterval(id), clearTimeout(armTimer.current));
  }, []);
  const timer = p?.timer;
  useEffect(() => {
    if (!timer) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer]);
  const setTimer = (minutes: number | null) =>
    invoke<PowerTimer | null>("set_power_timer", { action: minutes ? then : null, minutes: minutes ?? 0 }).then((t) => {
      setNow(Date.now());
      setP((x) => x && { ...x, timer: t });
    });
  const act = (a: string) => {
    if (ASK.includes(a) && armed !== a) {
      setArmed(a);
      clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), 3000);
      return;
    }
    onDone(); // out of the way first
    if (a === "lock") invoke("tool", { action: "lock" });
    else invoke("power_action", { action: a });
  };
  const b = p?.battery;
  const modeAt = MODES.findIndex(([id]) => id === p?.mode);
  const sessionEnd = (id: string) => ASK.includes(id);
  const actionBtn = ([id, label, icon]: (typeof ACTIONS)[number]) => (
    <button key={id} className={`tile${sessionEnd(id) ? " end" : ""}${armed === id ? " warn" : ""}`} title={sessionEnd(id) ? `${label} (asks once more)` : label} onClick={() => act(id)}>
      <Icon d={icon} size={16} />
      <span>{armed === id ? "Confirm" : label}</span>
    </button>
  );
  const leftMin = timer ? Math.ceil((timer.at - now) / 60_000) : 0;
  return (
    <div className="tool">
      <Head title="Power" onBack={onBack}>
        <SettingsLink target="power" label="Power settings" onDone={onDone} />
      </Head>
      <div className="power-top">
        {b ? (
          <>
            <Num className="power-pct mono" value={b.percent} show={(v) => `${Math.round(v)}%`} />
            <span className="batt-gauge" aria-hidden="true">
              <span style={{ width: `${b.percent}%` }} />
            </span>
            <span className="tool-hint grow">
              {b.charging ? (b.percent >= 100 ? "Fully charged" : "Charging") : b.left ? `${hm(b.left)} left` : "On battery"}
            </span>
          </>
        ) : (
          <span className="tool-hint grow">
            <Icon d={ICONS.power} size={14} /> Plugged in
          </span>
        )}
        {/* Windows has no switch apps may flip for energy saver; Settings does. */}
        <button className={`chip saver${p?.saver ? " on" : ""}`} title="Open energy saver settings" onClick={() => invoke("launch", { target: "energy_saver" }).then(onDone)}>
          <Icon d={ICONS.leaf} size={12} />
          {p?.saver ? "Energy saver on" : "Energy saver"}
        </button>
      </div>
      {modeAt >= 0 && (
        <div className="seg-slide" role="radiogroup" aria-label="Power mode" style={{ "--i": modeAt, "--n": 3 } as React.CSSProperties}>
          <span className="seg-thumb" aria-hidden="true" />
          {MODES.map(([id, label, hint]) => (
            <button
              key={id}
              role="radio"
              aria-checked={p?.mode === id}
              className={p?.mode === id ? "on" : ""}
              title={hint}
              onClick={() => {
                setP((x) => x && { ...x, mode: id });
                invoke<PowerState>("set_power_mode", { mode: id }).then(setP);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className={`power-timer${timer ? " running" : ""}`}>
        <Icon d={ICONS.timer} size={14} />
        {timer ? (
          <>
            <span className="grow">
              {timer.action === "sleep" ? "Sleeps" : "Shuts down"} in <b className="mono">{clockLeft(timer.at - now)}</b>
            </span>
            <button className="chip ghost" onClick={() => setTimer(leftMin + 15)}>
              +15m
            </button>
            <button className="chip" onClick={() => setTimer(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="seg-slide small" role="radiogroup" aria-label="When the timer ends" style={{ "--i": then === "sleep" ? 0 : 1, "--n": 2 } as React.CSSProperties}>
              <span className="seg-thumb" aria-hidden="true" />
              {(["sleep", "shutdown"] as const).map((a) => (
                <button key={a} role="radio" aria-checked={then === a} className={then === a ? "on" : ""} onClick={() => setThen(a)}>
                  {a === "sleep" ? "Sleep" : "Shut down"}
                </button>
              ))}
            </span>
            <span className="tool-hint">in</span>
            {TIMER_PRESETS.map((m) => (
              <button key={m} className="chip ghost" aria-label={`${then === "sleep" ? "Sleep" : "Shut down"} in ${m} minutes`} onClick={() => setTimer(m)}>
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </>
        )}
      </div>
      {/* Harmless ones first; the ones that end the session apart, and they ask once more. */}
      <div className="power-actions">
        <div className="power-group">{ACTIONS.slice(0, 3).map(actionBtn)}</div>
        <div className="power-group">{ACTIONS.slice(3).map(actionBtn)}</div>
      </div>
    </div>
  );
}

// ---------- color picker ----------

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

function ColorPicker({ onBack, onDone }: Props) {
  const [colors, setColors] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    invoke<string[]>("colors").then(setColors);
  }, []);
  const copy = (text: string) => invoke("clip_copy", { text }).then(() => setCopied(text));
  const [latest, ...older] = colors;
  return (
    <div className="tool">
      <Head title="Color picker" hint={copied ? `Copied ${copied}` : undefined} onBack={onBack} />
      <button
        className="shot-mode"
        onClick={() => {
          onDone(); // out of the picture first
          invoke("pick_color");
        }}
      >
        <Icon d={ICONS.picker} size={20} />
        <span>
          <b>Pick a color</b>
          <small>Click anywhere on screen · Esc or right-click cancels</small>
        </span>
      </button>
      {latest ? (
        <>
          <div className="color-latest">
            <span className="swatch big" style={{ background: latest }} />
            <button className="chip mono" title="Copy" onClick={() => copy(latest)}>
              {latest}
            </button>
            <button className="chip mono" title="Copy" onClick={() => copy(rgb(latest))}>
              {rgb(latest)}
            </button>
          </div>
          {older.length > 0 && (
            <div className="swatches">
              {older.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} title={`Copy ${c}`} aria-label={`Copy ${c}`} onClick={() => copy(c)} />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="tool-hint pad">Picked colors are copied as hex and kept here</div>
      )}
    </div>
  );
}

// ---------- what's new (opens by itself once after an update; see App.tsx) ----------

function WhatsNew({ onBack }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(""));
  }, []);
  const notes = version === null ? [] : NOTES.filter(([v]) => !version || !newer(v, version));
  return (
    <div className="tool">
      <Head title="What's new" hint={version ? `Pulo ${version}` : undefined} onBack={onBack} />
      <div className="news">
        {notes.map(([v, items], i) => (
          <section key={v}>
            {i > 0 && <h3 className="recent-day">Pulo {v}</h3>}
            <ul>
              {items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        ))}
        {version !== null && !notes.length && <div className="tool-hint pad">Nothing new in this version</div>}
      </div>
    </div>
  );
}

// ---------- camera mirror ----------

type CamError = "denied" | "none" | "busy";
const CAM_ERROR: Record<CamError, string> = {
  denied: "Windows is blocking camera access for desktop apps",
  none: "No camera found",
  busy: "Another app is using the camera",
};
let camId: string | undefined; // the camera picked last, while Pulo runs

/** The webcam, mirrored, to check yourself before a call. The camera is on only while this
 *  page is showing: leaving it, or the island closing, stops it (and its light). */
function Camera({ onBack, onDone }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [id, setId] = useState(camId);
  const [mirror, setMirror] = useState(true);
  const [error, setError] = useState<CamError | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    setLive(false);
    navigator.mediaDevices
      .getUserMedia({ video: id ? { deviceId: { exact: id } } : { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop()); // left before it opened
        stream = s;
        setError(null);
        if (video.current) video.current.srcObject = s;
        navigator.mediaDevices.enumerateDevices().then((d) => alive && setCams(d.filter((x) => x.kind === "videoinput")));
      })
      .catch((e: DOMException) => alive && setError(e.name === "NotAllowedError" ? "denied" : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? "none" : "busy"));
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [id]);
  const next = () => {
    const i = cams.findIndex((c) => c.deviceId === (id ?? cams[0]?.deviceId));
    camId = cams[(i + 1) % cams.length]?.deviceId;
    setId(camId);
  };
  return (
    <div className="tool">
      <Head title="Camera mirror" onBack={onBack}>
        {cams.length > 1 && (
          <button className="icon-btn" aria-label="Next camera" title="Next camera" onClick={next}>
            <Icon d={ICONS.swap} size={16} />
          </button>
        )}
        <button className={`chip${mirror ? " on" : ""}`} aria-pressed={mirror} title="Show it like a mirror, or as others see you" onClick={() => setMirror(!mirror)}>
          Mirror
        </button>
      </Head>
      {error ? (
        <div className="empty-note">
          <Icon d={ICONS.camera} size={22} />
          {CAM_ERROR[error]}
          {error === "denied" && (
            <button className="chip" onClick={() => invoke("launch", { target: "camera_privacy" }).then(onDone)}>
              Camera settings
            </button>
          )}
        </div>
      ) : (
        <div className="cam">
          <video ref={video} className={mirror ? "mirror" : ""} autoPlay muted playsInline onPlaying={() => setLive(true)} aria-label="Camera preview" />
          {!live && <span className="tool-hint">Starting the camera…</span>}
        </div>
      )}
    </div>
  );
}
