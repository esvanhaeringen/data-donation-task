import { z } from "zod"

// In order to work towards making visualizations a plugin, we postpone type checking
// until the visualization is actually used. We use zod to define every type, so that
// we can parse the visualizations argument in PropsUIPromptConsentFormTable.

// Matching types from Feldspar
// We can either import these from Feldspare, or keep visualization plugin separate b
// duplicating the types here. Currently opting for duplication to avoid complexity
// (and if input format changes, the plugin would break regardless)

export const zTranslatable = z.record(z.string(), z.string())
export type Translatable = z.infer<typeof zTranslatable>

export const zLabel = z.union([zTranslatable, z.string()])
export type Label = z.infer<typeof zLabel>

// Table type, but only taking what we need
export const zTable = z.object({
  id: z.string(),
  head: z.object({ cells: z.array(z.string()) }),
  body: z.object({ rows: z.array(z.object({ id: z.string(), cells: z.array(z.string()) })) }),
})
export type Table = z.infer<typeof zTable>

// Visualization Types

export const zVisualizationProps = z.object({
  title: zTranslatable,
  height: z.number().optional(),
  // Groups this visualization with whichever *consecutive* sibling
  // visualizations share the same row number, laying them out side by side
  // on wide screens and stacked on narrow ones (see groupVisualizations in
  // table_container.tsx). Not to be confused with ChartVisualization's own
  // "group" field (its x-axis aggregation column) - this is purely a layout
  // hint and has no effect on any visualization's data.
  row: z.number().optional(),
})
export type VisualizationProps = z.infer<typeof zVisualizationProps>

export const zAggregationFunction = z.enum(["count", "mean", "sum", "count_pct", "pct"])
export type AggregationFunction = z.infer<typeof zAggregationFunction>

export const zDateFormat = z.enum([
  "auto",
  "year",
  "quarter",
  "month",
  "day",
  "hour",
  "month_cycle",
  "weekday_cycle",
  "hour_cycle",
])
export type DateFormat = z.infer<typeof zDateFormat>

export const zChartVisualizationType = z.enum(["line", "bar", "area"])
export type ChartVisualizationType = z.infer<typeof zChartVisualizationType>

export const zTextVisualizationType = z.enum(["wordcloud"])
export type TextVisualizationType = z.infer<typeof zTextVisualizationType>

export const zCalendarVisualizationType = z.enum(["calendar_heatmap"])
export type CalendarVisualizationType = z.infer<typeof zCalendarVisualizationType>

// Chart Visualizations

// External types (need schema)
export const zAxis = z.object({
  label: zLabel.optional(),
  column: z.string(),
})
export type Axis = z.infer<typeof zAxis>

export const zAggregationGroup = z.object({
  label: zLabel.optional(),
  column: z.string(),
  dateFormat: zDateFormat.optional(),
  range: z.array(z.number()).optional(),
  levels: z.array(z.string()).optional(),
})
export type AggregationGroup = z.infer<typeof zAggregationGroup>

export const zAggregationValue = z.object({
  label: zLabel.optional(),
  column: z.string().optional().default(".COUNT"),
  aggregate: zAggregationFunction.optional(),
  group_by: z.string().optional(),
  z: z.string().optional(),
  zAggregate: zAggregationFunction.optional(),
  addZeroes: z.boolean().optional(),
})
export type AggregationValue = z.infer<typeof zAggregationValue>

export const zChartVisualization = zVisualizationProps.extend({
  type: zChartVisualizationType,
  group: zAggregationGroup,
  values: z.array(zAggregationValue),
})
export type ChartVisualization = z.infer<typeof zChartVisualization>

// Internal types
export type TickerFormat = "percent" | "default"
export type XType = "string" | "date"

export interface AxisSettings {
  id: string
  label: Translatable | string
  tickerFormat: TickerFormat
}

export interface ChartVisualizationData {
  type: ChartVisualizationType
  data: Array<Record<string, any>>
  xKey: string
  xLabel: string | Translatable | undefined
  yKeys: Record<string, AxisSettings>
}

// Text Visualizations

// External types (need schema)

export const zTextVisualization = zVisualizationProps.extend({
  type: zTextVisualizationType,
  textColumn: z.string(),
  valueColumn: z.string().optional(),
  tokenize: z.boolean().optional(),
  extract: z.enum(["url_domain"]).optional(),
})
export type TextVisualization = z.infer<typeof zTextVisualization>

// Internal types

export interface ScoredTerm {
  text: string
  value: number
  importance: number
  rowIds?: string[]
}

export interface TextVisualizationData {
  type: TextVisualizationType
  topTerms: ScoredTerm[]
}

// Calendar Heatmap Visualizations

// External types (need schema)

export const zCalendarVisualization = zVisualizationProps.extend({
  type: zCalendarVisualizationType,
  dateColumn: z.string(),
})
export type CalendarVisualization = z.infer<typeof zCalendarVisualization>

// Internal types

