/**
 * 学习日（study day）：以**凌晨 4 点**为一天的分界（Anki 惯例）——凌晨刚过还在
 * 复习的那一轮算前一天，不把一次连续学习劈成两天。
 *
 * 这是首页「今日已复习」、今日目标与引擎每日配额的**唯一定义**，必须与 Rust
 * `db::study_day_of`（SQL 里是 `date(reviewed_at,'localtime','-4 hours')`）一致：
 * 两边不一致时，凌晨 0–4 点同一屏上的两个数字会各说各话。
 */
export const STUDY_DAY_ROLL_HOURS = 4;

/** 某个时刻落在哪个学习日，`YYYY-MM-DD`。 */
export function studyDayKey(at: Date | string | number = new Date()): string {
  const d = new Date(at);
  d.setHours(d.getHours() - STUDY_DAY_ROLL_HOURS);
  return d.toLocaleDateString("sv");
}

/** 学习日平移 `deltaDays` 天。用正午当锚点，免得 4 小时偏移把日期挪走一天。 */
export function shiftStudyDay(key: string, deltaDays: number): string {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return d.toLocaleDateString("sv");
}
