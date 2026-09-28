//! Review scheduling: fixed-multiplier rules with a Familiar cap.
//!
//! Redesigned 2026-09-28 (replaces FSRS; design reviewed externally, see
//! docs/plans/2026-09-28-scheduling-redesign-prompt.md):
//! - Three self-ratings for spoken recall: Unknown / Familiar / Speakable.
//! - Unknown → short interval (or daily once the attention threshold is hit).
//! - Familiar → grows ×1.5 but is capped at the Familiar ceiling.
//! - Speakable → grows ×2.5 up to the global maximum.
//!
//! All intervals are minutes; day-scale intervals are whole days.

use chrono::{DateTime, Duration, Utc};

const DAY_MIN: u32 = 1440;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rating {
    /// 不了解 — could not recall the main points before revealing the answer.
    Unknown,
    /// 熟悉 — recalled the points but could not organize a full answer.
    Familiar,
    /// 可以讲出来 — could deliver the answer unaided.
    Speakable,
}

#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    pub min_interval_min: u32,
    pub initial_interval_min: u32,
    pub familiar_mult: f64,
    pub speak_mult: f64,
    pub familiar_cap_min: u32,
    pub max_interval_min: u32,
    pub attention_threshold: u32,
    pub attention_interval_min: u32,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        ScheduleConfig {
            min_interval_min: 120,      // 2h
            initial_interval_min: 1440, // 1d
            familiar_mult: 1.5,
            speak_mult: 2.5,
            familiar_cap_min: 10080, // 7d
            max_interval_min: 86400, // 60d
            attention_threshold: 3,
            attention_interval_min: 1440, // 1d
        }
    }
}

/// Scheduler-facing projection of a card. `interval_min: None` means the card
/// has never been scheduled (new card).
#[derive(Debug, Clone)]
pub struct CardSched {
    pub interval_min: Option<u32>,
    pub unknown_streak: u32,
    pub speak_streak: u32,
    pub needs_attention: bool,
}

#[derive(Debug, Clone)]
pub struct ScheduleOutcome {
    pub interval_min: u32,
    pub due_at: DateTime<Utc>,
    pub unknown_streak: u32,
    pub speak_streak: u32,
    pub needs_attention: bool,
}

/// Round up: below a day to whole hours, a day or more to whole days.
fn round_up(minutes: f64) -> u32 {
    if minutes < DAY_MIN as f64 {
        ((minutes / 60.0).ceil() as u32) * 60
    } else {
        ((minutes / DAY_MIN as f64).ceil() as u32) * DAY_MIN
    }
}

/// Interval + counter updates for one rating, without a due date (so `preview`
/// and `review` share the exact same rules).
fn next_interval(card: &CardSched, rating: Rating, cfg: &ScheduleConfig) -> (u32, u32, u32, bool) {
    let mut unknown_streak = card.unknown_streak;
    let mut speak_streak = card.speak_streak;
    let mut needs_attention = card.needs_attention;

    let raw: f64 = match rating {
        Rating::Unknown => {
            unknown_streak += 1;
            speak_streak = 0;
            if unknown_streak >= cfg.attention_threshold {
                // Not a memory problem to be fixed by popups: slow down to
                // daily and surface the card as "needs deliberate re-learning".
                needs_attention = true;
                cfg.attention_interval_min as f64
            } else {
                cfg.min_interval_min as f64
            }
        }
        Rating::Familiar => {
            unknown_streak = 0;
            speak_streak = 0;
            // Familiar does NOT clear the attention flag (design §1 note).
            match card.interval_min {
                None => cfg.initial_interval_min as f64,
                Some(i) => (i as f64 * cfg.familiar_mult)
                    .min(cfg.familiar_cap_min as f64)
                    .max(cfg.initial_interval_min as f64),
            }
        }
        Rating::Speakable => {
            unknown_streak = 0;
            speak_streak += 1;
            needs_attention = false;
            match card.interval_min {
                None => cfg.initial_interval_min as f64,
                Some(i) => (i as f64 * cfg.speak_mult).max(cfg.initial_interval_min as f64),
            }
        }
    };

    let mut interval = round_up(raw).clamp(cfg.min_interval_min, cfg.max_interval_min);
    if rating == Rating::Familiar {
        // The Familiar ceiling overrides the generic max.
        interval = interval.min(cfg.familiar_cap_min);
    }
    interval = interval.max(cfg.min_interval_min);
    (interval, unknown_streak, speak_streak, needs_attention)
}

