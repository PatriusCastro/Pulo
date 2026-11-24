//! Quick toggles in the island's Tools tab: dark mode, mic mute, keep awake, lock, empty
//! Recycle Bin.

use crate::sys::APP;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use tauri::Emitter;
use windows::{
    core::{implement, w, Result, PCWSTR},
    Win32::{
        Foundation::{LPARAM, WPARAM},
        Media::Audio::{Endpoints::*, *},
        System::{Com::*, Power::*, Registry::*},
        UI::{Shell::SHEmptyRecycleBinW, WindowsAndMessaging::*},
    },
};

/// Keep awake, applied by the 1 Hz loop in lib.rs (see hold_awake). Off at every launch.
pub static AWAKE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct State {
    dark: bool,
    mic_muted: bool,
    awake: bool,
    wifi: Option<bool>, // None: no such radio
    bluetooth: Option<bool>,
}

const THEME: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");

fn dark() -> bool {
    let (mut v, mut n) = (1u32, 4u32);
    unsafe {
        let _ = RegGetValueW(HKEY_CURRENT_USER, THEME, w!("AppsUseLightTheme"), RRF_RT_REG_DWORD, None, Some(&mut v as *mut u32 as _), Some(&mut n));
    }
    v == 0
}

/// Same switch as Settings > Personalization > Colors: apps and Windows together.
fn set_dark(on: bool) {
    let light = u32::from(!on);
    unsafe {
        for name in [w!("AppsUseLightTheme"), w!("SystemUsesLightTheme")] {
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, THEME, name, REG_DWORD.0, Some(&light as *const u32 as _), 4);
        }
        // Running apps re-read the theme when told it changed.
        let _ = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("ImmersiveColorSet").as_ptr() as isize), SMTO_ABORTIFHUNG, 200, None);
    }
}

/// The default microphone's volume control.
fn mic() -> Result<IAudioEndpointVolume> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // no-op if this thread already has COM
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        en.GetDefaultAudioEndpoint(eCapture, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn mic_muted() -> bool {
    mic().and_then(|m| unsafe { m.GetMute() }).is_ok_and(|b| b.as_bool())
}

#[implement(IAudioEndpointVolumeCallback)]
struct MicCb;

impl IAudioEndpointVolumeCallback_Impl for MicCb_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
        // Also called on every level change, which call apps' auto-gain does constantly:
        // only pass on a change of mute.
        static LAST: AtomicBool = AtomicBool::new(false);
        let muted = unsafe { (*data).bMuted.as_bool() };
        if LAST.swap(muted, Relaxed) != muted {
            if let Some(app) = APP.get() {
                let _ = app.emit("mic", muted);
            }
        }
        Ok(())
    }
}

/// Follow mute changes from anywhere (Teams, the keyboard, Pulo). Call on a thread that
/// stays alive, like sys::watch_volume.
// ponytail: the default mic at startup only, like watch_volume.
pub fn watch_mic() -> Result<()> {
    let ep = mic()?;
    unsafe { ep.RegisterControlChangeNotify(&IAudioEndpointVolumeCallback::from(MicCb))? };
    std::mem::forget(ep); // keep the registration alive for the life of the process
    Ok(())
}

/// Keep the screen on and the PC awake, or stop. The request belongs to the calling
/// thread, so call it from one that lives as long as the app.
pub fn hold_awake(on: bool) {
    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS };
    unsafe {
        SetThreadExecutionState(flags);
    }
}

// ---------- speaker volume (music page slider) ----------

fn speakers() -> Result<IAudioEndpointVolume> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        en.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

/// Master volume of the default speakers, 0..1, and whether they're muted (muting keeps the
/// level, as Windows does).
#[tauri::command]
pub async fn volume() -> (f32, bool) {
    speakers()
        .and_then(|v| unsafe { Ok((v.GetMasterVolumeLevelScalar()?, v.GetMute()?.as_bool())) })
        .unwrap_or((0.0, false))
}

#[tauri::command]
pub async fn set_muted(on: bool) {
    if let Ok(v) = speakers() {
        unsafe {
            let _ = v.SetMute(on, std::ptr::null());
        }
    }
}

