//! Battery levels of connected Bluetooth devices (mice, keyboards, headsets), the same
//! numbers Windows shows in Settings > Bluetooth & devices. USB-receiver (2.4 GHz)
//! devices aren't covered: their battery is only visible to the vendor's own app.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
use windows::{
    Devices::Enumeration::*,
    Foundation::{IPropertyValue, TypedEventHandler},
    core::*,
};
use windows_collections::IIterable;

const BATTERY: &str = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2"; // DEVPKEY_Bluetooth_Battery
const CONNECTED: &str = "{83DA6326-97A6-4088-9453-A1923F573B29} 15"; // DEVPKEY_Device_IsConnected
const AQS: &str = r#"System.Devices.Present:=System.StructuredQueryType.Boolean#True AND System.Devices.DeviceInstanceId:~<"BTH""#;
const CONTAINER: &str = "System.Devices.ContainerId";
const LOW: u8 = 15;

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Device {
    pub name: String,
    pub percent: u8,
    /// mouse | keyboard | headphones | other
    pub kind: &'static str,
}

const CLASS: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0} 9"; // DEVPKEY_Device_Class

/// What kind of device, from the driver classes Windows installed for it (a Bluetooth
/// mouse gets a "Mouse" node). Windows' own category field is often just "Unknown".
fn kind(container: GUID) -> &'static str {
    let aqs = HSTRING::from(format!("System.Devices.ContainerId:=\"{{{container:?}}}\""));
    let classes = || -> Result<Vec<String>> {
        let list = DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(&aqs, &IIterable::from(vec![HSTRING::from(CLASS)]), DeviceInformationKind::Device)?.get()?;
        Ok(list.into_iter().filter_map(|n| value(&n, CLASS)?.GetString().ok().map(|s| s.to_string())).collect())
    };
    kind_of(&classes().unwrap_or_default())
}

fn kind_of(classes: &[String]) -> &'static str {
    let has = |c: &str| classes.iter().any(|x| x.eq_ignore_ascii_case(c));
    match (has("Mouse"), has("Keyboard")) {
        (true, false) => "mouse",
        (false, true) => "keyboard",
        (true, true) => "other", // mice with macro keys and keyboards with pointers look alike
        _ if has("AudioEndpoint") || has("MEDIA") => "headphones",
        _ => "other",
    }
}

pub static DEVICES: Mutex<Vec<Device>> = Mutex::new(Vec::new());
static DIRTY: AtomicBool = AtomicBool::new(true);

/// The Bluetooth address in a device instance ID: the last run of exactly 12 hex digits
/// (child nodes like `BTHENUM\{GUID}_VID..\7&..&0&3409C98F270E_C00000000` carry it too).
fn address(id: &str) -> Option<&str> {
    let b = id.as_bytes();
    let mut found = None;
    let mut start = 0;
    for i in 0..=b.len() {
        if i < b.len() && b[i].is_ascii_hexdigit() {
            continue;
        }
        if i - start == 12 {
            found = Some(&id[start..i]);
        }
        start = i + 1;
    }
    found
}

fn props() -> IIterable<HSTRING> {
    IIterable::from(vec![HSTRING::from(BATTERY), HSTRING::from(CONNECTED), HSTRING::from(CONTAINER)])
}

fn value(d: &DeviceInformation, key: &str) -> Option<IPropertyValue> {
    d.Properties().ok()?.Lookup(&HSTRING::from(key)).ok()?.cast().ok()
}

/// One query over all Bluetooth device nodes. A device appears as several nodes (one per
/// profile); group by address, take the name from its root node, battery and connected
/// state from whichever node has them.
/// Connected devices: name, battery if it reports one, container.
fn connected() -> Result<Vec<(String, Option<u8>, Option<GUID>)>> {
    let list = DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(&HSTRING::from(AQS), &props(), DeviceInformationKind::Device)?.get()?;
    let mut by: BTreeMap<String, (String, bool, Option<u8>, Option<GUID>)> = BTreeMap::new();
    for d in list {
        let id = d.Id()?.to_string().to_uppercase(); // Windows mixes case: BTHLE\Dev_c0a3..
        let Some(addr) = address(&id) else { continue };
        let e = by.entry(addr.to_string()).or_default();
        if id.starts_with("BTHLE\\DEV_") || id.starts_with("BTHENUM\\DEV_") {
            e.0 = d.Name()?.to_string().trim().to_string();
            e.3 = value(&d, CONTAINER).and_then(|v| v.GetGuid().ok());
        }
        if value(&d, CONNECTED).and_then(|v| v.GetBoolean().ok()) == Some(true) {
            e.1 = true;
        }
        if let Some(p) = value(&d, BATTERY).and_then(|v| v.GetUInt8().ok()) {
            e.2 = Some(p.min(100));
        }
    }
    Ok(by.into_values().filter(|e| e.1 && !e.0.is_empty()).map(|(name, _, pct, container)| (name, pct, container)).collect())
}

