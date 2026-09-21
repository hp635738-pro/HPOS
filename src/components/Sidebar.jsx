import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import {
  Sidebar as ShadSidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupContent,
  SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton,
  SidebarRail, useSidebar,
} from '@/components/ui/sidebar'
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup,
  ContextMenuItem, ContextMenuSeparator, ContextMenuLabel,
} from '@/components/ui/context-menu'
import {
  Logo, InputTerminal, Analyzing, Topics, Bord, Chat, NetworkAgent,
  Chevron, Chevrons, Grip, Pin, PinOff, Lock, Unlock, Star,
  NotesIcon, Gamepad,
} from './Icons'

/**
 * Rail navigation only. Settings is deliberately NOT a rail item: it is a
 * header (Topbar) destination owned by the Topbar gear button. Keeping it out
 * of NAV also stops App from classifying the settings view as a rail page, so
 * the header receives `active === 'settings'` and its gear can show the
 * on-state. Regression: HPOS-Desktop/settingsNavigation.test.mjs.
 *
 * Structure — built on the shadcn sidebar (components/ui/sidebar.tsx):
 *   SidebarProvider (owned by App, controlled from prefs.sidebar)
 *   └── Sidebar  variant="floating" collapsible="icon"
 *       ├── SidebarHeader   — brand (logo + HPOS)
 *       ├── SidebarContent  — SidebarGroup > SidebarMenu > items
 *       │     (pin/lock badges, Chats dot, drag reorder, right-click
 *       │      context menu — behaviour unchanged)
 *       ├── SidebarFooter   — Collapse/Expand toggle
 *       └── SidebarRail     — edge strip that also toggles the sidebar
 *
 * Geometry comes from the existing Sidebar settings: ThemeContext paints
 * --rail-w / --rail-mini / --rail-item-h / --rail-gap / --rail-radius /
 * --rail-font, which the shadcn primitives consume via Tailwind
 * arbitrary-value classes. No new settings were added.
 */
export const NAV = [
  { id: 'overview',  label: 'Input terminal', Icon: InputTerminal },
  { id: 'schedule',  label: 'Dashboard',      Icon: Analyzing },
  { id: 'cards',     label: 'Topics',         Icon: Topics },
  { id: 'reports',   label: 'Bord',           Icon: Bord },
  { id: 'messages',  label: 'Chats',          Icon: Chat, dot: true },
  { id: 'assistant', label: 'Network',        Icon: NetworkAgent },
  { id: 'notes',     label: 'Notes',          Icon: NotesIcon },
  { id: 'gameview',  label: 'Game view',      Icon: Gamepad },
  { id: 'star',      label: 'Favourites',     Icon: Star },
]

/** Flat list of every leaf nav id (children included), in display order. */
export function flatNav() {
  const out = []
  NAV.forEach((n) => {
    if (n.children) { out.push(n); n.children.forEach((c) => out.push(c)) }
    else out.push(n)
  })
  return out
}

/** Applies a saved id order to NAV, tolerating added/removed items. */
export function orderNav(saved) {
  if (!Array.isArray(saved)) return NAV
  const topById = new Map(NAV.map((n) => [n.id, n]))
  const out = []
  saved.forEach((id) => {
    if (topById.has(id)) { out.push(topById.get(id)); topById.delete(id) }
  })
  return [...out, ...topById.values()]
}

