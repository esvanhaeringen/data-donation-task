import { getTableColumn } from './util'
import { Table, CalendarVisualization, CalendarVisualizationData, CalendarDayCount } from '../types'

export async function prepareCalendarData (
  table: Table,
  visualization: CalendarVisualization
): Promise<CalendarVisualizationData> {
  const dates = getTableColumn(table, visualization.dateColumn)

  const counts: Record<string, number> = {}
  // The date column's own raw value per contributing row, bucketed per day -
  // lets the heatmap test a DATE:... search term against *just* that column
  // rather than the row's other columns (e.g. message text, which could
  // coincidentally contain a date-shaped substring).
  const timestamps: Record<string, string[]> = {}
  // Every cell of each contributing row, joined - lets the heatmap test the
  // free-text part of a search against the row's full content, same as
  // everywhere else in the app, so a combined "word DATE:..." query can
  // still narrow down to days matching both.
  const rowTexts: Record<string, string[]> = {}

  for (let i = 0; i < dates.length; i++) {
    const dateString = dates[i]
    if (dateString == null || dateString === '') continue
    const date = new Date(dateString)
    if (isNaN(date.getTime())) continue

    const key = toLocalDayKey(date)
    counts[key] = (counts[key] ?? 0) + 1
    if (timestamps[key] === undefined) timestamps[key] = []
    timestamps[key].push(dateString)
    if (rowTexts[key] === undefined) rowTexts[key] = []
    rowTexts[key].push(table.body.rows[i].cells.join('\n'))
  }

  const result: CalendarDayCount[] = Object.entries(counts).map(([date, count]) => ({
    date,
    count,
    timestamps: timestamps[date],
    rowTexts: rowTexts[date]
  }))
  return { type: 'calendar_heatmap', counts: result }
}

// YYYY-MM-DD in the viewer's local timezone, matching the local-getter
// convention used by formatDate's "day" formatter in util.ts.
function toLocalDayKey (date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
