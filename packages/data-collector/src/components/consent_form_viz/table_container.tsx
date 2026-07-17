import { useCallback, useMemo, useState, useEffect, useRef } from "react"
import { 
    Translator,
    Title4,
} from "@eyra/feldspar"
import TextBundle from "@eyra/feldspar"
import { 
    TableWithContext,
    PropsUITableRow,
} from "./types"
import { TableItems } from "./table_items"
import { Figure } from "./visualization_plugin/figure"
import { Table } from "./table"
import { matchesQuery, queryTerms } from "./visualization_plugin/searchMatch"

interface TableContainerProps {
  id: string
  table: TableWithContext
  updateTable: (tableId: string, table: TableWithContext) => void
  locale: string
}

export const TableContainer = ({ id, table, updateTable, locale }: TableContainerProps): JSX.Element => {
  const tableVisualizations = table.visualizations != null ? table.visualizations : []
  const [searchFilterIds, setSearchFilterIds] = useState<Set<string>>()
  const [search, setSearch] = useState<string>("")
  const lastSearch = useRef<string>("")
  const text = useMemo(() => getTranslations(locale), [locale])
  const [show, setShow] = useState<boolean>(!table.folded)

  useEffect(() => {
    const timer = setTimeout(() => {
      const ids = searchRows(table.originalBody.rows, search)
      setSearchFilterIds(ids)
      if (search !== "" && lastSearch.current === "") {
        setTimeout(() => setShow(true), 10)
      }
      lastSearch.current = search
    }, 300)
    return () => clearTimeout(timer)
  }, [search, lastSearch])

  const searchedTable = useMemo(() => {
    if (searchFilterIds === undefined) return table
    const filteredRows = table.body.rows.filter((row) => searchFilterIds.has(row.id))
    return { ...table, body: { ...table.body, rows: filteredRows } }
  }, [table, searchFilterIds])

  const handleDelete = useCallback(
    (rowIds?: string[]) => {
      if (rowIds == null) {
        if (searchedTable !== null) {
          // if no rowIds specified, delete all rows that meet search condition
          rowIds = searchedTable.body.rows.map((row) => row.id)
        } else {
          return
        }
      }
      if (rowIds.length > 0) {
        if (rowIds.length === searchedTable?.body?.rows?.length) {
          setSearch("")
          setSearchFilterIds(undefined)
        }
        const deletedRows = [...table.deletedRows, rowIds]
        const newTable = deleteTableRows(table, deletedRows)
        updateTable(id, newTable)
      }
    },
    [id, table, searchedTable]
  )

  const handleUndo = useCallback(() => {
    const deletedRows = table.deletedRows.slice(0, -1)
    const newTable = deleteTableRows(table, deletedRows)
    updateTable(id, newTable)
  }, [id, table])

  const handleClearMessage = useCallback(
    (rowId: string, visualization: any) => {
      const newTable = clearMessageFields(table, rowId, visualization, text.removedMessage)
      updateTable(id, newTable)
    },
    [id, table, text.removedMessage]
  )

  const unfilteredRows = table.body.rows.length

  return (
    <div
      key={table.id}
      className="p-3 md:p-4 lg:p-6 flex flex-col gap-4 w-full overflow-hidden border-[0.2rem] border-grey4 rounded-lg"
    >
      <div className="flex flex-wrap ">
        <div key="Title" className="flex sm:flex-row justify-between w-full gap-1 mb-2">
          <Title4 text={table.title} margin="" />
        </div>
        <div key="Description" className="flex flex-col w-full mb-2 text-base md:text-lg font-body max-w-2xl">
          <p>{table.description}</p>
        </div>
        <div key="TableSummary" className="flex items-center justify-between w-full mt-1 pt-1 rounded ">
          <TableItems table={table} searchedTable={searchedTable} handleUndo={handleUndo} locale={locale} />

          <button
            key={show ? "animate" : ""}
            className={`flex end gap-3 animate-fadeIn ${unfilteredRows === 0 ? "hidden" : ""}`}
            onClick={() => setShow(!show)}
          >
            <div key="zoomIcon" className="text-primary">
              {show ? zoomOutIcon : zoomInIcon}
            </div>
            <div key="zoomText" className="text-right hidden md:block">
              {show ? text.hideTable : text.showTable}
            </div>
          </button>
        </div>
        <div key="Table" className="w-full">
          <div className="">
            <Table
              show={show}
              table={searchedTable}
              search={search}
              unfilteredRows={unfilteredRows}
              handleDelete={handleDelete}
              handleUndo={handleUndo}
              locale={locale}
            />
          </div>
        </div>
        <div
          key="Visualizations"
          className={`pt-2 grid w-full gap-4 transition-all ${
            tableVisualizations.length > 0 && unfilteredRows > 0 ? "" : "hidden"
          }`}
        >
          {groupVisualizations(tableVisualizations).map((group, groupIndex) => (
            <div key={groupIndex} className="min-[1000px]:flex lg:flex-row flex-wrap gap-4">
              {group.map((vs: any, i: number) => (
                <div key={i} className="flex-1 min-w-[280px]">
                  <Figure
                    key={table.id + "_" + String(groupIndex) + "_" + String(i)}
                    tableInput={searchedTable}
                    fullTableInput={table}
                    search={search}
                    onSearch={setSearch}
                    visualizationInput={vs}
                    locale={locale}
                    handleDelete={handleDelete}
                    handleUndo={handleUndo}
                    handleClearMessage={(rowId) => handleClearMessage(rowId, vs)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Groups *consecutive* visualizations that share the same (non-null) `row`
// config value into one responsive flex row (see the className above:
// stacked below `lg`, side by side from `lg` up), so platform configs opt
// in per-visualization by giving siblings a matching "row" number - see
// e.g. chatgpt.py's calendar_heatmap/wordcloud pair. Anything without a
// `row`, or whose `row` differs from its neighbor, gets its own group and
// renders exactly as before (full width, on its own row).
function groupVisualizations(visualizations: any[]): any[][] {
  const groups: any[][] = []
  for (const vs of visualizations) {
    const currentGroup = groups[groups.length - 1]
    const previous = currentGroup?.[0]
    if (vs.row != null && previous?.row === vs.row) {
      currentGroup.push(vs)
    } else {
      groups.push([vs])
    }
  }
  return groups
}

function deleteTableRows(table: TableWithContext, deletedRows: string[][]): TableWithContext {
  const deleteIds = new Set<string>()
  for (const deletedSet of deletedRows) {
    for (const id of deletedSet) {
      deleteIds.add(id)
    }
  }

  const rows = table.originalBody.rows.filter((row) => !deleteIds.has(row.id))
  const deletedRowCount = table.originalBody.rows.length - rows.length
  return {
    ...table,
    body: { ...table.body, rows },
    deletedRowCount,
    deletedRows,
  }
}

// Clears every cell of the row identified by rowId, except the columns named
// by visualization.idColumn, visualization.reactionToColumn,
// visualization.titleColumn and visualization.roleColumn (so the row stays 
// anchored in its conversation). The messageColumn cell is replaced with 
// removedMessageText instead of being blanked, so it's clear in the UI that 
// the message was intentionally removed.
function clearMessageFields(
  table: TableWithContext,
  rowId: string,
  visualization: any,
  removedMessageText: string
): TableWithContext {
  const keptColumns = new Set<string>(
    [visualization?.idColumn, visualization?.reactionToColumn, visualization?.titleColumn, visualization?.roleColumn].filter(Boolean)
  )
  const messageColumn = visualization?.messageColumn

  const clearRow = (row: PropsUITableRow): PropsUITableRow => {
    if (row.id !== rowId) return row
    const cells = table.head.cells.map((column, i) => {
      if (keptColumns.has(column)) return row.cells[i]
      if (column === messageColumn) return removedMessageText
      return ""
    })
    return { ...row, cells }
  }

  return {
    ...table,
    body: { ...table.body, rows: table.body.rows.map(clearRow) },
    originalBody: { ...table.originalBody, rows: table.originalBody.rows.map(clearRow) },
  }
}

function searchRows(rows: PropsUITableRow[], search: string): Set<string> | undefined {
  // Delegates to the shared matchesQuery (AND-of-terms, substring match,
  // plus its date-OR-group handling for multi-date calendar selections)
  // rather than a separate regex implementation, so this stays consistent
  // with every other search consumer (wordcloud, chat conversation, the
  // calendar heatmap itself). Joining a row's cells with a newline before
  // matching keeps "each term somewhere in the row, possibly in different
  // cells" working the same as before, since a term can't accidentally
  // span two cells across that separator.
  if (queryTerms(search).length === 0) return undefined

  const ids = new Set<string>()
  for (const row of rows) {
    if (matchesQuery(row.cells.join('\n'), search)) ids.add(row.id)
  }

  return ids
}

const zoomInIcon = (
  <svg
    className="h-6 w-6"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6"
    />
  </svg>
)

const zoomOutIcon = (
  <svg
    className="h-6 w-6"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6"
    />
  </svg>
)

function getTranslations(locale: string): Record<string, string> {
  const translated: Record<string, string> = {}
  for (const [key, value] of Object.entries(translations)) {
    translated[key] = Translator.translate(value, locale)
  }
  return translated
}

const translations = {
  showTable: new TextBundle().add("en", "Show table").add("nl", "Tabel tonen"),
  hideTable: new TextBundle().add("en", "Hide table").add("nl", "Tabel verbergen"),
  removedMessage: new TextBundle().add("en", "<message is removed>").add("nl", "<bericht is verwijderd>"),
}
