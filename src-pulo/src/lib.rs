mod agents;
mod devices;
mod eq;
mod sys;
mod tools;
mod update;

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, thread, time::Duration};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{CreateRectRgn, SetWindowRgn},
        System::Registry::*,
        UI::{Shell::*, WindowsAndMessaging::*},
    },
};

/// Gap between the top of the screen and the pill, in px; a setting (top_gap), 6 by default.
static TOP_GAP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(6);
/// Transparent margin around the pill inside the window, for its smooth edge (see
/// apply_region). The pill's `top` in island.css.
const EDGE: f64 = 2.0;
// The window is always the largest pill size and never resizes (resizing makes the web
// content jump for a frame). Instead its window region, which is the only part that is
// drawn and clickable, is set to the pill's current size. Clicks elsewhere pass through.
// The open pill (420 wide, .pill.open in island.css) plus a 48 px shortcut column on
// each side (.side), and EDGE above and below it. Must match EXPANDED in App.tsx.
const MAX: (f64, f64) = (516.0, 268.0 + 2.0 * EDGE);
/// Shortcut buttons that fit in a side column (also MAX_SHORTCUTS in prefs.ts).
const MAX_SHORTCUTS: u32 = 5;

/// What's drawn and clickable: the pill at its current size, plus the shortcut buttons
/// beside it (counts are 0 unless the island is open).
#[derive(Clone, Copy)]
struct Region {
    w: f64,
    h: f64,
    left: u32,
    right: u32,
}
static REGION: Mutex<Region> = Mutex::new(Region { w: 200.0, h: 36.0, left: 0, right: 0 });

/// Long-lived background thread with a name (shows up in profilers and debuggers).
fn named(name: &str, f: impl FnOnce() + Send + 'static) {
    let _ = thread::Builder::new().name(name.into()).spawn(f);
}

fn hwnd(w: &WebviewWindow) -> HWND {
    HWND(w.hwnd().expect("hwnd").0)
}

fn px(v: f64, s: f64) -> i32 {
    (v * s).round() as i32
}

/// Clip the window to the pill's shape: rounded like the pill (radius as in island.css),
/// centered, flush to the top, plus a circle per shortcut button (.side, .shortcut in
/// island.css). Outside this shape the window doesn't exist, so clicks pass through, and
/// if Windows ever drops the transparency there are no square corners left to turn white.
fn apply_region(w: &WebviewWindow, s: f64) {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateEllipticRgn, CreateRoundRectRgn, DeleteObject, RGN_OR};
    let r = *REGION.lock().unwrap();
    let pill_w = r.w.min(MAX.0);
    let radius = if r.h <= 36.0 { r.h / 2.0 } else { 30.0 };
    let x0 = (px(MAX.0, s) - px(pill_w, s)) / 2;
    // Regions are whole pixels with no anti-aliasing. Cut exactly on the pill's edge, they
    // chop off the webview's smooth edge and leave stairs, so leave a little transparent
    // margin around every shape for that edge to fade out in. The pill sits EDGE below the
    // window's top so the margin goes all the way round.
    let m = px(EDGE, s);
    unsafe {
        // +1: GDI leaves out the right and bottom edges of round regions.
        let d = px(radius * 2.0, s) + 2 * m;
        let rgn = CreateRoundRectRgn(x0 - m, 0, x0 + px(pill_w, s) + m + 1, px(r.h, s) + 2 * m + 1, d, d);
        // 40 px buttons, 4 px into each 48 px column, rows every 48 px from 6 px below the
        // pill's top.
        for (n, x) in [(r.left, 4.0), (r.right, MAX.0 - 44.0)] {
            for row in 0..n.min(MAX_SHORTCUTS) {
                let y = EDGE + 6.0 + row as f64 * 48.0;
                let b = CreateEllipticRgn(px(x, s) - m, px(y, s) - m, px(x + 40.0, s) + m + 1, px(y + 40.0, s) + m + 1);
                CombineRgn(Some(rgn), Some(rgn), Some(b), RGN_OR);
                let _ = DeleteObject(b.into());
            }
        }
        keep_transparent(w); // before the redraw, so it never shows a frame without it
        SetWindowRgn(hwnd(w), Some(rgn), true); // the window takes ownership of rgn
    }
}

