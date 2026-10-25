//! AI 助手窗口 (SPEC §10): the AI sites (DeepSeek/豆包/Kimi…) run in a real
//! webview — iframes cannot embed them — inside a DEDICATED top-level window
//! that DOCKS to the card window (2026-10-07 二次反馈：用户要"和闪卡对照").
//!
//! History (2026-10-07): the sidebar used to be a child webview overlaid on
//! the main/popup window, with the frontend syncing its rect through IPC on
//! every layout change. Editing card text while it was open crashed the host
//! renderer repeatedly (white screen, "failed to autoresize webview: 拒绝访
//! 问" in the logs). A separate window removes that entire failure surface —
//! and to keep the side-by-side reading experience, the watcher thread below
//! pins it flush against the owner window and moves it along, so the pair
//! reads as one wide window. "Close" means HIDE: the site page (and the
//! user's conversation on it) stays alive, so reopening continues the same
//! chat instead of starting a fresh one every time.

use std::sync::Mutex;
use tauri::{
    LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size,
    WebviewUrl,
};

/// The child webview (the actual AI site) inside the AI window.
pub const SIDEBAR_LABEL: &str = "ai-sidebar";
/// The dedicated top-level window hosting the sidebar.
pub const AI_WINDOW_LABEL: &str = "ai";
const AI_WINDOW_HEIGHT: f64 = 680.0;
/// Never dock the panel shorter than this (logical px) when the owner is tiny.
const AI_MIN_DOCK_HEIGHT: f64 = 420.0;

/// KV key remembering the last conversation URL, so a restart can jump back
/// into the same chat instead of the site's "new conversation" home page.
const LAST_URL_KEY: &str = "ai_last_url";
/// KV key holding the panel's remembered **visible** width (logical px).
const SIDEBAR_WIDTH_KEY: &str = "ai_sidebar_width";
/// A user resize is worth remembering only past this slop (physical px) — it
/// absorbs the rounding of the persisted logical width back into pixels, so a
/// re-dock can never be mistaken for a fresh manual resize.
const WIDTH_SLACK: i32 = 2;

/// Dock bookkeeping for the watcher thread. `auto_hidden` marks hides the
/// watcher performed itself (owner went away) so it can undo them when the
/// owner comes back — a hide the USER did never gets undone.
#[derive(Default)]
pub struct AiDock {
    owner: Mutex<Option<String>>,
    auto_hidden: Mutex<bool>,
    last_owner_geometry: Mutex<Option<(i32, i32, u32, u32)>>,
    /// The visible rect the dock itself last applied, so the watcher can tell a
    /// USER resize apart from its own placement.
    last_applied: Mutex<Option<PhysRect>>,
    /// Previous poll's visible width, used to wait out an in-progress drag.
    width_seen: Mutex<Option<i32>>,
}

fn sidebar_data_dir() -> Option<std::path::PathBuf> {
    std::env::var("APPDATA").ok().map(|a| {
        std::path::Path::new(&a)
            .join("FlashMemo")
            .join("webview_data")
    })
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: tauri::Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(w.max(1.0), h.max(1.0))),
    }
}

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| "网址无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("只支持 http/https 网址".into()),
    }
}

/// Reopen width: the panel's **visible** width (logical px), persisted in
/// settings. The window rect that carries it is wider by the invisible border,
/// so the number here is what the user actually sees next to the card window.
fn sidebar_width(app: &tauri::AppHandle) -> f64 {
    let width = app
        .try_state::<std::sync::Mutex<crate::db::Db>>()
        .and_then(|cell| {
            let db = cell.lock().unwrap_or_else(crate::recover_lock);
            db.get_setting(SIDEBAR_WIDTH_KEY).ok().flatten()
        })
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(420.0);
    width.clamp(320.0, 720.0)
}

/// Remember the width the user dragged the panel to (logical px). The caller
/// must not hold the DB lock: the dock call that follows it does window work.
fn save_sidebar_width(app: &tauri::AppHandle, logical: f64) {
    if let Some(cell) = app.try_state::<std::sync::Mutex<crate::db::Db>>() {
        let db = cell.lock().unwrap_or_else(crate::recover_lock);
        let _ = db.set_setting(SIDEBAR_WIDTH_KEY, &format!("{logical}"));
    }
}

