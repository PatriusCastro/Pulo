//! System state Pulo shows: now playing, volume, brightness, battery.
//! Volume, brightness and battery are push notifications from Windows; media is polled.

use serde::Serialize;
use std::{
    ffi::c_void,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};
use windows::{
    core::{implement, Result, GUID},
    Media::Control::*,
    Storage::Streams::DataReader,
    Win32::{
        Foundation::HANDLE,
        Media::Audio::{Endpoints::*, *},
        System::{Com::*, Power::*},
        UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK,
    },
};

#[derive(Serialize, Clone, PartialEq)]
pub struct Media {
    title: String,
    artist: String,
    playing: bool,
    art_rev: u32, // bumps when album art changes; UI then fetches it via `media_art`
    duration_ms: i64,
    position_ms: i64, // playback position as of `position_at`; the UI extrapolates while playing
    position_at: i64, // ms since epoch
}

/// WinRT DateTime (100 ns ticks since 1601) -> ms since 1970.
fn epoch_ms(t: windows::Foundation::DateTime) -> i64 {
    (t.UniversalTime - 116_444_736_000_000_000) / 10_000
}

#[derive(Serialize, Clone, PartialEq)]
pub struct Battery {
    percent: u32,
    charging: bool,
}

#[derive(Serialize, Clone)]
pub struct Snapshot {
    media: Option<Media>,
    battery: Option<Battery>,
}

pub static STATE: Mutex<Snapshot> = Mutex::new(Snapshot { media: None, battery: None });
pub static ART: Mutex<Vec<u8>> = Mutex::new(Vec::new());
pub static APP: OnceLock<AppHandle> = OnceLock::new();

fn emit_state() {
    let s = STATE.lock().unwrap().clone();
    if let Some(app) = APP.get() {
        let _ = app.emit("state", s);
    }
}

/// Momentary overlay: ("volume" | "brightness" | "power", level 0..1, flag = muted / charging).
fn hud(kind: &str, level: f32, flag: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("hud", (kind, level, flag));
    }
}

// ---------- media (System Media Transport Controls) ----------

fn manager() -> Option<&'static GlobalSystemMediaTransportControlsSessionManager> {
    static MGR: OnceLock<Option<GlobalSystemMediaTransportControlsSessionManager>> = OnceLock::new();
    MGR.get_or_init(|| GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok()).as_ref()
}

fn session() -> Option<GlobalSystemMediaTransportControlsSession> {
    manager()?.GetCurrentSession().ok()
}

static MEDIA_WAKE: OnceLock<Mutex<std::sync::mpsc::Sender<()>>> = OnceLock::new();

fn wake_media() {
    if let Some(tx) = MEDIA_WAKE.get() {
        let _ = tx.lock().unwrap().send(());
    }
}

/// Re-read the player whenever Windows says something changed (track, play state,
/// position, current player), instead of asking every second: each read is a
/// cross-process call into the player. A 30 s backstop covers missed events.
pub fn watch_media() {
    use windows::Foundation::TypedEventHandler;
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = MEDIA_WAKE.set(Mutex::new(tx));
    if let Some(m) = manager() {
        let _ = m.CurrentSessionChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
        let _ = m.SessionsChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
    }
    let mut hooked = String::new(); // player whose session events we listen to
    loop {
        if let Some(s) = session() {
            let id = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            if id != hooked {
                // ponytail: handlers on the previous player aren't removed; they only cause
                // an extra re-read. Keep tokens and unregister if players switch a lot.
                let _ = s.MediaPropertiesChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
                let _ = s.PlaybackInfoChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
                let _ = s.TimelinePropertiesChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
                hooked = id;
            }
        }
        poll_media();
        let _ = rx.recv_timeout(std::time::Duration::from_secs(30));
        std::thread::sleep(std::time::Duration::from_millis(60)); // let a burst of events land
        while rx.try_recv().is_ok() {}
    }
}

fn read_art(p: &GlobalSystemMediaTransportControlsSessionMediaProperties) -> Result<Vec<u8>> {
    let stream = p.Thumbnail()?.OpenReadAsync()?.get()?;
    let size = stream.Size()? as u32;
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.get()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    Ok(buf)
}

