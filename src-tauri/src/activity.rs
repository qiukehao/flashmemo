//! Screen-activity watcher (2026-10-04, 娱乐加速): a tiny Win32 sampler that
//! classifies the foreground window as 娱乐 / 学习 / 中性 against user rules
//! and exposes the current state to the engine's cadence funnel.
//!
//! Privacy red lines (PRIVACY.md): titles and process names live in memory
//! only — they are never written to the database nor to the log file. Only
//! the classification result and one aggregate counter (加速弹窗次数) persist.
//!
//! Implementation notes: a 3-second `SetTimer` message loop samples
//! `GetForegroundWindow`; the cost is microseconds per sample (no full
//! process enumeration, no keyboard/mouse hooks — `SetWindowsHookEx` would
//! trip antivirus heuristics). Process names are cached per pid and read
//! with `PROCESS_QUERY_LIMITED_INFORMATION`.

use crate::db::Db;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

/// A monitoring rule: match an exe name or a window-title substring.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivityRule {
    /// "exe" matches the foreground process image name; "title" matches the
    /// window title (browser tabs surface the site name in the title).
    pub kind: String,
    pub pattern: String,
    /// "entertainment" | "study" — anything else in the list is ignored.
    pub category: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Entertainment,
    Study,
    Neutral,
}

impl Category {
    fn from_str(s: &str) -> Category {
        match s {
            "entertainment" => Category::Entertainment,
            "study" => Category::Study,
            _ => Category::Neutral,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Category::Entertainment => "entertainment",
            Category::Study => "study",
            Category::Neutral => "neutral",
        }
    }
}

/// What the monitor saw in its latest sample — for the settings-page
/// 「实时捕捉」 panel. Lives in memory only; never persisted, never logged.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatus {
    pub enabled: bool,
    pub category: &'static str,
    /// How long the current category has lasted (continuous, resets on change).
    pub continuous_secs: u64,
    /// Foreground process image name (stem only, e.g. "chrome.exe").
    pub process: String,
    /// Window title — sampled for browsers only, shown in its original case.
    pub title: String,
    /// The rule pattern that matched, if any (for debugging the rule list).
    pub matched: Option<String>,
    /// True when the last sample classified as neutral because the user has
    /// been idle for over 5 minutes.
    pub idle: bool,
}

/// One sample of the foreground state (memory only — the display panel reads
/// it live; nothing here is ever written to the database or the log file).
#[derive(Debug, Clone)]
struct Snapshot {
    category: Category,
    since: Instant,
    process: String,
    title: String,
    matched: Option<String>,
    idle: bool,
}

/// Foreground state shared with the engine thread and the settings panel.
#[derive(Default)]
pub struct ActivityShared {
    inner: Mutex<Option<Snapshot>>,
    enabled: std::sync::atomic::AtomicBool,
}

impl ActivityShared {
    fn clear(&self, enabled: bool) {
        use std::sync::atomic::Ordering;
        self.enabled.store(enabled, Ordering::Relaxed);
        let mut guard = self.inner.lock().unwrap_or_else(crate::recover_lock);
        *guard = None;
    }

    /// Store one sample. `since` is preserved while the category is unchanged
    /// — "已持续 N 秒" means continuously in this category.
    fn record(
        &self,
        category: Category,
        process: String,
        title: String,
        matched: Option<String>,
        idle: bool,
    ) {
        use std::sync::atomic::Ordering;
        self.enabled.store(true, Ordering::Relaxed);
        let mut guard = self.inner.lock().unwrap_or_else(crate::recover_lock);
        let changed = !matches!(&*guard, Some(s) if s.category == category);
        if changed {
            // 只记录分类结果——绝不记录窗口标题或进程名（隐私红线）。
            log::debug!("[activity] category -> {category:?}");
        }
        let since = guard.as_ref().filter(|_| !changed).map(|s| s.since);
        *guard = Some(Snapshot {
            category,
            since: since.unwrap_or_else(Instant::now),
            process,
            title,
            matched,
            idle,
        });
    }

