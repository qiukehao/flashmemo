//! Review scheduling by "cards shown" instead of wall-clock time.
//!
//! Fourth revision (2026-10-04, "时间只记账，不催债" rework of the third
//! revision): the seq-based no-debt design stays; TIME no longer schedules
//! anything. The two time-scheduling rules of revision 3 (最长等待 force-due,
//! growing time-floor ladder) are retracted. Time only guards two things:
//! - 每天最多升 1 级: a second Speakable on the same day still delays by
//!   count and grows the streak, but the level holds — same-day recall is
//!   short-term memory, not mastery.
//! - Archive needs the Speakable streak to span ≥threshold DISTINCT study
//!   days (services checks the days; the count lives here).
//!
//! Gaps get a ±20% jitter (applied in services) so fixed card order cannot
//! become a guessing crutch.

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
    /// Cumulative lapses that also flag ⚠ ("会了又忘" repeated hopping).
    pub attention_lapses: u32,
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
            attention_lapses: 4,
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
    pub lapses: u32,
    /// True when the level was already raised earlier on this study day —
    /// 每天最多升 1 级.
    pub leveled_up_today: bool,
}

#[derive(Debug, Clone)]
pub struct ScheduleOutcome {
    pub level: u32,
    pub next_eligible_seq: u64,
    pub unknown_streak: u32,
    pub speak_streak: u32,
    pub needs_attention: bool,
    /// Time floor: the card may not appear before this moment.
    pub earliest_at: DateTime<Utc>,
    /// Whether this rating raised the level (services stamps `level_up_day`).
    pub leveled_up: bool,
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
) -> (u32, u64, u32, u32, bool, bool) {
    let mut unknown_streak = card.unknown_streak;
    let mut speak_streak = card.speak_streak;
    let mut needs_attention = card.needs_attention;
    let level;
    let gap;
    let leveled_up;

    match rating {
        Rating::Unknown => {
            unknown_streak += 1;
            speak_streak = 0;
            // New cards (0) stay at 0 — an Unknown must never promote; from
            // level 3 up an Unknown is a real forgetting event, drop to 1.
            level = if card.level >= 3 {
                1
            } else {
                card.level.saturating_sub(1)
            };
            // 阶梯必须单调：先到阈值（标记 ⚠ + 回访距离），再超过一步才退避。
            // 旧写法把退避硬编码在 streak>=4，阈值调大后会出现"标记了反而更近"。
            if unknown_streak >= cfg.attention_threshold {
                needs_attention = true;
                gap = if unknown_streak > cfg.attention_threshold {
                    // Repeating the same card faster does not build memory: back
                    // off further instead of hammering.
                    cfg.max_unknown_gap
                } else {
                    cfg.attention_gap
                };
            } else {
                gap = cfg.gap_unknown;
            }
            // 会了又忘 hopping: enough total lapses flag ⚠ even without a
            // consecutive streak.
            if card.lapses + 1 >= cfg.attention_lapses {
                needs_attention = true;
            }
            leveled_up = false;
        }
        Rating::Familiar => {
            unknown_streak = 0;
            speak_streak = 0;
            // Familiar does NOT clear the attention flag (design §3 note stays).
            // From level 4 up "familiar" means decay: lose one level.
            level = if card.level >= 4 {
                card.level - 1
            } else {
                card.level.max(1)
            };
            gap = (level_gap(cfg, level) / 2).max(cfg.gap_familiar);
            leveled_up = false;
        }
        Rating::Speakable => {
            unknown_streak = 0;
            speak_streak += 1;
            needs_attention = false;
            // A first-rating ace skips the bottom rung; clearing ⚠ caps the
            // climb at 2 so the card is re-tested soon instead of vanishing
            // into a high level right after recovery.
            let mut target = if card.level == 0 {
                2
            } else {
                (card.level + 1).min(MAX_LEVEL)
            };
            if card.needs_attention {
                target = target.min(2);
            }
            // 每天最多升 1 级: holding the level still grows the streak and
            // delays by count — only the promotion is deferred to tomorrow.
            if target > card.level && card.leveled_up_today {
                level = card.level;
                leveled_up = false;
            } else {
                level = target;
                leveled_up = target > card.level;
            }
            gap = level_gap(cfg, level).max(cfg.gap_speakable);
        }
    }
    (
        level,
        gap,
        unknown_streak,
        speak_streak,
        needs_attention,
        leveled_up,
    )
}

