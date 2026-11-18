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

fn session() -> Option<GlobalSystemMediaTransportControlsSession> {
    static MGR: OnceLock<Option<GlobalSystemMediaTransportControlsSessionManager>> = OnceLock::new();
    MGR.get_or_init(|| GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok())
        .as_ref()?
        .GetCurrentSession()
        .ok()
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
        Some((p.Title().ok()?.to_string(), p.Artist().unwrap_or_default().to_string(), playing, p))
    });
    let old = STATE.lock().unwrap().media.clone();
    let new = cur.map(|(title, artist, playing, p)| {
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
        Media { title, artist, playing, art_rev }
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
    poll_media(); // reflect the change now instead of on the next tick
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
    use windows::{
        core::HSTRING,
        Win32::{Storage::FileSystem::*, UI::Shell::*},
    };
    let dir = unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None)?;
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as _));
        s
    };
    let h = unsafe {
        CreateFileW(
            &HSTRING::from(&dir),
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
            ReadDirectoryChangesW(h, buf.as_mut_ptr() as _, (buf.len() * 4) as u32, false, FILE_NOTIFY_CHANGE_FILE_NAME, Some(&mut n), None, None)?;
        }
        let mut off = 0usize;
        while n > 0 {
            let info = unsafe { &*((buf.as_ptr() as *const u8).add(off) as *const FILE_NOTIFY_INFORMATION) };
            let name = String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(info.FileName.as_ptr(), info.FileNameLength as usize / 2)
            });
            let lower = name.to_lowercase();
            if info.Action == FILE_ACTION_RENAMED_NEW_NAME && !TEMP_EXTS.iter().any(|e| lower.ends_with(e)) && !name.starts_with('.') && !name.starts_with("~$") {
                if let Some(app) = APP.get() {
                    let _ = app.emit("download", format!(r"{dir}\{name}"));
                }
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            off += info.NextEntryOffset as usize;
        }
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