#[tauri::command]
pub async fn set_volume(level: f32) {
    if let Ok(v) = speakers() {
        unsafe {
            let _ = v.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null());
            let _ = v.SetMute(level <= 0.0, std::ptr::null()); // dragging up from 0 unmutes
        }
    }
}

// ---------- system stats (asked for every 2 s while the Now or Tools tab is showing) ----------

#[derive(Serialize)]
pub struct Stats {
    cpu: f64,  // percent; -1 on the first call, which has nothing to compare with
    mem: u32,  // percent in use
    mem_used: u64, // bytes of RAM
    mem_total: u64,
    down: f64, // bytes per second, all physical network adapters
    up: f64,
    gpu: f64, // percent like Task Manager's; -1 when unknown (first call, or no counters)
}

/// The "GPU Engine" performance counters Task Manager reads: one instance per process and
/// engine. Kept open, since a rate needs two samples.
static GPU_QUERY: std::sync::Mutex<Option<(isize, isize)>> = std::sync::Mutex::new(None);

/// Busiest GPU engine, in percent. Task Manager's GPU figure: sum each engine over all
/// processes, take the highest.
fn gpu_percent() -> f64 {
    use windows::{core::w, Win32::System::Performance::*};
    let mut q = GPU_QUERY.lock().unwrap();
    unsafe {
        if q.is_none() {
            let (mut query, mut counter) = (PDH_HQUERY::default(), PDH_HCOUNTER::default());
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return -1.0;
            }
            if PdhAddEnglishCounterW(query, w!(r"\GPU Engine(*)\Utilization Percentage"), 0, &mut counter) != 0 {
                let _ = PdhCloseQuery(query);
                return -1.0;
            }
            let _ = PdhCollectQueryData(query);
            *q = Some((query.0 as isize, counter.0 as isize));
            return -1.0;
        }
        let (query, counter) = q.unwrap();
        let (query, counter) = (PDH_HQUERY(query as _), PDH_HCOUNTER(counter as _));
        if PdhCollectQueryData(query) != 0 {
            return -1.0;
        }
        let (mut size, mut n) = (0u32, 0u32);
        let _ = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut n, None);
        if size == 0 {
            return -1.0;
        }
        let mut buf = vec![0u8; size as usize];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut n, Some(items)) != 0 {
            return -1.0;
        }
        let mut engines = std::collections::HashMap::<String, f64>::new();
        for it in std::slice::from_raw_parts(items, n as usize) {
            // "pid_1234_luid_0x0_0x1_phys_0_eng_3_engtype_3D": the engine is everything after the pid.
            let name = it.szName.to_string().unwrap_or_default();
            let engine = name.find("_luid").map_or(name.as_str(), |i| &name[i..]).to_string();
            *engines.entry(engine).or_default() += it.FmtValue.Anonymous.doubleValue;
        }
        engines.values().fold(0.0, |a: f64, &b| a.max(b)).min(100.0)
    }
}

/// (when, idle ticks, busy+idle ticks, bytes received, bytes sent) at the previous call.
static PREV: std::sync::Mutex<Option<(std::time::Instant, u64, u64, u64, u64)>> = std::sync::Mutex::new(None);

