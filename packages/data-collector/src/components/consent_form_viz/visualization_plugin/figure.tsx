import { VisualizationData, ChartVisualizationData, TextVisualizationData, ConversationVisualizationData, CalendarVisualizationData, Translatable, zTable, zVisualizationType } from './types'
import { memo, useEffect, useMemo, useState } from 'react'

import useVisualizationData from './visualizationDataFunctions/useVisualizationData'

import RechartsGraph, { helpText as chartHelp } from './figures/recharts_graph'
import VisxWordcloud, { helpText as wordcloudHelp } from './figures/d3_wordcloud'
import ChatConversation, { helpText as chatConversationHelp } from './figures/chat_conversation'
import CalendarHeatmap, { helpText as calendarHeatmapHelp } from './figures/calendar_heatmap'
import { zoomInIcon, zoomOutIcon } from './zoom_icons'
import { z } from 'zod'
import { Loader } from './ui/loader'
import { getTranslations, translate } from './translate'
import HelpSvg from '../assets/images/help.svg'

const doubleTypes = ['wordcloud', 'chat_conversation']

// Each figure component owns the explanation of its own visualization (see
// the exported helpText in the files imported above); this only maps the
// visualization type onto the right one, since the title - and therefore the
// help button next to it - is rendered here rather than in the components.
const helpTexts: Record<string, Translatable> = {
  line: chartHelp,
  bar: chartHelp,
  area: chartHelp,
  wordcloud: wordcloudHelp,
  chat_conversation: chatConversationHelp,
  calendar_heatmap: calendarHeatmapHelp
}
type ShowStatus = 'hidden' | 'visible' | 'double'

export interface FigureProps {
  tableInput: any
  fullTableInput: any
  search: string
  onSearch: (search: string) => void
  visualizationInput: any
  locale: string
  handleDelete: (rowIds: string[]) => void
  handleUndo: () => void
  handleRestore: (rowIds: string[]) => void
}

export const Figure = ({
  tableInput,
  fullTableInput,
  search,
  onSearch,
  visualizationInput,
  locale,
  handleDelete,
  handleUndo,
  handleRestore
}: FigureProps): JSX.Element => {
  const tableValidator = useMemo(() => zTable.safeParse(tableInput), [tableInput])
  const fullTableValidator = useMemo(() => zTable.safeParse(fullTableInput), [fullTableInput])
  const visualizationValidator = useMemo(() => zVisualizationType.safeParse(visualizationInput), [visualizationInput])

  if (!tableValidator.success || !fullTableValidator.success || !visualizationValidator.success) {
    if (!tableValidator.success) console.error(tableValidator.error)
    if (!fullTableValidator.success) console.error(fullTableValidator.error)
    if (!visualizationValidator.success) console.error(visualizationValidator.error)
    return <div />
  }

  return (
    <FigureComponent
      table={tableValidator.data}
      fullTable={fullTableValidator.data}
      search={search}
      onSearch={onSearch}
      visualization={visualizationValidator.data}
      locale={locale}
      handleDelete={handleDelete}
      handleUndo={handleUndo}
      handleRestore={handleRestore}
    />
  )
}

export interface ValidatedFigureProps {
  table: z.infer<typeof zTable>
  fullTable: z.infer<typeof zTable>
  search: string
  onSearch: (search: string) => void
  visualization: z.infer<typeof zVisualizationType>
  locale: string
  handleDelete: (rowIds: string[]) => void
  handleUndo: () => void
  handleRestore: (rowIds: string[]) => void
}

