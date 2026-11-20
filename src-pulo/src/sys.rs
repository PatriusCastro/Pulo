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
    album: String,
    duration_ms: i64,
    position_ms: i64, // playback position as of `position_at`; the UI extrapolates while playing
    position_at: i64, // ms since epoch
    can_seek: bool,
    shuffle: Option<bool>,      // None: the player doesn't offer shuffle
    repeat: Option<&'static str>, // "none" | "track" | "list"; None: not offered
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

/// A second player that is also playing, offered in the island as "Also playing".
#[derive(Serialize, Clone, PartialEq)]
pub struct Other {
    app: String,
    title: String,
    artist: String,
}

#[derive(Serialize, Clone)]
pub struct Snapshot {
    media: Option<Media>,
    other: Option<Other>,
    battery: Option<Battery>,
}

pub static STATE: Mutex<Snapshot> = Mutex::new(Snapshot { media: None, other: None, battery: None });
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

type Session = GlobalSystemMediaTransportControlsSession;

/// The player picked with "Also playing", by app id. Cleared when Windows moves to
/// another current player, so a pick doesn't outlive what the user was listening to.
// ponytail: players are told apart by app id, so two playing tabs of one browser count
// as one. Key on app id + title if that matters.
static PICK: Mutex<Option<String>> = Mutex::new(None);

fn app_id(s: &Session) -> String {
    s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
}

fn is_playing(s: &Session) -> bool {
    s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|p| p == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
}

fn sessions() -> Vec<Session> {
    manager().and_then(|m| m.GetSessions().ok()).map(|v| v.into_iter().collect()).unwrap_or_default()
}

/// "Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "MSEdge" -> a short label.
fn app_name(id: &str) -> String {
    let n = id.rsplit(['!', '\\']).next().unwrap_or(id);
    let n = n.strip_suffix(".exe").unwrap_or(n);
    match n.to_ascii_lowercase().as_str() {
        "msedge" => "Edge".into(),
        _ => n.to_string(),
    }
}

/// The player the island shows and controls: the one picked in the island, else
/// Windows' current player, unless that one is paused while another is playing.
fn session() -> Option<Session> {
    let all = sessions();
    let mut pick = PICK.lock().unwrap();
    if let Some(id) = pick.clone() {
        match all.iter().find(|s| app_id(s) == id) {
            Some(s) => return Some(s.clone()),
            None => *pick = None, // the picked player closed
        }
    }
    drop(pick);
    match manager()?.GetCurrentSession().ok() {
        Some(c) if is_playing(&c) => Some(c),
        c => all.into_iter().find(is_playing).or(c),
    }
}