/// Transparency comes from DWM blur-behind with an empty region (how tao sets it up). tao
/// never re-applies it, and window activation or display changes can drop it, which turns
/// the pill's transparent corners white. Cheap and idempotent, so re-apply freely.
fn keep_transparent(w: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND};
    use windows::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
    unsafe {
        // The white is the window's own surface, which nothing paints. Paint it black: with
        // blur-behind on, black is see-through, and in the moments it's off, black blends into
        // the pill instead of flashing white. (Class-wide, so the Settings window gets it too;
        // its page covers it.)
        let _ = SetClassLongPtrW(hwnd(w), GCLP_HBRBACKGROUND, GetStockObject(BLACK_BRUSH).0 as isize);
        let empty = CreateRectRgn(0, 0, -1, -1);
        let bb = DWM_BLURBEHIND { dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION, fEnable: true.into(), hRgnBlur: empty, fTransitionOnMaximized: false.into() };
        let _ = DwmEnableBlurBehindWindow(hwnd(w), &bb);
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(empty.into());
    }
}

/// Where the island belongs: top center of the screen the mouse is on, sized for that
/// screen's DPI. Returns the window rect (x, y, w, h) and the scale.
fn target() -> (RECT, f64) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    unsafe {
        let mut c = Default::default();
        let _ = GetCursorPos(&mut c);
        let m = MonitorFromPoint(c, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(m, &mut info);
        let (mut dx, mut dy) = (96, 96);
        let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let s = dx as f64 / 96.0;
        let r = info.rcMonitor;
        let (pw, ph) = (px(MAX.0, s), px(MAX.1, s));
        let x = r.left + (r.right - r.left - pw) / 2;
        let gap = TOP_GAP.load(std::sync::atomic::Ordering::Relaxed) as f64;
        let y = r.top + px(gap - EDGE, s); // the pill sits EDGE into its window
        (RECT { left: x, top: y, right: x + pw, bottom: y + ph }, s)
    }
}

/// Move the window where it belongs, unless it's already there. Called every second, so
/// the island follows the mouse between screens and survives monitor and DPI changes
/// (moving to a screen with another DPI makes Windows rescale the window afterwards; the
/// next call puts it right).
fn place(w: &WebviewWindow) {
    let (t, s) = target();
    let mut cur = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd(w), &mut cur);
        if cur == t {
            return;
        }
        // Landing on a screen with another DPI makes tao rescale the window by the DPI ratio
        // on top of our size (WM_DPICHANGED), so set it again once it has arrived.
        for _ in 0..2 {
            let _ = SetWindowPos(hwnd(w), Some(HWND_TOPMOST), t.left, t.top, t.right - t.left, t.bottom - t.top, SWP_NOACTIVATE);
            let _ = GetWindowRect(hwnd(w), &mut cur);
            if cur == t {
                break;
            }
        }
    }
    apply_region(w, s);
    keep_transparent(w);
}

/// The pill's size, and how many shortcut buttons show on each side (0 unless open).
#[tauri::command]
fn resize(window: WebviewWindow, w: f64, h: f64, left: u32, right: u32) {
    *REGION.lock().unwrap() = Region { w, h, left, right };
    apply_region(&window, window.scale_factor().unwrap_or(1.0));
    keep_transparent(&window);
}

/// Island shortcuts. Fixed list: the webview can't ask Windows to run anything else.
#[tauri::command]
fn launch(app: AppHandle, target: String) {
    let cmd = match target.as_str() {
        "settings" => return open_settings(&app),
        "scratchpad" => return open_window(&app, "scratchpad", "Pulo scratchpad", (420.0, 480.0), true),
        "mixer" => return sys::open_mixer(),
        "clipboard" => return sys::open_clipboard(),
        "calculator" => "calc.exe",
        "screenshot" => "ms-screenclip:",
        "explorer" => "explorer.exe",
        "task_manager" => "taskmgr.exe",
        _ => return,
    };
    sys::open_path(cmd);
}

#[tauri::command]
fn devices() -> Vec<devices::Device> {
    devices::DEVICES.lock().unwrap().clone()
}

#[tauri::command]
fn open_mixer() {
    sys::open_mixer();
}

