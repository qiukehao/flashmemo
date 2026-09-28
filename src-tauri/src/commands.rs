//! Tauri command layer: thin invoke wrappers that lock the managed database
//! and delegate to `services`. No business logic lives here.

use crate::db::Db;
use crate::import::ImportReport;
use crate::services::{self, CardDto, DeckOverview, ImportFile, ImportPreview};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

type DbState<'a> = State<'a, Mutex<Db>>;

fn lock<'a>(db: &'a DbState<'a>) -> std::sync::MutexGuard<'a, Db> {
    db.lock().expect("db mutex poisoned")
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
pub fn preview_intervals(card_id: i64, db: DbState) -> Result<Vec<Option<f64>>, String> {
    services::preview_intervals(&lock(&db), card_id)
}

#[tauri::command]
pub fn due_count(db: DbState) -> Result<i64, String> {
    services::due_count(&lock(&db))
}

#[tauri::command]
pub fn get_settings(db: DbState) -> Result<HashMap<String, String>, String> {
    Ok(services::list_settings(&lock(&db))?.into_iter().collect())
}

#[tauri::command]
pub fn set_settings(map: HashMap<String, String>, db: DbState) -> Result<(), String> {
    services::set_settings(&lock(&db), &map.into_iter().collect::<Vec<_>>())
}