    /// How long the foreground has continuously been entertainment, if it is.
    pub fn entertainment_for(&self) -> Option<Duration> {
        self.category_duration()
            .filter(|(c, _)| *c == Category::Entertainment)
            .map(|(_, d)| d)
    }

    /// Current category and how long it has been held continuously — the
    /// cadence funnel (娱乐 ÷2 / 学习 ×2) and the study deferral read this.
    pub fn category_duration(&self) -> Option<(Category, Duration)> {
        let guard = self.inner.lock().unwrap_or_else(crate::recover_lock);
        guard.as_ref().map(|s| (s.category, s.since.elapsed()))
    }

    /// Latest sample for the settings-page live panel.
    pub fn status(&self) -> ActivityStatus {
        use std::sync::atomic::Ordering;
        let enabled = self.enabled.load(Ordering::Relaxed);
        let guard = self.inner.lock().unwrap_or_else(crate::recover_lock);
        match &*guard {
            Some(s) => ActivityStatus {
                enabled,
                category: s.category.as_str(),
                continuous_secs: s.since.elapsed().as_secs(),
                process: s.process.clone(),
                title: s.title.clone(),
                matched: s.matched.clone(),
                idle: s.idle,
            },
            None => ActivityStatus {
                enabled,
                category: "neutral",
                continuous_secs: 0,
                process: String::new(),
                title: String::new(),
                matched: None,
                idle: false,
            },
        }
    }
}

/// Processes whose window titles carry the site/page name — only these get
/// title matching (title matching for, say, WeChat would be noise).
pub const BROWSER_STEMS: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "opera",
    "browser",
    "brave",
    "vivaldi",
    "qqbrowser",
    "360se",
    "360chrome",
    "sogouexplorer",
    "maxthon",
];

/// Pure classification: the FIRST matching rule wins; exe rules match the
/// process image name (lowercased substring), title rules match the window
/// title (only sampled for browsers). Everything else is neutral.
pub fn classify(rules: &[ActivityRule], process: &str, title: &str) -> Category {
    classify_detail(rules, process, title).0
}

/// Same as [`classify`] but also returns the matched rule's pattern — the
/// settings-page live panel shows it so rules are debuggable at a glance.
pub fn classify_detail<'a>(
    rules: &'a [ActivityRule],
    process: &str,
    title: &str,
) -> (Category, Option<&'a str>) {
    let process = process.to_lowercase();
    let title = title.to_lowercase();
    let process_stem = process
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&process)
        .to_string();
    for rule in rules {
        let pattern = rule.pattern.trim().to_lowercase();
        if pattern.is_empty() {
            continue;
        }
        let matches = match rule.kind.as_str() {
            "exe" => process_stem.contains(&pattern) || process.contains(&pattern),
            "title" => title.contains(&pattern),
            _ => false,
        };
        if matches {
            return (
                Category::from_str(&rule.category),
                Some(rule.pattern.as_str()),
            );
        }
    }
    (Category::Neutral, None)
}

/// Whether `process` looks like a browser (title sampling applies).
fn is_browser(process_stem: &str) -> bool {
    BROWSER_STEMS.iter().any(|stem| process_stem.contains(stem))
}

/// Spawn the background sampler. Non-Windows targets get a no-op (the app is
/// Windows-only; the stub keeps tests and CI compiling).
pub fn spawn_monitor(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || monitor_loop(app));
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// 托盘菜单刷新（托盘未建好时静默跳过——setup 先建监控线程后建菜单）。
fn refresh_tray(app: &tauri::AppHandle, shared: &Arc<ActivityShared>) {
    if let Some(tray) = app.try_state::<TrayMonitor>() {
        tray.refresh(app, &shared.status());
    }
}

/// Load rules + enabled flag from the settings KV (cheap: ~3 point queries
/// per 3-second sample).
fn load_settings(db: &Db) -> (bool, Vec<ActivityRule>) {
    let enabled = db
        .get_setting("activity_enabled")
        .ok()
        .flatten()
        .is_some_and(|v| v.trim() == "1");
    let rules: Vec<ActivityRule> = db
        .get_setting("activity_rules")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    (enabled, rules)
}