/// Put the island's transparency back and repaint, now and twice more shortly after: what
/// drops it (a tray menu opening, another Pulo window taking focus) can finish after the event
/// that tells us. From another thread on purpose: the tray menu blocks the main one.
fn refresh_island(app: &AppHandle) {
    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
    let Some(w) = app.get_webview_window("main") else { return };
    thread::spawn(move || {
        for ms in [0, 100, 400] {
            thread::sleep(Duration::from_millis(ms));
            keep_transparent(&w);
            unsafe {
                let _ = RedrawWindow(Some(hwnd(&w)), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
            }
        }
    });
}

/// Called by the UI after every click: clicking inside the webview drops the transparency.
#[tauri::command]
fn refresh_transparency(window: WebviewWindow) {
    keep_transparent(&window);
}

#[tauri::command]
fn snapshot() -> sys::Snapshot {
    sys::STATE.lock().unwrap().clone()
}

#[tauri::command]
fn media_art() -> Response {
    Response::new(sys::ART.lock().unwrap().clone())
}

#[tauri::command]
async fn media(action: String, value: Option<i64>) {
    sys::media_control(&action, value.unwrap_or(0));
}

#[tauri::command]
async fn open_path(path: String) {
    sys::open_path(&path);
}

// ---------- settings (settings.json in the app config folder) ----------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    #[serde(default)]
    calendar_url: String,
    #[serde(default)]
    lyrics: bool, // opt-in: sends track title/artist/length to lrclib.net
    #[serde(default)]
    off: Vec<String>, // features turned off (FEATURES in prefs.ts); everything else is on
    #[serde(default)]
    ui: serde_json::Value, // island-only preferences (Prefs in prefs.ts); not read here
    #[serde(default)]
    click_through: bool, // at rest, clicks go to what's under the island (watch_click_through)
    #[serde(default)]
    show_in_screenshots: bool, // off: hidden from screenshots, recordings and screen sharing
    #[serde(default)]
    top_gap: Option<u32>, // px between the top of the screen and the pill; None = 6
}

// ---------- click-through and screenshots ----------

