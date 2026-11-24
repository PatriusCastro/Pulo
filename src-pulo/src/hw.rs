//! What the island's Display, Wi-Fi & Bluetooth, Power and Volume mixer pages control:
//! screen brightness and night light, the radios, the power mode, sleep / restart / shut
//! down, and which speakers Windows plays through.

use serde::Serialize;
use windows::{
    core::{w, GUID, HSTRING, PCWSTR},
    Win32::{
        Devices::Display::*,
        Foundation::*,
        Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR},
        Media::Audio::*,
        System::{
            Com::{StructuredStorage::PropVariantToBSTR, *},
            Power::*,
            Registry::*,
        },
    },
};

// ---------- brightness ----------

#[derive(Serialize)]
pub struct Screen {
    id: String, // "builtin", or "ddc:<n>" for the nth physical monitor
    name: String,
    level: u32, // 0..100
}

const VIDEO: GUID = GUID::from_u128(0x7516b95f_f776_4464_8c53_06167f40cc99); // GUID_VIDEO_SUBGROUP
const VIDEO_LEVEL: GUID = GUID::from_u128(0xaded5e82_b909_4619_9949_f5d71dac0bcb); // display brightness

fn on_ac() -> bool {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).is_ok() && s.ACLineStatus == 1 }
}

/// The built-in screen's brightness, a power setting of the active plan (what the
/// brightness keys change). Read for the current power source.
// shortcut: "built-in screen" means a laptop's (has a battery); upgrade to WMI if a desktop with a panel shows up.
fn builtin() -> Option<u32> {
    if !crate::sys::has_battery() {
        return None;
    }
    unsafe {
        let mut scheme = std::ptr::null_mut();
        if PowerGetActiveScheme(None, &mut scheme) != ERROR_SUCCESS {
            return None;
        }
        let mut v = 0;
        let ok = if on_ac() {
            PowerReadACValueIndex(None, Some(scheme), Some(&VIDEO), Some(&VIDEO_LEVEL), &mut v) == ERROR_SUCCESS
        } else {
            PowerReadDCValueIndex(None, Some(scheme), Some(&VIDEO), Some(&VIDEO_LEVEL), &mut v) == 0
        };
        let _ = LocalFree(Some(HLOCAL(scheme as _)));
        ok.then_some(v.min(100))
    }
}

fn set_builtin(level: u32) {
    unsafe {
        let mut scheme = std::ptr::null_mut();
        if PowerGetActiveScheme(None, &mut scheme) != ERROR_SUCCESS {
            return;
        }
        if on_ac() {
            let _ = PowerWriteACValueIndex(None, scheme, Some(&VIDEO), Some(&VIDEO_LEVEL), level);
        } else {
            let _ = PowerWriteDCValueIndex(None, scheme, Some(&VIDEO), Some(&VIDEO_LEVEL), level);
        }
        let _ = PowerSetActiveScheme(None, Some(scheme)); // applies it
        let _ = LocalFree(Some(HLOCAL(scheme as _)));
    }
}

/// Runs `f` on every physical monitor (DDC/CI handles), in screen order, then frees them.
fn each_monitor<T>(mut f: impl FnMut(usize, HANDLE) -> Option<T>) -> Vec<T> {
    unsafe extern "system" fn add(m: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> windows::core::BOOL {
        unsafe { (*(list.0 as *mut Vec<HMONITOR>)).push(m) };
        true.into()
    }
    let mut hs: Vec<HMONITOR> = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(add), LPARAM(&mut hs as *mut _ as isize));
    }
    let mut out = vec![];
    let mut n = 0;
    for h in hs {
        let mut count = 0;
        unsafe {
            if GetNumberOfPhysicalMonitorsFromHMONITOR(h, &mut count).is_err() || count == 0 {
                continue;
            }
            let mut list = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(h, &mut list).is_err() {
                continue;
            }
            for m in &list {
                out.extend(f(n, m.hPhysicalMonitor));
                n += 1;
            }
            let _ = DestroyPhysicalMonitors(&list);
        }
    }
    out
}