/// Upsert one rule by (kind, pattern): re-adding an existing pattern re-tags
/// its category (娱乐 ↔ 学习 can be flipped right from the tray). Pure for
/// tests; returns the new list and whether anything changed.
pub fn upsert_rule(rules: Vec<ActivityRule>, rule: ActivityRule) -> (Vec<ActivityRule>, bool) {
    let pattern = rule.pattern.trim().to_string();
    if pattern.is_empty() {
        return (rules, false);
    }
    let mut rules = rules;
    if let Some(existing) = rules
        .iter_mut()
        .find(|r| r.kind == rule.kind && r.pattern.trim() == pattern)
    {
        if existing.category == rule.category {
            return (rules, false);
        }
        existing.category = rule.category;
        return (rules, true);
    }
    rules.push(ActivityRule {
        kind: rule.kind,
        pattern,
        category: rule.category,
    });
    (rules, true)
}

/// 托盘「加入监控清单」：把当前程序/标题写回设置 KV。返回是否真的有改动
/// （false = 清单里已有同样的规则）。
pub fn add_rule_to_settings(db: &Db, rule: ActivityRule) -> Result<bool, String> {
    let rules: Vec<ActivityRule> = db
        .get_setting("activity_rules")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let (rules, changed) = upsert_rule(rules, rule);
    if changed {
        let json = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
        db.set_setting("activity_rules", &json)
            .map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

// ------------------------------------------------------------- 托盘监控信息
// 托盘菜单右键就能看到监控正在看什么（进程 / 窗口标题 / 命中规则），用户
// 不用再为"这条规则该怎么写"翻到设置最底下。句柄由 lib.rs 建菜单时管理，
// 采样线程在状态变化时刷新文本（diff 过，无变化不发主线程任务）。

/// 托盘菜单的监控区句柄（lib.rs setup 创建后 manage）。
pub struct TrayMonitor {
    pub line1: tauri::menu::MenuItem<tauri::Wry>,
    pub line2: tauri::menu::MenuItem<tauri::Wry>,
    pub add_exe_ent: tauri::menu::MenuItem<tauri::Wry>,
    pub add_title_ent: tauri::menu::MenuItem<tauri::Wry>,
    pub add_exe_study: tauri::menu::MenuItem<tauri::Wry>,
    pub add_title_study: tauri::menu::MenuItem<tauri::Wry>,
    last: Mutex<(String, String, [bool; 4])>,
}

impl TrayMonitor {
    pub fn new(
        line1: tauri::menu::MenuItem<tauri::Wry>,
        line2: tauri::menu::MenuItem<tauri::Wry>,
        add_exe_ent: tauri::menu::MenuItem<tauri::Wry>,
        add_title_ent: tauri::menu::MenuItem<tauri::Wry>,
        add_exe_study: tauri::menu::MenuItem<tauri::Wry>,
        add_title_study: tauri::menu::MenuItem<tauri::Wry>,
    ) -> Self {
        Self {
            line1,
            line2,
            add_exe_ent,
            add_title_ent,
            add_exe_study,
            add_title_study,
            last: Mutex::new((String::new(), String::new(), [false; 4])),
        }
    }

    /// 用最新采样刷新托盘菜单（无变化时不做任何事）。
    pub fn refresh(&self, app: &tauri::AppHandle, status: &ActivityStatus) {
        let (line1, line2, enables) = monitor_lines(status);
        {
            let mut last = self.last.lock().unwrap_or_else(crate::recover_lock);
            if *last == (line1.clone(), line2.clone(), enables) {
                return;
            }
            *last = (line1.clone(), line2.clone(), enables);
        }
        let items = (
            self.line1.clone(),
            self.line2.clone(),
            self.add_exe_ent.clone(),
            self.add_title_ent.clone(),
            self.add_exe_study.clone(),
            self.add_title_study.clone(),
        );
        let _ = app.run_on_main_thread(move || {
            let _ = items.0.set_text(line1);
            let _ = items.1.set_text(line2);
            let _ = items.2.set_enabled(enables[0]);
            let _ = items.3.set_enabled(enables[1]);
            let _ = items.4.set_enabled(enables[2]);
            let _ = items.5.set_enabled(enables[3]);
        });
    }
}

/// 纯函数：采样 → 托盘两行文案 + 四个「加入清单」项的可用状态。
/// 进程名始终可加；窗口标题只有浏览器采样才有，标题加规则仅在那时可用。
fn monitor_lines(status: &ActivityStatus) -> (String, String, [bool; 4]) {
    if !status.enabled {
        return (
            "屏幕监控未开启".to_string(),
            "（打开监控设置后，这里显示当前窗口）".to_string(),
            [false; 4],
        );
    }
    if status.idle || status.process.is_empty() {
        return (
            "空闲中（5 分钟没有操作）".to_string(),
            "（空闲不算娱乐也不算学习）".to_string(),
            [false; 4],
        );
    }
    let line1 = match status.category {
        "entertainment" => format!(
            "📺 娱乐中：{} · 命中「{}」",
            status.process,
            status.matched.as_deref().unwrap_or("?")
        ),
        "study" => format!(
            "📚 学习中：{} · 命中「{}」",
            status.process,
            status.matched.as_deref().unwrap_or("?")
        ),
        _ => format!("💻 正在使用：{}（未命中规则）", status.process),
    };
    let line2 = if status.title.is_empty() {
        "窗口标题：无（非浏览器）".to_string()
    } else {
        let title: String = status.title.chars().take(36).collect();
        format!("窗口：{title}")
    };
    let has_title = !status.title.is_empty();
    (line1, line2, [true, has_title, true, has_title])
}

#[cfg(windows)]
fn monitor_loop(app: tauri::AppHandle) {
    use windows_sys::Win32::Foundation::{HWND, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, SetTimer, TranslateMessage, MSG,
    };

    let shared: Arc<ActivityShared> = match app.try_state::<Arc<ActivityShared>>() {
        Some(s) => s.inner().clone(),
        None => return,
    };
    // 3-second thread timer: every WM_TIMER runs one sample. No hooks, no
    // global callback state — the pump stays entirely on this thread.
    unsafe {
        SetTimer(std::ptr::null_mut(), 1, 3_000, None);
        let mut msg: MSG = std::mem::zeroed();
        let mut pid_cache: HashMap<u32, String> = HashMap::new();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            // ---- one sample ----
            let Some(cell) = app.try_state::<Mutex<Db>>() else {
                continue;
            };
            let (enabled, rules) = {
                let Ok(db) = cell.lock() else { continue };
                load_settings(&db)
            };
            if !enabled {
                shared.clear(false);
                refresh_tray(&app, &shared);
                continue;
            }
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_null() || hwnd == INVALID_HANDLE_VALUE {
                continue;
            }
            // Idle > 5 min → nobody is browsing anything: neutral.
            let mut info: LASTINPUTINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<LASTINPUTINFO>() as u32;
            if GetLastInputInfo(&mut info) != 0 {
                let idle_ms = GetTickCount().wrapping_sub(info.dwTime);
                if idle_ms > 5 * 60 * 1000 {
                    shared.record(Category::Neutral, String::new(), String::new(), None, true);
                    refresh_tray(&app, &shared);
                    continue;
                }
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let process = pid_cache
                .entry(pid)
                .or_insert_with(|| query_process_name(pid).unwrap_or_default());
            let process = process.to_lowercase();
            let stem = process
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(&process)
                .to_string();
            // Raw case for display; lowercased copy for matching.
            let title_raw = if is_browser(&stem) {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
                    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    String::from_utf16_lossy(&buf[..end])
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            let (category, matched) = classify_detail(&rules, &process, &title_raw);
            // The live panel shows what was captured — display-only, memory
            // only (truncate absurdly long titles to keep the payload sane).
            let title_display: String = title_raw.chars().take(200).collect();
            shared.record(
                category,
                stem,
                title_display,
                matched.map(|s| s.to_string()),
                false,
            );
            refresh_tray(&app, &shared);
        }
    }

    /// Process image name via LIMITED_INFORMATION — no elevation needed and
    /// no full process enumeration.
    unsafe fn query_process_name(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        windows_sys::Win32::Foundation::CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(not(windows))]
fn monitor_loop(app: tauri::AppHandle) {
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: &str, pattern: &str, category: &str) -> ActivityRule {
        ActivityRule {
            kind: kind.into(),
            pattern: pattern.into(),
            category: category.into(),
        }
    }

    #[test]
    fn classify_matches_exe_and_title_rules() {
        let rules = vec![
            rule("exe", "weixin", "entertainment"),
            rule("exe", "qq", "entertainment"),
            rule("title", "bilibili", "entertainment"),
            rule("title", "douyin", "entertainment"),
            rule("exe", "idea", "study"),
            rule("title", "rustdoc", "study"),
        ];
        assert_eq!(
            classify(&rules, "weixin.exe", "微信"),
            Category::Entertainment
        );
        assert_eq!(classify(&rules, "qq.exe", "QQ"), Category::Entertainment);
        assert_eq!(
            classify(
                &rules,
                "msedge.exe",
                "【番剧】xxx - 哔哩哔哩 (゜-゜)つロ bilibili"
            ),
            Category::Entertainment
        );
        assert_eq!(
            classify(&rules, "chrome.exe", "抖音 - 记录美好生活 douyin.com"),
            Category::Entertainment
        );
        assert_eq!(
            classify(&rules, "idea64.exe", "shanka_study – main.rs"),
            Category::Study
        );
        assert_eq!(
            classify(&rules, "chrome.exe", "std::path - RustDoc"),
            Category::Study
        );
    }

    #[test]
    fn classify_defaults_to_neutral_and_is_case_insensitive() {
        let rules = vec![rule("title", "BILIBILI", "entertainment")];
        assert_eq!(
            classify(&rules, "msedge.exe", "哔哩哔哩 (゜-゜)つロ Bilibili"),
            Category::Entertainment
        );
        assert_eq!(
            classify(&rules, "notepad.exe", "购物清单"),
            Category::Neutral
        );
        assert_eq!(classify(&[], "anything", "anything"), Category::Neutral);
        let blank = vec![rule("exe", "  ", "entertainment")];
        assert_eq!(classify(&blank, "weixin.exe", "x"), Category::Neutral);
    }

    #[test]
    fn first_matching_rule_wins() {
        let rules = vec![
            rule("title", "bilibili", "study"),
            rule("title", "哔哩哔哩", "entertainment"),
        ];
        assert_eq!(
            classify(&rules, "msedge.exe", "哔哩哔哩 bilibili"),
            Category::Study
        );
    }

    #[test]
    fn shared_state_tracks_continuous_entertainment() {
        let shared = ActivityShared::default();
        assert_eq!(shared.entertainment_for(), None);
        shared.record(
            Category::Entertainment,
            "chrome.exe".into(),
            "抖音".into(),
            None,
            false,
        );
        let first = shared.entertainment_for().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        shared.record(
            Category::Entertainment,
            "chrome.exe".into(),
            "抖音".into(),
            None,
            false,
        );
        assert!(shared.entertainment_for().unwrap() >= first, "timer kept");
        shared.record(Category::Neutral, "".into(), "".into(), None, true);
        assert_eq!(shared.entertainment_for(), None);
        shared.record(Category::Study, "idea64.exe".into(), "".into(), None, false);
        assert_eq!(shared.entertainment_for(), None);
    }

    #[test]
    fn classify_detail_reports_the_matched_rule() {
        let rules = vec![
            rule("title", "bilibili", "study"),
            rule("title", "哔哩哔哩", "entertainment"),
        ];
        let (category, matched) = classify_detail(&rules, "msedge.exe", "哔哩哔哩 bilibili");
        assert_eq!(category, Category::Study);
        assert_eq!(matched, Some("bilibili"), "first match wins and is named");
        let (category, matched) = classify_detail(&rules, "notepad.exe", "购物清单");
        assert_eq!(category, Category::Neutral);
        assert_eq!(matched, None);
    }

    #[test]
    fn status_reports_the_latest_sample_for_the_live_panel() {
        let shared = ActivityShared::default();
        // Disabled by default: the panel shows "off" with no capture.
        let s = shared.status();
        assert!(!s.enabled);
        assert_eq!(s.category, "neutral");
        assert!(s.process.is_empty());

        shared.record(
            Category::Entertainment,
            "chrome.exe".into(),
            "抖音-记录美好生活 - Google Chrome".into(),
            Some("抖音".into()),
            false,
        );
        std::thread::sleep(Duration::from_millis(5));
        let s = shared.status();
        assert!(s.enabled);
        assert_eq!(s.category, "entertainment");
        assert_eq!(s.process, "chrome.exe");
        assert!(s.title.contains("抖音"));
        assert_eq!(s.matched.as_deref(), Some("抖音"));
        assert!(!s.idle);

        // Idle samples read as neutral with the idle flag set.
        shared.record(Category::Neutral, String::new(), String::new(), None, true);
        let s = shared.status();
        assert_eq!(s.category, "neutral");
        assert!(s.idle);

        // Disabling clears the capture.
        shared.clear(false);
        let s = shared.status();
        assert!(!s.enabled);
        assert!(s.process.is_empty());
    }

    #[test]
    fn browser_stem_detection() {
        assert!(is_browser("msedge.exe"));
        assert!(is_browser("chrome"));
        assert!(!is_browser("weixin.exe"));
    }

    #[test]
    fn upsert_rule_retags_and_dedups() {
        let rules = vec![rule("exe", "weixin.exe", "entertainment")];
        // 同类重复：no-op
        let (rules, changed) =
            upsert_rule(rules.clone(), rule("exe", "weixin.exe", "entertainment"));
        assert!(!changed);
        assert_eq!(rules.len(), 1);
        // 同 pattern 换分类：retag
        let (rules, changed) = upsert_rule(rules, rule("exe", "weixin.exe", "study"));
        assert!(changed);
        assert_eq!(rules[0].category, "study");
        assert_eq!(rules.len(), 1);
        // 新规则：append
        let (rules, changed) = upsert_rule(rules, rule("title", "bilibili", "entertainment"));
        assert!(changed);
        assert_eq!(rules.len(), 2);
        // 空白 pattern：忽略
        let (rules, changed) = upsert_rule(rules, rule("exe", "  ", "study"));
        assert!(!changed);
        assert_eq!(rules.len(), 2);
    }

    #[test]
    fn monitor_lines_reflect_enabled_idle_and_match() {
        // 未开启：两个加入项都不可用
        let s = ActivityStatus {
            enabled: false,
            category: "neutral",
            continuous_secs: 0,
            process: String::new(),
            title: String::new(),
            matched: None,
            idle: false,
        };
        let (l1, _l2, enables) = monitor_lines(&s);
        assert_eq!(l1, "屏幕监控未开启");
        assert_eq!(enables, [false, false, false, false]);

        // 空闲
        let s = ActivityStatus {
            enabled: true,
            category: "neutral",
            continuous_secs: 0,
            process: String::new(),
            title: String::new(),
            matched: None,
            idle: true,
        };
        let (l1, _l2, enables) = monitor_lines(&s);
        assert!(l1.contains("空闲"));
        assert_eq!(enables, [false, false, false, false]);

        // 命中娱乐 + 浏览器标题：进程/标题都能加
        let s = ActivityStatus {
            enabled: true,
            category: "entertainment",
            continuous_secs: 9,
            process: "chrome.exe".into(),
            title: "抖音 - 记录美好生活".into(),
            matched: Some("抖音".into()),
            idle: false,
        };
        let (l1, l2, enables) = monitor_lines(&s);
        assert!(l1.contains("娱乐中"));
        assert!(l1.contains("chrome.exe"));
        assert!(l1.contains("抖音"));
        assert!(l2.contains("抖音"));
        assert_eq!(enables, [true, true, true, true]);

        // 非浏览器（无标题）：只能加进程
        let s = ActivityStatus {
            enabled: true,
            category: "neutral",
            continuous_secs: 0,
            process: "code.exe".into(),
            title: String::new(),
            matched: None,
            idle: false,
        };
        let (l1, l2, enables) = monitor_lines(&s);
        assert!(l1.contains("code.exe"));
        assert!(l2.contains("非浏览器"));
        assert_eq!(enables, [true, false, true, false]);
    }
}