// ponytail: polled at 1 Hz by the main loop. Swap for the session's MediaPropertiesChanged /
// PlaybackInfoChanged events if idle CPU shows it.
pub fn poll_media() {
    let cur = session().and_then(|s| {
        let p = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let status = s.GetPlaybackInfo().ok()?.PlaybackStatus().ok()?;
        let playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        let tl = s.GetTimelineProperties().ok();
        let ticks = |r: Result<windows::Foundation::TimeSpan>| r.map_or(0, |t| t.Duration / 10_000);
        let timing = tl.map_or((0, 0, 0), |t| {
            let start = ticks(t.StartTime());
            (ticks(t.EndTime()) - start, ticks(t.Position()) - start, t.LastUpdatedTime().map_or(0, epoch_ms))
        });
        Some((p.Title().ok()?.to_string(), p.Artist().unwrap_or_default().to_string(), playing, p, timing))
    });
    let old = STATE.lock().unwrap().media.clone();
    let new = cur.map(|(title, artist, playing, p, (duration_ms, position_ms, position_at))| {
        let same_track = old.as_ref().is_some_and(|o| o.title == title && o.artist == artist);
        let mut art_rev = old.as_ref().map_or(0, |o| o.art_rev);
        // Players often publish the art a moment after the title, so retry while it's missing.
        if !same_track || ART.lock().unwrap().is_empty() {
            let bytes = read_art(&p).unwrap_or_default();
            if !same_track || !bytes.is_empty() {
                *ART.lock().unwrap() = bytes;
                art_rev += 1;
            }
        }
        Media { title, artist, playing, art_rev, duration_ms, position_ms, position_at }
    });
    if new != old {
        STATE.lock().unwrap().media = new;
        emit_state();
    }
}

pub fn media_control(action: &str) {
    let Some(s) = session() else { return };
    let op = match action {
        "toggle" => s.TryTogglePlayPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "prev" => s.TrySkipPreviousAsync(),
        _ => return,
    };
    if let Ok(op) = op {
        let _ = op.get();
    }
    // Players (browsers especially) report the new state a little after accepting the
    // command, so check a few times now instead of waiting for the 1 Hz tick.
    for ms in [100, 250, 500] {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        poll_media();
    }
}

// ---------- volume ----------

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeCb;

impl IAudioEndpointVolumeCallback_Impl for VolumeCb_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
        let d = unsafe { &*data };
        hud("volume", d.fMasterVolume, d.bMuted.as_bool());
        Ok(())
    }
}

/// Must be called on a thread that stays alive (it hosts the COM apartment).
// ponytail: watches the default device at startup only; plugging in headphones later is
// not followed. Add an IMMNotificationClient (OnDefaultDeviceChanged) to re-register.
pub fn watch_volume() -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let ep: IAudioEndpointVolume = en.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
        ep.RegisterControlChangeNotify(&IAudioEndpointVolumeCallback::from(VolumeCb))?;
        std::mem::forget(ep); // keep the registration alive for the life of the process
    }
    Ok(())
}

// ---------- downloads + file shelf ----------

const TEMP_EXTS: [&str; 6] = [".crdownload", ".part", ".partial", ".download", ".tmp", ".opdownload"];

/// Browsers write to a temp name and rename it when the download finishes, so a rename to
/// a non-temp name in Downloads means "download complete". Blocks; run on its own thread.
// ponytail: files saved straight into Downloads without a rename (some apps' Save As) are
// not reported. Add FILE_ACTION_ADDED + a size-settled check if that matters.
pub fn watch_downloads() -> Result<()> {
    use windows::Win32::{Storage::FileSystem::*, UI::Shell::*};
    let dir = unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None)?;
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as _));
        s
    };
    watch_dir(&dir, false, FILE_NOTIFY_CHANGE_FILE_NAME, |batch| {
        for (action, name) in batch {
            let lower = name.to_lowercase();
            if action == FILE_ACTION_RENAMED_NEW_NAME && !TEMP_EXTS.iter().any(|e| lower.ends_with(e)) && !name.starts_with('.') && !name.starts_with("~$") {
                if let Some(app) = APP.get() {
                    let _ = app.emit("download", format!(r"{dir}\{name}"));
                }
            }
        }
    })
}