fn scan() -> Result<Vec<Device>> {
    Ok(connected()?.into_iter().filter_map(|(name, pct, container)| Some(Device { name, percent: pct?, kind: container.map_or("other", kind) })).collect())
}

/// Every connected Bluetooth device, with its battery when it reports one.
pub fn connected_names() -> Vec<(String, Option<u8>)> {
    connected().map(|l| l.into_iter().map(|(n, p, _)| (n, p)).collect()).unwrap_or_default()
}

fn publish(now: Vec<Device>) {
    let mut cur = DEVICES.lock().unwrap();
    if *cur == now {
        return;
    }
    if let Some(app) = crate::sys::APP.get() {
        for d in &now {
            match cur.iter().find(|o| o.name == d.name) {
                None => drop(app.emit("device_connected", d)),
                Some(o) if o.percent > LOW && d.percent <= LOW => drop(app.emit("device_low", d)),
                _ => {}
            }
        }
        let _ = app.emit("devices", &now);
    }
    *cur = now;
}

/// Rescan when Windows reports a Bluetooth node added, changed (connect, disconnect,
/// battery) or removed. Events arrive in bursts, so they only mark the list dirty and
/// this loop rescans at most every 2 s, plus every 5 min as a backstop.
pub fn watch() {
    let start = || -> Result<DeviceWatcher> {
        let w = DeviceInformation::CreateWatcherWithKindAqsFilterAndAdditionalProperties(&HSTRING::from(AQS), &props(), DeviceInformationKind::Device)?;
        w.Added(&TypedEventHandler::new(|_, _| Ok(DIRTY.store(true, Relaxed))))?;
        w.Updated(&TypedEventHandler::new(|_, _| Ok(DIRTY.store(true, Relaxed))))?;
        w.Removed(&TypedEventHandler::new(|_, _| Ok(DIRTY.store(true, Relaxed))))?;
        w.Start()?;
        Ok(w)
    };
    let _watcher = start(); // kept alive for the life of the thread
    let mut last = Instant::now();
    loop {
        if DIRTY.swap(false, Relaxed) || last.elapsed() > Duration::from_secs(300) {
            if let Ok(list) = scan() {
                publish(list);
            }
            last = Instant::now();
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_from_instance_ids() {
        assert_eq!(address(r"BTHLE\DEV_C0A3A64AECFA\7&1D23197A&0&C0A3A64AECFA"), Some("C0A3A64AECFA"));
        assert_eq!(
            address(r"BTHENUM\{0000111E-0000-1000-8000-00805F9B34FB}_HCIBYPASS_VID&000105D6_PID&000A\7&66DD012&0&3409C98F270E_C00000000"),
            Some("3409C98F270E")
        );
        assert_eq!(
            address(r"BTHLEDEVICE\{0000180F-0000-1000-8000-00805F9B34FB}_DEV_VID&010000_PID&0000_REV&0001_C0A3A64AECFA\8&209F07CA&0&000C"),
            Some("C0A3A64AECFA")
        );
        assert_eq!(address(r"USB\VID_089D&PID_062F\5&1"), None);
    }

    #[test]
    fn kinds_from_driver_classes() {
        let k = |c: &[&str]| kind_of(&c.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(k(&["Bluetooth", "Mouse", "HIDClass"]), "mouse");
        assert_eq!(k(&["Bluetooth", "Keyboard"]), "keyboard");
        assert_eq!(k(&["Mouse", "Keyboard"]), "other");
        assert_eq!(k(&["Bluetooth", "AudioEndpoint", "MEDIA"]), "headphones");
        assert_eq!(k(&[]), "other");
    }

    /// Prints what this PC reports right now: cargo test live_scan -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_scan() {
        println!("{:?}", scan().unwrap());
    }
}