fn ticks(t: windows::Win32::Foundation::FILETIME) -> u64 {
    (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64
}

/// Bytes received and sent by physical adapters. Virtual switches and filter drivers
/// repeat the same traffic, so they're skipped.
fn net_bytes() -> (u64, u64) {
    use windows::Win32::NetworkManagement::IpHelper::*;
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    let mut sum = (0, 0);
    unsafe {
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return sum;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        for r in rows {
            let flags = r.InterfaceAndOperStatusFlags._bitfield;
            let hardware = flags & 1 != 0;
            let filter = flags & 2 != 0;
            if hardware && !filter {
                sum.0 += r.InOctets;
                sum.1 += r.OutOctets;
            }
        }
        FreeMibTable(table as _);
    }
    sum
}

#[tauri::command]
pub fn stats() -> Stats {
    use windows::Win32::System::{SystemInformation::*, Threading::GetSystemTimes};
    let (mut idle, mut kernel, mut user) = Default::default();
    let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe {
        let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
        let _ = GlobalMemoryStatusEx(&mut mem);
    }
    let (idle, total) = (ticks(idle), ticks(kernel) + ticks(user)); // kernel time includes idle
    let (rx, tx) = net_bytes();
    let now = std::time::Instant::now();
    let prev = PREV.lock().unwrap().replace((now, idle, total, rx, tx));
    let mut s = Stats { cpu: -1.0, mem: mem.dwMemoryLoad, mem_used: mem.ullTotalPhys - mem.ullAvailPhys, mem_total: mem.ullTotalPhys, down: 0.0, up: 0.0, gpu: gpu_percent() };
    if let Some((t0, idle0, total0, rx0, tx0)) = prev {
        let secs = now.duration_since(t0).as_secs_f64().max(0.001);
        let busy = total.saturating_sub(total0);
        if busy > 0 {
            s.cpu = 100.0 * (1.0 - idle.saturating_sub(idle0) as f64 / busy as f64);
        }
        s.down = rx.saturating_sub(rx0) as f64 / secs;
        s.up = tx.saturating_sub(tx0) as f64 / secs;
    }
    s
}

// ---------- top apps (the Performance page's Apps view) ----------

#[derive(Serialize)]
pub struct AppUse {
    name: String,
    cpu: f64, // percent of all cores since the last call; 0 on the first
    mem: u64, // bytes in RAM (working set), summed over the app's processes
}

/// pid -> (exe path, CPU time in 100 ns) at the last call, and when that was.
static PROC_PREV: std::sync::Mutex<Option<(std::time::Instant, std::collections::HashMap<u32, u64>)>> = std::sync::Mutex::new(None);
/// exe path -> name, since reading version info for ~300 processes every 2 s adds up.
static PROC_NAMES: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> = std::sync::Mutex::new(None);

/// Apps by CPU then memory, processes of one program grouped like Task Manager's. Processes
/// Pulo isn't allowed to open (elevated, other users, protected) are left out.
#[tauri::command]
pub async fn top_apps() -> Vec<AppUse> {
    use std::collections::HashMap;
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::{Diagnostics::ToolHelp::*, ProcessStatus::*, Threading::*},
    };
    let now = std::time::Instant::now();
    let mut times = HashMap::new();
    let mut apps: HashMap<String, AppUse> = HashMap::new();
    let mut prev = PROC_PREV.lock().unwrap();
    let mut names = PROC_NAMES.lock().unwrap();
    let names = names.get_or_insert_with(HashMap::new);
    let secs = prev.as_ref().map(|(t, _)| now.duration_since(*t).as_secs_f64());
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return vec![] };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut e).is_ok();
        while more {
            let pid = e.th32ProcessID;
            if pid != 0 && let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                let mut m = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
                if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok() && K32GetProcessMemoryInfo(h, &mut m, m.cb).as_bool() {
                    let cpu = ticks(k) + ticks(u);
                    times.insert(pid, cpu);
                    let file = String::from_utf16_lossy(&e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len())]);
                    let name = match exe_path(pid) {
                        Some(path) => names.entry(path.clone()).or_insert_with(|| describe(&path).unwrap_or_else(|| file.trim_end_matches(".exe").to_string())).clone(),
                        None => file.trim_end_matches(".exe").to_string(),
                    };
                    let busy = match (secs, prev.as_ref().and_then(|(_, p)| p.get(&pid))) {
                        (Some(s), Some(&before)) if s > 0.0 => cpu.saturating_sub(before) as f64 / 1e7 / s / cores * 100.0,
                        _ => 0.0,
                    };
                    let a = apps.entry(name.clone()).or_insert(AppUse { name, cpu: 0.0, mem: 0 });
                    a.cpu += busy;
                    a.mem += m.WorkingSetSize as u64;
                }
                let _ = CloseHandle(h);
            }
            more = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    *prev = Some((now, times));
    let mut list: Vec<AppUse> = apps.into_values().collect();
    list.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.mem.cmp(&a.mem)));
    list
}

// ---------- keyboard shortcut ----------

