/**
 * Groups history records by local calendar day and orders the groups newest first.
 *
 * Groups are ordered by the local-midnight timestamp, not by the display label.
 * Labels are localized strings ("October 13, 2026", "13 жовтня 2026 р."), and
 * comparing those as text orders months alphabetically and days digit by digit:
 * September lands above October, and "9" above "13". The groups therefore lose
 * their real chronology, and the History and Favorites lists show the newest
 * day somewhere in the middle after a month change. Ordering by the day start
 * also keeps today and yesterday on top without matching translated
 * "Today" / "Yesterday" labels.
 *
 * Records inside a group keep their incoming order: the database already sorts
 * them newest first by list_order, so this helper does not reorder them.
 */
export interface DayGroup<T> {
  /** Local midnight of the day in epoch milliseconds; also used as the React key. */
  dayStart: number
  label: string
  records: T[]
}

export function groupByDay<T extends { timestamp: number }>(
  records: readonly T[],
  labelFor: (timestamp: number) => string,
): DayGroup<T>[] {
  const byDay = new Map<number, DayGroup<T>>()
  for (const record of records) {
    const date = new Date(record.timestamp)
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    let group = byDay.get(dayStart)
    if (!group) {
      group = { dayStart, label: labelFor(record.timestamp), records: [] }
      byDay.set(dayStart, group)
    }
    group.records.push(record)
  }
  return [...byDay.values()].sort((a, b) => b.dayStart - a.dayStart)
}
