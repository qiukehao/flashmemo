//! Review scheduling by "cards shown" instead of wall-clock time.
//!
//! Redesigned 2026-09-28 (2nd revision, replaces the fixed-multiplier rules;
//! external design review in docs/plans/2026-09-28-scheduling-redesign-prompt.md):
//! - A global display counter `review_seq` (total cards ever shown) drives
//!   eligibility: a card may reappear only after `next_eligible_seq` other
//!   cards have been shown — "隔 N 张卡后再见", not "N 小时后".
//! - A proficiency `level` (0..5) sets the base distance (3/5/10/20/50/100).
//! - Ratings move the level: Unknown −1 (min 1), Familiar ±0, Speakable +1 (max 5).
//! - Time survives only as an optional floor per rating (10min / 30min / 2h).
//!
//! Display itself (and thus `review_seq`) advances in `services::mark_shown`.

use chrono::{DateTime, Duration, Utc};

/// Levels 0..=5; index = level.
pub const LEVEL_GAPS: [u64; 6] = [3, 5, 10, 20, 50, 100];
pub const MAX_LEVEL: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rating {
    /// 不了解
    Unknown,
    /// 熟悉
    Familiar,
    /// 可以讲出来
    Speakable,
}

#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    pub gap_unknown: u64,
    pub gap_familiar: u64,
    pub gap_speakable: u64,
    pub attention_gap: u64,
    pub max_unknown_gap: u64,
    pub level_gap: [u64; 6],
    pub floor_unknown_min: u32,
    pub floor_familiar_min: u32,
    pub floor_speakable_min: u32,
    pub attention_threshold: u32,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        ScheduleConfig {
            gap_unknown: 3,
            gap_familiar: 8,
            gap_speakable: 20,
            attention_gap: 5,
            max_unknown_gap: 10,
            level_gap: LEVEL_GAPS,
            floor_unknown_min: 10,
            floor_familiar_min: 30,
            floor_speakable_min: 120,
            attention_threshold: 3,
        }
    }
}

/// Scheduler-facing projection of a card.
#[derive(Debug, Clone)]
pub struct CardSched {
    pub level: u32,
    pub next_eligible_seq: u64,
    pub unknown_streak: u32,
    pub speak_streak: u32,
    pub needs_attention: bool,
}

#[derive(Debug, Clone)]
pub struct ScheduleOutcome {
    pub level: u32,
    pub next_eligible_seq: u64,
    pub unknown_streak: u32,
    pub speak_streak: u32,
    pub needs_attention: bool,
    /// Optional time floor: the card may not appear before this moment.
    pub earliest_at: DateTime<Utc>,
}

fn level_gap(cfg: &ScheduleConfig, level: u32) -> u64 {
    cfg.level_gap[(level as usize).min(cfg.level_gap.len() - 1)]
}

fn floor_min(rating: Rating, cfg: &ScheduleConfig) -> u32 {
    match rating {
        Rating::Unknown => cfg.floor_unknown_min,
        Rating::Familiar => cfg.floor_familiar_min,
        Rating::Speakable => cfg.floor_speakable_min,
    }
}

/// Gap in cards + counter/level updates for one rating (no `now`), so `preview`
/// and `review` share the exact same rules.
fn next_state(
    card: &CardSched,
    rating: Rating,
    cfg: &ScheduleConfig,
) -> (u32, u64, u32, u32, bool) {
    let mut unknown_streak = card.unknown_streak;
    let mut speak_streak = card.speak_streak;
    let mut needs_attention = card.needs_attention;
    let level;
    let gap;

    match rating {
        Rating::Unknown => {
            unknown_streak += 1;
            speak_streak = 0;
            level = card.level.saturating_sub(1).max(1);
            if unknown_streak >= 4 {
                // Repeating the same card faster does not build memory: back off
                // further instead of hammering.
                gap = cfg.max_unknown_gap;
            } else if unknown_streak >= cfg.attention_threshold {
                gap = cfg.attention_gap;
                needs_attention = true;
            } else {
                gap = cfg.gap_unknown;
            }
        }
        Rating::Familiar => {
            unknown_streak = 0;
            speak_streak = 0;
            // Familiar does NOT clear the attention flag (design §3 note stays).
            level = card.level.max(1);
            gap = level_gap(cfg, level).max(cfg.gap_familiar);
        }
        Rating::Speakable => {
            unknown_streak = 0;
            speak_streak += 1;
            needs_attention = false;
            level = (card.level + 1).min(MAX_LEVEL);
            gap = level_gap(cfg, level).max(cfg.gap_speakable);
        }
    }
    (level, gap, unknown_streak, speak_streak, needs_attention)
}