/// Apply a rating: new level, next eligible display counter, time floor.
pub fn review(
    card: &CardSched,
    rating: Rating,
    current_seq: u64,
    now: DateTime<Utc>,
    cfg: &ScheduleConfig,
) -> ScheduleOutcome {
    let (level, gap, unknown_streak, speak_streak, needs_attention, leveled_up) =
        next_state(card, rating, cfg);
    ScheduleOutcome {
        level,
        next_eligible_seq: current_seq + gap,
        unknown_streak,
        speak_streak,
        needs_attention,
        earliest_at: now + Duration::minutes(i64::from(floor_min(rating, cfg))),
        leveled_up,
    }
}

/// ±20% 随机扰动 on the card gap: `roll ∈ [0,1)` maps to a factor in
/// [0.8, 1.2). Applied by services (which owns randomness) after `review`;
/// the popup preview keeps showing the base gap.
pub fn jitter_gap(gap: u64, roll: f64) -> u64 {
    let factor = 0.8 + 0.4 * roll.clamp(0.0, 0.999_999);
    (((gap as f64) * factor).round() as u64).max(1)
}

/// Card-gap preview per [Unknown, Familiar, Speakable] — "隔 N 张" (base, no
/// jitter).
pub fn preview(card: &CardSched, cfg: &ScheduleConfig) -> [u64; 3] {
    [
        next_state(card, Rating::Unknown, cfg).1,
        next_state(card, Rating::Familiar, cfg).1,
        next_state(card, Rating::Speakable, cfg).1,
    ]
}

