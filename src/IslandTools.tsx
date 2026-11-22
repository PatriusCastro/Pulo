// Pages that open in the island from its shortcut buttons, in place of the tabs: clipboard
// history, a calculator, the volume mixer and screenshots. The island never takes keyboard
// focus, so everything here works with the mouse.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ICONS, Icon } from "./icons";
import * as C from "./calc";

export const TOOL_TITLE = { clipboard: "Clipboard", calculator: "Calculator", mixer: "Volume mixer", screenshot: "Screenshot" } as const;
export type ToolId = keyof typeof TOOL_TITLE;
export const isTool = (t: string): t is ToolId => t in TOOL_TITLE;

type Props = { tool: ToolId; onBack: () => void; onDone: () => void; ago: (ms: number) => string };

export function ToolPage(p: Props) {
  return p.tool === "clipboard" ? <Clipboard {...p} /> : p.tool === "calculator" ? <Calculator {...p} /> : p.tool === "mixer" ? <Mixer {...p} /> : <Screenshot {...p} />;
}

function Head({ title, hint, onBack, children }: { title: string; hint?: string; onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="tool-head">
      <button className="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon d={ICONS.back} size={18} />
      </button>
      <span className="tool-title">{title}</span>
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

function VolumeRow({ name, letter, level, muted, onLevel, onMute }: { name: string; letter?: string; level: number; muted: boolean; onLevel: (v: number) => void; onMute: () => void }) {
  return (
    <div className={`mix-row${muted ? " muted" : ""}`}>
      <span className="mix-badge" aria-hidden="true">
        {letter ?? <Icon d={ICONS.volumeHigh} size={14} />}
      </span>
      <span className="mix-name" title={name}>
        {name}
      </span>
      <input
        type="range"
        className="slider"
        min={0}
        max={1}
        step={0.02}
        value={level}
        aria-label={`${name} volume`}
        aria-valuetext={muted ? "Muted" : `${Math.round(level * 100)}%`}
        style={{ "--pct": `${level * 100}%` } as React.CSSProperties}
        onChange={(e) => onLevel(+e.target.value)}
      />
      <span className="vol-pct mono">{Math.round(level * 100)}</span>
      <button className="icon-btn" aria-label={muted ? `Unmute ${name}` : `Mute ${name}`} aria-pressed={muted} onClick={onMute}>
        <Icon d={muted ? ICONS.mute : ICONS.volume} size={16} />
      </button>
    </div>
  );
}

function Mixer({ onBack, onDone }: Props) {
  const [master, setMaster] = useState<[number, boolean]>([0, false]);
  const [apps, setApps] = useState<AppVol[]>([]);
  const busy = useRef(0); // ms of the last change here: polling waits so it can't tug a slider back
  useEffect(() => {
    const get = () => {
      if (Date.now() - busy.current < 1500) return;
      invoke<[number, boolean]>("volume").then(setMaster);
      invoke<AppVol[]>("app_volumes").then(setApps);
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
  return (
    <div className="tool">
      <Head title="Volume mixer" onBack={onBack}>
        <button className="icon-btn" aria-label="Windows volume mixer" title="Windows volume mixer" onClick={() => invoke("open_mixer").then(onDone)}>
          <Icon d={ICONS.mixer} size={16} />
        </button>
      </Head>
      <div className="mix-list">
        <VolumeRow
          name="Speakers"
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
            <VolumeRow
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
