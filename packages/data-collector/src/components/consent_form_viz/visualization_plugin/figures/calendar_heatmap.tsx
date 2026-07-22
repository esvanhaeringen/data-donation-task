import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDayCount, CalendarVisualizationData, Translatable } from '../types'
import { DATE_PREFIX, dateTermFragments, isDateTerm, matchesQuery, queryTerms } from '../searchMatch'

interface Props {
  visualizationData: CalendarVisualizationData
  locale: string
  search: string
  onSearch: (search: string) => void
}

const GAP = 3
const MIN_CELL = 6
const MAX_CELL = 26
const LABEL_COL_WIDTH = 32
const LABEL_ROW_HEIGHT = 22

const EMPTY_COLOR = '#F6F6F6' // grey5
const SCALE_FROM = '#E3EAFD' // primarylight
const SCALE_TO = '#4272EF' // primary

// Same two-tone gradient system as the primary scale above, but for the
// no-search-active-yet-still-selectable states: grey for days that don't
// match the current search, yellow (tertiary) for days that do.
const GREY_FROM = EMPTY_COLOR // grey5
const GREY_TO = '#999999' // grey2
const YELLOW_TO = '#FFCF60' // tertiary
const YELLOW_FROM = interpolateColor('#FFFFFF', YELLOW_TO, 0.14) // ~ same white-blend ratio as primarylight vs primary

const MS_PER_DAY = 1000 * 60 * 60 * 24
const YEAR_MODE_THRESHOLD_DAYS = 365

// A label at a given position along one axis of the grid - used generically
// for both "dense" label sets (every index has one, e.g. the 7 weekdays or
// 12 months) and "sparse" ones (only some indices, e.g. a month boundary
// among many week columns), so the top/left renderers below don't need to
// know which kind they're dealing with.
interface AxisLabel {
  index: number
  label: string
}

interface DayCell {
  date: Date
  key: string // YYYY-MM-DD
  count: number
  matched: boolean
  wd: number // 0 = Monday .. 6 = Sunday
  wk: number // week index
}

interface MonthCell {
  year: number
  month: number // 0-11
  yearIndex: number
  key: string // YYYY-MM
  count: number
  matched: boolean
}

