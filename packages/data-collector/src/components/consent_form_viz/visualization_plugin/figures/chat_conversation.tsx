import { Fragment, JSX, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Highlighter from 'react-highlight-words'
import {
  ConversationVisualizationData,
  Conversation,
  SearchResultGroup,
  ContentReference,
  ContentReferenceEntity,
  ContentReferenceGroupedWebpages,
  ContentReferenceMap,
  ContentReferenceImageGroup,
  ContentReferenceDil,
  ContentReferenceUrl,
  ContentReferenceAltText,
} from '../types'
import { getTranslations } from '../translate'
import { matchesQuery, queryTerms } from '../searchMatch'
import { buildLiteBlocks, InputSegment, LiteBlock, LiteInlineChild } from './liteMarkdown'
import { SearchBar } from '../../search_bar'
import RemoveSvg from '../../assets/images/remove.svg'
import BackSvg from '../../assets/images/back.svg'
import MapSvg from '../../assets/images/map.svg'
import ImagesSvg from '../../assets/images/images.svg'
import WidgetSvg from '../../assets/images/widget.svg'
import LinkSvg from '../../assets/images/link.svg'
import EntitySvg from '../../assets/images/entity.svg'

// This file renders ChatGPT export conversations end to end: the
// conversation/message list UI, ChatGPT's private-use-area reference-marker
// format, and the popups that are specific to a ChatGPT message (sources).
// Generic, reusable rendering primitives (the lite markdown parser, the
// raw-data-with-highlight popup) live in their own files and are imported
// above rather than duplicated here.

interface Props {
  visualizationData: ConversationVisualizationData
  locale: string
  search: string
  onSearch: (search: string) => void
  handleDelete: (rowIds: string[]) => void
  handleClearMessage: (rowId: string) => void
}

const pillButton = 'group flex items-center text-xs font-bold rounded-full cursor-pointer'
const sourcesPill = `${pillButton} text-grey1 hover:border-primary hover:bg-grey4 hover:text-primary`
const sourcesPillMatched = `${pillButton} px-1 text-black border-tertiary bg-tertiary hover:bg-tertiary/70`
const removePill = `${pillButton} text-error hover:border-error hover:bg-error hover:text-white`
const removeIcon = 'w-4 h-4 group-hover:brightness-0 group-hover:invert'
const backIcon = 'w-4 h-4 group-hover:brightness-0 group-hover:invert'
//  max-[500px]:hidden'

function highlight (text: string, query: string) {
  return (
    <Highlighter
      searchWords={queryTerms(query)}
      autoEscape
      textToHighlight={text}
      highlightClassName='bg-tertiary rounded-sm'
    />
  )
}

function useMediaQuery (query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

// Drives the docked-panel-vs-popup switch for the message view. Backed by
// matchMedia rather than a CSS-only "hidden below Xpx" class so the two
// layouts are strictly mutually exclusive from JS's point of view too - the
// click handler below reads this before deciding whether to open the
// mobile popup, instead of always opening it and trusting CSS to hide it
// again on wide screens.
function useIsNarrowViewport (breakpointPx: number): boolean {
  return useMediaQuery(`(max-width: ${breakpointPx - 1}px)`)
}

// True on devices with a real pointer that can hover (mouse/trackpad).
// False on touch-only devices, where CitationPill needs a tap-driven
// fallback since there's no hover state to reveal its popover.
function useCanHover (): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)')
}

