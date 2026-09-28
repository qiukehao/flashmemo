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
const TASKBAR_RESERVE: f64 = 48.0;

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

/// Last notification time, shared between the tick thread and the
/// `force-review` listener.
#[derive(Default)]
pub struct EngineState {
    pub last_notify: Option<DateTime<Utc>>,
    /// When the last popup was opened — the `popup_interval_min` throttle
    /// counts from here (manual triggers bypass it).
    pub last_popup_at: Option<DateTime<Utc>>,
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

/// SPEC §16 弹窗间隔: at least `interval_min` must pass between popup sessions
/// (even when learning cards become due sooner). Manual triggers bypass this.
pub fn interval_elapsed(last_popup_at: Option<DateTime<Utc>>, interval_min: u32) -> bool {
    last_popup_at.is_none_or(|t| Utc::now() - t >= chrono::Duration::minutes(interval_min as i64))
}

/// SPEC §8.2: pop only when cards are due, within hours, unpaused, no popup
/// already open, and the popup interval has elapsed since the last session.
pub fn popup_decision(
    due_count: usize,
    now: DateTime<Local>,
    s: &EngineSettings,
    popup_open: bool,
    last_popup_at: Option<DateTime<Utc>>,
    force: bool,
) -> bool {
    due_count > 0
        && !popup_open
        && in_study_hours(now, s)
        && not_paused(s)
        && (force || interval_elapsed(last_popup_at, s.interval_min))
}

/// Center of the monitor work area, in **logical pixels** (2026-09-28 调整：
/// 用户要求固定居中，替代原随机位置方案). Vertically centered above the
/// taskbar reserve; the reserve is 48 logical px, matching the standard
/// Windows taskbar height.
pub fn popup_position(monitor: (f64, f64, f64, f64), win: (f64, f64)) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let (ww, wh) = win;
    let work_h = (mh - TASKBAR_RESERVE).max(wh);
    (mx + (mw - ww) / 2.0, my + (work_h - wh) / 2.0)
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

/// One engine pass. Returns true if a popup was opened. `force` is set for
/// manual triggers (tray "立即复习" / 复习选中) and bypasses the interval
/// throttle.
pub fn tick(app: &tauri::AppHandle, state: &Mutex<EngineState>, force: bool) -> bool {
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
    let mut st = state.lock().expect("engine state poisoned");
    if settings.notify_mode == "notify" {
        if due == 0 || !not_paused(&settings) || !in_study_hours(now_local, &settings) {
            return false;
        }
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
    if !popup_decision(
        due,
        now_local,
        &settings,
        popup_open,
        st.last_popup_at,
        force,
    ) {
        return false;
    }
    let (mx, my, mw, mh) = cursor_monitor_logical(app);
    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
    #[cfg(debug_assertions)]
    eprintln!(
        "[engine] popup at logical ({:.0}, {:.0}) on monitor ({:.0}, {:.0}, {:.0}, {:.0})",
        pos.0, pos.1, mx, my, mw, mh
    );
    match open_popup(app, pos) {
        Ok(_window) => {
            st.last_popup_at = Some(Utc::now());
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

/// Monitor the cursor is on, expressed in **logical** pixels because that is
/// what Tauri's window APIs consume (`WebviewWindowBuilder::position`/
/// `inner_size` are logical while `Monitor::size()`/`position()` are physical).
/// Mixing the two breaks centering on scaled displays — e.g. a 2560x1440 panel
/// at 150% reports 1707x960 logical; using physical numbers puts the window
/// 1.5x too far from the origin.
fn cursor_monitor_logical(app: &tauri::AppHandle) -> (f64, f64, f64, f64) {
    let fallback = (0.0, 0.0, 1920.0, 1080.0);
    let Ok(cursor) = app.cursor_position() else {
        return fallback;
    };
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let s = m.scale_factor();
            (
                m.position().x as f64 / s,
                m.position().y as f64 / s,
                m.size().width as f64 / s,
                m.size().height as f64 / s,
            )
        }
        None => fallback,
    }
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

/// Open a popup right now for an explicit card selection ("复习选中/复习该包").
/// Replaces any popup already on screen so the new session takes effect.
pub fn open_review_popup(app: &tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.close();
    }
    let (mx, my, mw, mh) = cursor_monitor_logical(app);
    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
    open_popup(app, pos).is_ok()
}

/// Background loop; also re-evaluated immediately on `force-review` events.
pub fn spawn(app: tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
        tick(&app, &state, false);
    });
}

/// Wire the immediate-review path: tray "立即复习" emits `force-review`.
/// If a popup session is already open, surface it; otherwise open one now,
/// bypassing the interval throttle (the user asked explicitly).
pub fn listen_force_review(app: &tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    let handle = app.clone();
    app.listen("force-review", move |_| {
        if let Some(w) = handle.get_webview_window("popup") {
            let _ = w.show();
            let _ = w.set_focus();
        } else {
            tick(&handle, &state, true);
        }
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
        assert!(!popup_decision(0, at(10, 0), &s, false, None, false));
        // Outside study hours.
        assert!(!popup_decision(5, at(7, 0), &s, false, None, false));
        // Paused.
        let mut paused = settings();
        paused.paused_until = Some(Utc::now() + chrono::Duration::hours(1));
        assert!(!popup_decision(5, at(10, 0), &paused, false, None, false));
        // Popup already open.
        assert!(!popup_decision(5, at(10, 0), &s, true, None, false));
        // All clear.
        assert!(popup_decision(5, at(10, 0), &s, false, None, false));
        // Pause expired.
        paused.paused_until = Some(Utc::now() - chrono::Duration::hours(1));
        assert!(popup_decision(5, at(10, 0), &paused, false, None, false));
    }

    #[test]
    fn popup_throttled_by_interval_setting() {
        // Default interval is 10 minutes.
        let s = settings();
        let recent = Some(Utc::now() - chrono::Duration::minutes(2));
        assert!(
            !popup_decision(5, at(10, 0), &s, false, recent, false),
            "a 1-minute-due learning card must wait for the 10-minute popup interval"
        );
        let old = Some(Utc::now() - chrono::Duration::minutes(11));
        assert!(popup_decision(5, at(10, 0), &s, false, old, false));
        // Manual triggers bypass the throttle.
        assert!(popup_decision(5, at(10, 0), &s, false, recent, true));
        // User-configured 5-minute interval.
        let mut custom = settings();
        custom.interval_min = 5;
        let four = Some(Utc::now() - chrono::Duration::minutes(4));
        assert!(!popup_decision(5, at(10, 0), &custom, false, four, false));
        let six = Some(Utc::now() - chrono::Duration::minutes(6));
        assert!(popup_decision(5, at(10, 0), &custom, false, six, false));
    }

    #[test]
    fn popup_position_is_workarea_center() {
        // 100% scaling, 1920x1080 with a 48px taskbar.
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(
            popup_position(monitor, POPUP_SIZE),
            ((1920.0 - 440.0) / 2.0, (1080.0 - 48.0 - 380.0) / 2.0)
        );
    }

    #[test]
    fn popup_position_handles_scaled_and_offset_monitors() {
        // Regression for the reported bug: physical 2560x1440 at 150% scaling
        // is 1706.67x960 logical; window APIs take logical pixels.
        let primary = (0.0, 0.0, 2560.0 / 1.5, 1440.0 / 1.5);
        let (x, y) = popup_position(primary, POPUP_SIZE);
        let expect_x = (2560.0 / 1.5 - 440.0) / 2.0;
        let expect_y = (1440.0 / 1.5 - 48.0 - 380.0) / 2.0;
        assert!((x - expect_x).abs() < 0.01, "x {x} != {expect_x}");
        assert!((y - expect_y).abs() < 0.01, "y {y} != {expect_y}");
        // Portrait second monitor at negative offsets.
        let portrait = (-1728.0 / 1.5, -768.0 / 1.5, 1728.0 / 1.5, 3072.0 / 1.5);
        let (x, y) = popup_position(portrait, POPUP_SIZE);
        assert!((x - (-1152.0 + (1152.0 - 440.0) / 2.0)).abs() < 0.01);
        assert!((y - (-512.0 + (2048.0 - 48.0 - 380.0) / 2.0)).abs() < 0.01);
    }

    #[test]
    fn parse_hhmm_works() {
        assert_eq!(parse_hhmm("09:00"), Some((9, 0)));
        assert_eq!(parse_hhmm(" 22:30 "), Some((22, 30)));
        assert_eq!(parse_hhmm("bad"), None);
        assert_eq!(parse_hhmm("9:"), None);
    }
}