/// (min, current, max) over DDC/CI; None if the monitor doesn't take it (laptop panels,
/// most TVs, some docks). Each call talks to the monitor: tens of ms.
fn ddc(h: HANDLE) -> Option<(u32, u32, u32)> {
    let (mut lo, mut cur, mut hi) = (0, 0, 0);
    (unsafe { GetMonitorBrightness(h, &mut lo, &mut cur, &mut hi) } != 0 && hi > lo).then_some((lo, cur, hi))
}

#[derive(Serialize)]
pub struct Display {
    screens: Vec<Screen>,
    night: Option<bool>, // None: night light's saved state isn't in the layout we know
}

#[tauri::command]
pub async fn display() -> Display {
    let mut screens: Vec<Screen> = builtin().map(|level| Screen { id: "builtin".into(), name: "Built-in display".into(), level }).into_iter().collect();
    let ext = each_monitor(|n, h| ddc(h).map(|(lo, cur, hi)| (n, (cur - lo.min(cur)) * 100 / (hi - lo))));
    let many = ext.len() > 1;
    for (i, (n, level)) in ext.into_iter().enumerate() {
        let name = if many { format!("Monitor {}", i + 1) } else { "Monitor".into() };
        screens.push(Screen { id: format!("ddc:{n}"), name, level });
    }
    Display { screens, night: night_light() }
}

#[tauri::command]
pub async fn set_brightness(id: String, level: u32) {
    let level = level.min(100);
    if id == "builtin" {
        return set_builtin(level);
    }
    let Some(want) = id.strip_prefix("ddc:").and_then(|n| n.parse::<usize>().ok()) else { return };
    each_monitor(|n, h| {
        if n == want
            && let Some((lo, _, hi)) = ddc(h)
        {
            unsafe { SetMonitorBrightness(h, lo + (hi - lo) * level / 100) };
        }
        None::<()>
    });
}

// ---------- night light ----------
// Windows keeps night light's on/off in an undocumented CloudStore blob and applies any
// change written to it. We only touch the two layouts we know (off: 41 bytes, 0x13 at 18;
// on: 43 bytes, 0x15 at 18 and 10 00 after the second header); anything else is left alone
// and the UI sends you to Settings instead.

const NIGHT: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate");

fn night_blob() -> Option<Vec<u8>> {
    let mut len = 0u32;
    unsafe {
        RegGetValueW(HKEY_CURRENT_USER, NIGHT, w!("Data"), RRF_RT_REG_BINARY, None, None, Some(&mut len)).ok().ok()?;
        let mut buf = vec![0u8; len as usize];
        RegGetValueW(HKEY_CURRENT_USER, NIGHT, w!("Data"), RRF_RT_REG_BINARY, None, Some(buf.as_mut_ptr() as _), Some(&mut len)).ok().ok()?;
        buf.truncate(len as usize);
        Some(buf)
    }
}

const HEADER: [u8; 4] = [0x43, 0x42, 0x01, 0x00];

fn night_state(d: &[u8]) -> Option<bool> {
    if !d.starts_with(&HEADER) || d.get(19..23) != Some(&HEADER[..]) {
        return None;
    }
    match (d.len(), d[18]) {
        (41, 0x13) => Some(false),
        (43, 0x15) => Some(true),
        _ => None,
    }
}

/// The blob with night light switched to `on`, stamped with `now` (unix seconds) so
/// Windows sees a new change.
fn night_toggled(d: &[u8], on: bool, now: u64) -> Option<Vec<u8>> {
    let cur = night_state(d)?;
    let mut n = if cur == on {
        d.to_vec()
    } else if on {
        [&d[..23], &[0x10, 0x00], &d[23..]].concat()
    } else {
        [&d[..23], &d[25..]].concat()
    };
    n[18] = if on { 0x15 } else { 0x13 };
    for i in 0..5 {
        n[10 + i] = ((now >> (7 * i)) & 0x7f) as u8 | if i < 4 { 0x80 } else { 0 }; // 5-byte varint
    }
    Some(n)
}

