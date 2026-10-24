import { describe, expect, it } from 'vitest'
import { groupByDay } from '../dayGroups'

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Mirrors the real day label. As text it puts September above October and
// "April 7" above "April 14", so a label-based sort cannot pass these expectations.
const labelFor = (ts: number) => {
  const date = new Date(ts)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

describe('groupByDay', () => {
  it('orders groups by date, not by the localized label', () => {
    const records = [
      { id: 'oct13', timestamp: at(2026, 10, 13) },
      { id: 'sep30', timestamp: at(2026, 9, 30) },
      { id: 'apr14', timestamp: at(2026, 4, 14) },
      { id: 'apr7', timestamp: at(2026, 4, 7) },
    ]

    const groups = groupByDay([records[3], records[1], records[0], records[2]], labelFor)

    expect(groups.map((group) => group.label)).toEqual([
      'October 13, 2026',
      'September 30, 2026',
      'April 14, 2026',
      'April 7, 2026',
    ])
  })

  it('puts a newer year first', () => {
    const groups = groupByDay(
      [
        { id: 'old', timestamp: at(2025, 12, 31) },
        { id: 'new', timestamp: at(2026, 1, 1) },
      ],
      labelFor,
    )

    expect(groups.map((group) => group.records[0].id)).toEqual(['new', 'old'])
  })

  it('keeps records of the same day together in their incoming order', () => {
    const groups = groupByDay(
      [
        { id: 'late', timestamp: at(2026, 10, 13, 22) },
        { id: 'early', timestamp: at(2026, 10, 13, 9) },
        { id: 'previous', timestamp: at(2026, 10, 12, 23) },
      ],
      labelFor,
    )

    expect(groups).toHaveLength(2)
    expect(groups[0].records.map((record) => record.id)).toEqual(['late', 'early'])
    expect(groups[1].records.map((record) => record.id)).toEqual(['previous'])
  })
})