/// Physical panel width → the logical width to persist, matching the 320..=720
/// range `sidebar_width` reads back (a drag past either bound must not stick as
/// a value that would be clamped away on the next launch anyway).
fn logical_width_from_pixels(physical: i32, scale: f64) -> f64 {
    (physical.max(0) as f64 / scale.max(0.1))
        .round()
        .clamp(320.0, 720.0)
}

/// Detect a MANUAL width change of the docked panel (pure, so it is unit
/// tested). `applied` is the width the dock itself last set; `seen`/`current`
/// are the widths two consecutive polls read back.
///
/// The watcher polls every 200ms, so a live drag reports a new width on every
/// tick: persisting those would write a trail of intermediate values AND let
/// the re-dock below fight the user mid-drag. Requiring the same width twice in
/// a row means the drag has stopped. Returns (next `seen`, width to remember).
fn settle_manual_width(
    seen: Option<i32>,
    applied: i32,
    current: i32,
) -> (Option<i32>, Option<i32>) {
    if (current - applied).abs() <= WIDTH_SLACK {
        (None, None)
    } else if seen == Some(current) {
        (Some(current), Some(current))
    } else {
        (Some(current), None)
    }
}

/// A rectangle in **physical** screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PhysRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl PhysRect {
    fn right(&self) -> i32 {
        self.x + self.w
    }

    fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

/// How far a window's **visible** area sits inside the rect Windows reports
/// through `outer_position()/outer_size()`: a resizeable window carries an
/// invisible resize border (`SM_CXSIZEFRAME + SM_CXPADDEDBORDER`), and tao adds
/// the DWM shadow margin for undecorated ones. Lining up those OUTER rects is
/// what left a ~10px seam between the card window and the AI window (2026-10-10
/// 用户反馈：独立窗口和闪卡窗口之间那道间隔)。只有 left/top 有用：tao 的
/// `set_size` 收的是 **client** 尺寸，可见左上角对上之后尺寸不用再补。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FrameInsets {
    left: i32,
    top: i32,
}

/// The window rect (`GetWindowRect`).
fn outer_rect(window: &tauri::Window) -> Option<PhysRect> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(PhysRect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    })
}

/// The rectangle the user actually sees — the one that has to line up so the
/// pair reads as a single window. The window rect keeps the invisible resize
/// border on the sides and the bottom; a decorated window's visible top is its
/// window rect top (the caption is visible), except while maximized, where the
/// rect is inflated beyond the screen by that same border on every side.
fn owner_visible_frame(window: &tauri::Window) -> Option<PhysRect> {
    let outer = outer_rect(window)?;
    let inner_pos = window.inner_position().ok()?;
    let inner_size = window.inner_size().ok()?;
    let frame = (inner_pos.x - outer.x).max(0);
    let right = (outer.right() - (inner_pos.x + inner_size.width as i32)).max(0);
    let bottom = (outer.bottom() - (inner_pos.y + inner_size.height as i32)).max(0);
    let top = if window.is_maximized().unwrap_or(false) {
        frame
    } else {
        0
    };
    Some(PhysRect {
        x: outer.x + frame,
        y: outer.y + top,
        w: (outer.w - frame - right).max(1),
        h: (outer.h - top - bottom).max(1),
    })
}

/// The AI window's own invisible margin. For an undecorated window the client
/// area *is* the visible panel (tao keeps the resize frame but paints nothing
/// there, and pads the client with the shadow margin when shadows are on), so
/// the client's offset from the window rect is exactly the number to subtract.
fn ai_insets(window: &tauri::Window) -> FrameInsets {
    let Some(outer) = outer_rect(window) else {
        return FrameInsets::default();
    };
    let Ok(inner_pos) = window.inner_position() else {
        return FrameInsets::default();
    };
    FrameInsets {
        left: (inner_pos.x - outer.x).max(0),
        top: (inner_pos.y - outer.y).max(0),
    }
}

/// The panel's **visible** rect — the AI window's client area, which is what
/// `place_at_dock` sizes. Comparing it against the last applied rect is how the
/// watcher notices the user grabbed an edge.
fn panel_visible_rect(window: &tauri::Window) -> Option<PhysRect> {
    let pos = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(PhysRect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    })
}

