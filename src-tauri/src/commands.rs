//! Tauri command layer: thin invoke wrappers that lock the managed database
//! and delegate to `services`. No business logic lives here.

use crate::db::Db;
use crate::import::ImportReport;
use crate::services::{self, CardDto, DeckOverview, ImportFile, ImportPreview, ReviewSession};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, State};

type DbState<'a> = State<'a, Mutex<Db>>;
type SessionState<'a> = State<'a, ReviewSession>;

fn lock<'a>(db: &'a DbState<'a>) -> std::sync::MutexGuard<'a, Db> {
    db.lock().expect("db mutex poisoned")
}

/// Popup queue: a pending manual selection first, else the due queue.
#[tauri::command]
pub fn review_queue(
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<Vec<CardDto>, String> {
    let limit = app
        .try_state::<Mutex<Db>>()
        .and_then(|cell| {
            let guard = cell.lock().ok()?;
            guard
                .get_setting("per_popup")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
        })
        .unwrap_or(1);
    services::review_queue(&lock(&db), &session, limit)
}

/// Start a review session over explicit cards and open the popup at once.
#[tauri::command]
pub fn start_review(
    card_ids: Vec<i64>,
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let cards = {
        let guard = lock(&db);
        services::cards_by_ids(&guard, &card_ids)?
    };
    if cards.is_empty() {
        return Err("选中的卡片不存在".into());
    }
    let ids: Vec<i64> = cards.iter().map(|c| c.id).collect();
    let n = ids.len();
    services::set_review_session(&session, ids);
    if !crate::engine::open_review_popup(&app) {
        return Err("无法打开复习弹窗".into());
    }
    Ok(n)
}

#[tauri::command]
pub fn search_cards(
    query: Option<String>,
    deck: Option<String>,
    filter: Option<String>,
    db: DbState,
) -> Result<Vec<CardDto>, String> {
    services::search_cards(&lock(&db), query, deck, filter)
}

#[tauri::command]
pub fn import_markdown(
    files: Vec<ImportFile>,
    prefer_file: bool,
    db: DbState,
) -> Result<ImportReport, String> {
    services::import_markdown(&lock(&db), &files, prefer_file)
}

#[tauri::command]
pub fn preview_import(files: Vec<ImportFile>, db: DbState) -> Result<ImportPreview, String> {
    services::preview_import(&lock(&db), &files)
}

#[tauri::command]
pub fn add_card(
    deck: String,
    chapter: String,
    title: String,
    content_md: String,
    db: DbState,
) -> Result<CardDto, String> {
    services::add_card(&lock(&db), &deck, &chapter, &title, &content_md)
}

#[tauri::command]
pub fn list_overview(db: DbState) -> Result<Vec<DeckOverview>, String> {
    services::list_overview(&lock(&db))
}

#[tauri::command]
pub fn list_cards(deck: String, db: DbState) -> Result<Vec<CardDto>, String> {
    services::list_cards(&lock(&db), &deck)
}

#[tauri::command]
pub fn rename_deck(old_name: String, new_name: String, db: DbState) -> Result<(), String> {
    services::rename_deck(&lock(&db), &old_name, &new_name)
}

#[tauri::command]
pub fn delete_deck(name: String, db: DbState) -> Result<(), String> {
    services::delete_deck(&mut lock(&db), &name)
}

#[tauri::command]
pub fn delete_card(card_id: i64, db: DbState) -> Result<(), String> {
    services::delete_card(&lock(&db), card_id)
}

#[tauri::command]
pub fn update_card(
    card_id: i64,
    title: String,
    content_md: String,
    db: DbState,
) -> Result<CardDto, String> {
    services::update_card(&lock(&db), card_id, &title, &content_md)
}

#[tauri::command]
pub fn save_card_content(card_id: i64, content_md: String, db: DbState) -> Result<CardDto, String> {
    services::update_card_content(&lock(&db), card_id, &content_md)
}

#[tauri::command]
pub fn due_queue(limit: i64, db: DbState) -> Result<Vec<CardDto>, String> {
    services::due_queue(&lock(&db), limit)
}

#[tauri::command]
pub fn rate_card(card_id: i64, rating: String, db: DbState) -> Result<CardDto, String> {
    services::rate(&mut lock(&db), card_id, &rating)
}

#[tauri::command]
pub fn skip_card(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::skip_card(&lock(&db), card_id)
}

#[tauri::command]
pub fn preview_intervals(card_id: i64, db: DbState) -> Result<Vec<u64>, String> {
    services::preview_intervals(&lock(&db), card_id)
}

#[tauri::command]
pub fn mark_card_shown(card_id: i64, db: DbState) -> Result<(), String> {
    services::mark_shown(&lock(&db), card_id)
}

#[tauri::command]
pub fn due_count(db: DbState) -> Result<i64, String> {
    services::due_count(&lock(&db))
}

#[tauri::command]
pub fn get_stats(db: DbState) -> Result<services::StatsDto, String> {
    services::get_stats(&lock(&db))
}

#[tauri::command]
pub fn list_attention_cards(db: DbState) -> Result<Vec<CardDto>, String> {
    services::attention_cards(&lock(&db))
}

#[tauri::command]
pub fn clear_attention(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::clear_attention(&lock(&db), card_id)
}

#[tauri::command]
pub fn reset_card_progress(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::reset_progress(&lock(&db), card_id)
}

#[tauri::command]
pub fn restore_card(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::restore_card(&lock(&db), card_id)
}

#[tauri::command]
pub fn get_settings(db: DbState) -> Result<HashMap<String, String>, String> {
    Ok(services::list_settings(&lock(&db))?.into_iter().collect())
}

#[tauri::command]
pub fn set_settings(map: HashMap<String, String>, db: DbState) -> Result<(), String> {
    services::set_settings(&lock(&db), &map.into_iter().collect::<Vec<_>>())
}