// Stringifies a value the same way matchesQuery does internally, so several
// of them can be joined into one haystack before matching.
function toSearchableText (value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function conversationMatches (conv: Conversation, query: string): boolean {
  if (matchesQuery(conv.title, query)) return true
  // Joining the message's fields into one haystack (rather than testing the
  // whole query against each field separately) lets different terms of a
  // combined query match different fields of the same message - e.g.
  // "banana DATE:2024-03-17" needs "banana" found in msg.message and the
  // date found in msg.timestamp; requiring the *entire* query to match a
  // single field alone would never satisfy both at once.
  return conv.messages.some(msg =>
    matchesQuery([msg.message, msg.references, msg.sources, msg.timestamp].map(toSearchableText).join('\n'), query)
  )
}

// What's shown once a conversation is open, as a navigation stack rather
// than a set of independent popups: always starts at 'messages', with
// 'sources'/'details' pushed on top by a message's Sources/References
// button or a reference chip's click-to-inspect. This whole app can run
// embedded in an iframe that a host page auto-resizes to fit
// `document.body` (see ScriptHostComponent's ResizeObserver), which makes
// `position: fixed` + `vh`-based popups (the previous SourcesPopup/
// ReferenceDataPopup/mobile message popup) unreliable - their sizing is
// relative to a viewport the host is simultaneously resizing to match the
// content, which on mobile showed up as popups far taller than the visible
// screen with nested/competing scrollbars. Rendering each "screen" in flow
// instead, inside the same box Figure already gives this visualization a
// real pixel height for, sidesteps that entirely: there's always exactly
// one scroll container, sized by layout rather than by viewport units.
type Screen =
  | { kind: 'messages' }
  // parentLabel identifies what triggered the screen (e.g. "Message
  // a1b2c3" for a message's Sources/References pill, or "Widget:
  // world_cup_standings" for a chip's click-to-inspect - see
  // MessageContent's onShowRaw), shown alongside the screen's own generic
  // title (sourceDataMsg/referenceDataMsg) by renderScreenPanel/
  // renderExtraPanel so a details screen in particular - reachable from
  // several different chip kinds - says which one it came from.
  | { kind: 'sources', sources: SearchResultGroup[], parentLabel: string }
  | { kind: 'details', data: unknown, parentLabel: string }

export default function ChatConversation ({ visualizationData, locale, search, onSearch, handleDelete, handleClearMessage }: Props): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>(visualizationData.conversations)
  const [selectedTitle, setSelectedTitle] = useState<string | null>(
    visualizationData.conversations[0]?.title ?? null
  )
  // Below 1000px there's only one visible panel; this tracks whether it's
  // currently showing the conversation list or the message/sources/details
  // screen stack below.
  const [mobileMessagesOpen, setMobileMessagesOpen] = useState(false)
  const [screenStack, setScreenStack] = useState<Screen[]>([{ kind: 'messages' }])
  const isMobileLayout = useIsNarrowViewport(1000)
  const isPhoneLayout = useIsNarrowViewport(500)
  // From 1500px up there's room for a third, independent panel: 'messages'
  // stays put and always visible instead of being swapped out, and a
  // pushed 'sources'/'details' screen opens beside it rather than replacing
  // it - see renderExtraPanel. Below that, sources/details still swap in
  // over 'messages' in the same panel (renderScreenPanel), same as before.
  const isWideLayout = !useIsNarrowViewport(1500)
  const query = search.trim()

  function pushScreen (screen: Screen): void {
    setScreenStack(stack => [...stack, screen])
  }

  // A no-op at the base 'messages' screen (depth 1) rather than clearing the
  // stack to empty - the caller (renderScreenPanel's back button) is what
  // decides what happens next at that point (leaving to the conversation
  // list on mobile; nothing on desktop, where it's unreachable since the
  // header that calls this only renders at depth > 1 there).
  function popScreen (): void {
    setScreenStack(stack => (stack.length > 1 ? stack.slice(0, -1) : stack))
  }

  // The wide-layout third panel (renderExtraPanel) is closed rather than
  // navigated "back" through - it's an independent panel beside 'messages',
  // not a replacement for it, so there's nothing to step back to within it;
  // closing always returns to just showing 'messages', regardless of how
  // many screens got pushed on top in the meantime.
  function closeExtraPanel (): void {
    setScreenStack([{ kind: 'messages' }])
  }

  const currentScreen = screenStack[screenStack.length - 1]

  // The table (and therefore visualizationData) is recomputed asynchronously
  // by a worker, e.g. after handleClearMessage mutates a row. Re-sync local
  // state when a fresh visualizationData prop arrives, keeping the current
  // selection when possible.
  useEffect(() => {
    setConversations(visualizationData.conversations)
    setSelectedTitle(prev =>
      prev != null && visualizationData.conversations.some(c => c.title === prev)
        ? prev
        : visualizationData.conversations[0]?.title ?? null
    )
    setScreenStack([{ kind: 'messages' }])
  }, [visualizationData])

  const { selectMsg, noDataMsg, deletedMsg, sourcesMsg, detailsMsg, referenceDataMsg, sourceDataMsg, messageLabel, backMsg, removeMsg, searchPlaceholder, youMsg, assistantMsg } = getTranslations({
    selectMsg: { en: 'Select a conversation', nl: 'Selecteer een gesprek' },
    noDataMsg: { en: 'No messages', nl: 'Geen berichten' },
    deletedMsg: { en: 'Delete', nl: 'Verwijder' },
    sourcesMsg: { en: 'Sources', nl: 'Bronnen' },
    detailsMsg: { en: 'References', nl: 'Referenties' },
    referenceDataMsg: { en: 'Reference data', nl: 'Referentiegegevens' },
    sourceDataMsg: { en: 'Sources', nl: 'Bronnen' },
    messageLabel: { en: 'Message', nl: 'Bericht' },
    backMsg: { en: 'Back', nl: 'Terug' },
    removeMsg: { en: 'Remove message', nl: 'Verwijder bericht' },
    youMsg: { en: 'You', nl: 'Jij' },
    assistantMsg: { en: 'Assistant', nl: 'Assistent' },
    searchPlaceholder: { en: 'Search..', nl: 'Zoeken..' }
  }, locale)

  function deleteConversation (conv: Conversation): void {
    handleDelete(conv.rowIds)
    const remaining = conversations.filter(c => c.title !== conv.title)
    setConversations(remaining)
    if (selectedTitle === conv.title) {
      setSelectedTitle(remaining[0]?.title ?? null)
    }
  }

  const visibleConversations = query === ''
    ? conversations
    : conversations.filter(conv => conversationMatches(conv, query))

  const selectedConversation =
    visibleConversations.find(c => c.title === selectedTitle) ??
    visibleConversations[0] ??
    null
  const activeTitle = selectedConversation?.title ?? null

  // Whichever conversation ends up active - picked directly or, if the one
  // the user had open got filtered out by a search, fallen back to above -
  // always starts back at the message screen, so a sources/details screen
  // left open from a previous conversation is never shown against the
  // wrong one.
  useEffect(() => {
    setScreenStack([{ kind: 'messages' }])
  }, [activeTitle])

  // On mobile, if the conversation the user has open stops matching a new
  // search (filtered out of visibleConversations above), pop back to the
  // conversation list - which still reflects the narrower set of matches -
  // rather than continuing to show a conversation that no longer fits the
  // query. Deliberately keyed only on the query changing: switching to a
  // different conversation manually shouldn't trigger this, only a search
  // invalidating the one currently open should.
  useEffect(() => {
    if (selectedTitle != null && !visibleConversations.some(c => c.title === selectedTitle)) {
      setMobileMessagesOpen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // The conversation list itself - the desktop-docked left panel's entire
  // content, and (on mobile) one of the two things the single panel below
  // can be showing.
  const conversationListPanel = (
    <>
      <div className='shrink-0 p-2 border-b border-grey4'>
        <SearchBar placeholder={searchPlaceholder} search={search} onSearch={onSearch} />
      </div>
      <div className='shrink-0 p-2 border-b border-grey4 flex items-center justify-between'>
        { query === '' ? (
          <span className='italic text-sm'>{"Your data contains "} {visibleConversations.length} {visibleConversations.length === 1 ? 'conversation' : 'conversations'}</span>
        ) :
        (
          <span className='italic text-sm'>{visibleConversations.length} {visibleConversations.length === 1 ? 'conversation contains messages that match your search' : 'conversations contain messages that match your search'}</span>
        )
      }
      </div>
      <div className='overflow-y-auto flex flex-col'>
        {visibleConversations.map(conv => (
          <div
            key={conv.title}
            onClick={() => { setSelectedTitle(conv.title); if (isMobileLayout) setMobileMessagesOpen(true) }}
            className={`flex items-start justify-between gap-1 px-3 py-2 cursor-pointer border-b border-grey4 hover:bg-grey5 ${
              activeTitle === conv.title ? 'bg-grey4 font-bold' : ''
            }`}
          >
            <div className='flex flex-col overflow-hidden'>
              <span className='text-sm truncate'>
                {highlight(conv.title, query)}
              </span>
              {conv.date != null && (
                <span className='text-xs text-grey2'>{formatDate(conv.date, locale)}</span>
              )}
            </div>
            <button
              onClick={e => { e.stopPropagation(); deleteConversation(conv) }}
              className={`shrink-0 mt-0.5 ${removePill}`}
              title={deletedMsg}
            >
              <img src={RemoveSvg} className={removeIcon} />
            </button>
          </div>
        ))}
      </div>
    </>
  )

  // The base 'messages' screen's content - shared between the desktop
  // docked right panel and the mobile single panel, same as before, just no
  // longer wrapped in a popup (see renderScreenPanel/Screen above).
  const messagesScreenBody = (
    // js-message-panel is a plain selector hook (no styling role) so
    // CitationPill can find this panel's bounds via closest() to keep its
    // tooltip positioned within it, rather than the viewport.
    <div className='js-message-panel flex-1 overflow-y-auto h-full overflow-x-hidden p-3 flex flex-col gap-2'>
      {selectedConversation == null
        ? <div className='m-auto text-grey2'>{selectMsg}</div>
        : selectedConversation.messages.length === 0
          ? <div className='m-auto text-grey2'>{noDataMsg}</div>
          : selectedConversation.messages.map(msg => {
              const isUser = msg.role === 'user'
              // handleClearMessage blanks every field except id/reactionTo/title/role,
              // an empty timestamp reliably marks an already-removed message.
              const isRemoved = msg.timestamp === ''
              const messageSources = msg.sources?.flatMap(group => group.entries ?? group.items ?? []) ?? []
              const sourcesMatched = matchesQuery(msg.sources, query)
              const detailsMatched = matchesQuery(msg.references, query)
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col max-w-[90%] py-1 ${isUser ? 'self-end items-end' : 'self-start items-start'}`}
                >
                  <div
                    className={`px-3 py-2 w-full rounded-2xl text-sm whitespace-pre-wrap break-words ${
                      isUser
                        ? 'bg-primary text-white rounded-br-sm'
                        : 'bg-grey4 text-black rounded-bl-sm'
                    }`}
                  >
                    <MessageContent
                      message={msg.message}
                      references={msg.references}
                      locale={locale}
                      searchQuery={query}
                      onShowRaw={(data, parentLabel) => pushScreen({ kind: 'details', data, parentLabel })}
                    />
                  </div>
                  <div className='flex items-start gap-2 mt-0.5 px-1'>
                    <span className="text-xs italic text-grey2">
                      {!isUser &&
                        msg.model != null &&
                        msg.model !== "" &&
                        (!isPhoneLayout
                          ? `${assistantMsg} (${msg.model})`
                          : msg.model)}

                      {isUser && youMsg}

                      {msg.timestamp != null &&
                        msg.timestamp !== "" &&
                        ` at ${formatDate(msg.timestamp, locale)}`}

                      {msg.branchCount != null &&
                        msg.branchCount > 1 &&
                        ` ${msg.branchIndex}/${msg.branchCount}`}
                    </span>
                    {messageSources.length > 0 && (
                      <button
                        onClick={() => pushScreen({ kind: 'sources', sources: msg.sources ?? [], parentLabel: `${messageLabel} ${msg.id}` })}
                        className={sourcesMatched ? sourcesPillMatched : sourcesPill}
                        title={sourcesMsg}
                      >
                        {/* <img src={SourcesSvg} className={sourcesIcon} /> */}
                        {sourcesMsg}
                      </button>
                    )}
                    {msg.references != null && msg.references.length > 0 && (
                      <button
                        onClick={() => pushScreen({ kind: 'details', data: msg.references ?? [], parentLabel: `${messageLabel} ${msg.id}` })}
                        className={detailsMatched ? sourcesPillMatched : sourcesPill}
                        title={detailsMsg}
                      >
                        {detailsMsg}
                      </button>
                    )}
                    {!isRemoved && (
                      <button
                        onClick={() => handleClearMessage(msg.id)}
                        className={removePill}
                        title={removeMsg}
                      >
                        <img src={RemoveSvg} className={removeIcon} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })
      }
    </div>
  )

  return (
    <div className='flex flex-row h-full overflow-hidden'>
      {/* Desktop (>=1000px): conversation list always docked on the left. */}
      {!isMobileLayout && (
        <div className='flex-1 border-r border-grey4 flex flex-col overflow-hidden'>
          {conversationListPanel}
        </div>
      )}

      {/* Desktop's messages panel (docked beside the list above) and
          mobile's single panel (swapped with the conversation list below).
          Below 1500px this renders whatever's on top of screenStack (see
          renderScreenPanel) - sources/details swap in over it, same panel.
          From 1500px up (isWideLayout) it always shows 'messages' as-is
          instead, regardless of stack depth, since a pushed sources/details
          screen gets its own panel there (below) rather than replacing this
          one. isMobileLayout is the single source of truth for which of the
          two top-level layouts renders - no CSS-only "hidden below Xpx"
          class, so they can never both be showing. */}
      {!isMobileLayout ? (
        <div className='flex-2 border-r border-grey4 flex flex-col overflow-hidden'>
          {isWideLayout ? messagesScreenBody : renderScreenPanel()}
        </div>
      ) : (
        <div className='flex-1 flex flex-col overflow-hidden'>
          {mobileMessagesOpen && selectedConversation != null ? renderScreenPanel() : conversationListPanel}
        </div>
      )}

      {/* Wide layout's third panel: only present once something's been
          pushed on top of 'messages', and closes (rather than navigates
          back) since it's independent of the always-visible messages panel
          beside it - see renderExtraPanel/closeExtraPanel. */}
      {isWideLayout && screenStack.length > 1 && (
        <div className='flex-1 flex flex-col overflow-hidden border-l border-grey3 bg-grey5'>
          {renderExtraPanel()}
        </div>
      )}
    </div>
  )

  // A screen's header title: for 'messages' just the conversation's own
  // title (unchanged); for 'sources'/'details' the screen's generic label
  // (sourceDataMsg/referenceDataMsg) plus that particular screen's
  // parentLabel, identifying what triggered it - a details screen in
  // particular is reachable from several different chip kinds (map/images/
  // widget/unknown/entity) as well as a message's References pill, so the
  // generic "Reference data" label alone wouldn't say which one this is.
  function screenTitle (screen: Screen): string {
    if (screen.kind === 'messages') return selectedConversation?.title ?? ''
    const baseLabel = screen.kind === 'sources' ? sourceDataMsg : referenceDataMsg
    return `${baseLabel} · ${screen.parentLabel}`
  }

  // Renders whichever screen is on top of screenStack, with a back button
  // above it once there's somewhere to go back to: on mobile that's true
  // from the very first ('messages') screen (back leads to the
  // conversation list, via mobileMessagesOpen); on the narrower desktop
  // tier (1000-1499px) the list is already permanently visible in its own
  // docked panel, so the header only appears once a 'sources'/'details'
  // screen has been pushed on top of 'messages'. Not used at all on
  // isWideLayout - there 'messages' renders directly (see the return
  // statement above) and a pushed screen gets renderExtraPanel's own panel
  // instead, so this never needs to show 'sources'/'details' there.
  function renderScreenPanel (): JSX.Element {
    const showHeader = isMobileLayout || screenStack.length > 1

    const onBack = (): void => {
      if (screenStack.length > 1) popScreen()
      else setMobileMessagesOpen(false)
    }

    return (
      <>
        {showHeader && (
          <div className='shrink-0 flex items-center gap-2 p-2 border-b border-grey4'>
            <button onClick={onBack} className='shrink-0 text-grey2 hover:text-black text-xl leading-none px-1 cursor-pointer' title={backMsg}>
              <img src={BackSvg} className={backIcon} />
            </button>
            <span className='text-sm font-bold truncate flex-1'>{screenTitle(currentScreen)}</span>
          </div>
        )}
        {currentScreen.kind === 'messages' && messagesScreenBody}
        {currentScreen.kind === 'sources' && <SourcesScreen sources={currentScreen.sources} locale={locale} searchQuery={query} />}
        {currentScreen.kind === 'details' && <DetailsScreen data={currentScreen.data} searchQuery={query} />}
      </>
    )
  }

  // isWideLayout's third panel - only ever rendered while screenStack.length
  // > 1 (see the return statement above), so currentScreen here is always
  // 'sources' or 'details', never the base 'messages' screen.
  function renderExtraPanel (): JSX.Element {
    return (
      <>
        <div className='shrink-0 flex items-center gap-2 p-2 border-b border-grey4'>
          <span className='text-sm font-bold truncate flex-1'>{screenTitle(currentScreen)}</span>
          <button onClick={closeExtraPanel} className='shrink-0 text-grey2 hover:text-black text-2xl leading-none px-1'>&times;</button>
        </div>
        {currentScreen.kind === 'sources' && <SourcesScreen sources={currentScreen.sources} locale={locale} searchQuery={query} />}
        {currentScreen.kind === 'details' && <DetailsScreen data={currentScreen.data} searchQuery={query} />}
      </>
    )
  }

  function formatDate (isoString: string, locale: string): string {
    try {
      if (isPhoneLayout) {
        return new Date(isoString).toLocaleDateString(locale, {
          year: 'numeric', month: 'numeric', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false
        })
      }
      return new Date(isoString).toLocaleString(locale, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      })
    } catch {
      return isoString
    }
  }
}


// --- Message content rendering -------------------------------------------
//
// Renders a single message's body: resolves ChatGPT's reference markers
// (see resolveMessageReferences below) into segments, runs those through
// the generic lite markdown parser, then renders the resulting blocks with
// ChatGPT-specific chip styling (entity/citation/map/images/widget).

interface CitationWebpage {
  title?: string
  url?: string
  attribution?: string
}

interface CitationSource extends CitationWebpage {
  snippet?: string
  // Additional webpages ChatGPT grouped under this same citation marker;
  // shown in a hover popover alongside the main title/url/attribution above.
  supportingWebsites?: CitationWebpage[]
}

interface MapPlace {
  name?: string
  address?: string
  rating?: number
}

type ReferenceSegment =
  | { kind: 'entity', name: string, disambiguation?: string, url?: string, raw: unknown }
  | { kind: 'url', text: string, href?: string }
  | { kind: 'video', text: string, href?: string }
  | { kind: 'citation', sources: CitationSource[] }
  | { kind: 'map', places: MapPlace[], raw: unknown }
  | { kind: 'images', count: number, raw: unknown }
  | { kind: 'widget', name: string, raw: unknown }
  // Catch-all for marker keywords and content_reference types this parser
  // doesn't otherwise recognize (a future ChatGPT export format change, or
  // any keyword-resolver below bottoming out with nothing useful to show):
  // keeps the marker visible instead of silently vanishing, with the raw
  // underlying data reachable via the same click-to-inspect popup as
  // entity/map/images/widget.
  | { kind: 'unknown', keyword: string, raw: unknown }

type MessageSegment = InputSegment<ReferenceSegment>

interface MessageContentProps {
  message: string
  references: ContentReference[] | undefined
  locale: string
  searchQuery?: string
  // Pushes a 'details' screen (see Screen/renderScreenPanel in
  // ChatConversation) showing this raw data - replaces what used to be a
  // ReferenceDataPopup owned locally by this component. parentLabel
  // identifies which chip triggered it (e.g. "Widget: world_cup_standings"),
  // shown in that screen's header alongside its generic title.
  onShowRaw: (data: unknown, parentLabel: string) => void
}

interface Labels {
  imagesLabel: string
  widgetLabel: string
  mapLabel: string
  unknownLabel: string
  entityLabel: string
}

// Content reference elements (map/images/widget/entity-without-a-link) open
// a popup showing the raw structured data behind them when clicked.
const clickableRef = 'cursor-pointer hover:ring-2 hover:ring-primary/40'
// Applied on top of a reference element's own styling when the current
// search query matches somewhere in its underlying structured data.
const matchedRef = 'ring-2 ring-tertiary bg-tertiary/40'

function MessageContent ({ message, references, locale, searchQuery = '', onShowRaw }: MessageContentProps) {
  const segments = resolveMessageReferences(message, references)
  const blocks = buildLiteBlocks(segments)
  const query = searchQuery.trim()
  const labels = getTranslations({
    imagesLabel: { en: 'Images', nl: 'Afbeeldingen' },
    widgetLabel: { en: 'Widget', nl: 'Widget' },
    mapLabel: { en: 'Map', nl: 'Kaart' },
    unknownLabel: { en: 'Unknown', nl: 'Onbekend' },
    entityLabel: { en: 'Entity', nl: 'Entiteit' },
  }, locale) as unknown as Labels

  const elements: Array<ReturnType<typeof renderBlock>> = []
  let listBuffer: Array<{ children: Array<LiteInlineChild<ReferenceSegment>> }> = []

  const flushList = (key: string): void => {
    if (listBuffer.length === 0) return
    elements.push(
      <ul key={key} className='list-disc list-outside pl-4 my-1'>
        {listBuffer.map((item, i) => (
          <li key={i}>{item.children.map((child, j) => <Fragment key={j}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}</li>
        ))}
      </ul>
    )
    listBuffer = []
  }

  blocks.forEach((block, i) => {
    if (block.kind === 'listItem') {
      listBuffer.push(block)
      return
    }
    flushList(`list-${i}`)
    elements.push(<Fragment key={i}>{renderBlock(block, labels, query, onShowRaw)}</Fragment>)
  })
  flushList('list-end')

  return <>{elements}</>
}

function renderBlock (block: LiteBlock<ReferenceSegment>, labels: Labels, query: string, onShowRaw: (data: unknown, parentLabel: string) => void) {
  switch (block.kind) {
    case 'heading': {
      const headingClass = block.level === 1 ? 'text-xl font-bold' : block.level === 2 ? 'text-lg font-bold' : block.level === 3 ? 'text-base font-semibold' : 'text-sm font-bold'
      return (
        <div className={`${headingClass} mt-1`}>
          {block.children.map((child, j) => <Fragment key={j}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
        </div>
      )
    }

    case 'table':
      return (
        <div className='my-1 rounded-lg inline-auto border border-grey4 overflow-x-auto overflow-y-hidden'>
          <table className='text-xs'>
            {block.header.length > 0 && (
              <thead>
                <tr>
                  {block.header.map((cell, i) => (
                    <th key={i} className='border border-grey4 bg-primary/20 px-2 py-1 text-left font-bold'>
                      {cell.map((child, j) => <Fragment key={j}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    // extra column that extends beyond the header row is a "details" column, which is visually separated
                    // from the rest of the table with a different background color
                    j > block.header.length - 1 ? (
                      <td key={j} className=''>
                        {cell.map((child, k) => <Fragment key={k}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
                      </td>
                    ) :
                      <td key={j} className='border border-grey4 px-2 py-1 bg-grey6'>
                        {cell.map((child, k) => <Fragment key={k}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
                      </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'codeBlock':
      return (
        <div className='my-1'>
          {block.language != null && block.language !== '' && (
            <div className='text-[0.65rem] text-grey2 font-semibold px-1'>{block.language}</div>
          )}
          <pre className='rounded-lg bg-grey6 border border-grey4 p-2 text-xs overflow-x-auto whitespace-pre'>
            <code>{highlight(block.code, query)}</code>
          </pre>
        </div>
      )

    case 'paragraph':
      return (
        <div>
          {block.children.length === 0 ? ' ' : block.children.map((child, j) => <Fragment key={j}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
        </div>
      )

    case 'blockquote':
      return (
        <blockquote className='my-1 border-s-[.25rem] border-grey2 pl-2 text-grey1 bg-grey5'>
          {block.lines.map((line, i) => (
            <div key={i}>
              {line.length === 0 ? ' ' : line.map((child, j) => <Fragment key={j}>{renderInline(child, labels, query, onShowRaw)}</Fragment>)}
            </div>
          ))}
        </blockquote>
      )

    case 'horizontalRule':
      return <hr className='border-grey3' />

    default:
      return <></>
  }
}

function renderInline (child: LiteInlineChild<ReferenceSegment>, labels: Labels, query: string, onShowRaw: (data: unknown, parentLabel: string) => void) {
  switch (child.type) {
    case 'text':
      return highlight(child.value, query)
    case 'bold':
      return <span className='font-semibold'>{highlight(child.value, query)}</span>
    case 'italic':
      return <em>{highlight(child.value, query)}</em>
    case 'ref':
      return renderReference(child.segment, labels, query, onShowRaw)
    default:
      return null
  }
}

function renderReference (segment: ReferenceSegment, { imagesLabel, widgetLabel, mapLabel, unknownLabel, entityLabel }: Labels, query: string, onShowRaw: (data: unknown, parentLabel: string) => void) {
  switch (segment.kind) {
    case 'entity':
      return <EntityChip segment={segment} query={query} onShowRaw={onShowRaw} parentLabel={`${entityLabel}: ${segment.name}`} />

    case 'url':
      return segment.href != null
        ? (
          <a
            href={segment.href}
            target='_blank'
            rel='noopener noreferrer'
            className='text-primary hover:underline'
          >
            {segment.text}
          </a>
          )
        : (
          <span>{segment.text}</span>
          )

    case 'video':
      return segment.href != null
        ? (
          <a
            href={segment.href}
            target='_blank'
            rel='noopener noreferrer'
            className='text-primary hover:underline'
          >
            {segment.text}
          </a>
          )
        : (
          <span>{segment.text}</span>
          )

    case 'citation':
      return (
        <span className='inline-flex gap-0.5 align-super text-[0.65rem]'>
          {segment.sources.map((source, i) => (
            <CitationPill key={i} source={source} query={query} />
          ))}
        </span>
      )

    case 'map':
      return (
        <span
          onClick={() => onShowRaw(segment.raw, mapLabel)}
          className={`block my-1 rounded-lg border border-grey4 bg-grey6 p-2 text-xs ${clickableRef} ${matchesQuery(segment.raw, query) ? matchedRef : ''}`}
        >
          <div className='flex items-center gap-1 mb-1'>
            <img src={MapSvg} className='w-5 h-5' />
            <span className='font-bold text-sm'>{mapLabel}</span>
          </div>
          {segment.places.map((place, i) => (
            <span key={i} className='block'>
              <span className='font-normal'>{place.name}</span>
              {place.address != null && <span className='text-grey2'> — {place.address}</span>}
              {place.rating != null && <span className='text-grey2'> ({place.rating}★)</span>}
            </span>
          ))}
        </span>
      )

    case 'images':
      return (
        <div
          onClick={() => onShowRaw(segment.raw, imagesLabel)}
          className={`inline-flex items-center gap-1 m-1 inline-block rounded-full bg-grey6 px-3 py-2.5 ${clickableRef} ${matchesQuery(segment.raw, query) ? matchedRef : ''}`}
        >
          <img src={ImagesSvg} className='w-5 h-5 pr-1' />
          <span className='text-sm text-black'>
            {segment.count} {imagesLabel}
          </span>
        </div>
      )

    case 'widget':
      return (
        <div
          onClick={() => onShowRaw(segment.raw, `${widgetLabel}: ${segment.name}`)}
          className={`inline-flex items-center gap-1 m-1 inline-block rounded-full bg-grey6 px-3 py-2.5 ${clickableRef} ${matchesQuery(segment.raw, query) ? matchedRef : ''}`}
        >
          <img src={WidgetSvg} className='w-5 h-5 pr-1' />
          <span className='text-sm text-black'>
            {widgetLabel}: {segment.name}
          </span>
        </div>
      )

    case 'unknown':
      return (
        <span
          onClick={() => onShowRaw(segment.raw, `${unknownLabel}: ${segment.keyword}`)}
          title={segment.keyword}
          className={`inline-flex items-center gap-1 m-1 inline-block rounded-full bg-grey6 px-3 py-2.5 ${clickableRef} ${matchesQuery(segment.raw, query) ? matchedRef : ''}`}
        >
          [{segment.keyword}]
        </span>
      )

    default:
      return null
  }
}

// A citation pill's hover popover: same list-item style as SourcesPopup
// (link icon + title, opening in a new tab), just compact enough to fit a
// floating box instead of a modal.
function renderCitationEntry (entry: CitationWebpage, key: string | number) {
  return (
    <li key={key} className='text-xs border-b border-grey4 pb-1 last:border-none last:pb-0'>
      {entry.url != null
        ? (
          <a
            href={entry.url}
            target='_blank'
            rel='noopener noreferrer'
            className='flex items-center gap-1 text-primary hover:underline font-semibold'
          >
            <img src={LinkSvg} className='w-3 h-3 shrink-0' />
            {/* min-w-0 overrides the flex item's default min-width:auto,
                which otherwise stops it from shrinking below its content's
                intrinsic (unwrapped) width - without it, break-words has
                nothing to wrap against and the row just overflows instead. */}
            <span className='min-w-0 break-words'>{entry.attribution ?? entry.title ?? entry.url}</span>
          </a>
          )
        : (
          <span className='font-semibold'>{entry.attribution ?? entry.title}</span>
          )}
      {entry.attribution != null && entry.title != null && (
        <div className='text-grey2'>{entry.title}</div>
      )}
    </li>
  )
}

// Shared hover/tap-to-reveal popover state for a citation source's link,
// used both by the standalone CitationPill (a dedicated link pill, for
// "cite" citations) and by EntityChip below (triggered by hovering the
// entity chip itself, with no separate pill needed - matching how ChatGPT's
// own UI surfaces an entity's link; see resolveCitation's module comment
// for why entity self-citations don't get their own citation marker).
// Extracted so the interaction (positioning, hover-vs-tap behavior) is only
// implemented once; callers wire wrapperRef/openTooltip/closeTooltip onto
// whatever their own trigger element is.
//
// On devices with a real pointer (useCanHover), hovering the trigger (or
// the popover itself, once open - see the mouseenter/mouseleave on both the
// trigger and the portaled tooltip) shows a tooltip anchored below it.
//
// The tooltip (and the touch modal) are rendered via a portal into
// document.body rather than as a normal DOM child of the trigger, because a
// citation can end up inside a table cell - and a wide table's own
// overflow-x-auto/overflow-y-hidden (needed so it can scroll instead of
// blowing out the message bubble) clips ANY descendant painted inside it,
// including position:fixed ones; only actually moving the element out of
// that DOM subtree escapes it. Since portaling forfeits the normal
// "position:absolute relative to a positioned ancestor" trick, position is
// instead computed by hand in openTooltip below (in fixed/viewport
// coordinates) and clamped against the message panel's own bounding rect
// (found via closest('.js-message-panel')) on both axes - flipping above
// the trigger instead of below if there isn't room underneath - so the
// tooltip still reads as "anchored to the panel", not just "floating
// somewhere on the page".
//
// Touch devices have no hover state to reveal the tooltip via mouseenter,
// so callers wire a tap instead (via openTooltip, same as hover - see
// CitationPill's onClick) to open the exact same anchored tooltip, rather
// than a separate centered modal: unlike the old touch modal this replaced
// (which sized itself with `max-h-[70vh]`), this tooltip's box has always
// been a real fixed size (`max-h-64`) positioned from live
// getBoundingClientRect() measurements, not viewport units, so it doesn't
// share the `vh`-inside-an-auto-resizing-iframe fragility that made popups
// elsewhere in this file too tall on mobile. Once open on a touch device, a
// transparent full-viewport tap-catcher (below the tooltip in z-index, so
// taps on the tooltip's own content/links still reach it) closes it on the
// next tap anywhere else - a real element with its own onClick, not a
// document-wide "click outside" listener, since those are unreliable on iOS
// Safari for elements with no click handler of their own. EntityChip
// doesn't wire up a tap trigger for this - tapping the entity chip keeps
// its existing raw-data-inspect behavior instead, since there's no hover
// state on touch to distinguish "show the link" from "show the debug data".
function useCitationTooltip (source: CitationSource) {
  const [open, setOpen] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0, flipped: false })
  const canHover = useCanHover()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)

  const closeTooltip = (): void => setOpen(false)

  // tooltipPos is a snapshot taken once, in openTooltip, when the tooltip is
  // triggered - it isn't kept in sync afterwards. Scrolling anywhere that
  // could move the trigger relative to it (the message panel itself, or the
  // page around it) would otherwise leave the tooltip visually detached
  // from whatever it's meant to be anchored to, since it's positioned with
  // `fixed` viewport coordinates rather than tracking the trigger's layout
  // position. Closing on scroll sidesteps that instead of re-measuring
  // continuously. Attached to `window` with `capture: true` because native
  // `scroll` events don't bubble, but still propagate in the capture phase
  // from any nested scrollable ancestor (e.g. the message panel's own
  // overflow-y-auto) - so this alone catches scrolling both the panel and
  // the page around it.
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', closeTooltip, true)
    return () => window.removeEventListener('scroll', closeTooltip, true)
  }, [open])

  const openTooltip = (): void => {
    const wrapper = wrapperRef.current
    const tooltip = tooltipRef.current
    if (wrapper != null && tooltip != null) {
      const wrapperRect = wrapper.getBoundingClientRect()
      const panel = wrapper.closest('.js-message-panel')
      // Falls back to the viewport if the panel marker isn't found for
      // some reason, rather than skipping the clamp entirely.
      const bounds = panel != null
        ? panel.getBoundingClientRect()
        : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
      const margin = 8

      // tooltip.offsetWidth/offsetHeight work here even before the tooltip
      // is visible because it's hidden via visibility/opacity, not
      // display:none, so it still has real layout dimensions to measure.
      const maxLeft = bounds.right - tooltip.offsetWidth - margin
      const minLeft = bounds.left + margin
      const left = Math.max(minLeft, Math.min(wrapperRect.left, maxLeft))

      // The tooltip's own box sits flush against the trigger (top/bottom
      // matches wrapperRect exactly, no gap) - the visual gap is instead
      // padding-top/bottom *inside* that box (see the pt-1/pb-1 below), so
      // the mouse never crosses a dead zone between trigger and tooltip on
      // its way from one to the other.
      const fitsBelow = bounds.bottom - wrapperRect.bottom >= tooltip.offsetHeight
      const flipped = !fitsBelow
      const top = flipped
        ? Math.max(bounds.top + margin, wrapperRect.top - tooltip.offsetHeight)
        : wrapperRect.bottom

      setTooltipPos({ top, left, flipped })
    }
    setOpen(true)
  }

  const entries = (
    <ul className='flex flex-col gap-1'>
      {renderCitationEntry(source, 'main')}
      {source.supportingWebsites?.map((sw, j) => renderCitationEntry(sw, j))}
    </ul>
  )

  // Its own mouseenter/mouseleave let the pointer move from the trigger
  // down into the tooltip - e.g. to click a link in it - without it closing
  // along the way, even though it's no longer a DOM descendant of the
  // trigger once portaled. max-w is a fallback safety clamp in case JS
  // hasn't positioned it yet; long titles wrap (see renderCitationEntry)
  // rather than pushing the box wider.
  const tooltipPortal = createPortal(
    <>
      {!canHover && open && (
        <span className='fixed inset-0 z-40' onClick={closeTooltip} />
      )}
      <span
        ref={tooltipRef}
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
        onMouseEnter={canHover ? openTooltip : undefined}
        onMouseLeave={canHover ? closeTooltip : undefined}
        className={`fixed ${tooltipPos.flipped ? 'pb-1' : 'pt-1'} ${open ? 'visible opacity-100' : 'invisible opacity-0'} transition-opacity z-50 w-80 max-w-[calc(100vw-1rem)] normal-case font-normal`}
      >
        <span className='block max-h-64 overflow-y-auto bg-white rounded-lg shadow-lg border border-grey4 p-1'>
          {entries}
        </span>
      </span>
    </>,
    document.body
  )

  return { wrapperRef, canHover, openTooltip, closeTooltip, tooltipPortal }
}

// The link pill itself, plus its hover/tap popover (see useCitationTooltip).
// Click still follows the link immediately on hover-capable devices,
// unchanged from before; touch devices open the tooltip on first tap
// instead of navigating (a second tap on the link itself, once open,
// follows it as normal).
function CitationPill ({ source, query }: { source: CitationSource, query: string }): JSX.Element {
  const { wrapperRef, canHover, openTooltip, closeTooltip, tooltipPortal } = useCitationTooltip(source)
  const extraCount = source.supportingWebsites?.length ?? 0

  return (
    <span ref={wrapperRef} className='inline-block'>
      <a
        href={source.url}
        target='_blank'
        rel='noopener noreferrer'
        onMouseEnter={canHover ? openTooltip : undefined}
        onMouseLeave={canHover ? closeTooltip : undefined}
        onClick={e => {
          if (!canHover) {
            e.preventDefault()
            openTooltip()
          }
        }}
        className={`inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-grey4 text-primary font-semibold hover:bg-primary hover:text-white no-underline group ${matchesQuery(source, query) ? matchedRef : ''}`}
      >
        <img src={LinkSvg} className='w-3 h-3 pr-0.5 group-hover:brightness-0 group-hover:invert' />
        {source.attribution != null && (
          <span className='ml-0.5 text-[0.60rem]'>
            {source.attribution}{extraCount > 0 ? ` +${extraCount}` : ''}
          </span>
        )}
      </a>

      {tooltipPortal}
    </span>
  )
}

// An entity chip (see resolveEntity/EntitySegment). Clicking it still opens
// the raw-data-inspect popup as before (onShowRaw); on hover-capable
// devices, when the entity has a resolvable link (segment.url), hovering
// the chip *also* reveals it via the same tooltip a citation would (see
// useCitationTooltip) - directly off the chip itself rather than a separate
// pill, matching how ChatGPT's own UI surfaces an entity's link. Touch
// devices keep tapping-to-inspect as the only interaction (no touchModal
// here), since there's no hover state there to distinguish "show the link"
// from "show the debug data".
type EntitySegment = Extract<ReferenceSegment, { kind: 'entity' }>

function EntityChip ({ segment, query, onShowRaw, parentLabel }: { segment: EntitySegment, query: string, onShowRaw: (data: unknown, parentLabel: string) => void, parentLabel: string }): JSX.Element {
  const matched = matchesQuery(segment.raw, query)
  const hasLink = segment.url != null
  const { wrapperRef, canHover, openTooltip, closeTooltip, tooltipPortal } = useCitationTooltip({
    title: segment.name,
    url: segment.url,
    attribution: segment.name,
  })

  return (
    <span ref={wrapperRef} className='inline-block'>
      <span
        title={segment.disambiguation}
        onClick={() => onShowRaw(segment.raw, parentLabel)}
        onMouseEnter={hasLink && canHover ? openTooltip : undefined}
        onMouseLeave={hasLink && canHover ? closeTooltip : undefined}
        className={`font-semibold bg-grey5 rounded inline-flex items-center px-1 ${clickableRef} ${matched ? matchedRef : ''}`}
      >
        <img src={EntitySvg} className='w-3 h-3 mr-0.5 group-hover:brightness-0 group-hover:invert' />
        {segment.name}
      </span>
      {hasLink && tooltipPortal}
    </span>
  )
}

// --- Sources / details screens ---------------------------------------------
//
// The 'sources' and 'details' screens pushed onto ChatConversation's
// screenStack (see Screen/renderScreenPanel above) when a message's
// Sources/References pill, or a reference chip's click-to-inspect, is used.
// Both render in flow - as the body below whatever header renderScreenPanel
// puts above them - rather than as their own fixed-position/backdrop popup
// (the previous SourcesPopup/ReferenceDataPopup), for the reasons given on
// the Screen type above. Each is just `flex-1 overflow-y-auto`: exactly one
// scroll container, sized by the panel around it.

function SourcesScreen ({ sources, locale, searchQuery = '' }: { sources: SearchResultGroup[], locale: string, searchQuery?: string }): JSX.Element {
  const { noSourcesMsg } = getTranslations({
    noSourcesMsg: { en: 'No sources found for this conversation', nl: 'Geen bronnen gevonden voor dit gesprek' },
  }, locale)
  const query = searchQuery.trim()
  const searchWords = queryTerms(query)

  const entries = sources.flatMap(group => group.entries ?? group.items ?? [])

  return (
    <div className='flex-1 overflow-y-auto p-3'>
      {entries.length === 0
        ? <div className='text-grey2 text-sm'>{noSourcesMsg}</div>
        : (
          <ul className='flex flex-col gap-2'>
            {entries.map((entry, i) => (
              <li key={i} className='text-sm border-b border-grey4 pb-2 last:border-none'>
                {entry.url != null
                  ? (
                    <a
                      href={entry.url}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='flex items-start gap-1 text-primary hover:underline font-semibold'
                    >
                      <img src={LinkSvg} className='w-3 h-3 mt-1 shrink-0' />
                      <Highlighter searchWords={searchWords} autoEscape textToHighlight={entry.title ?? entry.url} highlightClassName='bg-tertiary rounded-sm' />
                    </a>
                    )
                  : (
                    <span className='font-semibold'>
                      <Highlighter searchWords={searchWords} autoEscape textToHighlight={entry.title ?? ''} highlightClassName='bg-tertiary rounded-sm' />
                    </span>
                    )}
                {entry.snippet != null && (
                  <div className='text-grey2 mt-0.5'>
                    <Highlighter searchWords={searchWords} autoEscape textToHighlight={entry.snippet} highlightClassName='bg-tertiary rounded-sm' />
                  </div>
                )}
              </li>
            ))}
          </ul>
          )}
    </div>
  )
}

// Raw content_references for a message (via its References pill) or a
// single reference chip's underlying data (via click-to-inspect) - the one
// guaranteed-complete view of everything ChatGPT attached to a message,
// including entries no inline marker ever pointed to.
function DetailsScreen ({ data, searchQuery = '' }: { data: unknown, searchQuery?: string }): JSX.Element {
  const query = searchQuery.trim()

  return (
    <div className='flex-1 overflow-y-auto p-3'>
      <pre className='text-xs bg-grey6 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words'>
        <Highlighter
          searchWords={queryTerms(query)}
          autoEscape
          textToHighlight={JSON.stringify(data, null, 2)}
          highlightClassName='bg-tertiary rounded-sm'
        />
      </pre>
    </div>
  )
}

// --- ChatGPT reference-marker resolution ------------------------------------
//
// ChatGPT export messages embed reference markers using private-use-area
// characters: U+E200 opens a marker, U+E202 separates fields within it, and
// U+E201 closes it. E.g. (open)cite(sep)turn0news21(close) or
// (open)entity(sep)["country","Argentina","2026 FIFA World Cup team"](close).
//
// Markers of type "entity", "url" and "genui" carry their own display data
// inline (for "genui", a JSON payload - e.g. a chart widget, see
// resolveGenui). Markers of type "map" are bare/opaque and are resolved
// against the message's content_references array positionally: the Nth
// "map" marker corresponds to the Nth "map"-typed content_references entry,
// because entries whose type has no marker equivalent (hidden,
// sources_footnote, followup_a) never consume a cursor slot. "video" markers
// are the odd one out: despite their own marker keyword, they resolve
// against content_references entries whose own type is "alt_text", not
// "video". A bare "genui" marker with no inline payload is resolved the same
// way, against a "dil" entry.
//
// "cite" markers carry their own ref tokens too (e.g. "turn0news21",
// "turn0business12" - one or more, FIELD_SEP-separated) and are matched
// against content_references by that token rather than by position: each
// "grouped_webpages" entry's items carry a `refs` array of
// {turn_index, ref_type, ref_index} triples that reconstruct to the same
// token shape (see webpageRefTokens), so a cite marker's token(s) are looked
// up directly instead of assuming marker occurrence order lines up with
// content_references array order. That assumption doesn't hold for citations
// re-citing an entity already introduced earlier in the message (e.g. a
// local business from a "map" answer, cited again via a bare "cite" marker
// carrying the same token) - those have no separate content_references entry
// of their own to consume positionally, which would silently desync every
// following "cite" marker in the message by one. resolveEntity records
// name/url in entityRegistry under that same token as it's encountered, and
// resolveCitation checks there first: if every one of a "cite" marker's
// tokens turns out to be one of these self-citations, it resolves to no
// visible citation at all (matching ChatGPT's own UI, which shows that link
// on the entity itself on hover - see renderReference's 'entity' case, which
// reuses CitationPill for that - rather than as a separate citation). A
// token that's neither a known entity nor found in content_references at
// all still surfaces as 'unknown', so a genuine mismatch stays visible
// instead of being indistinguishable from an expected self-citation.
//
// Real ChatGPT exports frequently omit the U+E201 close character for bare
// "cite"/"map" markers (observed e.g. on multi-source "cite" markers like
// (open)cite(sep)turn0search0(sep)turn0search1 with no closer at all). Those
// are bounded by content shape instead — the keyword plus zero or more
// FIELD_SEP-separated \w+ tokens, stopping at the first character outside
// that shape — with the close character consumed if present but optional.
// "entity"/"url"/"genui"/"image_group" payloads (JSON, URLs, link text) can
// contain arbitrary characters, so those still require an explicit close.

const MARKER_OPEN = ''
const MARKER_CLOSE = ''
const FIELD_SEP = ''

const MARKER_RE = new RegExp(
  `${MARKER_OPEN}(?:(cite|map)((?:${FIELD_SEP}\\w+)*)${MARKER_CLOSE}?` +
  `|([^${MARKER_OPEN}${MARKER_CLOSE}]*)${MARKER_CLOSE})`,
  'g'
)

class ReferenceCursor {
  private readonly buckets = new Map<string, ContentReference[]>()

  constructor (references: ContentReference[]) {
    for (const ref of references) {
      const key = ReferenceCursor.bucketKey(ref.type)
      const bucket = this.buckets.get(key)
      if (bucket == null) {
        this.buckets.set(key, [ref])
      } else {
        bucket.push(ref)
      }
    }
  }

  private static bucketKey (type: string): string {
    // "webpage" and "grouped_webpages" both back "cite" markers.
    return type === 'webpage' ? 'grouped_webpages' : type
  }

  next (type: string): ContentReference | undefined {
    return this.buckets.get(ReferenceCursor.bucketKey(type))?.shift()
  }

  // Finds and removes the first "grouped_webpages" entry covering at least
  // one of the given ref tokens (see webpageRefTokens), rather than just
  // taking whichever one is next in array order - see resolveCitation for
  // why occurrence order can't be relied on here.
  takeMatchingWebpage (tokens: Set<string>): ContentReferenceGroupedWebpages | undefined {
    const bucket = this.buckets.get('grouped_webpages')
    if (bucket == null) return undefined
    const index = bucket.findIndex(ref => webpageRefTokens(ref as ContentReferenceGroupedWebpages).some(t => tokens.has(t)))
    if (index === -1) return undefined
    return bucket.splice(index, 1)[0] as ContentReferenceGroupedWebpages
  }
}

// Reconstructs each of a "grouped_webpages" entry's covered ref tokens (e.g.
// "turn0news21") from its items' own {turn_index, ref_type, ref_index}
// triples, so they can be compared against a "cite" marker's own tokens.
function webpageRefTokens (ref: ContentReferenceGroupedWebpages): string[] {
  return (ref.items ?? []).flatMap(item =>
    (item.refs ?? []).map(r => `turn${r.turn_index}${r.ref_type}${r.ref_index}`)
  )
}

// Token -> {name, url} recorded for each "entity" marker resolved so far in
// the current message, keyed by that entity's own ref token when it has one
// (e.g. "turn0business12" - see resolveEntity). Lets a later "cite" marker
// re-citing the same entity resolve directly instead of via
// content_references, which has no separate entry for it to consume.
type EntityRegistry = Map<string, { name: string, url?: string }>

const REF_TOKEN_RE = /^turn\d+\w+\d+$/

function resolveMessageReferences (
  message: string,
  references: ContentReference[] | undefined
): MessageSegment[] {
  const cursor = new ReferenceCursor(references ?? [])
  const entityRegistry: EntityRegistry = new Map()
  const segments: MessageSegment[] = []

  let lastIndex = 0
  MARKER_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = MARKER_RE.exec(message)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: message.slice(lastIndex, match.index) })
    }

    const [keyword, ...params] = match[1] != null
      ? [match[1], ...match[2].split(FIELD_SEP).filter(p => p !== '')]
      : match[3].split(FIELD_SEP)
    segments.push({ kind: 'ref', segment: resolveMarker(keyword, params, cursor, entityRegistry) })

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < message.length) {
    segments.push({ kind: 'text', value: message.slice(lastIndex) })
  }

  return segments
}

function resolveMarker (keyword: string, params: string[], cursor: ReferenceCursor, entityRegistry: EntityRegistry): ReferenceSegment {
  switch (keyword) {
    case 'entity':
      return resolveEntity(params, cursor, entityRegistry)
    case 'url':
      return resolveUrl(params, cursor)
    case 'video':
      return resolveVideo(params, cursor)
    case 'cite':
      return resolveCitation(params, cursor, entityRegistry)
    case 'map':
      return resolveMap(cursor)
    case 'image_group':
      return resolveImageGroup(params, cursor)
    case 'genui':
      return resolveGenui(params, cursor)
    default:
      // Any keyword this parser doesn't otherwise recognize (a marker type
      // introduced by a future ChatGPT export version) - best-effort
      // consume a same-typed content_references entry if one exists, so
      // the marker's underlying data stays visible and inspectable
      // instead of the text just vanishing.
      return { kind: 'unknown', keyword, raw: cursor.next(keyword) ?? { keyword, params } }
  }
}

function resolveEntity (params: string[], cursor: ReferenceCursor, entityRegistry: EntityRegistry): ReferenceSegment {
  let name: string | undefined
  let disambiguation: string | undefined
  let token: string | undefined

  try {
    const parsed: unknown = JSON.parse(params[0] ?? 'null')
    if (Array.isArray(parsed)) {
      // Some entities (e.g. local businesses from a "map" answer) carry
      // their own ref token as the array's first element instead of a
      // category string (contrast e.g. ["country", "Argentina", ...]) - see
      // the module comment above for why this is recorded.
      if (typeof parsed[0] === 'string' && REF_TOKEN_RE.test(parsed[0])) token = parsed[0]
      if (typeof parsed[1] === 'string') name = parsed[1]
      if (typeof parsed[2] === 'string') disambiguation = parsed[2]
    }
  } catch {
    name = params[0]
  }

  const ref = cursor.next('entity') as ContentReferenceEntity | undefined
  const url = ref?.entity_data?.website_url ?? undefined

  if (token != null && name != null) entityRegistry.set(token, { name, url })

  if (name == null || name === '') return { kind: 'unknown', keyword: 'entity', raw: ref ?? { params } }
  return { kind: 'entity', name, disambiguation, url, raw: ref ?? { name, disambiguation } }
}

function resolveUrl (params: string[], cursor: ReferenceCursor): ReferenceSegment {
  const [text, href] = params
  if (text == null) return { kind: 'unknown', keyword: 'url', raw: { params } }
  if (href != null && href.includes('://')) return { kind: 'url', text, href }
  // Not an inline href but a positional reference key (e.g. "turn0search0"),
  // same idea as bare "cite"/"map"/"genui" markers: resolve it against the
  // Nth "url"-typed content reference instead, whose real href isn't its
  // own field but is embedded as markdown in `alt`, e.g.
  // "[Data Donation (D3I)](https://datadonation.eu/data-donation/)".
  // A missing/unresolvable href still keeps the label visible (rendered as
  // plain text) rather than dropping the marker entirely.
  const ref = cursor.next('url') as ContentReferenceUrl | undefined
  const resolvedHref = extractHrefFromMarkdownLink(ref?.alt)
  return { kind: 'url', text, href: resolvedHref }
}

function extractHrefFromMarkdownLink (markdown: string | undefined): string | undefined {
  if (markdown == null) return undefined
  return /]\((https?:\/\/[^)\s]+)\)/.exec(markdown)?.[1]
}

// "video" markers carry a title and a positional reference key (e.g.
// "turn0search0"), same shape as "url" markers - but resolve against the
// content_references entry's own type "alt_text" rather than "video", and a
// matching entry isn't guaranteed to be present, so a missing href still
// yields a segment (rendered as plain text) rather than being dropped,
// keeping the title visible either way.
function resolveVideo (params: string[], cursor: ReferenceCursor): ReferenceSegment {
  const [text, key] = params
  if (text == null) return { kind: 'unknown', keyword: 'video', raw: { params } }
  if (key != null && key.includes('://')) return { kind: 'video', text, href: key }

  const ref = cursor.next('alt_text') as ContentReferenceAltText | undefined
  const href = extractHrefFromMarkdownLink(ref?.alt)
  return { kind: 'video', text, href }
}

// Items without a url still render (as plain, non-linked text - see
// renderCitationEntry) rather than being dropped, so a citation entry
// donated without a resolvable link doesn't just disappear.
//
// Matches by the marker's own ref token(s) rather than by position - see the
// module comment above.
function resolveCitation (params: string[], cursor: ReferenceCursor, entityRegistry: EntityRegistry): ReferenceSegment {
  const tokens = new Set(params)

  const ref = cursor.takeMatchingWebpage(tokens)
  const sources = (ref?.items ?? []).map(item => ({
    title: item.title,
    url: item.url,
    attribution: item.attribution,
    snippet: item.snippet,
    supportingWebsites: item.supporting_websites,
  }))

  if (sources.length > 0) return { kind: 'citation', sources }

  // No web source matched any of this marker's tokens. If every token is
  // instead a self-citation of an entity already introduced earlier in the
  // message (see entityRegistry above), that's expected - ChatGPT doesn't
  // show a separate citation for those either, so resolve to an empty
  // citation (renders nothing) rather than a placeholder pill.
  if (params.length > 0 && params.every(token => entityRegistry.has(token))) {
    return { kind: 'citation', sources: [] }
  }

  // Genuinely nothing backs this marker - surface that rather than treating
  // it the same as an expected, silent self-citation. The click-to-inspect
  // popup only opens for a non-null/undefined value (see MessageContent's
  // rawData state below), so this still needs a placeholder object here
  // rather than null, or clicking the resulting pill would silently do
  // nothing.
  return { kind: 'unknown', keyword: 'cite', raw: ref ?? { note: 'No matching content reference found', params } }
}

function resolveMap (cursor: ReferenceCursor): ReferenceSegment {
  const ref = cursor.next('map') as ContentReferenceMap | undefined
  if (ref == null) return { kind: 'unknown', keyword: 'map', raw: { note: 'No matching content reference found' } }

  const places: MapPlace[] = (ref.entities ?? []).map(e => ({
    name: e.entity?.name ?? e.name,
    address: e.entity?.address,
    rating: e.entity?.rating,
  }))

  if (places.length === 0) return { kind: 'unknown', keyword: 'map', raw: ref }
  return { kind: 'map', places, raw: ref }
}

function resolveImageGroup (params: string[], cursor: ReferenceCursor): ReferenceSegment {
  const ref = cursor.next('image_group') as ContentReferenceImageGroup | undefined

  let count = ref?.images?.length ?? 0
  let paramsFallback: unknown
  if (count === 0 && params[0] != null) {
    try {
      const parsed: unknown = JSON.parse(params[0])
      paramsFallback = parsed
      const query = (parsed as { query?: unknown }).query
      if (Array.isArray(query)) count = query.length
    } catch {
      // ignore malformed payload, fall through with count 0
    }
  }

  if (count === 0) return { kind: 'unknown', keyword: 'image_group', raw: ref ?? paramsFallback ?? { params } }
  return { kind: 'images', count, raw: ref ?? paramsFallback }
}

// A "genui" marker's payload is usually inline JSON (e.g. a chart widget:
// { charts_widget_v2: { content: { chartType, meta: { title, ... }, ... } } }
// - only the title is surfaced here since this is a lite, non-exhaustive
// renderer with no chart-drawing of its own; the full payload is still
// reachable by clicking the resulting pill (onShowRaw). A bare marker with
// no payload (or an unparsable one) falls back to the older content
// reference lookup below.
function resolveGenui (params: string[], cursor: ReferenceCursor): ReferenceSegment {
  const payload = params[0]

  if (payload != null && payload !== '') {
    try {
      const parsed: unknown = JSON.parse(payload)
      const title = (parsed as { charts_widget_v2?: { content?: { meta?: { title?: string } } } })
        ?.charts_widget_v2?.content?.meta?.title
      return { kind: 'widget', name: title ?? '', raw: parsed }
    } catch {
      // Malformed JSON payload; fall through to the bare-marker lookup below.
    }
  }

  const ref = cursor.next('dil') as ContentReferenceDil | undefined
  if (ref?.name == null) return { kind: 'unknown', keyword: 'genui', raw: ref ?? { params } }
  return { kind: 'widget', name: ref.name, raw: ref }
}