/// The **visible** rect to dock the AI panel into: flush against the owner's
/// visible right edge, same top and visible height; mirrored to the owner's
/// left edge when there is no room on the right; clamped into the monitor work
/// area and never shorter than `min_height`. Pure function so the geometry can
/// be unit tested without a window.
fn dock_visible_rect(owner: PhysRect, work: PhysRect, width: i32, min_height: i32) -> PhysRect {
    // 两侧都放不下请求宽度时，收缩面板而不是压在卡面上：评分按钮和顶栏必须
    // 永远可点（弹窗与 AI 面板都置顶，重叠时两者互相翻 z 序，按钮"时有时无"）。
    // 收缩只影响本次几何，不写回持久化宽度。
    const MIN_DOCK_WIDTH: i32 = 240;
    let right_avail = work.right() - owner.right();
    let left_avail = owner.x - work.x;
    let w = if right_avail >= width || left_avail >= width {
        width.clamp(1, work.w.max(1))
    } else {
        width
            .min(right_avail.max(left_avail).max(MIN_DOCK_WIDTH))
            .clamp(1, work.w.max(1))
    };
    let mut x = owner.right();
    if x + w > work.right() {
        x = owner.x - w; // no room on the right: dock flush on the left
    }
    if x < work.x || x + w > work.right() {
        x = (work.right() - w).max(work.x); // degenerate geometry: clamp inside
    }
    let y = owner.y.max(work.y);
    let h = owner
        .h
        .min(work.bottom() - y)
        .max(min_height)
        .min(work.h)
        .max(1);
    PhysRect { x, y, w, h }
}

/// A monitor's work area in physical pixels (taskbar excluded); `Monitor`'s own
/// position/size/work_area are physical already.
fn monitor_work_area(monitor: &tauri::Monitor) -> PhysRect {
    let area = monitor.work_area();
    PhysRect {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width as i32,
        h: area.size.height as i32,
    }
}

/// Remember which window the AI panel is docked to (set on every show).
fn set_dock_owner(app: &tauri::AppHandle, origin: &str) {
    if let Some(dock) = app.try_state::<AiDock>() {
        if let Ok(mut owner) = dock.owner.lock() {
            *owner = Some(if origin == "popup" { "popup" } else { "main" }.into());
        }
        if let Ok(mut hidden) = dock.auto_hidden.lock() {
            *hidden = false;
        }
        if let Ok(mut last) = dock.last_owner_geometry.lock() {
            *last = None; // force a dock refresh on the next watcher pass
        }
    }
}

/// Where the docked panel should sit, as the rect the user sees (physical px):
/// flush to the owner's visible right edge, same top and height, so the pair
/// reads as one wide window with the card on one side and the AI site on the
/// other. Falls back to a sensible default when the owner cannot be read.
fn dock_rect(app: &tauri::AppHandle, owner_label: &str) -> PhysRect {
    let width = sidebar_width(app);
    let Some(owner) = app.get_window(owner_label) else {
        return PhysRect {
            x: 80,
            y: 80,
            w: width as i32,
            h: AI_WINDOW_HEIGHT as i32,
        };
    };
    let scale = owner.scale_factor().unwrap_or(1.0);
    let work = owner
        .current_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(monitor_work_area);
    let (Some(owner_visible), Some(work)) = (owner_visible_frame(&owner), work) else {
        return PhysRect {
            x: 80,
            y: 80,
            w: (width * scale).round() as i32,
            h: (AI_WINDOW_HEIGHT * scale).round() as i32,
        };
    };
    dock_visible_rect(
        owner_visible,
        work,
        (width * scale).round() as i32,
        (AI_MIN_DOCK_HEIGHT * scale).round() as i32,
    )
}

/// Put the panel at `visible` (physical px). `set_position` moves the window
/// rect, so the panel's own invisible margin has to be subtracted to land its
/// visible corner on target; `set_size` is the client size in tao, and the
/// client is the visible panel — so the size goes in as is.
fn dock_window_position(visible: PhysRect, insets: FrameInsets) -> (i32, i32) {
    (visible.x - insets.left, visible.y - insets.top)
}

