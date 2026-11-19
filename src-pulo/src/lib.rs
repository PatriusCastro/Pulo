mod agents;
mod devices;
mod eq;
mod sys;
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

const TOP_MARGIN: f64 = 6.0;
// The window is always the largest pill size and never resizes (resizing makes the web
// content jump for a frame). Instead its window region, which is the only part that is
// drawn and clickable, is set to the pill's current size. Clicks elsewhere pass through.
// The open pill (420 wide, .pill.open in island.css) plus a 48 px shortcut column on
// each side (.side). Must match EXPANDED in App.tsx.
const MAX: (f64, f64) = (516.0, 268.0);
static REGION: Mutex<(f64, f64)> = Mutex::new((200.0, 36.0));

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
/// centered, flush to the top. When open, add a circle per shortcut button (.side,
/// .shortcut in island.css). Outside this shape the window doesn't exist, so clicks pass
/// through, and if Windows ever drops the transparency there are no square corners left
/// to turn white.
fn apply_region(w: &WebviewWindow, s: f64) {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateEllipticRgn, CreateRoundRectRgn, DeleteObject, RGN_OR};
    let (rw, rh) = *REGION.lock().unwrap();
    let open = rw > 420.0; // the expanded size includes the shortcut columns
    let pill_w = if open { 420.0 } else { rw };
    let radius = if rh <= 36.0 { rh / 2.0 } else { 30.0 };
    let x0 = (px(MAX.0, s) - px(pill_w, s)) / 2;
    unsafe {
        // +1: GDI leaves out the right and bottom edges of round regions.
        let rgn = CreateRoundRectRgn(x0, 0, x0 + px(pill_w, s) + 1, px(rh, s) + 1, px(radius * 2.0, s), px(radius * 2.0, s));
        if open {
            // 40 px buttons, 4 px into each 48 px column, rows every 48 px from y = 6.
            for row in 0..4 {
                let y = 6.0 + row as f64 * 48.0;
                for x in [4.0, MAX.0 - 44.0] {
                    let b = CreateEllipticRgn(px(x, s), px(y, s), px(x + 40.0, s) + 1, px(y + 40.0, s) + 1);
                    CombineRgn(Some(rgn), Some(rgn), Some(b), RGN_OR);
                    let _ = DeleteObject(b.into());
                }
            }
        }
        SetWindowRgn(hwnd(w), Some(rgn), true); // the window takes ownership of rgn
    }
}

/// Transparency comes from DWM blur-behind with an empty region (how tao sets it up). tao
/// never re-applies it, and window activation or display changes can drop it, which turns
/// the pill's transparent corners white. Cheap and idempotent, so re-apply freely.
fn keep_transparent(w: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND};
    unsafe {
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
        let y = r.top + px(TOP_MARGIN, s);
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

#[tauri::command]
fn resize(window: WebviewWindow, w: f64, h: f64) {
    *REGION.lock().unwrap() = (w, h);
    apply_region(&window, window.scale_factor().unwrap_or(1.0));
    keep_transparent(&window);
}

/// Island shortcuts. Fixed list: the webview can't ask Windows to run anything else.
#[tauri::command]
fn launch(app: AppHandle, target: String) {
    let cmd = match target.as_str() {
        "settings" => return open_settings(&app),
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
async fn media(action: String) {
    sys::media_control(&action);
}

// Sync on purpose: runs on the UI thread, which OLE drag and drop requires.
#[tauri::command]
fn drag_out(window: WebviewWindow, paths: Vec<String>) {
    let _ = sys::drag_files(hwnd(&window), &paths);
}

#[tauri::command]
async fn open_path(path: String) {
    sys::open_path(&path);
}

// ---------- settings (settings.json in the app config folder) ----------

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(default)]
    calendar_url: String,
    #[serde(default)]
    lyrics: bool, // opt-in: sends track title/artist/length to lrclib.net
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_file(app);
    fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_lyrics(app: AppHandle, on: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.lyrics = on;
    save_settings(&app, &s)?;
    use tauri::Emitter;
    let _ = app.emit("lyrics_enabled", on);
    Ok(())
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
fn equalizer(on: bool) {
    eq::ON.store(on, std::sync::atomic::Ordering::Relaxed);
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
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // Built off the event-loop thread: creating a webview inside a menu callback can deadlock.
    let app = app.clone();
    thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html#settings".into()))
            .title("Pulo settings")
            .inner_size(480.0, 380.0)
            .resizable(false)
            .center()
            .build();
    });
}

// ---------- autostart (HKCU Run key) ----------

const RUN_KEY: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");

#[tauri::command]
fn autostart_enabled() -> bool {
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

#[tauri::command]
fn set_autostart(on: bool) {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            resize,
            refresh_transparency,
            open_mixer,
            devices,
            launch,
            snapshot,
            media_art,
            media,
            drag_out,
            open_path,
            get_settings,
            set_calendar,
            calendar,
            agents,
            equalizer,
            set_lyrics,
            lyrics,
            autostart_enabled,
            set_autostart
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
            place(&w);

            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let updates = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &updates, &quit])?;
            update::start(app.handle().clone(), updates);
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("icon").clone())
                .tooltip("Pulo")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "settings" => open_settings(app),
                    "update" => update::clicked(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            sys::watch_power();
            sys::request_notification_access(); // UI thread: required for the consent prompt
            named("downloads", || drop(sys::watch_downloads()));
            named("agents", || drop(agents::watch()));
            named("devices", devices::watch);
            named("equalizer", eq::run);

            // Calendar refresh every 10 minutes.
            let handle = app.handle().clone();
            named("calendar", move || loop {
                let url = load_settings(&handle).calendar_url;
                if !url.is_empty() {
                    let _ = sys::fetch_calendar(&url);
                }
                thread::sleep(Duration::from_secs(600));
            });

            // ponytail: 1 Hz poll for fullscreen, monitor changes and media (~0% CPU). Switch to
            // ABN_FULLSCREENAPP / WM_DISPLAYCHANGE / SMTC events if this ever shows up in a profile.
            // Also hides on any fullscreen app, even one on a different monitor.
            named("tick", move || {
                let _ = sys::watch_volume(); // inits COM on this long-lived thread
                let mut hidden = true; // window starts hidden; first tick shows it
                let mut away = false;
                loop {
                    let fs = fullscreen_app_active();
                    if fs != hidden {
                        hidden = fs;
                        let cmd = if fs { SW_HIDE } else { SW_SHOWNOACTIVATE };
                        unsafe {
                            let _ = ShowWindow(hwnd(&w), cmd);
                        }
                    }
                    place(&w); // follows the mouse between screens; no-op when already there
                    sys::poll_media();
                    sys::poll_notifications();
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