pub fn review(
    card: &CardSched,
    rating: Rating,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
) -> ScheduleOutcome {
    let (interval_min, unknown_streak, speak_streak, needs_attention) =
        next_interval(card, rating, cfg);
    ScheduleOutcome {
        interval_min,
        due_at: now + Duration::minutes(interval_min as i64),
        unknown_streak,
        speak_streak,
        needs_attention,
    }
}

/// Planned interval in minutes per [Unknown, Familiar, Speakable].
pub fn preview(card: &CardSched, cfg: &ScheduleConfig) -> [u32; 3] {
    [
        next_interval(card, Rating::Unknown, cfg).0,
        next_interval(card, Rating::Familiar, cfg).0,
        next_interval(card, Rating::Speakable, cfg).0,
    ]
}

/// SPEC §7.1: skipping rates nothing — the card re-enters the queue later with
/// every field untouched.
pub fn skip(now: DateTime<Utc>, skip_delay_min: u32) -> DateTime<Utc> {
    now + Duration::minutes(skip_delay_min as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ScheduleConfig {
        ScheduleConfig::default()
    }

    fn new_card() -> CardSched {
        CardSched {
            interval_min: None,
            unknown_streak: 0,
            speak_streak: 0,
            needs_attention: false,
        }
    }

    fn card_at(interval_min: u32) -> CardSched {
        CardSched {
            interval_min: Some(interval_min),
            ..new_card()
        }
    }

    #[test]
    fn new_card_rules_match_design_table() {
        let now = Utc::now();
        let c = cfg();
        let unknown = review(&new_card(), Rating::Unknown, now, &c);
        assert_eq!(unknown.interval_min, 120, "new + Unknown = 2h");
        assert_eq!(unknown.unknown_streak, 1);
        let familiar = review(&new_card(), Rating::Familiar, now, &c);
        assert_eq!(familiar.interval_min, 1440, "new + Familiar = 1d");
        let speakable = review(&new_card(), Rating::Speakable, now, &c);
        assert_eq!(
            speakable.interval_min, 1440,
            "new + Speakable = 1d (cross-day confirm)"
        );
        assert_eq!(speakable.speak_streak, 1);
    }

    #[test]
    fn unknown_streak_marks_attention_at_threshold() {
        let now = Utc::now();
        let c = cfg();
        let mut card = new_card();
        // 1st and 2nd Unknown: still the short interval.
        for streak in 1..=2u32 {
            let out = review(&card, Rating::Unknown, now, &c);
            assert_eq!(out.interval_min, 120, "streak {streak}");
            assert!(!out.needs_attention);
            card = CardSched {
                interval_min: Some(out.interval_min),
                unknown_streak: out.unknown_streak,
                speak_streak: out.speak_streak,
                needs_attention: out.needs_attention,
            };
        }
        // 3rd: switch to daily + attention flag, and stay there.
        let out = review(&card, Rating::Unknown, now, &c);
        assert_eq!(out.unknown_streak, 3);
        assert_eq!(out.interval_min, 1440, "3rd Unknown slows to 1d");
        assert!(out.needs_attention);
        let again = review(
            &CardSched {
                interval_min: Some(out.interval_min),
                unknown_streak: out.unknown_streak,
                speak_streak: out.speak_streak,
                needs_attention: out.needs_attention,
            },
            Rating::Unknown,
            now,
            &c,
        );
        assert_eq!(again.interval_min, 1440, "stays daily afterwards");
    }

    #[test]
    fn familiar_growth_is_capped() {
        let now = Utc::now();
        let c = cfg();
        // 1d → (1.5d→2d) → 3d → 5d → 7d (cap)
        let expected = [2 * DAY_MIN, 3 * DAY_MIN, 5 * DAY_MIN, 7 * DAY_MIN];
        let mut interval = DAY_MIN;
        for want in expected {
            let out = review(&card_at(interval), Rating::Familiar, now, &c);
            assert_eq!(out.interval_min, want, "from {interval} min");
            interval = out.interval_min;
        }
        // A long-interval card rated Familiar falls back to the cap.
        let out = review(&card_at(30 * DAY_MIN), Rating::Familiar, now, &c);
        assert_eq!(out.interval_min, 7 * DAY_MIN);
        // Familiar never clears the attention flag.
        let flagged = CardSched {
            needs_attention: true,
            ..card_at(DAY_MIN)
        };
        assert!(review(&flagged, Rating::Familiar, now, &c).needs_attention);
    }

    #[test]
    fn speakable_growth_reaches_max_and_clamps() {
        let now = Utc::now();
        let c = cfg();
        // 1d → 3d → 8d → 20d → 50d → 60d (clamp)
        let expected = [
            3 * DAY_MIN,
            8 * DAY_MIN,
            20 * DAY_MIN,
            50 * DAY_MIN,
            60 * DAY_MIN,
        ];
        let mut interval = DAY_MIN;
        for want in expected {
            let out = review(&card_at(interval), Rating::Speakable, now, &c);
            assert_eq!(out.interval_min, want, "from {interval} min");
            interval = out.interval_min;
        }
        // Already at max: stays at max.
        let out = review(&card_at(60 * DAY_MIN), Rating::Speakable, now, &c);
        assert_eq!(out.interval_min, 60 * DAY_MIN);
    }

    #[test]
    fn speakable_clears_attention_and_resets_unknown_streak() {
        let now = Utc::now();
        let c = cfg();
        let flagged = CardSched {
            interval_min: Some(DAY_MIN),
            unknown_streak: 3,
            speak_streak: 0,
            needs_attention: true,
        };
        let out = review(&flagged, Rating::Speakable, now, &c);
        assert!(!out.needs_attention);
        assert_eq!(out.unknown_streak, 0);
        assert_eq!(out.speak_streak, 1);
    }

    #[test]
    fn familiar_resets_streaks_both_ways() {
        let now = Utc::now();
        let c = cfg();
        let card = CardSched {
            interval_min: Some(DAY_MIN),
            unknown_streak: 2,
            speak_streak: 3,
            needs_attention: false,
        };
        let out = review(&card, Rating::Familiar, now, &c);
        assert_eq!((out.unknown_streak, out.speak_streak), (0, 0));
    }

    #[test]
    fn intervals_respect_configured_bounds() {
        let now = Utc::now();
        let mut c = cfg();
        c.min_interval_min = 30;
        // Familiar has a floor at the 1-day confirm interval (design formula).
        let out = review(&card_at(60), Rating::Familiar, now, &c);
        assert_eq!(
            out.interval_min, 1440,
            "Familiar never dips below the 1-day confirm interval"
        );
        // Custom tiny max clamps.
        c.max_interval_min = 200;
        let out = review(&card_at(DAY_MIN), Rating::Speakable, now, &c);
        assert_eq!(out.interval_min, 200);
    }

    #[test]
    fn preview_lists_three_intervals_and_never_panics() {
        let c = cfg();
        let p = preview(&new_card(), &c);
        assert_eq!(
            p,
            [120, 1440, 1440],
            "new card: unknown 2h, both positives 1d"
        );
        let p = preview(&card_at(DAY_MIN), &c);
        assert_eq!(p, [120, 2 * DAY_MIN, 3 * DAY_MIN]);
        // A card already on a 2-long Unknown streak previews the daily drop.
        let flagged = CardSched {
            interval_min: Some(DAY_MIN),
            unknown_streak: 2,
            speak_streak: 0,
            needs_attention: false,
        };
        assert_eq!(preview(&flagged, &c)[0], 1440);
    }

    #[test]
    fn skip_postpones_without_touching_the_card() {
        let now = Utc::now();
        let due = skip(now, 30);
        assert_eq!((due - now).num_minutes(), 30);
    }
}