fn place_at_dock(app: &tauri::AppHandle, ai: &tauri::Window, visible: PhysRect) {
    let insets = ai_insets(ai);
    let (x, y) = dock_window_position(visible, insets);
    let _ = ai.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    let _ = ai.set_size(Size::Physical(PhysicalSize::new(
        visible.w.max(1) as u32,
        visible.h.max(1) as u32,
    )));
    // Record what the dock just did, so the watcher never mistakes this
    // placement for a user resize (which would loop through the settings).
    if let Some(dock) = app.try_state::<AiDock>() {
        if let Ok(mut last) = dock.last_applied.lock() {
            *last = Some(visible);
        }
        if let Ok(mut seen) = dock.width_seen.lock() {
            *seen = None;
        }
    }
}

/// Reveal (or create) the AI window docked to the caller's window. An already
/// visible window docked to the SAME owner is only focused — the user may
/// have pulled it somewhere they like, and re-anchoring on every 🤖 click
/// would fight them.
#[tauri::command]
pub async fn ai_window_show(app: tauri::AppHandle, origin: String) -> Result<(), String> {
    show_ai_window(&app, &origin)
}

/// `show_main_with_ai` (SPEC §10.1): surface the main window AND the AI window
/// (used by the card editor's 「问 AI」 button).
#[tauri::command]
pub async fn show_main_with_ai(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    show_ai_window(&app, "main")
}

fn show_ai_window(app: &tauri::AppHandle, origin: &str) -> Result<(), String> {
    // NOTE: `get_webview_window` returns None once the window hosts a second
    // (child) webview — the site webview makes it a multi-webview window.
    // Window-level operations must go through `get_window`; webview loss is
    // detected via the host page webview (`get_webview("ai")`).
    set_dock_owner(app, origin);
    let owner_label = if origin == "popup" { "popup" } else { "main" };
    let shell_alive = app.get_window(AI_WINDOW_LABEL).is_some();
    let host_alive = app.get_webview(AI_WINDOW_LABEL).is_some();
    if !shell_alive {
        return create_ai_window(app, owner_label);
    }
    if !host_alive {
        // Self-heal, mirroring the popup: a lost webview leaves a window shell
        // that rejects a rebuild under the same label until it is destroyed.
        let shell = app.get_window(AI_WINDOW_LABEL).expect("checked above");
        log::warn!("[ai] ai window webview lost, destroying the leftover shell");
        let _ = shell.destroy();
        std::thread::sleep(std::time::Duration::from_millis(150));
        return create_ai_window(app, owner_label);
    }
    let already_docked = app
        .try_state::<AiDock>()
        .and_then(|dock| {
            let owner = dock.owner.lock().ok()?;
            Some(owner.as_deref() == Some(owner_label))
        })
        .unwrap_or(false);
    // 焦点归复习流程：从弹窗打开 AI 不抢焦点——弹窗的评分热键（空格/1/2/3）
    // 必须继续工作，用户想打字时自己点进 AI 面板即可。主窗口打开才给焦点。
    let focus = origin != "popup";
    let window = app.get_window(AI_WINDOW_LABEL).expect("checked above");
    apply_topmost_for_origin(&window, origin);
    if window.is_visible().unwrap_or(false) {
        // Same owner → keep the user's placement; different owner → re-dock.
        if !already_docked {
            place_at_dock(app, &window, dock_rect(app, owner_label));
        }
        if focus {
            let _ = window.set_focus();
        }
        return Ok(());
    }
    place_at_dock(app, &window, dock_rect(app, owner_label));
    let _ = window.unminimize();
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
    Ok(())
}

/// 置顶与任务栏随宿主走：贴着弹窗（本就置顶）时置顶、无任务栏；贴着主窗口
/// 时做个普通窗口——否则它是屏上唯一的置顶窗，切去别的应用还会盖在人家上面，
/// 而且 alt-tab 里找不到它（用户反馈"很奇怪"的一部分）。
fn apply_topmost_for_origin(window: &tauri::Window, origin: &str) {
    let with_popup = origin == "popup";
    let _ = window.set_always_on_top(with_popup);
    let _ = window.set_skip_taskbar(with_popup);
}