/// Apply a rating: new level, next eligible display counter, time floor.
pub fn review(
    card: &CardSched,
    rating: Rating,
    current_seq: u64,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
) -> ScheduleOutcome {
    let (level, gap, unknown_streak, speak_streak, needs_attention) = next_state(card, rating, cfg);
    ScheduleOutcome {
        level,
        next_eligible_seq: current_seq + gap,
        unknown_streak,
        speak_streak,
        needs_attention,
        earliest_at: now + Duration::minutes(i64::from(floor_min(rating, cfg))),
    }
}

/// Card-gap preview per [Unknown, Familiar, Speakable] — "隔 N 张".
pub fn preview(card: &CardSched, cfg: &ScheduleConfig) -> [u64; 3] {
    [
        next_state(card, Rating::Unknown, cfg).1,
        next_state(card, Rating::Familiar, cfg).1,
        next_state(card, Rating::Speakable, cfg).1,
    ]
}

/// Eligibility: enough other cards shown AND the time floor passed.
pub fn is_eligible(
    card: &CardSched,
    current_seq: u64,
    earliest_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    current_seq >= card.next_eligible_seq && now >= earliest_at
}

/// SPEC §7.1: skipping rates nothing — the card re-enters the queue later with
/// every field untouched (only its `due_at` floor is pushed forward).
pub fn skip(now: DateTime<Utc>, skip_delay_min: u32) -> DateTime<Utc> {
    now + Duration::minutes(i64::from(skip_delay_min))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ScheduleConfig {
        ScheduleConfig::default()
    }

    fn new_card() -> CardSched {
        CardSched {
            level: 0,
            next_eligible_seq: 0,
            unknown_streak: 0,
            speak_streak: 0,
            needs_attention: false,
        }
    }

    fn card_at(level: u32) -> CardSched {
        CardSched {
            level,
            ..new_card()
        }
    }

    #[test]
    fn unknown_gap_is_three_cards_then_escalates() {
        let now = Utc::now();
        let c = cfg();
        let mut card = new_card();
        // 1st and 2nd Unknown: 3 cards later.
        for expected_streak in 1..=2u32 {
            let out = review(&card, Rating::Unknown, 100, now, &c);
            assert_eq!(out.next_eligible_seq, 103, "streak {expected_streak}");
            assert_eq!(out.unknown_streak, expected_streak);
            assert!(!out.needs_attention);
            assert_eq!(out.level, 1, "level drops but never below 1");
            card = CardSched {
                level: out.level,
                next_eligible_seq: out.next_eligible_seq,
                unknown_streak: out.unknown_streak,
                speak_streak: out.speak_streak,
                needs_attention: out.needs_attention,
            };
        }
        // 3rd: 5 cards later + attention flag.
        let out = review(&card, Rating::Unknown, 100, now, &c);
        assert_eq!(out.next_eligible_seq, 105);
        assert!(out.needs_attention);
        // 4th and beyond: 10 cards later, no further escalation.
        card = CardSched {
            level: out.level,
            next_eligible_seq: out.next_eligible_seq,
            unknown_streak: out.unknown_streak,
            speak_streak: out.speak_streak,
            needs_attention: out.needs_attention,
        };
        let out = review(&card, Rating::Unknown, 100, now, &c);
        assert_eq!(out.next_eligible_seq, 110);
        let out2 = review(
            &CardSched {
                unknown_streak: 4,
                ..card
            },
            Rating::Unknown,
            100,
            now,
            &c,
        );
        assert_eq!(out2.next_eligible_seq, 110);
    }

    #[test]
    fn unknown_time_floor_is_ten_minutes() {
        let now = Utc::now();
        let out = review(&new_card(), Rating::Unknown, 0, now, &cfg());
        assert_eq!((out.earliest_at - now).num_minutes(), 10);
    }

    #[test]
    fn familiar_gap_uses_level_with_minimum_eight() {
        let now = Utc::now();
        let c = cfg();
        // level 0 → treated as 1 → base 5, floored by gap_familiar 8.
        let out = review(&new_card(), Rating::Familiar, 50, now, &c);
        assert_eq!(out.level, 1);
        assert_eq!(out.next_eligible_seq, 58, "max(level_gap[1]=5, 8)");
        // level 3 → base 20 wins over the 8 minimum.
        let out = review(&card_at(3), Rating::Familiar, 50, now, &c);
        assert_eq!(out.level, 3);
        assert_eq!(out.next_eligible_seq, 70);
        assert_eq!((out.earliest_at - now).num_minutes(), 30);
    }

    #[test]
    fn speakable_levels_up_and_gap_uses_new_level() {
        let now = Utc::now();
        let c = cfg();
        // level 0 → 1: max(level_gap[1]=5, 20) = 20.
        let out = review(&new_card(), Rating::Speakable, 0, now, &c);
        assert_eq!(out.level, 1);
        assert_eq!(out.next_eligible_seq, 20);
        assert_eq!(out.speak_streak, 1);
        // level 3 → 4: max(level_gap[4]=50, 20) = 50.
        let out = review(&card_at(3), Rating::Speakable, 100, now, &c);
        assert_eq!(out.level, 4);
        assert_eq!(out.next_eligible_seq, 150);
        // level 5 stays at 5: max(level_gap[5]=100, 20) = 100.
        let out = review(&card_at(5), Rating::Speakable, 0, now, &c);
        assert_eq!(out.level, 5);
        assert_eq!(out.next_eligible_seq, 100);
        assert_eq!((out.earliest_at - now).num_minutes(), 120);
    }

    #[test]
    fn speakable_clears_attention_familiar_does_not() {
        let now = Utc::now();
        let c = cfg();
        let flagged = CardSched {
            level: 2,
            needs_attention: true,
            unknown_streak: 3,
            ..new_card()
        };
        assert!(!review(&flagged, Rating::Speakable, 0, now, &c).needs_attention);
        assert!(review(&flagged, Rating::Familiar, 0, now, &c).needs_attention);
    }

    #[test]
    fn streaks_reset_appropriately() {
        let now = Utc::now();
        let c = cfg();
        let card = CardSched {
            level: 2,
            unknown_streak: 2,
            speak_streak: 3,
            ..new_card()
        };
        let out = review(&card, Rating::Familiar, 0, now, &c);
        assert_eq!((out.unknown_streak, out.speak_streak), (0, 0));
        let out = review(&card, Rating::Speakable, 0, now, &c);
        assert_eq!((out.unknown_streak, out.speak_streak), (0, 4));
    }

    #[test]
    fn preview_lists_three_card_gaps() {
        let c = cfg();
        let p = preview(&new_card(), &c);
        assert_eq!(
            p,
            [3, 8, 20],
            "new card: unknown 3, familiar 8, speakable 20"
        );
        let p = preview(&card_at(4), &c);
        assert_eq!(p, [3, 50, 100], "level 4: familiar base 50, speakable 100");
    }

    #[test]
    fn eligibility_requires_seq_and_time() {
        let now = Utc::now();
        let card = CardSched {
            next_eligible_seq: 104,
            ..new_card()
        };
        // Sequence reached but time floor still in the future.
        assert!(!is_eligible(&card, 104, now + Duration::minutes(5), now));
        // Time passed but sequence not reached.
        assert!(!is_eligible(&card, 103, now - Duration::minutes(5), now));
        assert!(is_eligible(&card, 104, now - Duration::minutes(5), now));
    }

    #[test]
    fn skip_postpones_the_time_floor_only() {
        let now = Utc::now();
        let due = skip(now, 30);
        assert_eq!((due - now).num_minutes(), 30);
    }
}
