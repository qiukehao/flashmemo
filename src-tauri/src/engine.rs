//! 15s tick engine per SPEC §8.2/§8.5: decides whether a popup (or a light
//! notification) is due, and opens the popup window on the monitor the cursor
//! is currently on. The decision logic is pure and unit-tested.

use crate::db::{self, Db};
use crate::services;
use chrono::{DateTime, Local, Timelike, Utc};
use std::sync::Mutex;
use tauri::{Listener, Manager};

const TICK_SECS: u64 = 15;
const POPUP_SIZE: (f64, f64) = (440.0, 380.0);
const MARGIN: f64 = 20.0;
const TASKBAR_RESERVE: f64 = 48.0;
const MIN_OFFSET_FROM_LAST: f64 = 100.0;

pub struct EngineSettings {
    pub interval_min: u32,
    pub study_start: String,
    pub study_end: String,
    pub paused_until: Option<DateTime<Utc>>,
    pub notify_mode: String,
}

impl Default for EngineSettings {
    fn default() -> Self {
        EngineSettings {
            interval_min: 10,
            study_start: "09:00".into(),
            study_end: "22:30".into(),
            paused_until: None,
            notify_mode: "popup".into(),
        }
    }
}

/// Position of the last popup + last notification time, shared between the
/// tick thread and the `force-review` listener.
#[derive(Default)]
pub struct EngineState {
    pub last_pos: Option<(f64, f64)>,
    pub last_notify: Option<DateTime<Utc>>,
}

pub fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    Some((h.trim().parse().ok()?, m.trim().parse().ok()?))
}

/// SPEC §8.5: outside the study window nothing pops. Malformed settings fall
/// open (always in hours) so a typo can't silence the app silently.
pub fn in_study_hours(now: DateTime<Local>, s: &EngineSettings) -> bool {
    let Some((sh, sm)) = parse_hhmm(&s.study_start) else {
        return true;
    };
    let Some((eh, em)) = parse_hhmm(&s.study_end) else {
        return true;
    };
    let mins = now.hour() * 60 + now.minute();
    mins >= sh * 60 + sm && mins <= eh * 60 + em
}

/// Not paused = no future paused_until in settings.
fn not_paused(s: &EngineSettings) -> bool {
    s.paused_until.is_none_or(|t| Utc::now() >= t)
}

/// SPEC §8.2: pop only when cards are due, within hours, unpaused, and while
/// no popup session is already open.
pub fn popup_decision(
    due_count: usize,
    now: DateTime<Local>,
    s: &EngineSettings,
    popup_open: bool,
) -> bool {
    due_count > 0 && !popup_open && in_study_hours(now, s) && not_paused(s)
}

/// Random spot in the monitor work area: >= MARGIN from edges, below the
/// taskbar reserve, and >= MIN_OFFSET_FROM_LAST away from the previous popup.
/// `rand` is a pair in [0,1) so tests are deterministic.
pub fn popup_position(
    monitor: (f64, f64, f64, f64),
    win: (f64, f64),
    last: Option<(f64, f64)>,
    rand: (f64, f64),
) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let (ww, wh) = win;
    let min_x = mx + MARGIN;
    let min_y = my + MARGIN;
    let max_x = (mx + mw - MARGIN - ww).max(min_x);
    let max_y = (my + mh - TASKBAR_RESERVE - MARGIN - wh).max(min_y);
    let mut x = (min_x + rand.0 * (max_x - min_x)).clamp(min_x, max_x);
    let y = (min_y + rand.1 * (max_y - min_y)).clamp(min_y, max_y);
    if let Some((lx, ly)) = last {
        if (x - lx).abs() < MIN_OFFSET_FROM_LAST && (y - ly).abs() < MIN_OFFSET_FROM_LAST {
            x = if lx + MIN_OFFSET_FROM_LAST <= max_x {
                lx + MIN_OFFSET_FROM_LAST
            } else {
                (lx - MIN_OFFSET_FROM_LAST).max(min_x)
            };
        }
    }
    (x, y)
}

fn read_settings(db: &Db) -> EngineSettings {
    let get = |k: &str| db.get_setting(k).ok().flatten();
    EngineSettings {
        interval_min: get("popup_interval_min")
            .and_then(|v| v.parse().ok())
            .unwrap_or(10),
        study_start: get("study_start").unwrap_or_else(|| "09:00".into()),
        study_end: get("study_end").unwrap_or_else(|| "22:30".into()),
        paused_until: get("paused_until").map(|v| db::parse_time(&v)),
        notify_mode: get("notify_mode").unwrap_or_else(|| "popup".into()),
    }
}

/// One engine pass. Returns true if a popup was opened.
pub fn tick(app: &tauri::AppHandle, state: &Mutex<EngineState>) -> bool {
    let Some(db_cell) = app.try_state::<Mutex<Db>>() else {
        return false;
    };
    let (settings, due, popup_open) = {
        let db = db_cell.lock().expect("db mutex poisoned");
        (
            read_settings(&db),
            services::due_count(&db).unwrap_or(0) as usize,
            app.get_webview_window("popup").is_some(),
        )
    };
    let now_local = Local::now();
    if due == 0 || !not_paused(&settings) || !in_study_hours(now_local, &settings) {
        return false;
    }
    let mut st = state.lock().expect("engine state poisoned");
    if settings.notify_mode == "notify" {
        // Light notification (SPEC §8.1); throttled to one per popup interval.
        let due_notify = st.last_notify.is_none_or(|t| {
            Utc::now() - t >= chrono::Duration::minutes(settings.interval_min as i64)
        });
        if due_notify && app.get_webview_window("popup").is_none() {
            st.last_notify = Some(Utc::now());
            show_notification(app, due);
        }
        return false;
    }
    if popup_open {
        return false;
    }
    let rand = pseudo_rand();
    let (mx, my, mw, mh) = cursor_monitor(app);
    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE, st.last_pos, rand);
    match open_popup(app, pos) {
        Ok(_window) => {
            st.last_pos = Some(pos);
            true
        }
        Err(_) => false,
    }
}