export interface CalendarDayCount {
  date: string // YYYY-MM-DD, local timezone
  count: number
  timestamps: string[] // each contributing row's raw date-column value - date search terms (DATE:...) are matched against just this
  rowTexts: string[] // each contributing row's cells, joined - free-text search terms are matched against this instead
}

export interface CalendarVisualizationData {
  type: CalendarVisualizationType
  counts: CalendarDayCount[]
}

// Conversation Visualizations

// External types (need schema)

export const zConversationVisualization = zVisualizationProps.extend({
  type: z.literal("chat_conversation"),
  roleColumn: z.string(),
  messageColumn: z.string(),
  modelColumn: z.string().optional(),
  timestampColumn: z.string().optional(),
  titleColumn: z.string().optional(),
  referencesColumn: z.string().optional(),
  sourcesColumn: z.string().optional(),
  idColumn: z.string().optional(),
  reactionToColumn: z.string().optional(),
})
export type ConversationVisualization = z.infer<typeof zConversationVisualization>

// Internal types

// Content reference types, as found in ChatGPT export data (assistant message
// metadata.content_references). Only the fields we actually use are typed;
// unknown/unhandled types fall through to ContentReferenceUnknown.

export interface ContentReferenceEntity {
  type: 'entity'
  name?: string
  prompt_text?: string
  entity_data?: { website_url?: string, rating?: number, address?: string } | null
}

export interface WebpageItem {
  title?: string
  url?: string
  attribution?: string
  snippet?: string
  refs?: Array<{ ref_index: number, ref_type: string, turn_index: number }>
  // Additional webpages ChatGPT folded into this citation (e.g. multiple
  // sources backing the same claim). The main `url`/`title`/`attribution`
  // above are the citation's primary link; these are the rest.
  supporting_websites?: Array<{ title?: string, url?: string, attribution?: string, snippet?: string }>
}

export interface ContentReferenceGroupedWebpages {
  type: 'grouped_webpages' | 'webpage'
  items: WebpageItem[]
}

export interface MapEntity {
  name?: string
  entity?: { name?: string, address?: string, rating?: number } | null
}

export interface ContentReferenceMap {
  type: 'map'
  entities?: MapEntity[]
}

export interface ContentReferenceImageGroup {
  type: 'image_group'
  images?: unknown[]
}

export interface ContentReferenceDil {
  type: 'dil'
  name?: string
}

// Backs "url" markers whose second field is a positional reference key
// (e.g. "turn0search0") rather than an inline href. The real href isn't a
// separate field here - it's embedded as markdown in `alt`, e.g.
// "[Data Donation (D3I)](https://datadonation.eu/data-donation/)".
export interface ContentReferenceUrl {
  type: 'url'
  alt?: string
  title?: string
}

// Backs "video" markers (e.g. a cited news video result), despite its own
// type being "alt_text" rather than "video" - same positional-reference-key
// quirk as ContentReferenceUrl above, with the real destination URL embedded
// as markdown in `alt`, e.g.
// "[Nederlanders vrezen massaal voor escalatie Iranconflict (RTL Nieuws)](https://www.rtl.nl/...)".
export interface ContentReferenceAltText {
  type: 'alt_text'
  alt?: string
}

export interface ContentReferenceUnknown {
  type: string
  [key: string]: unknown
}

export type ContentReference =
  | ContentReferenceEntity
  | ContentReferenceGroupedWebpages
  | ContentReferenceMap
  | ContentReferenceImageGroup
  | ContentReferenceDil
  | ContentReferenceUrl
  | ContentReferenceAltText
  | ContentReferenceUnknown

// Search result group types, as found in ChatGPT export message metadata
// (metadata.search_result_groups). Only the fields we actually use are
// typed; the exact shape of this (currently undocumented) field may vary.

export interface SearchResultEntry {
  url?: string
  title?: string
  snippet?: string
  attribution?: string
}

export interface SearchResultGroup {
  domain?: string
  entries?: SearchResultEntry[]
  items?: SearchResultEntry[]
}

export interface ConversationMessage {
  id: string
  role: string
  message: string
  model?: string
  timestamp?: string
  references?: ContentReference[]
  sources?: SearchResultGroup[]
  messageId?: string
  reactionTo?: string
  // Set by prepareConversationData when this message shares its reactionTo
  // with sibling messages (e.g. regenerated assistant replies to the same
  // parent turn) - 1-based position and total count within that sibling
  // group, so the UI can show "Version i of N" instead of silently
  // flattening alternates into what looks like a linear sequence of turns.
  branchIndex?: number
  branchCount?: number
}

export interface Conversation {
  title: string
  date?: string
  rowIds: string[]
  messages: ConversationMessage[]
}

export interface ConversationVisualizationData {
  type: "chat_conversation"
  conversations: Conversation[]
  hasSources: boolean
}

// Visualization Type union

export type VisualizationData = ChartVisualizationData | TextVisualizationData | ConversationVisualizationData | CalendarVisualizationData

export const zVisualizationType = z.union([zChartVisualization, zTextVisualization, zConversationVisualization, zCalendarVisualization])
export type VisualizationType = z.infer<typeof zVisualizationType>