// Measures the rendered size of `ref`'s element, so the grid can size its
// cells to actually fill the space the Figure wrapper gives it (default
// 250px tall, full available width) instead of sitting at a fixed pixel
// size regardless of the surrounding box.
function useElementSize (): [RefObject<HTMLDivElement | null>, { width: number, height: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (el == null) return

    setSize({ width: el.clientWidth, height: el.clientHeight })

    const ro = new ResizeObserver(entries => {
      const cr = entries[0]?.contentRect
      if (cr == null) return
      // Bail out when the measured size hasn't actually changed - setting
      // state to an == but not === value would still schedule a render,
      // which (combined with any residual sub-pixel rounding elsewhere)
      // could otherwise turn into a self-sustaining resize/re-render cycle.
      setSize(prev => (prev.width === cr.width && prev.height === cr.height ? prev : { width: cr.width, height: cr.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}

// Explanation shown in the help overlay of this visualization (see the help
// button next to the title in figure.tsx). Module-level rather than inside
// the component because the overlay is rendered by the surrounding figure.
export const helpText: Translatable = {
  en: 'Every square is one day, and the darker the square the more activity that day contains. Hovering a square shows the date and the number of items. Clicking a day adds it to the search, so the other visualizations and the table only show that day; clicking it again removes it from the search.',
  nl: 'Elk vierkantje is één dag, en hoe donkerder het vierkantje, hoe meer activiteit die dag bevat. Beweeg je muis over een vierkantje om de datum en het aantal items te zien. Klik op een dag om deze aan de zoekopdracht toe te voegen, zodat de andere visualisaties en de tabel alleen die dag tonen; klik nogmaals om de dag weer uit de zoekopdracht te halen.'
}

export default function CalendarHeatmap ({ visualizationData, locale, search, onSearch }: Props): JSX.Element | null {
  const dayMap = useMemo(() => {
    const map = new Map<string, CalendarDayCount>()
    for (const day of visualizationData.counts) map.set(day.date, day)
    return map
  }, [visualizationData])

  const query = search.trim()
  const hasQuery = query !== ''

  // Whether each day matches the current search text - drives the
  // grey-vs-yellow gradient family below, independent of `activeTerms`
  // (which drives the selection ring for a clicked date term). DATE:...
  // terms are tested against a row's date column only (so a message that
  // happens to mention a date doesn't cause a false match); every other
  // term is tested against that same row's full content, same as everywhere
  // else in the app. Critically, all terms must hold for one and the same
  // contributing row (day.timestamps[i]/day.rowTexts[i] are index-aligned
  // per row - see prepareCalendarData) - a day is matched by OR-ing that
  // per-row check across its rows, mirroring the row.some(termsAllMatch)
  // shape table_container/chat_conversation use, rather than independently
  // checking "is each term satisfied by *some* row", which lets unrelated
  // rows on the same day satisfy different terms of a multi-term query
  // (e.g. "apple banana") and falsely mark the day as matched even though
  // no single message on it contains both words.
  const matchesByDay = useMemo(() => {
    const map = new Map<string, boolean>()
    if (!hasQuery) return map

    const terms = queryTerms(query)
    const dateTerms = terms.filter(isDateTerm)
    const otherTerms = terms.filter(t => !isDateTerm(t))

    for (const day of visualizationData.counts) {
      const matched = day.timestamps.some((ts, i) => {
        const text = day.rowTexts[i]
        const dateOk = dateTerms.every(t => matchesQuery(ts, t))
        const otherOk = otherTerms.every(t => text != null && matchesQuery(text, t))
        return dateOk && otherOk
      })
      map.set(day.date, matched)
    }
    return map
  }, [visualizationData, query, hasQuery])

  const { minDate, maxDate } = useMemo(() => bounds(dayMap), [dayMap])
  // The individually selected dates, expanded out of whichever comma-joined
  // date term(s) are present in the search text - drives the selection ring
  // per cell, independent of `matched` (which drives the grey/yellow fill).
  const activeTerms = useMemo(() => {
    const set = new Set<string>()
    for (const term of queryTerms(search)) {
      if (isDateTerm(term)) dateTermFragments(term).forEach(d => set.add(d))
    }
    return set
  }, [search])
  const [containerRef, size] = useElementSize()

  if (minDate == null || maxDate == null) return null

  const spanDays = (maxDate.getTime() - minDate.getTime()) / MS_PER_DAY
  const mode = (spanDays > YEAR_MODE_THRESHOLD_DAYS) || (size.width < 500) ? 'month' : 'day'

  function handleClick (term: string): void {
    onSearch(toggleDateInSearch(term, search))
  }

  return (
    // min-w-0/min-h-0 are load-bearing: a flex item's default min-width and
    // min-height are "auto", meaning it refuses to shrink below its
    // content's intrinsic size. The grid inside is sized *from* this
    // container's own measured size, so without these the two feed back
    // into each other on either axis - any tiny overflow forces this
    // container to grow, which gets re-measured as more available space,
    // which computes an even bigger grid, without bound.
    <div ref={containerRef} className='w-full h-full flex items-center min-w-0 min-h-0 overflow-x-auto p-2'>
      {mode === 'day'
        ? (
          <DayGrid
            dayMap={dayMap}
            matchesByDay={matchesByDay}
            hasQuery={hasQuery}
            minDate={minDate}
            maxDate={maxDate}
            locale={locale}
            activeTerms={activeTerms}
            onCellClick={handleClick}
            availableWidth={size.width}
            availableHeight={size.height}
          />
          )
        : (
          <MonthGrid
            dayMap={dayMap}
            matchesByDay={matchesByDay}
            hasQuery={hasQuery}
            minDate={minDate}
            maxDate={maxDate}
            locale={locale}
            activeTerms={activeTerms}
            onCellClick={handleClick}
            availableWidth={size.width}
            availableHeight={size.height}
          />
          )}
    </div>
  )
}

// Cell width and height are deliberately *not* capped at MAX_CELL - each
// fills whatever space is available along its own axis (dividing it evenly
// across columns/rows), even if that makes cells rectangular rather than
// square. MAX_CELL only survives as the pre-measurement fallback below.
function cellWidthFor (nCols: number, availableWidth: number): number {
  const widthBudget = availableWidth - LABEL_COL_WIDTH
  const byWidth = nCols > 0 && widthBudget > 0 ? (widthBudget - (nCols - 1) * GAP) / nCols : MAX_CELL
  return Math.max(MIN_CELL, byWidth)
}

// There are only (nCols - 1) gaps *between* columns, not one per column -
// `nCols * (cellWidth + GAP)` overcounts by one GAP, which made the grid
// systematically wider than the space cellWidthFor was given. Combined with
// a flex container's default min-width:auto (see the min-w-0 comment on
// CalendarHeatmap's root div), that small persistent overflow was enough to
// force the measured container to keep growing on every resize pass.
function gridWidthFor (nCols: number, cellWidth: number): number {
  return nCols * cellWidth + Math.max(0, nCols - 1) * GAP
}

function cellHeightFor (nRows: number, availableHeight: number): number {
  const heightBudget = availableHeight - LABEL_ROW_HEIGHT
  const byHeight = nRows > 0 && heightBudget > 0 ? (heightBudget - (nRows - 1) * GAP) / nRows : MAX_CELL
  return Math.max(MIN_CELL, byHeight)
}

function DayGrid ({
  dayMap,
  matchesByDay,
  hasQuery,
  minDate,
  maxDate,
  locale,
  activeTerms,
  onCellClick,
  availableWidth,
  availableHeight
}: {
  dayMap: Map<string, CalendarDayCount>
  matchesByDay: Map<string, boolean>
  hasQuery: boolean
  minDate: Date
  maxDate: Date
  locale: string
  activeTerms: Set<string>
  onCellClick: (term: string) => void
  availableWidth: number
  availableHeight: number
}): JSX.Element {
  const { cells, monthLabels, nWeeks } = useMemo(() => {
    const start = mondayOnOrBefore(minDate)
    const end = sundayOnOrAfter(maxDate)

    const cells: DayCell[] = []
    const monthLabels: AxisLabel[] = []
    let seenMonth = ''

    let cursor = new Date(start)
    let wk = 0
    let wd = 0
    while (cursor.getTime() <= end.getTime()) {
      const key = toLocalDayKey(cursor)
      const monthKey = key.slice(0, 7)
      if (cursor.getDate() === 1 && monthKey !== seenMonth) {
        monthLabels.push({ index: wk, label: formatMonth(cursor, locale) })
        seenMonth = monthKey
      } else if (monthLabels.length === 0 && seenMonth === '') {
        // label the very first (partial) month too, even though it doesn't start on the 1st
        monthLabels.push({ index: wk, label: formatMonth(cursor, locale) })
        seenMonth = monthKey
      }

      cells.push({
        date: new Date(cursor),
        key,
        count: dayMap.get(key)?.count ?? 0,
        matched: matchesByDay.get(key) ?? false,
        wd,
        wk
      })

      cursor = addDays(cursor, 1)
      wd += 1
      if (wd === 7) {
        wd = 0
        wk += 1
      }
    }

    return { cells, monthLabels, nWeeks: wk + (wd > 0 ? 1 : 0) }
  }, [dayMap, matchesByDay, minDate, maxDate, locale])

  const breakpoints = useMemo(() => computeBreakpoints(cells.map(c => c.count)), [cells])
  const weekdayLabels = useMemo(() => weekdayShortLabels(locale), [locale])

  // Put whichever axis has fewer labels on the row (y) axis - normally the
  // 7 weekdays, but a very short span (fewer weeks than weekdays) flips it
  // so the sparser week axis becomes rows instead.
  const swap = nWeeks < 7
  const nRows = swap ? nWeeks : 7
  const nCols = swap ? 7 : nWeeks

  const cellWidth = cellWidthFor(nCols, availableWidth)
  const cellHeight = cellHeightFor(nRows, availableHeight)
  const gridWidth = gridWidthFor(nCols, cellWidth)

  const denseWeekdayLabels = useMemo(
    () => weekdayLabels.map((label, i) => ({ index: i, label })),
    [weekdayLabels]
  )
  const topLabels = swap ? denseWeekdayLabels : monthLabels
  const leftLabels = swap ? monthLabels : denseWeekdayLabels

  return (
    <div className='flex flex-col text-xs text-grey2 select-none'>
      <div className='flex'>
        <div style={{ width: LABEL_COL_WIDTH }} />
        <TopLabels labels={topLabels} cellWidth={cellWidth} width={gridWidth} />
      </div>
      <div className='flex'>
        <LeftLabels labels={leftLabels} cellHeight={cellHeight} nRows={nRows} />
        <div
          className='grid'
          style={{
            width: gridWidth,
            gridTemplateColumns: `repeat(${nCols}, ${cellWidth}px)`,
            gridTemplateRows: `repeat(${nRows}, ${cellHeight}px)`,
            columnGap: GAP,
            rowGap: GAP
          }}
        >
          {cells.map(c => (
            <Cell
              key={c.key}
              row={swap ? c.wk : c.wd}
              col={swap ? c.wd : c.wk}
              width={cellWidth}
              height={cellHeight}
              count={c.count}
              color={colorFor(c.count, breakpoints, hasQuery, c.matched)}
              active={activeTerms.has(c.key)}
              title={`${c.key}: ${c.count}`}
              onClick={() => onCellClick(c.key)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function MonthGrid ({
  dayMap,
  matchesByDay,
  hasQuery,
  minDate,
  maxDate,
  locale,
  activeTerms,
  onCellClick,
  availableWidth,
  availableHeight
}: {
  dayMap: Map<string, CalendarDayCount>
  matchesByDay: Map<string, boolean>
  hasQuery: boolean
  minDate: Date
  maxDate: Date
  locale: string
  activeTerms: Set<string>
  onCellClick: (term: string) => void
  availableWidth: number
  availableHeight: number
}): JSX.Element {
  const { cells, years } = useMemo(() => {
    const monthSums = new Map<string, number>()
    const monthMatched = new Map<string, boolean>()
    for (const [dayKey, day] of dayMap.entries()) {
      const monthKey = dayKey.slice(0, 7)
      monthSums.set(monthKey, (monthSums.get(monthKey) ?? 0) + day.count)
      if (matchesByDay.get(dayKey) === true) monthMatched.set(monthKey, true)
    }

    const minYear = minDate.getFullYear()
    const maxYear = maxDate.getFullYear()
    const years: number[] = []
    for (let y = minYear; y <= maxYear; y++) years.push(y)

    const cells: MonthCell[] = []
    years.forEach((year, yearIndex) => {
      for (let month = 0; month < 12; month++) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}`
        cells.push({
          year,
          month,
          yearIndex,
          key,
          count: monthSums.get(key) ?? 0,
          matched: monthMatched.get(key) ?? false
        })
      }
    })

    return { cells, years }
  }, [dayMap, matchesByDay, minDate, maxDate])

  const breakpoints = useMemo(() => computeBreakpoints(cells.map(c => c.count)), [cells])
  const monthLabels = useMemo(() => monthShortLabels(locale), [locale])

  const nYears = years.length
  // Put whichever axis has fewer labels on the row (y) axis - normally the
  // years (almost always fewer than 12), but a very long history (13+
  // years) flips it back so the 12 months become rows instead.
  const swap = nYears < 12
  const nRows = swap ? nYears : 12
  const nCols = swap ? 12 : nYears

  const cellWidth = cellWidthFor(nCols, availableWidth)
  const cellHeight = cellHeightFor(nRows, availableHeight)
  const gridWidth = gridWidthFor(nCols, cellWidth)

  const denseMonthLabels = useMemo(
    () => monthLabels.map((label, i) => ({ index: i, label })),
    [monthLabels]
  )
  const denseYearLabels = useMemo(
    () => years.map((year, i) => ({ index: i, label: String(year) })),
    [years]
  )
  const topLabels = swap ? denseMonthLabels : denseYearLabels
  const leftLabels = swap ? denseYearLabels : denseMonthLabels

  return (
    <div className='flex flex-col text-xs text-grey2 select-none'>
      <div className='flex'>
        <div style={{ width: LABEL_COL_WIDTH }} />
        <TopLabels labels={topLabels} cellWidth={cellWidth} width={gridWidth} />
      </div>
      <div className='flex'>
        <LeftLabels labels={leftLabels} cellHeight={cellHeight} nRows={nRows} />
        <div
          className='grid'
          style={{
            width: gridWidth,
            gridTemplateColumns: `repeat(${nCols}, ${cellWidth}px)`,
            gridTemplateRows: `repeat(${nRows}, ${cellHeight}px)`,
            columnGap: GAP,
            rowGap: GAP
          }}
        >
          {cells.map(c => (
            <Cell
              key={c.key}
              row={swap ? c.yearIndex : c.month}
              col={swap ? c.month : c.yearIndex}
              width={cellWidth}
              height={cellHeight}
              count={c.count}
              color={colorFor(c.count, breakpoints, hasQuery, c.matched)}
              active={activeTerms.has(c.key)}
              title={`${c.key}: ${c.count}`}
              onClick={() => onCellClick(c.key)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// The label row above the grid - shared by both DayGrid and MonthGrid,
// regardless of whether `labels` is a dense set (one per column) or sparse
// (only some columns, e.g. month boundaries among many week columns).
function TopLabels ({ labels, cellWidth, width }: { labels: AxisLabel[], cellWidth: number, width: number }): JSX.Element {
  return (
    <div className='relative' style={{ width, height: LABEL_ROW_HEIGHT }}>
      {labels.map(({ index, label }) => (
        <div key={index} className='absolute top-0' style={{ left: index * (cellWidth + GAP) }}>
          {label}
        </div>
      ))}
    </div>
  )
}

// The label column to the left of the grid - same dense/sparse flexibility
// as TopLabels, placing each label at its explicit grid row so gaps in a
// sparse set don't compact the remaining labels upward.
function LeftLabels ({ labels, cellHeight, nRows }: { labels: AxisLabel[], cellHeight: number, nRows: number }): JSX.Element {
  return (
    <div
      className='grid shrink-0'
      style={{ width: LABEL_COL_WIDTH, gridTemplateRows: `repeat(${nRows}, ${cellHeight}px)`, rowGap: GAP }}
    >
      {labels.map(({ index, label }) => (
        <div key={index} className='flex items-center' style={{ gridRowStart: index + 1 }}>{label}</div>
      ))}
    </div>
  )
}

function Cell ({
  row,
  col,
  width,
  height,
  count,
  color,
  active,
  title,
  onClick
}: {
  row: number
  col: number
  width: number
  height: number
  count: number
  color: string
  active: boolean
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <div
      title={title}
      onClick={onClick}
      className={`rounded-[2px] cursor-pointer ${active ? 'ring-2 ring-tertiary ring-offset-1' : ''}`}
      style={{
        gridRowStart: row + 1,
        gridColumnStart: col + 1,
        width,
        height,
        backgroundColor: color,
        opacity: count === 0 ? 0.7 : 1
      }}
    />
  )
}

// Toggles `date` in/out of the set of selected dates, which live together
// as a single DATE:-prefixed, comma-joined search term (e.g.
// "DATE:2024-03-15,2024-03-20") so multiple dates can be selected at once -
// a plain space-separated term per date would AND them together via the
// normal search rules and always yield zero rows, since a message can only
// have one date. The DATE: prefix also lets this term be combined with
// ordinary free-text terms (typed, or added by clicking a wordcloud word)
// without the two being confused - see matchesByDay above, and
// isDateTerm/dateTermFragments in searchMatch.ts, which matchesQuery (and
// table_container.tsx's searchRows, which delegates to it) also use.
function toggleDateInSearch (date: string, currentSearch: string): string {
  const terms = queryTerms(currentSearch)
  const existingDateTerm = terms.find(isDateTerm)
  const otherTerms = terms.filter(t => !isDateTerm(t))

  const selected = new Set(existingDateTerm != null ? dateTermFragments(existingDateTerm) : [])
  if (selected.has(date)) {
    selected.delete(date)
  } else {
    selected.add(date)
  }

  const rebuilt = Array.from(selected).sort()
  return rebuilt.length > 0 ? [...otherTerms, `${DATE_PREFIX}${rebuilt.join(',')}`].join(' ') : otherTerms.join(' ')
}

function bounds (dayMap: Map<string, CalendarDayCount>): { minDate: Date | null, maxDate: Date | null } {
  let minKey: string | null = null
  let maxKey: string | null = null
  for (const key of dayMap.keys()) {
    if (minKey == null || key < minKey) minKey = key
    if (maxKey == null || key > maxKey) maxKey = key
  }
  return {
    minDate: minKey != null ? parseLocalDayKey(minKey) : null,
    maxDate: maxKey != null ? parseLocalDayKey(maxKey) : null
  }
}

// Parses a YYYY-MM-DD key as a local-timezone date. Using `new Date(string)`
// here would parse it as UTC midnight instead, which can shift the weekday
// or day-of-month by one depending on the viewer's timezone offset.
function parseLocalDayKey (key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function toLocalDayKey (date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays (date: Date, n: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + n)
  return next
}

// ISO-style week: Monday = 0 .. Sunday = 6
function isoWeekday (date: Date): number {
  return (date.getDay() + 6) % 7
}

function mondayOnOrBefore (date: Date): Date {
  return addDays(date, -isoWeekday(date))
}

function sundayOnOrAfter (date: Date): Date {
  return addDays(date, 6 - isoWeekday(date))
}

function formatMonth (date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short' }).format(date)
}

// Reference week 2024-01-01 (a Monday), used purely to get locale-correct
// weekday names in Mon..Sun order - mirrors the reference-week trick used by
// util.ts's "weekday_cycle" date formatter.
function weekdayShortLabels (locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  const labels: string[] = []
  for (let i = 0; i < 7; i++) labels.push(formatter.format(new Date(2024, 0, 1 + i)))
  return labels
}

function monthShortLabels (locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: 'short' })
  const labels: string[] = []
  for (let i = 0; i < 12; i++) labels.push(formatter.format(new Date(2024, i, 1)))
  return labels
}

// Splits the non-zero counts into 4 buckets via quartile breakpoints, so
// color intensity reflects the distribution actually in view rather than a
// fixed absolute scale (a chat history with 50 msgs/day peak and one with 5
// msgs/day peak should each still show visible contrast).
function computeBreakpoints (counts: number[]): [number, number, number] {
  const nonZero = counts.filter(c => c > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return [0, 0, 0]

  const quantile = (p: number): number => nonZero[Math.floor(p * (nonZero.length - 1))]
  return [quantile(0.25), quantile(0.5), quantile(0.75)]
}

// Picks the color family (plain primary scale with no active search; yellow
// for a day that matches the current search text; grey for one that
// doesn't) and the intensity within it (message-count quartile, same
// breakpoints regardless of family) - so "busy" days still read as busier
// whether they're highlighted or dimmed.
function colorFor (count: number, breakpoints: [number, number, number], hasQuery: boolean, matched: boolean): string {
  if (count === 0) return EMPTY_COLOR
  const level = count <= breakpoints[0] ? 1 : count <= breakpoints[1] ? 2 : count <= breakpoints[2] ? 3 : 4

  if (!hasQuery) return interpolateColor(SCALE_FROM, SCALE_TO, level / 4)
  return matched
    ? interpolateColor(YELLOW_FROM, YELLOW_TO, level / 4)
    : interpolateColor(GREY_FROM, GREY_TO, level / 4)
}

// Returns hex (not rgb(...)) specifically so its output can be fed back into
// hexToRgb/interpolateColor again - as YELLOW_FROM's definition above does -
// without the "rgb(...)" string being misparsed as hex (every channel comes
// out NaN, which browsers then silently ignore, leaving whatever
// background-color was already there instead of erroring visibly).
function interpolateColor (hexA: string, hexB: string, t: number): string {
  const [rA, gA, bA] = hexToRgb(hexA)
  const [rB, gB, bB] = hexToRgb(hexB)
  const r = Math.round(rA + (rB - rA) * t)
  const g = Math.round(gA + (gB - gA) * t)
  const b = Math.round(bA + (bB - bA) * t)
  return rgbToHex(r, g, b)
}

function hexToRgb (hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return [r, g, b]
}

function rgbToHex (r: number, g: number, b: number): string {
  const toHex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