export const FigureComponent = ({
  table,
  fullTable,
  search,
  onSearch,
  visualization,
  locale,
  handleDelete,
  handleUndo,
  handleRestore
}: ValidatedFigureProps): JSX.Element => {
  // The chat visualization filters conversations and highlights matches
  // itself (see ChatConversation), rather than having non-matching rows
  // dropped before it ever sees them, so it needs the full, unfiltered
  // table. The calendar heatmap needs the same treatment: it's a navigation
  // aid for the search box, not itself a filtered view, so selecting a date
  // must not make every other date's cell go blank. Other visualization
  // types keep relying on the pre-filtered table.
  const selfFiltering = visualization.type === 'chat_conversation' || visualization.type === 'calendar_heatmap'
  const effectiveTable = selfFiltering ? fullTable : table
  const [visualizationData, status] = useVisualizationData(effectiveTable, visualization)
  const [longLoading, setLongLoading] = useState<boolean>(false)
  const [showStatus, setShowStatus] = useState<ShowStatus>('visible')
  const [resizeLoading, setResizeLoading] = useState<boolean>(false)
  const [showHelp, setShowHelp] = useState<boolean>(false)
  const help = helpTexts[visualization.type]

  // Escape closes the help overlay, matching how the other popups in these
  // visualizations behave.
  useEffect(() => {
    if (!showHelp) return
    function onKeyDown (e: KeyboardEvent): void {
      if (e.key === 'Escape') setShowHelp(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showHelp])

  useEffect(() => {
    if (status !== 'loading') {
      setLongLoading(false)
      return
    }
    const timer = setTimeout((): void => {
      setLongLoading(true)
    }, 1000)

    return () => clearTimeout(timer)
  }, [status])

  function toggleDouble (): void {
    setResizeLoading(true)
    if (showStatus === 'visible') {
      setShowStatus('double')
    } else {
      setShowStatus('visible')
    }
    setTimeout(() => {
      setResizeLoading(false)
    }, 150)
  }

  const canDouble = doubleTypes.includes(visualization.type)
  const { errorMsg, noDataMsg, helpMsg, closeMsg } = useMemo(() => prepareTexts(locale), [locale])

  if (visualizationData == null && status === 'loading') {
    if (longLoading) return <Loader />
    return <div />
  }
  if (status === 'error') {
    return <div className='flex justify-center items-center text-error'>{errorMsg}</div>
  }

  let height = visualization.height ?? 250
  if (showStatus === 'double') height = height * 2

  return (
    <div className='relative max-w overflow-hidden  bg-grey6 rounded-md border-[0.2rem] border-grey4'>
      <div className='flex justify-between'>
        <div className='flex items-center gap-2 p-3'>
          <div className='font-bold'>{translate(visualization.title, locale)}</div>
          {help != null && (
            <button onClick={() => setShowHelp(true)} title={helpMsg} aria-label={helpMsg}>
              <img src={HelpSvg} className='w-5 h-5 cursor-pointer' alt='' />
            </button>
          )}
        </div>
        <button onClick={toggleDouble} className={showStatus !== 'hidden' && canDouble ? 'text-primary' : 'hidden'}>
          {showStatus === 'double' ? zoomOutIcon : zoomInIcon}
        </button>
      </div>
      {showHelp && help != null && (
        <div
          className='absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4 cursor-pointer'
          onClick={() => setShowHelp(false)}
        >
          <div
            className='max-h-full w-full max-w-[36rem] overflow-auto rounded-md bg-grey6 p-5 shadow-2xl cursor-default'
            onClick={e => e.stopPropagation()}
          >
            <div className='flex justify-between items-start gap-4'>
              <div className='font-bold'>{translate(visualization.title, locale)}</div>
              <button onClick={() => setShowHelp(false)} className='text-primary font-bold cursor-pointer' aria-label={closeMsg}>
                {closeMsg}
              </button>
            </div>
            <div className='mt-3 whitespace-pre-line'>{translate(help, locale)}</div>
          </div>
        </div>
      )}
      <div className='w-full overflow-auto'>
        <div className='flex flex-col '>
          <div
            className='grid relative w-full pr-1  min-w-[250px]'
            style={{ gridTemplateRows: String(height) + 'px' }}
          >
            <RenderVisualization
              visualizationData={visualizationData}
              fallbackMessage={noDataMsg}
              loading={resizeLoading}
              locale={locale}
              search={search}
              onSearch={onSearch}
              handleDelete={handleDelete}
              handleRestore={handleRestore}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export const RenderVisualization = memo(
  ({
    visualizationData,
    fallbackMessage,
    loading,
    locale,
    search,
    onSearch,
    handleDelete,
    handleRestore
  }: {
    visualizationData: VisualizationData | undefined
    fallbackMessage: string
    loading: boolean
    locale: string
    search: string
    onSearch: (search: string) => void
    handleDelete: (rowIds: string[]) => void
    handleRestore: (rowIds: string[]) => void
  }): JSX.Element | null => {
    if (visualizationData == null) return null

    const fallback = <div className='m-auto font-bodybold text-4xl text-grey2 '>{fallbackMessage}</div>

    if (loading) return null

    if (['line', 'bar', 'area'].includes(visualizationData.type)) {
      const chartVisualizationData: ChartVisualizationData = visualizationData as ChartVisualizationData
      if (chartVisualizationData.data.length === 0) return fallback
      return <RechartsGraph visualizationData={chartVisualizationData} locale={locale} />
    }

    if (visualizationData.type === 'wordcloud') {
      const textVisualizationData: TextVisualizationData = visualizationData
      if (textVisualizationData.topTerms.length === 0) return fallback
      return <VisxWordcloud visualizationData={textVisualizationData} search={search} onSearch={onSearch} />
    }

    if (visualizationData.type === 'chat_conversation') {
      const convData = visualizationData as ConversationVisualizationData
      if (convData.conversations.length === 0) return fallback
      return <ChatConversation visualizationData={convData} locale={locale} search={search} onSearch={onSearch} handleDelete={handleDelete} handleRestore={handleRestore} />
    }

    if (visualizationData.type === 'calendar_heatmap') {
      const calendarData: CalendarVisualizationData = visualizationData
      if (calendarData.counts.length === 0) return fallback
      return <CalendarHeatmap visualizationData={calendarData} locale={locale} search={search} onSearch={onSearch} />
    }

    return null
  }
)

function prepareTexts (locale: string): Record<string, string> {
  const texts = {
    errorMsg: {
      en: 'Could not create visualization',
      nl: 'Kon visualisatie niet maken'
    },
    noDataMsg: {
      en: 'No data',
      nl: 'Geen data'
    },
    helpMsg: {
      en: 'What am I looking at?',
      nl: 'Wat zie ik hier?'
    },
    closeMsg: {
      en: 'Close',
      nl: 'Sluiten'
    }
  }

  return getTranslations(texts, locale)
}