static CLICK_THROUGH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn apply_window_settings(app: &AppHandle, s: &Settings) {
    CLICK_THROUGH.store(s.click_through, std::sync::atomic::Ordering::Relaxed);
    TOP_GAP.store(s.top_gap.unwrap_or(6).min(40), std::sync::atomic::Ordering::Relaxed); // place() moves it
    if let Some(w) = app.get_webview_window("main") {
        use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
        let a = if s.show_in_screenshots { WDA_NONE } else { WDA_EXCLUDEFROMCAPTURE };
        let mut cur = Default::default();
        unsafe {
            // Changing the affinity rebuilds the window's surface without its transparency
            // (white island), so only touch it on a real change, then restore and repaint.
            if GetWindowDisplayAffinity(hwnd(&w), &mut cur).is_ok() && cur == a.0 {
                return;
            }
            let _ = SetWindowDisplayAffinity(hwnd(&w), a);
            keep_transparent(&w);
            let _ = RedrawWindow(Some(hwnd(&w)), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
        }
    }
}

/// Whether the mouse is over the pill itself (not the transparent rest of the window).
fn over_pill(w: &WebviewWindow, r: Region) -> bool {
    let s = w.scale_factor().unwrap_or(1.0);
    let (mut c, mut win) = (Default::default(), RECT::default());
    unsafe {
        let _ = GetCursorPos(&mut c);
        let _ = GetWindowRect(hwnd(w), &mut win);
    }
    let x0 = win.left + (px(MAX.0, s) - px(r.w, s)) / 2;
    let y0 = win.top + px(EDGE, s);
    (x0..x0 + px(r.w, s)).contains(&c.x) && (y0..y0 + px(r.h, s)).contains(&c.y)
}

/// Click-through, only while clicks pass through. Through tao, not by setting the styles by
/// hand: tao rebuilds the window's styles from its own flags whenever one changes, which
/// stripped hand-set ones and left the rebuilt surface white.
fn set_through(w: &WebviewWindow, through: bool) {
    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
    let _ = w.set_ignore_cursor_events(through); // applied later, on tao's thread
    unsafe {
        let h = hwnd(w);
        keep_transparent(w);
        let _ = RedrawWindow(Some(h), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
    }
}

/// Click-through mode: at rest (or peeking) the island passes clicks to whatever is under
/// it, a browser's tabs say, and fades while the mouse is over it. Holding Ctrl makes it
/// take clicks again, and once open (Ctrl+click or the keyboard shortcut) it works as usual.
// ponytail: polls at 20 Hz while the mode is on; a low-level mouse hook if that ever shows up.
fn watch_click_through(w: WebviewWindow) {
    use tauri::Emitter;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    let (mut through, mut dim) = (false, false);
    loop {
        let on = CLICK_THROUGH.load(std::sync::atomic::Ordering::Relaxed);
        let r = *REGION.lock().unwrap();
        let key = |k: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| unsafe { GetAsyncKeyState(k.0 as i32) } < 0;
        let over = on && over_pill(&w, r);
        let t = on && r.h <= 36.0 && !key(VK_CONTROL);
        // A layered window draws nothing (Pulo vanishes) until it has an opacity, and tao
        // makes it layered without one, some time after set_ignore_cursor_events. Check here.
        unsafe {
            let h = hwnd(&w);
            if GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_LAYERED.0 as isize != 0
                && GetLayeredWindowAttributes(h, None, None, None).is_err()
            {
                let _ = SetLayeredWindowAttributes(h, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);
            }
        }
        if t != through {
            set_through(&w, t);
            through = t;
            let _ = w.emit("passthrough", t); // no mouseleave arrives once clicks pass through
        }
        let d = t && over;
        if d != dim {
            dim = d;
            let _ = w.emit("dim", d);
        }
        thread::sleep(Duration::from_millis(if on { 50 } else { 500 }));
    }
}

/// Features turned off, as last saved. Read by the background loops.
static OFF: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn on(feature: &str) -> bool {
    !OFF.lock().unwrap().iter().any(|f| f == feature)
}

/// Start the watcher thread of every feature that's on and not running yet. Turning a
/// feature off hides it at once; its thread stops with the next launch.
// ponytail: watchers block forever in OS waits, so there's no clean stop. Give each a stop
// flag if leaving one running until restart ever matters.
fn start_watchers() {
    static STARTED: Mutex<Vec<&str>> = Mutex::new(Vec::new());
    let watchers: [(&str, fn()); 6] = [
        ("media", sys::watch_media),
        ("downloads", || drop(sys::watch_downloads())),
        ("agents", || drop(agents::watch())),
        ("devices", devices::watch),
        ("equalizer", eq::run),
        ("hotkey", tools::watch_hotkey),
    ];
    let mut started = STARTED.lock().unwrap();
    for (name, f) in watchers {
        if on(name) && !started.contains(&name) {
            started.push(name);
            named(name, f);
        }
    }
}

/// Save, then tell every window (the island follows changes made in Settings at once).
fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_file(app);
    fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|e| e.to_string())?;
    *OFF.lock().unwrap() = s.off.clone();
    start_watchers();
    apply_window_settings(app, s);
    use tauri::Emitter;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

#[tauri::command]
fn set_lyrics(app: AppHandle, on: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.lyrics = on;
    save_settings(&app, &s)
}

#[tauri::command]
fn set_window(app: AppHandle, click_through: Option<bool>, show_in_screenshots: Option<bool>, top_gap: Option<u32>) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.top_gap = top_gap.or(s.top_gap);
    s.click_through = click_through.unwrap_or(s.click_through);
    s.show_in_screenshots = show_in_screenshots.unwrap_or(s.show_in_screenshots);
    save_settings(&app, &s)
}

/// Save the feature switches and/or the island preferences.
#[tauri::command]
fn set_prefs(app: AppHandle, off: Option<Vec<String>>, ui: Option<serde_json::Value>) -> Result<(), String> {
    let mut s = load_settings(&app);
    if let Some(off) = off {
        s.off = off;
    }
    if let Some(ui) = ui {
        s.ui = ui;
    }
    save_settings(&app, &s)
}

/// Synced lyrics for a track, or "" if none. Refuses unless the user opted in.
#[tauri::command]
async fn lyrics(app: AppHandle, artist: String, title: String, secs: i64) -> Result<String, String> {
    if !load_settings(&app).lyrics {
        return Err("Lyrics are turned off in Settings.".into());
    }
    sys::fetch_lyrics(&artist, &title, secs)
}

fn settings_file(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("settings.json")
}