/// Another player that is playing besides `shown`, if any: its app id, and what the island shows.
fn other(shown: Option<&Session>) -> Option<(String, Other)> {
    let shown = shown.map(app_id);
    let s = sessions().into_iter().find(|s| Some(app_id(s)) != shown && is_playing(s))?;
    let p = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let id = app_id(&s);
    let o = Other {
        app: app_name(&id),
        title: p.Title().ok()?.to_string(),
        artist: p.Artist().map(|h| h.to_string()).unwrap_or_default(),
    };
    Some((id, o))
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
/// Blocks forever; run on its own thread.
pub fn watch_media() {
    use windows::Foundation::TypedEventHandler;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // WinRT calls need an apartment
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = MEDIA_WAKE.set(Mutex::new(tx));
    if let Some(m) = manager() {
        let _ = m.CurrentSessionChanged(&TypedEventHandler::new(|_, _| {
            *PICK.lock().unwrap() = None;
            Ok(wake_media())
        }));
        let _ = m.SessionsChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
    }
    use std::time::{Duration, Instant};
    // Every player's events, not just the shown one's: a second player starting or
    // pausing changes which one is shown and the "Also playing" line.
    let mut hooked = std::collections::HashSet::new(); // players whose events we listen to
    let mut fast_until = Instant::now();
    loop {
        let all = sessions();
        let ids: Vec<String> = all.iter().map(app_id).collect();
        hooked.retain(|id| ids.contains(id)); // a player that closed gets hooked again if it returns
        for (s, id) in all.iter().zip(ids) {
            if hooked.insert(id) {
                // ponytail: handlers on closed players aren't removed; they only cause an
                // extra re-read. Keep tokens and unregister if players come and go a lot.
                let _ = s.MediaPropertiesChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
                let _ = s.PlaybackInfoChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
                let _ = s.TimelinePropertiesChanged(&TypedEventHandler::new(|_, _| Ok(wake_media())));
            }
        }
        // Browsers swap in the real cover some seconds after a track starts without saying
        // so (measured: Chrome reports its logo first). Look every second for a while after
        // a track change, then only on events with a 30 s backstop.
        if poll_media() {
            fast_until = Instant::now() + Duration::from_secs(15);
        }
        let wait = if Instant::now() < fast_until { Duration::from_secs(1) } else { Duration::from_secs(30) };
        let _ = rx.recv_timeout(wait);
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

/// Read the current player and push it to the UI if anything changed. Called by
/// watch_media on player events, and by media_control right after a button press.
/// Returns true when a different track started.
pub fn poll_media() -> bool {
    let shown = session();
    let also = other(shown.as_ref()).map(|(_, o)| o);
    let cur = shown.and_then(|s| {
        let p = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let info = s.GetPlaybackInfo().ok()?;
        let playing = info.PlaybackStatus().ok()? == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        let tl = s.GetTimelineProperties().ok();
        let ticks = |r: Result<windows::Foundation::TimeSpan>| r.map_or(0, |t| t.Duration / 10_000);
        let timing = tl.map_or((0, 0, 0), |t| {
            let start = ticks(t.StartTime());
            (ticks(t.EndTime()) - start, ticks(t.Position()) - start, t.LastUpdatedTime().map_or(0, epoch_ms))
        });
        // What the player lets us change. Browsers usually offer seeking but not shuffle/repeat.
        let controls = info.Controls().ok();
        let offers = |f: fn(&GlobalSystemMediaTransportControlsSessionPlaybackControls) -> Result<bool>| {
            controls.as_ref().is_some_and(|c| f(c).unwrap_or(false))
        };
        let can_seek = offers(|c| c.IsPlaybackPositionEnabled());
        let shuffle = if offers(|c| c.IsShuffleEnabled()) {
            Some(info.IsShuffleActive().and_then(|v| v.Value()).unwrap_or(false))
        } else {
            None
        };
        let repeat = offers(|c| c.IsRepeatEnabled()).then(|| match info.AutoRepeatMode().and_then(|v| v.Value()) {
            Ok(windows::Media::MediaPlaybackAutoRepeatMode::Track) => "track",
            Ok(windows::Media::MediaPlaybackAutoRepeatMode::List) => "list",
            _ => "none",
        });
        let text = |r: Result<windows::core::HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
        let (artist, album) = (text(p.Artist()), text(p.AlbumTitle()));
        Some((p.Title().ok()?.to_string(), artist, album, playing, p, timing, (can_seek, shuffle, repeat)))
    });
    let old = STATE.lock().unwrap().media.clone();
    let new = cur.map(|(title, artist, album, playing, p, (duration_ms, position_ms, position_at), (can_seek, shuffle, repeat))| {
        let same_track = old.as_ref().is_some_and(|o| o.title == title && o.artist == artist);
        let mut art_rev = old.as_ref().map_or(0, |o| o.art_rev);
        // Players often publish the art after the title, and browsers first report their own
        // app icon as the art until the page sets the cover. So re-read on every change (this
        // only runs on player events) and swap whenever the image differs.
        let bytes = read_art(&p).unwrap_or_default();
        let mut art = ART.lock().unwrap();
        if !same_track || (!bytes.is_empty() && *art != bytes) {
            *art = bytes;
            art_rev += 1;
        }
        drop(art);
        Media { title, artist, album, playing, art_rev, duration_ms, position_ms, position_at, can_seek, shuffle, repeat }
    });
    let new_track = match (&old, &new) {
        (Some(o), Some(n)) => o.title != n.title || o.artist != n.artist,
        (None, Some(_)) => true,
        _ => false,
    };
    let mut st = STATE.lock().unwrap();
    if new != old || also != st.other {
        st.media = new;
        st.other = also;
        drop(st);
        emit_state();
    }
    new_track
}

/// `value`: the position in ms for "seek"; unused otherwise.
/// "swap" shows the "Also playing" player instead of the current one.
pub fn media_control(action: &str, value: i64) {
    use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
    if action == "swap" {
        if let Some((id, _)) = other(session().as_ref()) {
            *PICK.lock().unwrap() = Some(id);
        }
        poll_media();
        return;
    }
    let Some(s) = session() else { return };
    let op = match action {
        "toggle" => s.TryTogglePlayPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "prev" => s.TrySkipPreviousAsync(),
        "shuffle" => s.GetPlaybackInfo().and_then(|i| {
            let on = i.IsShuffleActive().and_then(|v| v.Value()).unwrap_or(false);
            s.TryChangeShuffleActiveAsync(!on)
        }),
        // Off -> all -> one -> off, like most players' repeat button.
        "repeat" => s.GetPlaybackInfo().and_then(|i| {
            let next = match i.AutoRepeatMode().and_then(|v| v.Value()) {
                Ok(Repeat::List) => Repeat::Track,
                Ok(Repeat::Track) => Repeat::None,
                _ => Repeat::List,
            };
            s.TryChangeAutoRepeatModeAsync(next)
        }),
        // The timeline may not start at 0; positions in the UI are relative to its start.
        "seek" => s.GetTimelineProperties().and_then(|t| {
            let start = t.StartTime().map_or(0, |d| d.Duration);
            s.TryChangePlaybackPositionAsync(start + value.max(0) * 10_000)
        }),
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

// ---------- downloads ----------

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

/// Desktops get the AC notification too; without this they'd show a "charging 100%" battery.
fn has_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    // 128 = no system battery, 255 = unknown status
    let ok = unsafe { GetSystemPowerStatus(&mut s).is_ok() };
    ok && s.BatteryFlag != 128 && s.BatteryFlag != 255
}

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
    } else if (g == BATTERY_PCT || g == AC_DC) && has_battery() {
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