pub fn night_light() -> Option<bool> {
    night_state(&night_blob()?)
}

/// False if it couldn't be switched (unknown layout or the write failed).
pub fn set_night(on: bool) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let Some(n) = night_blob().and_then(|d| night_toggled(&d, on, now)) else { return false };
    unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, NIGHT, w!("Data"), REG_BINARY.0, Some(n.as_ptr() as _), n.len() as u32) == ERROR_SUCCESS }
}

#[tauri::command]
pub async fn set_night_light(on: bool) -> Option<bool> {
    if !set_night(on) {
        crate::sys::open_path("ms-settings:nightlight");
    }
    night_light()
}

// ---------- Wi-Fi and Bluetooth ----------

use windows::Devices::Radios::{Radio, RadioKind, RadioState};

fn radio(kind: RadioKind) -> Option<Radio> {
    let _ = Radio::RequestAccessAsync().ok()?.get();
    Radio::GetRadiosAsync().ok()?.get().ok()?.into_iter().find(|r| r.Kind().is_ok_and(|k| k == kind))
}

/// None: no such radio. Off also covers "disabled" (airplane mode, or turned off in Device Manager).
pub fn radio_on(kind: RadioKind) -> Option<bool> {
    radio(kind).map(|r| r.State().is_ok_and(|s| s == RadioState::On))
}

/// False if there's no such radio or Windows refused.
pub fn set_radio_on(kind: RadioKind, on: bool) -> bool {
    use windows::Devices::Radios::RadioAccessStatus;
    let Some(r) = radio(kind) else { return false };
    r.SetStateAsync(if on { RadioState::On } else { RadioState::Off }).and_then(|a| a.get()).is_ok_and(|s| s == RadioAccessStatus::Allowed)
}

#[derive(Serialize)]
pub struct BtDevice {
    name: String,
    battery: Option<u8>,
}

#[derive(Serialize)]
pub struct Radios {
    wifi: Option<bool>,
    bluetooth: Option<bool>,
    network: Option<String>, // the Wi-Fi network joined, if any (a VPN can be the internet profile)
    devices: Vec<BtDevice>,
}

#[tauri::command]
pub async fn radios() -> Radios {
    use windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkInformation};
    let network = NetworkInformation::GetConnectionProfiles().ok().and_then(|l| {
        l.into_iter()
            .find(|p| p.IsWlanConnectionProfile().unwrap_or(false) && p.GetNetworkConnectivityLevel().is_ok_and(|c| c != NetworkConnectivityLevel::None))
            .and_then(|p| p.ProfileName().ok())
            .map(|s| s.to_string())
    });
    let bluetooth = radio_on(RadioKind::Bluetooth);
    let devices = if bluetooth == Some(true) { crate::devices::connected_names().into_iter().map(|(name, battery)| BtDevice { name, battery }).collect() } else { vec![] };
    Radios { wifi: radio_on(RadioKind::WiFi), devices, bluetooth, network }
}

#[tauri::command]
pub async fn set_radio(kind: String, on: bool) -> Radios {
    let k = if kind == "wifi" { RadioKind::WiFi } else { RadioKind::Bluetooth };
    if !set_radio_on(k, on) {
        crate::sys::open_path(if kind == "wifi" { "ms-settings:network-wifi" } else { "ms-settings:bluetooth" });
    }
    radios().await
}

// ---------- power ----------

/// Settings > Power mode. They only exist on the Balanced plan.
const MODES: [(&str, GUID); 3] = [
    ("efficiency", GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a)), // GUID_POWER_MODE_BEST_EFFICIENCY
    ("balanced", GUID::zeroed()),
    ("performance", GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238)), // GUID_POWER_MODE_BEST_PERFORMANCE
];