fn load_settings(app: &AppHandle) -> Settings {
    fs::read(settings_file(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// Save the calendar link only if it loads, and return the calendar text.
#[tauri::command]
async fn set_calendar(app: AppHandle, url: String) -> Result<String, String> {
    let text = sys::fetch_calendar(&url)?;
    let mut s = load_settings(&app);
    s.calendar_url = url.trim().to_string();
    save_settings(&app, &s)?;
    Ok(text)
}

/// The UI turns the equalizer on while the expanded panel shows a playing track.
#[tauri::command]
fn equalizer(on: bool, fps: Option<u64>) {
    use std::sync::atomic::Ordering::Relaxed;
    if let Some(fps) = fps {
        eq::INTERVAL_MS.store(1000 / fps.clamp(1, 60), Relaxed);
    }
    eq::ON.store(on, Relaxed);
}

#[tauri::command]
fn agents() -> agents::Agents {
    agents::AGENTS.lock().unwrap().clone()
}

#[tauri::command]
fn calendar() -> String {
    sys::CALENDAR.lock().unwrap().clone()
}

fn open_settings(app: &AppHandle) {
    open_window(app, "settings", "Pulo settings", (520.0, 640.0), false);
}

/// Show the window `label` (index.html#label), creating it the first time.
fn open_window(app: &AppHandle, label: &'static str, title: &'static str, (w, h): (f64, f64), resizable: bool) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    // Built off the event-loop thread: creating a webview inside a menu callback can deadlock.
    let app = app.clone();
    thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(format!("index.html#{label}").into()))
            .title(title)
            .inner_size(w, h)
            .resizable(resizable)
            .center()
            .build();
    });
}

// ---------- autostart (HKCU Run key) ----------

const RUN_KEY: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");

/// Installed as an MSIX (Store or local test package) rather than by the .exe installer.
fn packaged() -> bool {
    windows::ApplicationModel::Package::Current().is_ok()
}

/// Packaged apps can't use the Run key (their HKCU writes go to a private copy), so they
/// start with Windows through the manifest's startup task instead.
fn startup_task() -> Option<windows::ApplicationModel::StartupTask> {
    windows::ApplicationModel::StartupTask::GetAsync(windows::core::h!("Pulo")).ok()?.get().ok()
}

#[tauri::command(async)]
fn autostart_enabled() -> bool {
    if packaged() {
        use windows::ApplicationModel::StartupTaskState as S;
        return startup_task().is_some_and(|t| matches!(t.State(), Ok(S::Enabled | S::EnabledByPolicy)));
    }
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

#[tauri::command(async)] // off the UI thread: the startup task calls block on WinRT
fn set_autostart(on: bool) {
    if packaged() {
        if let Some(t) = startup_task() {
            let _ = if on { t.RequestEnableAsync().and_then(|op| op.get()).map(|_| ()) } else { t.Disable() };
        }
        return;
    }
    unsafe {
        if on {
            let exe = std::env::current_exe().unwrap_or_default();
            let cmd: Vec<u16> = format!("\"{}\"", exe.display()).encode_utf16().chain([0]).collect();
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), REG_SZ.0, Some(cmd.as_ptr() as _), (cmd.len() * 2) as u32);
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"));
        }
    }
}