/// Block forever, calling `f` with each batch of (action, path relative to `dir`) changes.
pub fn watch_dir(
    dir: &str,
    recursive: bool,
    filter: windows::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE,
    mut f: impl FnMut(Vec<(windows::Win32::Storage::FileSystem::FILE_ACTION, String)>),
) -> Result<()> {
    use windows::{core::HSTRING, Win32::Storage::FileSystem::*};
    let h = unsafe {
        CreateFileW(
            &HSTRING::from(dir),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )?
    };
    let mut buf = vec![0u32; 16 * 1024]; // 64 KB, DWORD-aligned as the API requires
    loop {
        let mut n = 0u32;
        unsafe {
            ReadDirectoryChangesW(h, buf.as_mut_ptr() as _, (buf.len() * 4) as u32, recursive, filter, Some(&mut n), None, None)?;
        }
        let mut batch = Vec::new();
        let mut off = 0usize;
        while n > 0 {
            let info = unsafe { &*((buf.as_ptr() as *const u8).add(off) as *const FILE_NOTIFY_INFORMATION) };
            let name = String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(info.FileName.as_ptr(), info.FileNameLength as usize / 2)
            });
            batch.push((info.Action, name));
            if info.NextEntryOffset == 0 {
                break;
            }
            off += info.NextEntryOffset as usize;
        }
        f(batch); // empty batch = buffer overflowed and changes were dropped
    }
}

/// Start a native drag of these files, as if from Explorer. Call on the UI thread while
/// the mouse button is down; returns when the drop finishes.
pub fn drag_files(hwnd: windows::Win32::Foundation::HWND, paths: &[String]) -> Result<()> {
    use windows::{
        core::HSTRING,
        Win32::{
            System::{Com::IDataObject, Ole::DROPEFFECT_COPY},
            UI::Shell::{Common::ITEMIDLIST, *},
        },
    };
    unsafe {
        let pidls: Vec<*const ITEMIDLIST> = paths
            .iter()
            .filter_map(|p| {
                let mut pidl = std::ptr::null_mut();
                SHParseDisplayName(&HSTRING::from(p.as_str()), None, &mut pidl, 0, None).ok()?;
                Some(pidl as *const _)
            })
            .collect();
        if pidls.is_empty() {
            return Ok(());
        }
        let items = SHCreateShellItemArrayFromIDLists(&pidls);
        for p in &pidls {
            CoTaskMemFree(Some(*p as _));
        }
        let data: IDataObject = items?.BindToHandler(None, &BHID_DataObject)?;
        let _ = SHDoDragDrop(Some(hwnd), &data, None, DROPEFFECT_COPY);
    }
    Ok(())
}