export default function Sidebar({ active, onChange }) {
  const { prefs, set } = useTheme()
  const { toggleSidebar } = useSidebar()
  const mini = prefs.sidebar === 'icons'

  const pinned = prefs.navPinned || []
  const locked = prefs.navLocked || []
  const expanded = prefs.navExpanded || []

  // Pinned items float to the top, keeping their relative order.
  const items = useMemo(() => {
    const base = orderNav(prefs.navOrder)
    const isPinned = (n) => pinned.includes(n.id)
    return [...base.filter(isPinned), ...base.filter((n) => !isPinned(n))]
  }, [prefs.navOrder, pinned])

  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const [edge, setEdge] = useState('above')
  const dragRef = useRef(null)

  // When true, the sidebar was expanded automatically by clicking a parent
  // icon in collapsed mode — clicking a child should then collapse it back.
  const autoExpandedRef = useRef(false)

  // Track when sidebar becomes mini (collapsed) so we can reset the flag.
  useEffect(() => {
    if (mini) autoExpandedRef.current = false
  }, [mini])

  // Persist expanded state on mount so default-open stays across reloads.
  useEffect(() => {
    if (!Array.isArray(prefs.navExpanded)) {
      set('navExpanded', [])
    }
  }, [])

  const toggle = (key, id) => {
    const list = prefs[key] || []
    set(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  }

  const toggleExpanded = (id) => {
    const list = prefs.navExpanded || []
    set('navExpanded', list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  }

  const commit = (fromId, toId, placeBelow) => {
    if (!fromId || !toId || fromId === toId) return
    if (locked.includes(fromId) || locked.includes(toId)) return
    // Only reorder top-level items (don't drag children).
    const ids = items.map((n) => n.id)
    if (!ids.includes(fromId) || !ids.includes(toId)) return
    const from = ids.indexOf(fromId)
    ids.splice(from, 1)
    let to = ids.indexOf(toId)
    if (placeBelow) to += 1
    ids.splice(to, 0, fromId)
    set('navOrder', ids)
  }

  const reset = () => { setDragId(null); setOverId(null); dragRef.current = null }

  // Context menu content shared by every rail item (top-level and nested) —
  // the exact actions, labels and order of the original portaled menu:
  // Pin, Lock, then the conditional separator + Reset all. Radix renders
  // <ContextMenuContent> in a portal on <body>, so it stays unclipped by the
  // rail's overflow/scroll (and by the glass preset's backdrop-filter).
  // Dismissal (outside click / Escape) and close-on-select come from Radix.
  const navMenuContent = (id, label) => (
    <>
      <ContextMenuLabel>{label}</ContextMenuLabel>
      <ContextMenuGroup>
        <ContextMenuItem onSelect={() => toggle('navPinned', id)}>
          {pinned.includes(id) ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned.includes(id) ? 'Unpin from top' : 'Pin to top'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggle('navLocked', id)}>
          {locked.includes(id) ? <Unlock size={14} /> : <Lock size={14} />}
          {locked.includes(id) ? 'Unlock position' : 'Lock position'}
        </ContextMenuItem>
      </ContextMenuGroup>
      {(pinned.length > 0 || prefs.navOrder) && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onSelect={() => {
                set('navOrder', null); set('navPinned', []); set('navLocked', []); set('navExpanded', [])
              }}
            >
              <span style={{ width: 14 }} />
              Reset all
            </ContextMenuItem>
          </ContextMenuGroup>
        </>
      )}
    </>
  )

  return (
    <ShadSidebar
      variant="floating"
      collapsible="icon"
      style={{
        /* Same surface as the header (Topbar) so rail + header read as ONE
           connected piece. When the rail is flush (no inset) the top-right
           corner is squared — it butts against the header's top-left corner,
           so the top edge runs as one continuous line. */
        background: 'var(--surface)',
        margin: prefs.railInset,
        marginRight: prefs.railInset ? prefs.railInset : 0,
      }}
    >
      {prefs.railBrand && (
        <SidebarHeader style={{ padding: '14px 0 0' }}>
          <div style={S.brand} className="group-data-[collapsible=icon]:justify-center">
            <span style={S.mark}><Logo size={20} /></span>
            <span style={S.brandText} className="group-data-[collapsible=icon]:hidden">HPOS</span>
          </div>
        </SidebarHeader>
      )}

      <SidebarContent style={{ padding: `0 ${prefs.railPad}px` }} className="px-0 pb-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item, i) => {
                const { id, label, Icon, dot, children } = item
                const isParent = !!children
                const isOpen = expanded.includes(id)
                // Section headers themselves are never "active" — they only
                // highlight when one of their children is the active page.
                const on = isParent ? false : active === id
                const dragging = dragId === id
                const marker = overId === id && dragId && dragId !== id
                const pin = pinned.includes(id)
                const lock = locked.includes(id)
                const lastPinned = pin && !pinned.includes(items[i + 1]?.id)
                const hasActiveChild = isParent && children.some((c) => c.id === active)

                return (
                  <Fragment key={id}>
                    <SidebarMenuItem>
                      {marker && edge === 'above' && <span style={{ ...S.marker, top: -2 }} />}

                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <SidebarMenuButton
                            isActive={on || hasActiveChild}
                            draggable={!lock && !mini}
                            onDragStart={(e) => {
                              dragRef.current = id
                              setDragId(id)
                              e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragOver={(e) => {
                              if (lock) return
                              e.preventDefault()
                              const r = e.currentTarget.getBoundingClientRect()
                              setOverId(id)
                              setEdge(e.clientY > r.top + r.height / 2 ? 'below' : 'above')
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              commit(dragRef.current, id, edge === 'below')
                              reset()
                            }}
                            onDragEnd={reset}
                            onClick={() => {
                              if (isParent) {
                                if (mini) {
                                  // Collapsed (icon-only) mode: click on AI tools icon
                                  // auto-expands the sidebar AND opens the section.
                                  autoExpandedRef.current = true
                                  set('sidebar', 'expanded')
                                  // Make sure the parent's children are visible.
                                  const list = prefs.navExpanded || []
                                  if (!list.includes(id)) {
                                    set('navExpanded', [...list, id])
                                  }
                                } else {
                                  // Expanded mode: normal toggle of the section chevron.
                                  toggleExpanded(id)
                                }
                              } else {
                                onChange(id)
                              }
                            }}
                            title={mini ? label : undefined}
                            aria-label={label}
                            style={dragging ? { opacity: 0.35 } : undefined}
                          >
                            <span style={S.iconBox}>
                              <Icon size={prefs.railIcon} />
                              {dot && prefs.railDots && <span style={S.dot} />}
                            </span>

                            <span style={S.label} className="group-data-[collapsible=icon]:hidden">{label}</span>
                            <span style={S.badges} className="group-data-[collapsible=icon]:hidden">
                              {pin && <Pin size={11} />}
                              {lock && <Lock size={11} />}
                            </span>
                            {isParent ? (
                              <>
                                {!lock && (
                                  <span className="rail-grip group-data-[collapsible=icon]:hidden" style={S.grip}><Grip size={13} /></span>
                                )}
                                <span
                                  className="group-data-[collapsible=icon]:hidden"
                                  style={{
                                    ...S.chev,
                                    transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                                    transition: 'transform .18s',
                                    opacity: 0.7,
                                    marginLeft: -4,
                                  }}
                                >
                                  <Chevron size={14} dir="right" />
                                </span>
                              </>
                            ) : !lock ? (
                              <span className="rail-grip" style={S.grip}><Grip size={13} /></span>
                            ) : null}
                          </SidebarMenuButton>
                        </ContextMenuTrigger>
                        <ContextMenuContent sideOffset={2}>
                          {navMenuContent(id, label)}
                        </ContextMenuContent>
                      </ContextMenu>

                      {/* Nested children */}
                      {isParent && isOpen && (
                        <SidebarMenuSub className="sublist-in">
                          {children.map((child) => {
                            const childOn = active === child.id
                            const openChat = () => {
                              onChange(child.id)
                              if (autoExpandedRef.current) {
                                autoExpandedRef.current = false
                                setTimeout(() => set('sidebar', 'icons'), 150)
                              }
                            }
                            return (
                              <SidebarMenuSubItem key={child.id}>
                                <ContextMenu>
                                  <ContextMenuTrigger asChild>
                                    <SidebarMenuSubButton
                                      render="button"
                                      isActive={childOn}
                                      onClick={openChat}
                                      title={child.label}
                                      className="h-[calc(var(--rail-item-h,36px)_-_4px)] cursor-pointer"
                                    >
                                      <span style={S.bullet}>•</span>
                                      <span style={{
                                        ...S.iconBox,
                                        width: 16, height: 16,
                                        marginLeft: 4,
                                        opacity: 0.75,
                                      }}>
                                        <child.Icon size={14} />
                                      </span>
                                      <span style={{
                                        fontSize: 'var(--rail-font)',
                                        fontWeight: 500,
                                      }}>
                                        {child.label}
                                      </span>
                                    </SidebarMenuSubButton>
                                  </ContextMenuTrigger>
                                  <ContextMenuContent sideOffset={2}>
                                    {navMenuContent(child.id, child.label)}
                                  </ContextMenuContent>
                                </ContextMenu>
                              </SidebarMenuSubItem>
                            )
                          })}
                        </SidebarMenuSub>
                      )}

                      {marker && edge === 'below' && <span style={{ ...S.marker, bottom: -2 }} />}
                    </SidebarMenuItem>
                    {/* Sibling <li> (not nested in the item's own <li>) so the
                        divider is valid HTML and gets the ul's gap spacing. */}
                    {lastPinned && (
                      <li style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        <span style={S.pinDivider} />
                      </li>
                    )}
                  </Fragment>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer holds rail chrome only. Settings is a header destination —
          the Topbar gear button owns it (no rail Settings entry point). */}
      <SidebarFooter style={{ padding: '8px 0 14px' }} className="px-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              title={mini ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={mini ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <span style={S.iconBox}>
                <Chevrons size={prefs.railIcon - 1} dir={mini ? 'right' : 'left'} />
              </span>
              <span style={S.label} className="group-data-[collapsible=icon]:hidden">Collapse</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Edge strip: click to toggle, 2px line on hover (shadcn rail). */}
      <SidebarRail />
    </ShadSidebar>
  )
}

const S = {
  brand: {
    display: 'flex', alignItems: 'center', gap: 10,
    height: 40, padding: '0 6px', marginBottom: 18, flexShrink: 0,
  },
  mark: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    background: 'var(--accent)', color: 'var(--accent-fg)',
    display: 'grid', placeItems: 'center',
  },
  brandText: {
    fontSize: 15, fontWeight: 800, letterSpacing: '-.3px',
    color: 'var(--rail-fg-on)', whiteSpace: 'nowrap',
  },

  iconBox: {
    position: 'relative',
    width: 'var(--rail-icon-box, 16px)', height: 'var(--rail-icon-box, 16px)',
    display: 'grid', placeItems: 'center', flexShrink: 0,
  },
  label: {
    /* 500 = shadcn's font-medium menu label (inline weight, so it wins over
       the button class). */
    fontSize: 'var(--rail-font)', fontWeight: 500, whiteSpace: 'nowrap',
    letterSpacing: '-.1px', flex: 1, textAlign: 'left',
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
  badges: {
    display: 'flex', alignItems: 'center', gap: 4,
    opacity: 0.5, flexShrink: 0,
  },
  chev: {
    display: 'grid', placeItems: 'center',
    flexShrink: 0,
  },
  grip: {
    display: 'grid', placeItems: 'center',
    color: 'var(--rail-fg)', opacity: 0,
    transition: 'opacity .16s', flexShrink: 0, cursor: 'grab',
  },
  dot: {
    position: 'absolute', top: -2, right: -3,
    width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)',
  },
  marker: {
    position: 'absolute', left: 4, right: 4, height: 2,
    borderRadius: 99, background: 'var(--accent)', pointerEvents: 'none',
  },
  pinDivider: {
    display: 'block', height: 1, margin: '6px 6px 3px',
    background: 'var(--rail-line)',
  },
  bullet: {
    width: 14, textAlign: 'center',
    fontSize: 14, lineHeight: 1,
    color: 'var(--rail-fg)',
    opacity: 0.5,
    flexShrink: 0,
  },
}