/// Create the AI window (hidden, frameless — the in-page head is the title
/// bar), dock it to `owner_label`, then show it. The frontend page it loads
/// attaches the site webview itself once mounted.
fn create_ai_window(app: &tauri::AppHandle, owner_label: &str) -> Result<(), String> {
    log::info!("[ai] creating the dedicated ai window");
    // The returned handle is intentionally dropped: windows are owned by the
    // app, and every window-level op below goes through `get_window` (shared
    // with the dock watcher, which only ever sees the Window handle).
    let _ai_window = tauri::WebviewWindowBuilder::new(
        app,
        AI_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("闪记 · AI 助手")
    .visible(false)
    // Rough size only: the dock rect needs the window's own invisible margin to
    // be measurable, so it is computed right after the build (below) and the
    // window is placed before it is ever shown.
    .inner_size(sidebar_width(app), AI_WINDOW_HEIGHT)
    .min_inner_size(320.0, 420.0)
    .resizable(true)
    .focused(false)
    // Frameless so the docked pair reads as one window; the page's head bar
    // carries the drag region. Topmost to stay next to the always-on-top
    // review popup; skip-taskbar + no minimize so it can never become an
    // unreachable minimized ghost (the 2026-10-05 popup trap).
    .decorations(false)
    // No shadow: a docked panel should read as part of the card window, and the
    // DWM shadow margin is exactly what paints a soft dark band over the card
    // area (the "缝" the user saw on 2026-10-10). The page draws its own 1px
    // divider instead.
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .minimizable(false)
    .maximizable(false)
    .build()
    .map_err(|e| e.to_string())?;
    // Window-level ops go through the Window handle (the builder returns a
    // WebviewWindow, and place_at_dock is shared with the watcher).
    if let Some(window) = app.get_window(AI_WINDOW_LABEL) {
        place_at_dock(app, &window, dock_rect(app, owner_label));
        apply_topmost_for_origin(&window, owner_label);
        let _ = window.show();
        let _ = window.unminimize();
        if owner_label != "popup" {
            let _ = window.set_focus();
        }
    }
    Ok(())
}

/// Attach (or re-anchor) the AI site webview inside the AI window. Called by
/// the page rendered in that window, which owns the layout slot rect.
/// When the child already sits on the same site we deliberately do NOT
/// navigate: the conversation page must survive hide/show cycles.
#[tauri::command]
pub async fn ai_window_attach(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    force: Option<bool>,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    app.get_window(AI_WINDOW_LABEL).ok_or("AI 窗口尚未创建")?;
    if let Some(webview) = app.get_webview(SIDEBAR_LABEL) {
        // Same site → keep the page (and the conversation) exactly as it is…
        // unless the user explicitly typed this URL (网址栏「打开」)：同源不同
        // 路径也必须真的导航，否则点了「打开」纹丝不动还清了报错。
        let explicit = force.unwrap_or(false);
        if webview
            .url()
            .map(|u| explicit || u.origin() != parsed.origin())
            .unwrap_or(true)
        {
            webview.navigate(parsed).map_err(|e| e.to_string())?;
        }
        webview
            .set_bounds(rect(x, y, w, h))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // First attach after a launch: a remembered conversation URL on the same
    // site jumps straight back into the last chat.
    let target = app
        .try_state::<std::sync::Mutex<crate::db::Db>>()
        .and_then(|cell| {
            let db = cell.lock().unwrap_or_else(crate::recover_lock);
            db.get_setting(LAST_URL_KEY).ok().flatten()
        })
        .and_then(|saved| saved.parse::<tauri::Url>().ok())
        .filter(|saved| saved.origin() == parsed.origin())
        .unwrap_or(parsed);
    let mut builder = tauri::WebviewBuilder::new(SIDEBAR_LABEL, WebviewUrl::External(target));
    if let Some(dir) = sidebar_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }
    let window = app.get_window(AI_WINDOW_LABEL).ok_or("AI 窗口尚未创建")?;
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ai_window_resize(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(SIDEBAR_LABEL) {
        webview
            .set_bounds(rect(x, y, w, h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remember the site webview's current URL (best effort) so a restart can
/// jump back into the conversation.
fn save_last_url(app: &tauri::AppHandle) {
    if let Some(webview) = app.get_webview(SIDEBAR_LABEL) {
        if let Ok(url) = webview.url() {
            if let Some(cell) = app.try_state::<std::sync::Mutex<crate::db::Db>>() {
                let db = cell.lock().unwrap_or_else(crate::recover_lock);
                let _ = db.set_setting(LAST_URL_KEY, url.as_str());
            }
        }
    }
}

/// Hide (never destroy) the AI window: the site page keeps running, so the
/// conversation is still there on the next show. The current chat URL is
/// saved for the after-restart case.
#[tauri::command]
pub async fn ai_window_hide(app: tauri::AppHandle) -> Result<(), String> {
    save_last_url(&app);
    if let Some(window) = app.get_window(AI_WINDOW_LABEL) {
        match window.hide() {
            Ok(()) => log::info!("[ai] ai window hidden"),
            Err(e) => log::error!("[ai] ai window hide failed: {e}"),
        }
    } else {
        log::warn!("[ai] ai_window_hide: window not found");
    }
    // A hide the USER did must not be undone by the dock watcher when the
    // owner window becomes visible again.
    if let Some(dock) = app.try_state::<AiDock>() {
        if let Ok(mut hidden) = dock.auto_hidden.lock() {
            *hidden = false;
        }
    }
    Ok(())
}

/// Background loop that keeps the AI window docked to its owner: follows the
/// owner's moves and resizes (so the pair reads as one window), hides along
/// when the owner hides (review session ends, main goes to tray, popup
/// yields for jump-to-edit), and brings it back when the owner returns.
/// Everything here dispatches to the main thread WITHOUT holding the DB
/// lock for the window calls — same rule as the engine tick (deadlock fix
/// 2026-10-05).
pub fn spawn_dock_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let Some(dock) = app.try_state::<AiDock>() else {
            continue;
        };
        let owner_label = match dock.owner.lock() {
            Ok(owner) => match owner.as_deref() {
                Some(label) => label.to_string(),
                None => continue,
            },
            Err(_) => continue,
        };
        let Some(ai) = app.get_window(AI_WINDOW_LABEL) else {
            continue;
        };
        let Some(owner) = app.get_window(&owner_label) else {
            continue;
        };
        let owner_visible =
            owner.is_visible().unwrap_or(false) && !owner.is_minimized().unwrap_or(false);
        let ai_visible = ai.is_visible().unwrap_or(false);
        if !owner_visible {
            if ai_visible {
                save_last_url(&app);
                let _ = ai.hide();
                if let Ok(mut hidden) = dock.auto_hidden.lock() {
                    *hidden = true;
                }
                log::info!("[ai] owner hidden — docking the ai window away");
            }
            continue;
        }
        if !ai_visible {
            let auto_hidden = dock.auto_hidden.lock().map(|h| *h).unwrap_or(false);
            if auto_hidden {
                // The owner is back (popup resumed after jump-to-edit etc.):
                // undo our own hide, but never resurrect a user- hidden panel.
                place_at_dock(&app, &ai, dock_rect(&app, &owner_label));
                let _ = ai.show();
                let _ = ai.unminimize();
                if let Ok(mut hidden) = dock.auto_hidden.lock() {
                    *hidden = false;
                }
                log::info!("[ai] owner back — ai window restored to the dock");
            }
            continue;
        }
        // Both visible: follow the owner only when its geometry actually
        // changed — otherwise the user's own AI-window drags would be fought.
        let geo = match (owner.outer_position(), owner.outer_size()) {
            (Ok(p), Ok(s)) => (p.x, p.y, s.width, s.height),
            _ => continue,
        };
        let changed = dock
            .last_owner_geometry
            .lock()
            .map(|last| last.map(|g| g != geo).unwrap_or(true))
            .unwrap_or(false);
        if changed {
            place_at_dock(&app, &ai, dock_rect(&app, &owner_label));
            if let Ok(mut last) = dock.last_owner_geometry.lock() {
                *last = Some(geo);
            }
            continue;
        }
        // The owner is still: any size change of the panel is the user dragging
        // an edge. Remember that width (2026-10-10 用户反馈：拖完边缘后主窗口
        // 一动，面板又被重置回设置里的旧宽度), and once the drag has settled
        // re-dock so the panel sits flush again with the remembered width.
        let applied = dock.last_applied.lock().ok().and_then(|r| *r);
        let (Some(applied), Some(current)) = (applied, panel_visible_rect(&ai)) else {
            continue;
        };
        let seen = dock.width_seen.lock().ok().and_then(|s| *s);
        let (next_seen, settled) = settle_manual_width(seen, applied.w, current.w);
        if let Ok(mut slot) = dock.width_seen.lock() {
            *slot = next_seen;
        }
        if let Some(physical) = settled {
            let scale = owner.scale_factor().unwrap_or(1.0);
            let logical = logical_width_from_pixels(physical, scale);
            save_sidebar_width(&app, logical);
            place_at_dock(&app, &ai, dock_rect(&app, &owner_label));
            log::info!("[ai] remembered the manually dragged width: {logical:.0}px");
        }
    });
}

/// Best-effort script that types `text` into the AI site's chat input once it
/// shows up (the site may still be loading when the window has just opened).
/// Input discovery: the last visible textarea / contenteditable in the main
/// document, then same-origin iframes — chat inputs sit at the bottom, which
/// makes "last" the right heuristic for DeepSeek/Kimi/豆包/ChatGPT alike.
/// The frontend always copies the question to the clipboard first, so when a
/// site uses a custom editor this script misses, Ctrl+V still works.
pub fn fill_script(text: &str) -> String {
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    r#"(() => {
  const text = __FLASHMEMO_TEXT__;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 20;
  };
  const scan = (doc) => {
    const els = [...doc.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible);
    return els.length ? els[els.length - 1] : null;
  };
  const find = () => {
    const direct = scan(document);
    if (direct) return direct;
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (!frame.contentDocument) continue;
        const el = scan(frame.contentDocument);
        if (el) return el;
      } catch (e) { /* cross-origin */ }
    }
    return null;
  };
  const fill = (el) => {
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      try { el.selectionStart = el.selectionEnd = text.length; } catch (e) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ProseMirror/Draft 类编辑器（ChatGPT/豆包）不认裸 textContent 赋值：
      // 内部状态不同步、多行被挤成一行。execCommand('insertText') 走浏览器
      // 编辑管线，编辑器自己收到 isTrusted 的 input 事件，多行原样保留。
      el.focus();
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('insertText', false, text);
      } catch (e) { ok = false; }
      if (!ok) el.textContent = text;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    el.focus();
  };
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const el = find();
    if (el) { clearInterval(timer); fill(el); return; }
    if (tries >= 24) clearInterval(timer);
  }, 350);
})();
"#
    .replace("__FLASHMEMO_TEXT__", &literal)
}