pub fn open_path(path: &str) {
    use windows::{
        core::{w, HSTRING, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    unsafe {
        ShellExecuteW(None, w!("open"), &HSTRING::from(path), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

// ---------- calendar (secret iCal link) ----------

/// Latest .ics text. Parsing happens in the UI (src/ics.ts), which has time zone data.
pub static CALENDAR: Mutex<String> = Mutex::new(String::new());

/// Download the calendar and push it to the UI if it changed. An empty link clears it.
pub fn fetch_calendar(link: &str) -> std::result::Result<String, String> {
    use windows::{core::HSTRING, Foundation::Uri, Web::Http::HttpClient};
    let link = link.trim();
    let text = if link.is_empty() {
        String::new()
    } else {
        let url = match link.strip_prefix("webcal://") {
            Some(rest) => format!("https://{rest}"),
            None => link.to_string(),
        };
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("The link must start with https:// or webcal://".into());
        }
        let get = || -> Result<String> {
            let uri = Uri::CreateUri(&HSTRING::from(&url))?;
            Ok(HttpClient::new()?.GetStringAsync(&uri)?.get()?.to_string())
        };
        let text = get().map_err(|e| format!("Couldn't load the calendar: {}", e.message()))?;
        if !text.contains("BEGIN:VCALENDAR") {
            return Err("That link didn't return a calendar (.ics) file.".into());
        }
        text
    };
    let changed = {
        let mut cur = CALENDAR.lock().unwrap();
        let changed = *cur != text;
        *cur = text.clone();
        changed
    };
    if changed {
        if let Some(app) = APP.get() {
            let _ = app.emit("calendar", &text);
        }
    }
    Ok(text)
}

// ---------- lyrics (LRCLIB, opt-in) ----------

/// Time-synced lyrics in LRC format from lrclib.net, or "" when it has none.
/// Sends only the track's title, artist and length. Callers check the opt-in first.
pub fn fetch_lyrics(artist: &str, title: &str, secs: i64) -> std::result::Result<String, String> {
    use windows::{
        core::{h, HSTRING},
        Foundation::Uri,
        Web::Http::HttpClient,
    };
    let get = || -> Result<String> {
        let esc = |s: &str| Uri::EscapeComponent(&HSTRING::from(s)).map(|h| h.to_string());
        let mut url = format!("https://lrclib.net/api/get?artist_name={}&track_name={}", esc(artist)?, esc(title)?);
        if secs > 0 {
            url += &format!("&duration={secs}");
        }
        let client = HttpClient::new()?;
        let _ = client.DefaultRequestHeaders()?.UserAgent()?.TryParseAdd(h!("Pulo/0.1"));
        Ok(client.GetStringAsync(&Uri::CreateUri(&HSTRING::from(url))?)?.get()?.to_string())
    };
    // A 404 (song not in the database) also lands here; both mean "no lyrics".
    let body = get().map_err(|e| e.message())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v["syncedLyrics"].as_str().unwrap_or_default().to_string())
}

// ---------- Windows notifications (packaged builds only) ----------

/// Ask once for notification access. Must run on the UI thread or Windows shows no prompt.
/// Doesn't wait for the answer; poll_notifications checks the status each second.
pub fn request_notification_access() {
    use windows::UI::Notifications::Management::*;
    if let Ok(l) = UserNotificationListener::Current() {
        if l.GetAccessStatus() == Ok(UserNotificationListenerAccessStatus::Unspecified) {
            let _ = l.RequestAccessAsync();
        }
    }
}

static SEEN_NOTIFICATIONS: Mutex<Option<std::collections::HashSet<u32>>> = Mutex::new(None);

/// Announce new toasts in the island. Needs package identity (the MSIX build) and the
/// user's consent; in the plain .exe the listener is unavailable and this does nothing.
// ponytail: polled from the 1 Hz loop; the NotificationChanged event isn't delivered to
// desktop apps, and a background task trigger is more packaging than this needs.
pub fn poll_notifications() {
    use windows::UI::Notifications::{Management::*, *};
    static DISABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if DISABLED.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Ok(l) = UserNotificationListener::Current() else {
        DISABLED.store(true, std::sync::atomic::Ordering::Relaxed); // no package identity
        return;
    };
    if l.GetAccessStatus() != Ok(UserNotificationListenerAccessStatus::Allowed) {
        return; // not answered yet, or turned off in Settings > Privacy > Notifications
    }
    let read = || -> Result<Vec<(u32, String, String, String)>> {
        let toast = KnownNotificationBindings::ToastGeneric()?;
        let mut out = Vec::new();
        for n in l.GetNotificationsAsync(NotificationKinds::Toast)?.get()? {
            let app = n.AppInfo().and_then(|a| a.DisplayInfo()?.DisplayName()).map(|s| s.to_string()).unwrap_or_default();
            let texts: Vec<String> = n
                .Notification()
                .and_then(|x| x.Visual()?.GetBinding(&toast)?.GetTextElements())
                .map(|t| t.into_iter().filter_map(|e| e.Text().ok().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            out.push((n.Id()?, app, texts.first().cloned().unwrap_or_default(), texts.get(1).cloned().unwrap_or_default()));
        }
        Ok(out)
    };
    let Ok(list) = read() else { return };
    let mut seen = SEEN_NOTIFICATIONS.lock().unwrap();
    let first = seen.is_none(); // don't replay what was already in Action Center at startup
    let ids = seen.get_or_insert_with(Default::default);
    for (id, app, title, body) in list {
        if ids.insert(id) && !first {
            if let Some(a) = APP.get() {
                let _ = a.emit("notification", (app, title, body));
            }
        }
    }
}

/// Press a Windows shortcut: keys go down in order, then up in reverse.
fn press(keys: &[windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() } },
    };
    let seq: Vec<INPUT> = keys.iter().map(|&k| key(k, false)).chain(keys.iter().rev().map(|&k| key(k, true))).collect();
    unsafe {
        SendInput(&seq, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Open Windows 11's own per-app volume mixer (Quick Settings), via Win+Ctrl+V.
// ponytail: native mixer instead of an in-island one. Build WASAPI session sliders
// (IAudioSessionManager2 + ISimpleAudioVolume) only if this flyout isn't enough.
pub fn open_mixer() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    press(&[VK_LWIN, VK_CONTROL, VK_V]);
}

/// Open Windows' clipboard history (Win+V). Picking an item pastes into the app you were
/// in, since the island never takes focus.
// ponytail: native history instead of Pulo's own clipboard store.
pub fn open_clipboard() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    press(&[VK_LWIN, VK_V]);
}

/// True once there's been no keyboard or mouse input for 5 minutes.
pub fn user_away() -> bool {
    use windows::Win32::{
        System::SystemInformation::GetTickCount,
        UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
    };
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe { GetLastInputInfo(&mut info).as_bool() && GetTickCount().wrapping_sub(info.dwTime) > 5 * 60_000 }
}

// ---------- brightness + battery (power setting notifications) ----------

const BRIGHTNESS: GUID = GUID::from_u128(0x8ffee2c6_2d01_46be_adb9_398addc5b4ff); // GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS
const BATTERY_PCT: GUID = GUID::from_u128(0xa7ad8041_b45a_4cae_87a3_eecbb468a9e1); // GUID_BATTERY_PERCENTAGE_REMAINING
const AC_DC: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548); // GUID_ACDC_POWER_SOURCE, 0 = AC

static LAST_BRIGHTNESS: Mutex<Option<u32>> = Mutex::new(None);

unsafe extern "system" fn on_power(_ctx: *const c_void, _ty: u32, setting: *const c_void) -> u32 {
    let s = unsafe { &*(setting as *const POWERBROADCAST_SETTING) };
    let v = unsafe { (s.Data.as_ptr() as *const u32).read_unaligned() };
    let g = s.PowerSetting;
    if g == BRIGHTNESS {
        // Windows sends the current value on registration; only show the HUD on real changes.
        let prev = LAST_BRIGHTNESS.lock().unwrap().replace(v);
        if prev.is_some_and(|p| p != v) {
            hud("brightness", v as f32 / 100.0, false);
        }
    } else if g == BATTERY_PCT || g == AC_DC {
        let mut st = STATE.lock().unwrap();
        let old = st.battery.clone();
        let mut b = old.clone().unwrap_or(Battery { percent: 100, charging: false });
        if g == BATTERY_PCT {
            b.percent = v;
        } else {
            b.charging = v == 0;
        }
        st.battery = Some(b.clone());
        drop(st);
        if old.as_ref() != Some(&b) {
            emit_state();
            if old.is_some_and(|o| o.charging != b.charging) {
                hud("power", b.percent as f32 / 100.0, b.charging);
            }
        }
    }
    0
}

pub fn watch_power() {
    // Leaked on purpose: Windows keeps calling back through this for the process lifetime.
    let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(on_power), Context: std::ptr::null_mut() }));
    for g in [BATTERY_PCT, AC_DC, BRIGHTNESS] {
        let mut h = std::ptr::null_mut();
        unsafe {
            let _ = PowerSettingRegisterNotification(&g, DEVICE_NOTIFY_CALLBACK, HANDLE(params as *mut _ as _), &mut h);
        }
    }
}
