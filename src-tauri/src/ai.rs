//! AI 侧栏 (SPEC §10): an embedded *real* external webview in the main window.
//! iframes cannot be used (DeepSeek/豆包 etc. forbid embedding), so the sidebar
//! runs as a Tauri child webview with a persistent data directory for logins.

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Rect, Size, WebviewUrl};

pub const SIDEBAR_LABEL: &str = "ai-sidebar";

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

/// Open (or navigate + reposition) the sidebar webview on the main window.
#[tauri::command]
pub fn ai_sidebar_open(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    if let Some(webview) = app.get_webview(SIDEBAR_LABEL) {
        // Already alive: only re-navigate when the target actually changed.
        if webview
            .url()
            .map(|u| u.as_str() != parsed.as_str())
            .unwrap_or(true)
        {
            webview.navigate(parsed).map_err(|e| e.to_string())?;
        }
        webview
            .set_bounds(rect(x, y, w, h))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("主窗口不存在")?;
    let mut builder = tauri::WebviewBuilder::new(SIDEBAR_LABEL, WebviewUrl::External(parsed));
    if let Some(dir) = sidebar_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ai_sidebar_resize(
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

#[tauri::command]
pub fn ai_sidebar_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(SIDEBAR_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "问 AI" from the popup / card editor: surface the main window and ask the
/// frontend to expand the sidebar (SPEC §10.1).
#[tauri::command]
pub fn show_main_with_ai(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("ai-expand", ());
    }
    Ok(())
}