/// False if another app already owns the shortcut.
pub static HOTKEY_OK: AtomicBool = AtomicBool::new(true);

/// Ctrl+Alt+Space toggles the island. Blocks on this thread's message queue; run on its
/// own thread (the hotkey belongs to the thread that registered it).
// ponytail: fixed key. Make it a setting if it clashes for someone.
pub fn watch_hotkey() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    unsafe {
        if RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_SPACE.0 as u32).is_err() {
            HOTKEY_OK.store(false, Relaxed);
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                crate::shortcut_pressed(); // shows it first if a hide rule has it hidden
                if let Some(app) = APP.get() {
                    let _ = app.emit("hotkey", ());
                }
            }
        }
    }
}

#[tauri::command]
pub fn hotkey_ok() -> bool {
    HOTKEY_OK.load(Relaxed)
}

#[tauri::command]
pub async fn tools_state() -> State {
    use windows::Devices::Radios::RadioKind;
    State {
        dark: dark(),
        mic_muted: mic_muted(),
        awake: AWAKE.load(Relaxed),
        wifi: crate::hw::radio_on(RadioKind::WiFi),
        bluetooth: crate::hw::radio_on(RadioKind::Bluetooth),
    }
}

/// Fixed list, like `launch`: the webview can only pick one of these.
#[tauri::command]
pub async fn tool(action: String) -> State {
    match action.as_str() {
        "dark" => set_dark(!dark()),
        "mic" => {
            if let Ok(m) = mic() {
                unsafe {
                    let muted = m.GetMute().is_ok_and(|b| b.as_bool());
                    let _ = m.SetMute(!muted, std::ptr::null());
                }
            }
        }
        "awake" => {
            AWAKE.fetch_xor(true, Relaxed);
        }
        "lock" => unsafe {
            let _ = windows::Win32::System::Shutdown::LockWorkStation();
        },
        // Flags 0: Windows asks for confirmation itself.
        "empty_bin" => unsafe {
            let _ = SHEmptyRecycleBinW(None, PCWSTR::null(), 0);
        },
        // Radios that can't be switched (none, or Windows refuses) open their Settings page.
        "wifi" | "bluetooth" => {
            use windows::Devices::Radios::RadioKind;
            let k = if action == "wifi" { RadioKind::WiFi } else { RadioKind::Bluetooth };
            if !crate::hw::set_radio_on(k, crate::hw::radio_on(k) != Some(true)) {
                crate::sys::open_path(if action == "wifi" { "ms-settings:network-wifi" } else { "ms-settings:bluetooth" });
            }
        }
        _ => {}
    }
    tools_state().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_sample_in_range() {
        assert_eq!(stats().cpu, -1.0); // first call has nothing to compare with
        std::thread::sleep(std::time::Duration::from_millis(300));
        let s = stats();
        eprintln!("cpu {:.0} mem {} gpu {:.0}", s.cpu, s.mem, s.gpu);
        assert!((0.0..=100.0).contains(&s.cpu), "cpu {}", s.cpu);
        assert!((1..=100).contains(&s.mem), "mem {}", s.mem);
        assert!(s.mem_used > 0 && s.mem_used < s.mem_total);
        assert!(s.down >= 0.0 && s.up >= 0.0);
        assert!(s.gpu == -1.0 || (0.0..=100.0).contains(&s.gpu), "gpu {}", s.gpu);
    }

    #[test]
    fn top_apps_grouped() {
        let first = tauri::async_runtime::block_on(top_apps());
        assert!(first.iter().all(|a| a.cpu == 0.0)); // nothing to compare with yet
        std::thread::sleep(std::time::Duration::from_millis(500));
        let apps = tauri::async_runtime::block_on(top_apps());
        eprintln!("{:?}", apps.iter().take(5).map(|a| (&a.name, a.cpu.round(), a.mem >> 20)).collect::<Vec<_>>());
        assert!(apps.len() > 5);
        let total: f64 = apps.iter().map(|a| a.cpu).sum();
        assert!((0.0..=105.0).contains(&total), "cpu total {total}"); // timer slack
        let names: std::collections::HashSet<_> = apps.iter().map(|a| &a.name).collect();
        assert_eq!(names.len(), apps.len());
    }
}