/// Eligibility: enough other cards shown AND the time floor passed. When the
/// whole pool starves (few cards, frequent reviews), services fills the popup
/// from the nearest-seq fallback instead — time never forces a card out.
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
            lapses: 0,
            leveled_up_today: false,
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
            assert_eq!(out.level, 0, "an Unknown never promotes a new card");
            card = CardSched {
                level: out.level,
                next_eligible_seq: out.next_eligible_seq,
                unknown_streak: out.unknown_streak,
                speak_streak: out.speak_streak,
                needs_attention: out.needs_attention,
                ..card
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
            ..card
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
    fn unknown_drops_high_levels_to_one() {
        let now = Utc::now();
        let c = cfg();
        for from in [2u32, 3, 4, 5] {
            let out = review(&card_at(from), Rating::Unknown, 0, now, &c);
            assert_eq!(out.level, 1, "level {from} unknown → 1");
        }
        for from in [0u32, 1] {
            let out = review(&card_at(from), Rating::Unknown, 0, now, &c);
            assert_eq!(out.level, 0, "level {from} unknown stays at 0");
        }
    }

    #[test]
    fn unknown_time_floor_is_ten_minutes() {
        let now = Utc::now();
        let out = review(&new_card(), Rating::Unknown, 0, now, &cfg());
        assert_eq!((out.earliest_at - now).num_minutes(), 10);
    }

    #[test]
    fn familiar_keeps_level_below_four_and_half_gap_above() {
        let now = Utc::now();
        let c = cfg();
        // level 0 → treated as 1: gap max(5/2, 8) = 8, floor 30.
        let out = review(&new_card(), Rating::Familiar, 50, now, &c);
        assert_eq!(out.level, 1);
        assert_eq!(out.next_eligible_seq, 58);
        assert_eq!((out.earliest_at - now).num_minutes(), 30);
        // level 3: gap max(20/2, 8) = 10.
        let out = review(&card_at(3), Rating::Familiar, 50, now, &c);
        assert_eq!(out.level, 3);
        assert_eq!(out.next_eligible_seq, 60);
        // level 5 → 4: gap max(50/2, 8) = 25.
        let out = review(&card_at(5), Rating::Familiar, 50, now, &c);
        assert_eq!(out.level, 4);
        assert_eq!(out.next_eligible_seq, 75);
    }

    #[test]
    fn speakable_levels_up_and_gap_uses_new_level() {
        let now = Utc::now();
        let c = cfg();
        // First-rating ace: 0 → 2, gap max(10, 20) = 20, floor 2h.
        let out = review(&new_card(), Rating::Speakable, 0, now, &c);
        assert_eq!(out.level, 2);
        assert!(out.leveled_up);
        assert_eq!(out.next_eligible_seq, 20);
        assert_eq!(out.speak_streak, 1);
        assert_eq!((out.earliest_at - now).num_minutes(), 120);
        // level 3 → 4: max(level_gap[4]=50, 20) = 50.
        let out = review(&card_at(3), Rating::Speakable, 100, now, &c);
        assert_eq!(out.level, 4);
        assert_eq!(out.next_eligible_seq, 150);
        // level 5 stays at 5: max(100, 20) = 100.
        let out = review(&card_at(5), Rating::Speakable, 0, now, &c);
        assert_eq!(out.level, 5);
        assert!(!out.leveled_up, "already at MAX_LEVEL");
        assert_eq!(out.next_eligible_seq, 100);
    }

    #[test]
    fn level_rises_at_most_once_per_day() {
        let now = Utc::now();
        let c = cfg();
        // First Speakable of the day: 2 → 3.
        let first = review(&card_at(2), Rating::Speakable, 0, now, &c);
        assert_eq!(first.level, 3);
        assert!(first.leveled_up);
        // Second Speakable the same day: streak grows, level holds.
        let second = review(
            &CardSched {
                level: first.level,
                speak_streak: first.speak_streak,
                leveled_up_today: true,
                ..new_card()
            },
            Rating::Speakable,
            30,
            now,
            &c,
        );
        assert_eq!(second.level, 3, "每天最多升 1 级");
        assert!(!second.leveled_up);
        assert_eq!(second.speak_streak, 2, "streak still grows");
        // The held card still delays by the count gap of its current level.
        assert_eq!(second.next_eligible_seq, 50, "gap 20 from seq 30");
    }

    #[test]
    fn speakable_clears_attention_and_caps_level_at_two() {
        let now = Utc::now();
        let c = cfg();
        let flagged = CardSched {
            level: 2,
            needs_attention: true,
            unknown_streak: 3,
            ..new_card()
        };
        // Clearing ⚠ keeps the level at 2 for a quick re-test.
        let out = review(&flagged, Rating::Speakable, 0, now, &c);
        assert!(!out.needs_attention);
        assert_eq!(out.level, 2);
        // Familiar does not clear the flag.
        assert!(review(&flagged, Rating::Familiar, 0, now, &c).needs_attention);
        // A high-level flagged card is pulled back to 2 (a drop, not a rise —
        // the daily cap does not block it).
        let high_flagged = CardSched {
            level: 4,
            needs_attention: true,
            ..new_card()
        };
        assert_eq!(
            review(&high_flagged, Rating::Speakable, 0, now, &c).level,
            2
        );
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
    fn enough_lapses_flag_attention_without_a_streak() {
        let now = Utc::now();
        let c = cfg();
        let hopping = CardSched {
            level: 2,
            lapses: 3,
            ..new_card()
        };
        assert!(
            review(&hopping, Rating::Unknown, 0, now, &c).needs_attention,
            "4th lifetime lapse flags ⚠ even with streak 1"
        );
        let young = CardSched {
            level: 2,
            lapses: 2,
            ..new_card()
        };
        assert!(!review(&young, Rating::Unknown, 0, now, &c).needs_attention);
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        assert_eq!(jitter_gap(20, 0.0), 16, "roll 0 → factor 0.8");
        assert_eq!(jitter_gap(20, 0.5), 20, "roll 0.5 → factor 1.0");
        assert_eq!(jitter_gap(20, 0.999), 24, "roll →1 → factor →1.2");
        assert_eq!(jitter_gap(3, 0.0), 2, "small gap rounds down");
        assert_eq!(jitter_gap(3, 0.999), 4, "small gap rounds up");
        assert_eq!(jitter_gap(0, 0.0), 1, "never below 1");
        assert_eq!(jitter_gap(1, 0.5), 1);
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
        assert_eq!(
            p,
            [3, 10, 100],
            "level 4: familiar decays to 3 (gap max(20/2,8)=10), speakable 100"
        );
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
    fn unknown_ladder_stays_monotonic_for_custom_thresholds() {
        let now = Utc::now();
        let mut c = cfg();
        c.attention_threshold = 6;
        let mut card = new_card();
        let mut gaps = Vec::new();
        let mut flagged_at = None;
        for step in 1..=8u32 {
            let out = review(&card, Rating::Unknown, 100, now, &c);
            gaps.push(out.next_eligible_seq - 100);
            if out.needs_attention && flagged_at.is_none() {
                flagged_at = Some(step);
            }
            card.unknown_streak = out.unknown_streak;
        }
        for w in gaps.windows(2) {
            assert!(w[1] >= w[0], "间距阶梯倒挂: {gaps:?}");
        }
        assert_eq!(flagged_at, Some(6), "标记必须正好落在阈值那一击");
        assert_eq!(
            gaps,
            vec![3, 3, 3, 3, 3, 5, 10, 10],
            "阈值前 gap_unknown，阈值当拍 attention_gap，再往后退避"
        );
    }

    #[test]
    fn skip_postpones_the_time_floor_only() {
        let now = Utc::now();
        let due = skip(now, 30);
        assert_eq!((due - now).num_minutes(), 30);
    }
}
