import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import {
  Logo, InputTerminal, Analyzing, Topics, Bord, Chat, Ghost, Sparkle,
  Chevron, Grip, Pin, PinOff, Lock, Unlock, Star,
} from './Icons'

export const NAV = [
  { id: 'overview',  label: 'Input terminal', Icon: InputTerminal },
  { id: 'schedule',  label: 'Analyzing',      Icon: Analyzing },
  { id: 'cards',     label: 'Topics',         Icon: Topics },
  { id: 'reports',   label: 'Bord',           Icon: Bord },
  { id: 'aianalyz',  label: 'AI analyz',      Icon: Sparkle },
  { id: 'messages',  label: 'Chats',          Icon: Chat, dot: true },
  { id: 'assistant', label: 'Assistant',      Icon: Ghost },
  { id: 'star',      label: 'Favourites',     Icon: Star },
]

/** Applies a saved id order to NAV, tolerating added/removed items. */
export function orderNav(saved) {
  if (!Array.isArray(saved)) return NAV
  const byId = new Map(NAV.map((n) => [n.id, n]))
  const out = []
  saved.forEach((id) => {
    if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id) }
  })
  return [...out, ...byId.values()]
}

export default function Sidebar({ active, onChange }) {
  const { prefs, set } = useTheme()
  const mini = prefs.sidebar === 'icons'

  const pinned = prefs.navPinned || []
  const locked = prefs.navLocked || []

  // Pinned items float to the top, keeping their relative order.
  const items = useMemo(() => {
    const base = orderNav(prefs.navOrder)
    const isPinned = (n) => pinned.includes(n.id)
    return [...base.filter(isPinned), ...base.filter((n) => !isPinned(n))]
  }, [prefs.navOrder, pinned])

  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const [edge, setEdge] = useState('above')
  const [menu, setMenu] = useState(null)     // { id, x, y }
  const dragRef = useRef(null)

  // Any click or scroll dismisses the context menu.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const toggle = (key, id) => {
    const list = prefs[key] || []
    set(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  }

  const commit = (fromId, toId, placeBelow) => {
    if (!fromId || !toId || fromId === toId) return
    if (locked.includes(fromId) || locked.includes(toId)) return
    const ids = items.map((n) => n.id)
    const from = ids.indexOf(fromId)
    ids.splice(from, 1)
    let to = ids.indexOf(toId)
    if (placeBelow) to += 1
    ids.splice(to, 0, fromId)
    set('navOrder', ids)
  }

  const openMenu = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ id, x: e.clientX, y: e.clientY })
  }

  const reset = () => { setDragId(null); setOverId(null); dragRef.current = null }

  const menuItem = menu && NAV.find((n) => n.id === menu.id)
  const isPinned = menu && pinned.includes(menu.id)
  const isLocked = menu && locked.includes(menu.id)

  return (
    <aside style={{
      ...S.rail,
      width: mini ? prefs.railMini : prefs.railWidth,
      padding: `14px ${prefs.railPad}px`,
      borderRadius: prefs.railSharp,
      margin: prefs.railInset,
      marginRight: prefs.railInset ? prefs.railInset : 0,
    }}>
      {prefs.railBrand && (
        <div style={{ ...S.brand, justifyContent: mini ? 'center' : 'flex-start' }}>
          <span style={S.mark}><Logo size={20} /></span>
          {!mini && <span style={S.brandText}>HPOS</span>}
        </div>
      )}

      <nav style={{ ...S.nav, gap: prefs.railGap }}>
        {items.map(({ id, label, Icon, dot }, i) => {
          const on = active === id
          const dragging = dragId === id
          const marker = overId === id && dragId && dragId !== id
          const pin = pinned.includes(id)
          const lock = locked.includes(id)
          // Divider sits under the last pinned item.
          const lastPinned = pin && !pinned.includes(items[i + 1]?.id)

          return (
            <div key={id} style={S.slot}>
              {marker && edge === 'above' && <span style={{ ...S.marker, top: -2 }} />}

              <button
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
                onClick={() => onChange(id)}
                onContextMenu={(e) => openMenu(e, id)}
                title={mini ? label : undefined}
                style={{
                  ...S.item,
                  height: prefs.railItemH,
                  borderRadius: prefs.railRadius,
                  justifyContent: mini ? 'center' : 'flex-start',
                  padding: mini ? 0 : '0 8px 0 11px',
                  background: on ? 'var(--rail-hover)' : 'transparent',
                  color: on ? 'var(--rail-fg-on)' : 'var(--rail-fg)',
                  opacity: dragging ? 0.35 : 1,
                  cursor: dragging ? 'grabbing' : 'pointer',
                }}
              >
                {on && prefs.railPips && <span style={S.pip} />}
                <span style={S.iconBox}>
                  <Icon size={prefs.railIcon} />
                  {dot && prefs.railDots && <span style={S.dot} />}
                </span>

                {!mini && (
                  <>
                    <span style={S.label}>{label}</span>
                    <span style={S.badges}>
                      {pin && <Pin size={11} />}
                      {lock && <Lock size={11} />}
                    </span>
                    {!lock && (
                      <span className="rail-grip" style={S.grip}><Grip size={13} /></span>
                    )}
                  </>
                )}
              </button>

              {marker && edge === 'below' && <span style={{ ...S.marker, bottom: -2 }} />}
              {!mini && lastPinned && <span style={S.pinDivider} />}
            </div>
          )
        })}
      </nav>

      <div style={S.foot}>
        <button
          onClick={() => set('sidebar', mini ? 'expanded' : 'icons')}
          title={mini ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            ...S.item,
            height: prefs.railItemH,
            borderRadius: prefs.railRadius,
            justifyContent: mini ? 'center' : 'flex-start',
            padding: mini ? 0 : '0 11px',
            color: 'var(--rail-fg)',
          }}
        >
          <span style={S.iconBox}><Chevron size={prefs.railIcon - 2} dir={mini ? 'right' : 'left'} /></span>
          {!mini && <span style={S.label}>Collapse</span>}
        </button>
      </div>

      {/* ------------------------------------------------------ CONTEXT MENU */}
      {menu && (
        <div
          style={{ ...S.menu, left: menu.x + 2, top: menu.y + 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          <span style={S.menuHead}>{menuItem?.label}</span>

          <button
            className="ctx-item"
            style={S.menuBtn}
            onClick={() => { toggle('navPinned', menu.id); setMenu(null) }}
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
            <span>{isPinned ? 'Unpin from top' : 'Pin to top'}</span>
          </button>

          <button
            className="ctx-item"
            style={S.menuBtn}
            onClick={() => { toggle('navLocked', menu.id); setMenu(null) }}
          >
            {isLocked ? <Unlock size={14} /> : <Lock size={14} />}
            <span>{isLocked ? 'Unlock position' : 'Lock position'}</span>
          </button>

          {(pinned.length > 0 || prefs.navOrder) && (
            <>
              <span style={S.menuSep} />
              <button
                className="ctx-item"
                style={S.menuBtn}
                onClick={() => {
                  set('navOrder', null); set('navPinned', []); set('navLocked', [])
                  setMenu(null)
                }}
              >
                <span style={{ width: 14 }} />
                <span>Reset all</span>
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  )
}

const S = {
  rail: {
    position: 'relative', flexShrink: 0, overflow: 'hidden',
    background: 'var(--rail)',
    display: 'flex', flexDirection: 'column',
    transition: 'width .22s cubic-bezier(.4,0,.2,1), background .22s,\n                 border-radius .18s, margin .18s',
  },
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

  nav: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1 },
  slot: { position: 'relative' },
  marker: {
    position: 'absolute', left: 4, right: 4, height: 2,
    borderRadius: 99, background: 'var(--accent)', pointerEvents: 'none',
  },
  pinDivider: {
    display: 'block', height: 1, margin: '6px 6px 3px',
    background: 'rgba(255,255,255,.09)',
  },
  item: {
    position: 'relative', width: '100%',
    display: 'flex', alignItems: 'center', gap: 11,
    transition: 'background .16s, color .16s, opacity .16s',
  },
  pip: {
    position: 'absolute', left: -10, top: '50%', transform: 'translateY(-50%)',
    width: 3, height: 18, borderRadius: 99, background: 'var(--accent)',
  },
  iconBox: {
    position: 'relative',
    width: 'var(--rail-icon-box, 20px)', height: 'var(--rail-icon-box, 20px)',
    display: 'grid', placeItems: 'center', flexShrink: 0,
  },
  label: {
    fontSize: 'var(--rail-font)', fontWeight: 600, whiteSpace: 'nowrap',
    letterSpacing: '-.1px', flex: 1, textAlign: 'left',
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
  badges: {
    display: 'flex', alignItems: 'center', gap: 4,
    opacity: 0.5, flexShrink: 0,
  },
  grip: {
    display: 'grid', placeItems: 'center',
    color: 'var(--rail-fg)', opacity: 0,
    transition: 'opacity .16s', flexShrink: 0, cursor: 'grab',
  },
  dot: {
    position: 'absolute', top: -2, right: -3,
    width: 6, height: 6, borderRadius: '50%', background: '#f5c451',
  },

  foot: { display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 },

  menu: {
    position: 'fixed', zIndex: 90, minWidth: 186,
    padding: 5,
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 7,
    boxShadow: '0 12px 34px -10px rgba(0,0,0,.42)',
    display: 'flex', flexDirection: 'column', gap: 1,
  },
  menuHead: {
    padding: '6px 10px 7px', fontSize: 10.5, fontWeight: 800,
    letterSpacing: '.4px', color: 'var(--muted)',
    textTransform: 'uppercase',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  menuBtn: {
    display: 'flex', alignItems: 'center', gap: 10,
    height: 32, padding: '0 10px', borderRadius: 5,
    fontSize: 12.5, fontWeight: 500, color: 'var(--text)',
    background: 'transparent', textAlign: 'left',
  },
  menuSep: { height: 1, background: 'var(--line)', margin: '4px 6px' },
}