/// Power mode calls live in powrprof.dll without import-library entries.
fn powrprof(name: windows::core::PCSTR) -> Option<unsafe extern "system" fn() -> isize> {
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    unsafe { GetProcAddress(LoadLibraryW(w!("powrprof.dll")).ok()?, name) }
}

/// The mode chosen for the current power source (Windows keeps one for plugged in and one
/// for battery), as Settings shows it.
fn power_mode() -> Option<&'static str> {
    type Get = unsafe extern "system" fn(*mut GUID) -> u32;
    let name = if on_ac() { windows::core::s!("PowerGetUserConfiguredACPowerMode") } else { windows::core::s!("PowerGetUserConfiguredDCPowerMode") };
    let f: Get = unsafe { std::mem::transmute(powrprof(name)?) };
    let mut g = GUID::zeroed();
    (unsafe { f(&mut g) } == 0).then_some(())?;
    MODES.iter().find(|(_, m)| *m == g).map(|(n, _)| *n)
}

fn set_mode(mode: &str) {
    type Set = unsafe extern "system" fn(*const GUID) -> u32;
    let name = if on_ac() { windows::core::s!("PowerSetUserConfiguredACPowerMode") } else { windows::core::s!("PowerSetUserConfiguredDCPowerMode") };
    if let (Some((_, g)), Some(f)) = (MODES.iter().find(|(n, _)| *n == mode), powrprof(name)) {
        let f: Set = unsafe { std::mem::transmute(f) };
        unsafe { f(g) };
    }
}

#[derive(Serialize)]
pub struct Battery {
    percent: u8,
    charging: bool,
    left: Option<u32>, // seconds, while on battery and Windows has an estimate
}

#[derive(Serialize)]
pub struct Power {
    mode: Option<&'static str>,
    battery: Option<Battery>,
    saver: bool, // energy saver is on
    timer: Option<PowerTimer>,
}

#[tauri::command]
pub async fn power() -> Power {
    let mut s = SYSTEM_POWER_STATUS::default();
    let ok = unsafe { GetSystemPowerStatus(&mut s).is_ok() };
    let battery = (ok && crate::sys::has_battery() && s.BatteryLifePercent <= 100).then(|| Battery {
        percent: s.BatteryLifePercent,
        charging: s.ACLineStatus == 1,
        left: (s.ACLineStatus != 1 && s.BatteryLifeTime != u32::MAX).then_some(s.BatteryLifeTime),
    });
    Power { mode: power_mode(), battery, saver: ok && s.SystemStatusFlag == 1, timer: POWER_TIMER.lock().unwrap().clone() }
}

#[tauri::command]
pub async fn set_power_mode(mode: String) -> Power {
    set_mode(&mode);
    power().await
}

/// Fixed list, like `launch`. Restart and shut down go through shutdown.exe without /f,
/// so apps with unsaved work can still stop it.
#[tauri::command]
pub fn power_action(action: String) {
    use std::os::windows::process::CommandExt;
    let arg = match action.as_str() {
        "sleep" => {
            unsafe { SetSuspendState(false, false, false) };
            return;
        }
        "screen_off" => {
            // After a beat, so the click that asked for it doesn't wake the screens again.
            std::thread::spawn(|| {
                use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND};
                std::thread::sleep(std::time::Duration::from_millis(600));
                let _ = unsafe { PostMessageW(Some(HWND_BROADCAST), WM_SYSCOMMAND, WPARAM(SC_MONITORPOWER as usize), LPARAM(2)) }; // 2: off
            });
            return;
        }
        "restart" => "/r",
        "shutdown" => "/s",
        "signout" => "/l",
        _ => return,
    };
    let mut cmd = std::process::Command::new("shutdown");
    cmd.arg(arg);
    if arg != "/l" {
        cmd.args(["/t", "0"]); // /l takes no timeout
    }
    let _ = cmd.creation_flags(0x0800_0000).spawn(); // CREATE_NO_WINDOW
}

