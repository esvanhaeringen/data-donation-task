// Splits a search query into its individual (non-empty) whitespace-separated
// terms. Shared by matchesQuery below and by callers that need to highlight
// each term rather than the query as one literal phrase.
export function queryTerms (query: string): string[] {
  return query.split(/\s+/).filter(t => t !== '')
}

// Marks a term as one or more comma-joined YYYY / YYYY-MM / YYYY-MM-DD
// fragments - produced when the calendar heatmap has one or more dates
// selected (e.g. "DATE:2024-03-15,2024-03-20"). The prefix is what lets a
// date term be told apart from an ordinary word once it's combined with
// free text in the same search box (e.g. by the calendar heatmap, which
// needs to test date terms against only a row's date column, and free-text
// terms against the rest of the row - see matchesByDay in
// calendar_heatmap.tsx). Without a prefix, a plain "2024-03-15" term looks
// exactly like any other literal substring term.
export const DATE_PREFIX = 'DATE:'
const DATE_OR_GROUP_RE = /^date:\d{4}(-\d{2}){0,2}(,\d{4}(-\d{2}){0,2})*$/i

export function isDateTerm (term: string): boolean {
  return DATE_OR_GROUP_RE.test(term)
}

// The individual date fragments a date term represents, prefix stripped.
export function dateTermFragments (term: string): string[] {
  return term.slice(DATE_PREFIX.length).split(',')
}

function termMatchesHaystack (haystack: string, term: string): boolean {
  // The literal comma-joined string (with its prefix) never appears in any
  // real timestamp, so a date term matches if ANY one of its fragments
  // does, rather than requiring the whole term as one substring like every
  // other term.
  if (isDateTerm(term)) return dateTermFragments(term).some(part => haystack.includes(part))
  return haystack.includes(term)
}

// Case-insensitive, all-terms match: the query is split on whitespace and
// every term must appear somewhere in the value (in any order, with
// anything in between), rather than the query matching as one literal
// substring. Non-string values (e.g. parsed references/sources arrays) are
// stringified first, so a match anywhere in their structured data counts.
export function matchesQuery (value: unknown, query: string): boolean {
  const terms = queryTerms(query).map(t => t.toLowerCase())
  if (terms.length === 0) return false
  const haystack = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).toLowerCase()
  return terms.every(term => termMatchesHaystack(haystack, term))
}
