//! Review scheduling per SPEC §7: minute-level learning steps owned by this
//! module, FSRS-6 (via the `fsrs` crate) owns graduated-card intervals and
//! memory states (S/D). All intervals crossing the boundary are minutes (f64).

use chrono::{DateTime, Duration, Utc};
use fsrs::{MemoryState, FSRS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rating {
    Again,
    Hard,
    Good,
    Easy,
}

/// Typed card state; the DB layer keeps raw strings, services convert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardState {
    New,
    Learning,
    Review,
    Relearning,
}

#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    /// Minute-level learning/relearning steps, SPEC §7.2 default 1m/5m/10m.
    pub steps_min: Vec<u32>,
    pub retention: f32,
    pub skip_delay_min: u32,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        ScheduleConfig {
            steps_min: vec![1, 5, 10],
            retention: 0.90,
            skip_delay_min: 30,
        }
    }
}

/// Scheduler-facing projection of a card (from `db::Card`).
#[derive(Debug, Clone)]
pub struct CardSched {
    pub state: CardState,
    pub stability: Option<f32>,
    pub difficulty: Option<f32>,
    pub learning_step: usize,
    pub last_review_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ScheduleOutcome {
    pub state: CardState,
    pub stability: Option<f32>,
    pub difficulty: Option<f32>,
    pub learning_step: usize,
    pub due_at: DateTime<Utc>,
}

fn minutes(days: f32) -> i64 {
    // Fractional FSRS days -> whole minutes, at least one.
    ((days * 1440.0).round() as i64).max(1)
}

fn memory_state(card: &CardSched) -> Option<MemoryState> {
    Some(MemoryState {
        stability: card.stability?,
        difficulty: card.difficulty?,
    })
}

fn step_due(steps: &[u32], idx: usize, now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::minutes(steps[idx.min(steps.len() - 1)] as i64)
}

fn outcome(
    state: CardState,
    learning_step: usize,
    now: DateTime<Utc>,
    memory: Option<MemoryState>,
    due_at: DateTime<Utc>,
) -> ScheduleOutcome {
    ScheduleOutcome {
        state,
        learning_step,
        stability: memory.map(|m| m.stability),
        difficulty: memory.map(|m| m.difficulty),
        due_at,
    }
}

/// Days since the last review, floored — `next_states` works in whole days.
fn elapsed_days(card: &CardSched, now: DateTime<Utc>) -> u32 {
    card.last_review_at
        .map(|t| ((now - t).num_seconds() as f32 / 86_400.0).floor().max(0.0) as u32)
        .unwrap_or(0)
}

/// Graduated-card scheduling: FSRS-6 decides interval and the new S/D.
fn fsrs_outcome(
    card: &CardSched,
    rating: Rating,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
    days_elapsed: u32,
) -> fsrs::Result<ScheduleOutcome> {
    let fsrs = FSRS::new(&[])?;
    let states = fsrs.next_states(memory_state(card), cfg.retention, days_elapsed)?;
    let item = match rating {
        Rating::Again => &states.again,
        Rating::Hard => &states.hard,
        Rating::Good => &states.good,
        Rating::Easy => &states.easy,
    };
    Ok(outcome(
        CardState::Review,
        0,
        now,
        Some(item.memory),
        now + Duration::minutes(minutes(item.interval)),
    ))
}

pub fn review(
    card: &CardSched,
    rating: Rating,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
) -> fsrs::Result<ScheduleOutcome> {
    let steps = &cfg.steps_min;
    let last = steps.len().saturating_sub(1);
    match card.state {
        CardState::Review => match rating {
            // SPEC §7.3: lapse -> relearn steps, stability drops via FSRS Again.
            Rating::Again => {
                let fsrs = FSRS::new(&[])?;
                let states =
                    fsrs.next_states(memory_state(card), cfg.retention, elapsed_days(card, now))?;
                Ok(outcome(
                    CardState::Relearning,
                    0,
                    now,
                    Some(states.again.memory),
                    step_due(steps, 0, now),
                ))
            }
            _ => fsrs_outcome(card, rating, now, cfg, elapsed_days(card, now)),
        },
        // New / Learning / Relearning walk the minute-level steps (SPEC §7.2).
        _ => match rating {
            Rating::Again => Ok(outcome(
                if card.state == CardState::Relearning {
                    CardState::Relearning
                } else {
                    CardState::Learning
                },
                0,
                now,
                memory_state(card),
                step_due(steps, 0, now),
            )),
            Rating::Hard => {
                // First rating on a new card: Hard counts as entering step 2.
                let idx = if card.state == CardState::New {
                    1.min(last)
                } else {
                    card.learning_step.min(last)
                };
                Ok(outcome(
                    CardState::Learning,
                    idx,
                    now,
                    memory_state(card),
                    step_due(steps, idx, now),
                ))
            }
            Rating::Good => {
                if card.learning_step >= last {
                    fsrs_outcome(card, Rating::Good, now, cfg, 0)
                } else {
                    let idx = card.learning_step + 1;
                    Ok(outcome(
                        CardState::Learning,
                        idx,
                        now,
                        memory_state(card),
                        step_due(steps, idx, now),
                    ))
                }
            }
            Rating::Easy => fsrs_outcome(card, Rating::Easy, now, cfg, 0),
        },
    }
}

pub fn skip(card: &CardSched, now: DateTime<Utc>, cfg: &ScheduleConfig) -> DateTime<Utc> {
    now + Duration::minutes(cfg.skip_delay_min as i64)
}

pub fn preview(
    card: &CardSched,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
) -> fsrs::Result<[Option<f64>; 4]> {
    let steps = &cfg.steps_min;
    let last = steps.len().saturating_sub(1);
    let m = |min: i64| Some(min as f64);
    if card.state == CardState::Review {
        let fsrs = FSRS::new(&[])?;
        let states =
            fsrs.next_states(memory_state(card), cfg.retention, elapsed_days(card, now))?;
        return Ok([
            m(steps[0] as i64),
            Some(minutes(states.hard.interval) as f64),
            Some(minutes(states.good.interval) as f64),
            Some(minutes(states.easy.interval) as f64),
        ]);
    }
    // Learning-phase previews (SPEC §7.5).
    let again = steps[0] as i64;
    let hard = if card.state == CardState::New {
        steps[1.min(last)] as i64
    } else {
        steps[card.learning_step.min(last)] as i64
    };
    let good = if card.learning_step >= last {
        // Graduation preview: ask FSRS for the Good interval.
        let fsrs = FSRS::new(&[])?;
        Some(minutes(
            fsrs.next_states(memory_state(card), cfg.retention, 0)?
                .good
                .interval,
        ) as f64)
    } else {
        Some(steps[card.learning_step + 1] as f64)
    };
    let fsrs = FSRS::new(&[])?;
    let easy = minutes(
        fsrs.next_states(memory_state(card), cfg.retention, 0)?
            .easy
            .interval,
    ) as f64;
    Ok([m(again), m(hard), good, Some(easy)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ScheduleConfig {
        ScheduleConfig::default()
    }

    fn new_card() -> CardSched {
        CardSched {
            state: CardState::New,
            stability: None,
            difficulty: None,
            learning_step: 0,
            last_review_at: None,
        }
    }

    fn days(out: &ScheduleOutcome, now: DateTime<Utc>) -> f64 {
        (out.due_at - now).num_seconds() as f64 / 86_400.0
    }

    #[test]
    fn new_again_goes_step0_1min() {
        let now = Utc::now();
        let out = review(&new_card(), Rating::Again, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Learning);
        assert_eq!(out.learning_step, 0);
        assert_eq!((out.due_at - now).num_minutes(), 1);
    }

    #[test]
    fn new_hard_enters_step2() {
        let now = Utc::now();
        let out = review(&new_card(), Rating::Hard, now, &cfg()).unwrap();
        assert_eq!(out.learning_step, 1);
        assert_eq!((out.due_at - now).num_minutes(), 5);
        assert_eq!(out.state, CardState::Learning);
    }

    #[test]
    fn learning_hard_stays_put() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Learning,
            learning_step: 2,
            ..new_card()
        };
        let out = review(&card, Rating::Hard, now, &cfg()).unwrap();
        assert_eq!(out.learning_step, 2);
        assert_eq!((out.due_at - now).num_minutes(), 10);
    }

    #[test]
    fn learning_good_advances() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Learning,
            learning_step: 0,
            ..new_card()
        };
        let out = review(&card, Rating::Good, now, &cfg()).unwrap();
        assert_eq!(out.learning_step, 1);
        assert_eq!((out.due_at - now).num_minutes(), 5);
        assert_eq!(out.state, CardState::Learning);
    }

    #[test]
    fn good_on_last_step_graduates() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Learning,
            learning_step: 2, // last of [1,5,10]
            ..new_card()
        };
        let out = review(&card, Rating::Good, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Review);
        assert!(out.stability.is_some());
        let d = days(&out, now);
        assert!(
            d >= 1.0 && d <= 7.0,
            "graduation interval {d} not in 1..=7d"
        );
    }

    #[test]
    fn new_easy_graduates() {
        let now = Utc::now();
        let out = review(&new_card(), Rating::Easy, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Review);
        let d = days(&out, now);
        assert!(d >= 2.0 && d <= 20.0, "easy graduation {d} not in 2..=20d");
    }

    #[test]
    fn review_again_enters_relearning() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Review,
            stability: Some(5.0),
            difficulty: Some(4.0),
            learning_step: 0,
            last_review_at: Some(now - Duration::days(5)),
        };
        let out = review(&card, Rating::Again, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Relearning);
        assert_eq!(out.learning_step, 0);
        assert_eq!((out.due_at - now).num_minutes(), 1);
        // SPEC §7.3: a lapse must drop stability substantially.
        assert!(out.stability.unwrap() < 5.0);
    }

    #[test]
    fn relearning_good_graduates_back_to_review() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Relearning,
            stability: Some(0.4),
            difficulty: Some(6.0),
            learning_step: 2,
            last_review_at: Some(now - Duration::minutes(30)),
        };
        let out = review(&card, Rating::Good, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Review);
        assert!(out.due_at > now, "graduation due must be in the future");
        assert!(out.stability.is_some());
    }

    #[test]
    fn review_good_schedules_by_fsrs() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Review,
            stability: Some(3.0),
            difficulty: Some(5.0),
            learning_step: 0,
            last_review_at: Some(now - Duration::days(3)),
        };
        let out = review(&card, Rating::Good, now, &cfg()).unwrap();
        assert_eq!(out.state, CardState::Review);
        let d = days(&out, now);
        assert!(d > 1.0, "review Good interval {d} should exceed a day");
        assert!(out.due_at > now);
    }

    #[test]
    fn skip_adds_30min_and_keeps_state() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Review,
            stability: Some(5.0),
            difficulty: Some(4.0),
            learning_step: 0,
            last_review_at: Some(now - Duration::days(5)),
        };
        let due = skip(&card, now, &cfg());
        assert_eq!((due - now).num_minutes(), 30);
    }

    #[test]
    fn preview_learning_shows_minute_steps() {
        let now = Utc::now();
        let p = preview(&new_card(), now, &cfg()).unwrap();
        assert_eq!(p[0], Some(1.0), "again preview = first step");
        assert_eq!(p[1], Some(5.0), "hard preview = step 2 for a new card");
        assert_eq!(p[2], Some(5.0), "good preview = next step");
        let easy = p[3].unwrap();
        assert!(easy > 1000.0, "easy preview should be days-scale minutes");
    }

    #[test]
    fn preview_graduated_returns_four_intervals() {
        let now = Utc::now();
        let card = CardSched {
            state: CardState::Review,
            stability: Some(5.0),
            difficulty: Some(5.0),
            learning_step: 0,
            last_review_at: Some(now - Duration::days(4)),
        };
        let p = preview(&card, now, &cfg()).unwrap();
        assert_eq!(p[0], Some(1.0), "again preview = relearn first step");
        assert!(
            p[1].unwrap() < p[2].unwrap(),
            "hard interval < good interval"
        );
        assert!(
            p[2].unwrap() < p[3].unwrap(),
            "good interval < easy interval"
        );
    }
}