// ---------- power timer ----------

/// Sleep or shut down at a set time. Held here rather than in the island, so closing it
/// can't drop the timer; quitting Pulo does.
#[derive(Serialize, Clone)]
pub struct PowerTimer {
    action: String, // "sleep" | "shutdown"
    at: u64,        // unix ms
}

static POWER_TIMER: std::sync::Mutex<Option<PowerTimer>> = std::sync::Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn publish_timer(t: &Option<PowerTimer>) {
    use tauri::Emitter;
    if let Some(app) = crate::sys::APP.get() {
        let _ = app.emit("power_timer", t); // the pill counts down
    }
}

/// `action` None cancels.
#[tauri::command]
pub fn set_power_timer(action: Option<String>, minutes: u32) -> Option<PowerTimer> {
    let t = action.filter(|a| a == "sleep" || a == "shutdown").map(|action| PowerTimer { action, at: now_ms() + minutes.clamp(1, 24 * 60) as u64 * 60_000 });
    *POWER_TIMER.lock().unwrap() = t.clone();
    publish_timer(&t);
    t
}

/// Called every second by the tick loop in lib.rs.
pub fn tick_power_timer() {
    let due = {
        let mut t = POWER_TIMER.lock().unwrap();
        if t.as_ref().is_some_and(|t| now_ms() >= t.at) { t.take() } else { None }
    };
    if let Some(t) = due {
        publish_timer(&None);
        power_action(t.action);
    }
}

// ---------- sound output ----------

/// Undocumented, but what every "switch audio device" tool uses: Windows' own sound
/// settings set the default endpoint through it. Only the last slot is called; the
/// ones before it are placeholders that keep the vtable in order.
#[allow(non_snake_case)] // COM method names
mod policy {
    use windows::{core::{HRESULT, PCWSTR}, Win32::Media::Audio::ERole};
    #[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    pub unsafe trait IPolicyConfig: windows::core::IUnknown {
    fn GetMixFormat(&self) -> HRESULT;
    fn GetDeviceFormat(&self) -> HRESULT;
    fn ResetDeviceFormat(&self) -> HRESULT;
    fn SetDeviceFormat(&self) -> HRESULT;
    fn GetProcessingPeriod(&self) -> HRESULT;
    fn SetProcessingPeriod(&self) -> HRESULT;
    fn GetShareMode(&self) -> HRESULT;
    fn SetShareMode(&self) -> HRESULT;
    fn GetPropertyValue(&self) -> HRESULT;
    fn SetPropertyValue(&self) -> HRESULT;
    fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    }
    const POLICY_CONFIG: windows::core::GUID = windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// Makes `id` the default output for every role (games, music and calls).
    pub fn set_default(id: &windows::core::HSTRING) {
        use windows::Win32::{Media::Audio::*, System::Com::*};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Ok(p) = CoCreateInstance::<_, IPolicyConfig>(&POLICY_CONFIG, None, CLSCTX_ALL) {
                for role in [eConsole, eMultimedia, eCommunications] {
                    let _ = p.SetDefaultEndpoint(PCWSTR(id.as_ptr()), role);
                }
            }
        }
    }
}
const FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 }; // PKEY_Device_FriendlyName

#[derive(Serialize)]
pub struct Output {
    id: String,
    name: String,
    on: bool, // the default one
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
    }
}

fn id_of(d: &IMMDevice) -> Option<String> {
    unsafe {
        let p = d.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s
    }
}

#[tauri::command]
pub async fn outputs() -> Vec<Output> {
    let list = || -> windows::core::Result<Vec<Output>> {
        let en = enumerator()?;
        unsafe {
            let def = en.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| id_of(&d));
            let all = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            let mut out = vec![];
            for i in 0..all.GetCount()? {
                let d = all.Item(i)?;
                let Some(id) = id_of(&d) else { continue };
                let name = d.OpenPropertyStore(STGM_READ).and_then(|p| p.GetValue(&FRIENDLY_NAME)).and_then(|v| PropVariantToBSTR(&v)).map(|b| b.to_string()).unwrap_or_default();
                out.push(Output { on: def.as_ref() == Some(&id), id, name });
            }
            Ok(out)
        }
    };
    list().unwrap_or_default()
}