/// 把问题写进 AI 站点的输入框（SPEC §10.1）：best-effort —— 各站点编辑器结构
/// 不同，找不到就静默放弃，前端以剪贴板 + Ctrl+V 兜底。
#[tauri::command]
pub fn ai_fill_question(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let webview = app.get_webview(SIDEBAR_LABEL).ok_or("AI 窗口尚未打开")?;
    webview
        .eval(fill_script(&text).as_str())
        .map_err(|e| format!("注入失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        dock_visible_rect, dock_window_position, fill_script, logical_width_from_pixels,
        settle_manual_width, FrameInsets, PhysRect,
    };

    /// 2560×1400 的工作区，主窗口可见区域随便定一个。
    const WORK: PhysRect = PhysRect {
        x: 0,
        y: 0,
        w: 2560,
        h: 1400,
    };

    #[test]
    fn embeds_text_as_a_js_string_literal() {
        let js = fill_script("a\"b\\c\n新行");
        // serde_json 转义后的字面量必须原样出现在脚本里，注入才不会碎。
        assert!(js.contains(r#""a\"b\\c\n新行""#));
        assert!(!js.contains("__FLASHMEMO_TEXT__"));
    }

    #[test]
    fn docks_flush_against_the_owners_visible_right_edge() {
        let owner = PhysRect {
            x: 100,
            y: 40,
            w: 900,
            h: 700,
        };
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        // x 就是拥有者的可见右边缘：中间不留任何像素（这是这条 bug 的全部）。
        assert_eq!(docked.x, owner.right());
        // 顶边对齐、可见高度一致，两扇窗才像一个整体。
        assert_eq!(docked.y, owner.y);
        assert_eq!(docked.h, owner.h);
        assert_eq!(docked.w, 500);
    }

    #[test]
    fn mirrors_to_the_owners_left_edge_when_the_right_side_is_full() {
        let owner = PhysRect {
            x: 2000,
            y: 0,
            w: 500,
            h: 800,
        };
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        assert_eq!(docked.x, owner.x - 500);
        assert_eq!(docked.right(), owner.x);
    }

    #[test]
    fn clamps_inside_the_work_area_when_neither_side_fits() {
        let owner = PhysRect {
            x: 0,
            y: 0,
            w: WORK.w, // 主窗口铺满整个工作区：两边都放不下
            h: 2000,   // 还比工作区高
        };
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        // 收缩到保底 240 而不是 500 宽压在卡面上（几何退化时的钳制路径）。
        assert_eq!(docked.w, 240);
        assert_eq!(docked.x, WORK.right() - 240);
        assert_eq!(docked.h, WORK.h);
        assert!(docked.bottom() <= WORK.bottom());
    }

    #[test]
    fn shrinks_to_the_wider_side_instead_of_covering_the_card() {
        // 右侧剩 360、左侧剩 300，请求 500：两侧都不够 → 收成 360 贴右缘，
        // 面板绝不压在卡面上（旧实现会钳成 500 宽直接盖上去）。
        let owner = PhysRect {
            x: 300,
            y: 0,
            w: 1900,
            h: 800,
        };
        assert_eq!(owner.right(), 2200);
        assert_eq!(WORK.right() - owner.right(), 360, "预置条件：右侧 360");
        assert_eq!(owner.x - WORK.x, 300, "预置条件：左侧 300");
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        assert_eq!(docked.w, 360, "两侧都不够请求宽 → 收缩到较大一侧");
        assert_eq!(docked.x, owner.right());
    }

    #[test]
    fn keeps_the_full_width_when_one_side_fits() {
        // 右侧充足：请求宽原样保留（回归保护：收缩逻辑不许误伤常态）。
        let owner = PhysRect {
            x: 100,
            y: 40,
            w: 900,
            h: 700,
        };
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        assert_eq!(docked.w, 500);
        assert_eq!(docked.x, owner.right());
    }

    #[test]
    fn keeps_the_minimum_height_for_a_tiny_owner() {
        let owner = PhysRect {
            x: 0,
            y: 100,
            w: 800,
            h: 200,
        };
        let docked = dock_visible_rect(owner, WORK, 500, 420);
        assert_eq!(docked.h, 420);
    }

    #[test]
    fn subtracts_only_the_panels_own_invisible_margin_when_placing() {
        // place_at_dock 的换算：定位要减掉 AI 窗口自己的不可见边距（左上），
        // 尺寸走 client（= 可见尺寸）所以不用补。
        let visible = PhysRect {
            x: 1000,
            y: 40,
            w: 500,
            h: 700,
        };
        let insets = FrameInsets { left: 8, top: 2 };
        assert_eq!(dock_window_position(visible, insets), (992, 38));
    }

    #[test]
    fn remembers_a_manual_width_only_once_the_drag_settles() {
        // 拖动中：每个 tick 都读出新的宽度，此时落库等于把一串中间值写进设置。
        let (seen, settled) = settle_manual_width(None, 630, 640);
        assert_eq!((seen, settled), (Some(640), None));
        let (seen, settled) = settle_manual_width(seen, 630, 660);
        assert_eq!((seen, settled), (Some(660), None));
        // 松手：连续两次读到同一个宽度 → 这一次才值得记住。
        let (seen, settled) = settle_manual_width(seen, 630, 660);
        assert_eq!((seen, settled), (Some(660), Some(660)));
    }

    #[test]
    fn ignores_the_width_the_dock_itself_just_applied() {
        // 停靠程序刚把面板设成 630：它还是 630 说明没人碰过，绝不能落库。
        assert_eq!(settle_manual_width(Some(630), 630, 630), (None, None));
        // 重新贴合后那点取整误差（±2px）也不算用户拖动。
        assert_eq!(settle_manual_width(Some(631), 630, 631), (None, None));
    }

    #[test]
    fn clamps_a_manual_width_into_the_dock_range() {
        assert_eq!(logical_width_from_pixels(750, 1.5), 500.0); // 150% 缩放下的常用宽度
        assert_eq!(logical_width_from_pixels(4000, 1.5), 720.0); // 拖太宽 → 上限
        assert_eq!(logical_width_from_pixels(300, 1.5), 320.0); // 拖太窄 → 下限
    }
}