fn show_notification(app: &tauri::AppHandle, due: usize) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("闪记 FlashMemo")
        .body(format!(
            "⏰ 有 {due} 张卡片待复习，通过托盘菜单「立即复习」打开"
        ))
        .show();
}

/// Monitor the cursor is on, or the primary monitor, or a 1920x1080 fallback.
fn cursor_monitor(app: &tauri::AppHandle) -> (f64, f64, f64, f64) {
    let fallback = (0.0, 0.0, 1920.0, 1080.0);
    let Ok(cursor) = app.cursor_position() else {
        return fallback;
    };
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    monitor
        .map(|m| {
            (
                m.position().x as f64,
                m.position().y as f64,
                m.size().width as f64,
                m.size().height as f64,
            )
        })
        .unwrap_or(fallback)
}

fn open_popup(app: &tauri::AppHandle, pos: (f64, f64)) -> tauri::Result<tauri::WebviewWindow> {
    // SPEC §8.3: 440x380, borderless, always-on-top, not focus-stealing.
    tauri::WebviewWindowBuilder::new(app, "popup", tauri::WebviewUrl::App("index.html".into()))
        .title("闪记")
        .inner_size(POPUP_SIZE.0, POPUP_SIZE.1)
        .position(pos.0, pos.1)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .focused(false)
        .build()
}

/// Cheap SplitMix64 in [0,1)² — no external RNG dependency for two floats.
fn pseudo_rand() -> (f64, f64) {
    let mut z = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    let mut next = move || {
        z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let x = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        let x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (x ^ (x >> 31)) >> 11
    };
    let scale = (1u64 << 53) as f64;
    ((next() as f64) / scale, (next() as f64) / scale)
}

/// Background loop; also re-evaluated immediately on `force-review` events.
pub fn spawn(app: tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
        tick(&app, &state);
    });
}

/// Wire the immediate-review path: tray "立即复习" emits `force-review`.
pub fn listen_force_review(app: &tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    let handle = app.clone();
    app.listen("force-review", move |_| {
        tick(&handle, &state);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn settings() -> EngineSettings {
        EngineSettings::default()
    }

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 28, h, m, 0).unwrap()
    }

    #[test]
    fn in_study_hours_bounds() {
        let s = settings();
        assert!(!in_study_hours(at(8, 59), &s));
        assert!(in_study_hours(at(9, 0), &s));
        assert!(in_study_hours(at(22, 30), &s));
        assert!(!in_study_hours(at(22, 31), &s));
    }

    #[test]
    fn popup_decision_suppressed() {
        let s = settings();
        // Nothing due.
        assert!(!popup_decision(0, at(10, 0), &s, false));
        // Outside study hours.
        assert!(!popup_decision(5, at(7, 0), &s, false));
        // Paused.
        let mut paused = settings();
        paused.paused_until = Some(Utc::now() + chrono::Duration::hours(1));
        assert!(!popup_decision(5, at(10, 0), &paused, false));
        // Popup already open.
        assert!(!popup_decision(5, at(10, 0), &s, true));
        // All clear.
        assert!(popup_decision(5, at(10, 0), &s, false));
        // Pause expired.
        paused.paused_until = Some(Utc::now() - chrono::Duration::hours(1));
        assert!(popup_decision(5, at(10, 0), &paused, false));
    }

    #[test]
    fn popup_position_respects_margins_and_offset() {
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        // rand (0,0) -> top-left margin corner.
        assert_eq!(
            popup_position(monitor, POPUP_SIZE, None, (0.0, 0.0)),
            (20.0, 20.0)
        );
        // Same spot twice: second must shift >= 100px away.
        let (x, y) = popup_position(monitor, POPUP_SIZE, Some((20.0, 20.0)), (0.0, 0.0));
        assert!((x - 20.0).abs() >= 100.0 || (y - 20.0).abs() >= 100.0);
        assert_eq!(y, 20.0, "y unchanged; x shifts right");
        assert_eq!(x, 120.0);
        // Tiny screen clamps inside bounds.
        let small = (0.0, 0.0, 500.0, 400.0);
        let (x, y) = popup_position(small, POPUP_SIZE, None, (0.0, 0.0));
        assert!((20.0..=40.0).contains(&x));
        assert!((20.0..=32.0).contains(&y));
    }

    #[test]
    fn parse_hhmm_works() {
        assert_eq!(parse_hhmm("09:00"), Some((9, 0)));
        assert_eq!(parse_hhmm(" 22:30 "), Some((22, 30)));
        assert_eq!(parse_hhmm("bad"), None);
        assert_eq!(parse_hhmm("9:"), None);
    }
}