#[tauri::command]
pub async fn set_output(id: String) -> Vec<Output> {
    policy::set_default(&HSTRING::from(id));
    outputs().await
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real "off" blob from Windows 11.
    const OFF: [u8; 41] = [
        0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06, 0xc0, 0xcf, 0xba, 0xd3, 0x06, 0x2a, 0x2b, 0x0e, 0x13, 0x43, 0x42, 0x01, 0x00, 0xd0, 0x0a, 0x02, 0xc6, 0x14, 0x90, 0xa7, 0xf1, 0xe4, 0xc7, 0xc4, 0xc8, 0xee, 0x01, 0x00, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn night_light_round_trip() {
        assert_eq!(night_state(&OFF), Some(false));
        let t = 1_785_636_800; // the stamp already in OFF
        let on = night_toggled(&OFF, true, t).unwrap();
        assert_eq!((on.len(), night_state(&on)), (43, Some(true)));
        assert_eq!(&on[23..25], &[0x10, 0x00]);
        assert_eq!(night_toggled(&on, false, t).unwrap(), OFF.to_vec()); // same stamp, same bytes
        assert_eq!(night_state(&OFF[..40]), None); // unknown layouts are left alone
    }

    #[test]
    fn reads_hardware() {
        let time = |name: &str, t: std::time::Instant| eprintln!("{name} {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        let d = tauri::async_runtime::block_on(display());
        time("display", t);
        let t = std::time::Instant::now();
        let o = tauri::async_runtime::block_on(outputs());
        time("outputs", t);
        let t = std::time::Instant::now();
        let r = tauri::async_runtime::block_on(radios());
        time("radios", t);
        let t = std::time::Instant::now();
        let p = tauri::async_runtime::block_on(power());
        time("power", t);
        eprintln!("screens {:?}", d.screens.iter().map(|s| (&s.name, s.level)).collect::<Vec<_>>());
        eprintln!("night {:?} mode {:?} outputs {:?}", d.night, p.mode, o.iter().map(|o| (&o.name, o.on)).collect::<Vec<_>>());
        eprintln!("wifi {:?} bt {:?} net {:?} devices {:?}", r.wifi, r.bluetooth, r.network, r.devices.iter().map(|d| (&d.name, d.battery)).collect::<Vec<_>>());
        assert!(o.iter().filter(|o| o.on).count() <= 1);
    }
}


#[cfg(test)]
mod live {
    /// Flips the power mode and back, checking Windows applies it:
    /// cargo test --lib power_mode_applies -- --ignored --nocapture
    #[test]
    #[ignore]
    fn power_mode_applies() {
        type Get = unsafe extern "system" fn(*mut super::GUID) -> u32;
        let effective = || {
            let f: Get = unsafe { std::mem::transmute(super::powrprof(windows::core::s!("PowerGetEffectiveOverlayScheme")).unwrap()) };
            let mut g = super::GUID::zeroed();
            unsafe { f(&mut g) };
            super::MODES.iter().find(|(_, m)| *m == g).map(|(n, _)| *n)
        };
        let before = super::power_mode().unwrap();
        let other = if before == "balanced" { "efficiency" } else { "balanced" };
        super::set_mode(other);
        std::thread::sleep(std::time::Duration::from_millis(4000));
        let (now, eff) = (super::power_mode(), effective());
        super::set_mode(before);
        std::thread::sleep(std::time::Duration::from_millis(500));
        eprintln!("before {before} -> set {other}: configured {now:?} effective {eff:?}; restored {:?} effective {:?}", super::power_mode(), effective());
        assert_eq!(now, Some(other));
        assert_eq!(super::power_mode(), Some(before));
    }
}