/// True when a fullscreen app, game or presentation owns the foreground.
fn fullscreen_app_active() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One island only: a second copy would stack its window on top of this one.
    // The handle stays open for the life of the process.
    unsafe {
        use windows::Win32::{Foundation::*, System::Threading::CreateMutexW};
        let _ = CreateMutexW(None, true, windows::core::w!("Local\\Pulo.SingleInstance"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
    }
    // Release builds abort on panic with no console, so leave a note of where it happened:
    // %LOCALAPPDATA%\com.pulo.dev\panic.log.
    std::panic::set_hook(Box::new(|info| {
        let dir = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("com.pulo.dev");
        let _ = fs::create_dir_all(&dir);
        let thread = thread::current().name().unwrap_or("?").to_string();
        let line = format!("{} [{thread}] {info}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        use std::io::Write;
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log")) {
            let _ = f.write_all(line.as_bytes());
        }
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Focus moving between any of Pulo's windows (the island, Settings, the tray menu's
        // hidden window) drops the island's transparency: white behind the pill.
        .on_window_event(|win, e| {
            if let tauri::WindowEvent::Focused(_) = e {
                refresh_island(win.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            resize,
            refresh_transparency,
            open_mixer,
            devices,
            launch,
            snapshot,
            media_art,
            media,
            open_path,
            get_settings,
            set_calendar,
            calendar,
            agents,
            equalizer,
            set_lyrics,
            set_prefs,
            lyrics,
            tools::tools_state,
            tools::tool,
            tools::stats,
            tools::volume,
            tools::set_volume,
            tools::hotkey_ok,
            autostart_enabled,
            set_autostart,
            set_window
        ])
        .setup(|app| {
            let _ = sys::APP.set(app.handle().clone());
            let w = app.get_webview_window("main").expect("main window");
            // Tool window: out of Alt+Tab and the taskbar. No-activate: clicking the island
            // never steals focus from the app you're in (and activation was what dropped the
            // window's transparency, see keep_transparent).
            unsafe {
                let h = hwnd(&w);
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE).0 as isize);
            }
            // Also tell tao, or its next style rebuild drops no-activate (see set_through).
            let _ = w.set_focusable(false);
            place(&w);
            apply_window_settings(app.handle(), &load_settings(app.handle()));
            let cw = w.clone();
            named("click-through", move || watch_click_through(cw));

            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let updates = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulo", true, None::<&str>)?;
            // The Store updates packaged copies itself; only the .exe install updates from GitHub.
            let menu = if packaged() {
                Menu::with_items(app, &[&settings, &quit])?
            } else {
                update::start(app.handle().clone(), updates.clone());
                Menu::with_items(app, &[&settings, &updates, &quit])?
            };
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("icon").clone())
                .tooltip("Pulo")
                .menu(&menu)
                .on_tray_icon_event(|tray, _| refresh_island(tray.app_handle()))
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "settings" => open_settings(app),
                    "update" => update::clicked(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            sys::watch_power();
            sys::request_notification_access(); // UI thread: required for the consent prompt
            *OFF.lock().unwrap() = load_settings(app.handle()).off;
            start_watchers();

            // Calendar refresh every 10 minutes.
            let handle = app.handle().clone();
            named("calendar", move || loop {
                let url = load_settings(&handle).calendar_url;
                if !url.is_empty() && on("calendar") {
                    let _ = sys::fetch_calendar(&url);
                }
                thread::sleep(Duration::from_secs(600));
            });

            // ponytail: 1 Hz poll for fullscreen, monitor changes and notifications (~0% CPU).
            // Switch to ABN_FULLSCREENAPP / WM_DISPLAYCHANGE if this ever shows up in a profile.
            // Media is event-driven (sys::watch_media).
            // Also hides on any fullscreen app, even one on a different monitor.
            named("tick", move || {
                let _ = sys::watch_volume(); // inits COM on this long-lived thread
                let _ = tools::watch_mic();
                let mut hidden = true; // window starts hidden; first tick shows it
                let mut away = false;
                let mut awake = false;
                loop {
                    let fs = fullscreen_app_active();
                    if fs != hidden {
                        hidden = fs;
                        // Through tao, so it knows: shown behind its back, its next style rebuild
                        // hid the island again. Not focusable, so showing doesn't activate it.
                        let _ = if fs { w.hide() } else { w.show() };
                    }
                    place(&w); // follows the mouse between screens; no-op when already there
                    // Windows drops the transparency now and then (focus and display changes),
                    // which paints the margin around the pill white. Put it back within a second.
                    keep_transparent(&w);
                    // tao has no flag for tool window (out of Alt+Tab), so its style rebuilds
                    // drop the one set in setup. Put it back; it doesn't touch layered.
                    unsafe {
                        let ex = GetWindowLongPtrW(hwnd(&w), GWL_EXSTYLE);
                        if ex & WS_EX_TOOLWINDOW.0 as isize == 0 {
                            SetWindowLongPtrW(hwnd(&w), GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
                        }
                    }
                    if on("notifications") {
                        sys::poll_notifications();
                    }
                    // Keep awake is held by this thread: the request lasts while it's set here.
                    let want = tools::AWAKE.load(std::sync::atomic::Ordering::Relaxed);
                    if want != awake {
                        awake = want;
                        tools::hold_awake(want);
                    }
                    if sys::user_away() != away {
                        away = !away;
                        use tauri::Emitter;
                        let _ = w.emit("away", away); // the pet naps while you're away
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pulo");
}