// ---------- per-app volume (the island's mixer) ----------

#[derive(Serialize)]
pub struct AppVolume {
    name: String,
    level: f32,
    muted: bool,
}

/// Audio sessions on the default speakers grouped by app (a browser has several), System
/// sounds last. Expired sessions are left out.
fn app_sessions() -> Result<Vec<(String, Vec<ISimpleAudioVolume>)>> {
    use windows::core::Interface;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let mgr: IAudioSessionManager2 = en.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
        let list = mgr.GetSessionEnumerator()?;
        let mut apps: Vec<(String, Vec<ISimpleAudioVolume>)> = vec![];
        for i in 0..list.GetCount()? {
            let s = list.GetSession(i)?;
            if s.GetState()? == AudioSessionStateExpired {
                continue;
            }
            let s2: IAudioSessionControl2 = s.cast()?;
            let name = if s2.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK {
                "System sounds".to_string()
            } else {
                match app_name(s2.GetProcessId()?) {
                    Some(n) => n,
                    None => continue,
                }
            };
            let vol: ISimpleAudioVolume = s.cast()?;
            match apps.iter_mut().find(|(n, _)| *n == name) {
                Some((_, v)) => v.push(vol),
                None => apps.push((name, vec![vol])),
            }
        }
        apps.sort_by_key(|(n, _)| n == "System sounds");
        Ok(apps)
    }
}

/// An app's name as it describes itself ("Google Chrome"), else its file name ("chrome").
fn app_name(pid: u32) -> Option<String> {
    let path = exe_path(pid)?;
    describe(&path).or_else(|| std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()))
}

/// The full path of a process's program.
pub(crate) fn exe_path(pid: u32) -> Option<String> {
    use windows::{
        core::PWSTR,
        Win32::{Foundation::CloseHandle, System::Threading::*},
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// FileDescription from the program's version info, in its first listed language.
pub(crate) fn describe(path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    let file: Vec<u16> = path.encode_utf16().chain([0]).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(file.as_ptr()), None, size, data.as_mut_ptr() as _).ok()?;
        let (mut p, mut n) = (std::ptr::null_mut(), 0u32);
        if !VerQueryValueW(data.as_ptr() as _, w!(r"\VarFileInfo\Translation"), &mut p, &mut n).as_bool() || n < 4 {
            return None;
        }
        let (lang, cp) = (*(p as *const u16), *(p as *const u16).add(1));
        let key: Vec<u16> = format!(r"\StringFileInfo\{lang:04x}{cp:04x}\FileDescription").encode_utf16().chain([0]).collect();
        if !VerQueryValueW(data.as_ptr() as _, PCWSTR(key.as_ptr()), &mut p, &mut n).as_bool() || n == 0 {
            return None;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p as *const u16, n as usize));
        let s = s.trim_end_matches('\0').trim();
        (!s.is_empty()).then(|| s.to_string())
    }
}

#[tauri::command]
pub async fn app_volumes() -> Vec<AppVolume> {
    let apps = app_sessions().unwrap_or_default();
    apps.into_iter()
        .filter_map(|(name, v)| unsafe {
            let s = v.first()?;
            Some(AppVolume { name, level: s.GetMasterVolume().ok()?, muted: s.GetMute().ok()?.as_bool() })
        })
        .collect()
}

/// Sets every session of the app (by the name app_volumes gave).
#[tauri::command]
pub async fn set_app_volume(name: String, level: Option<f32>, muted: Option<bool>) {
    for (_, v) in app_sessions().unwrap_or_default().into_iter().filter(|(n, _)| *n == name) {
        for s in v {
            unsafe {
                if let Some(l) = level {
                    let _ = s.SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null());
                }
                if let Some(m) = muted {
                    let _ = s.SetMute(m, std::ptr::null());
                }
            }
        }
    }
}

#[cfg(test)]
mod mixer_tests {
    // Lists the real mixer. Run: cargo test mixer -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mixer_lists_apps() {
        for a in tauri::async_runtime::block_on(super::app_volumes()) {
            println!("{} {:.2} {}", a.name, a.level, a.muted);
        }
    }
}
