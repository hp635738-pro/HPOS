import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic, Plus, Stop, X } from '../Icons'
import ModelSelector from './ModelSelector'
import DeepThinkToggle from './DeepThinkToggle'
import VoiceVisualizer from './VoiceVisualizer'
import { useMicLevels } from '../../lib/chat/useMicLevels.js'
import {
  MAX_ATTACHMENTS,
  readImageAttachment,
  validateImageFile,
} from '../../lib/chat/attachments.js'

const MAX_H = 148

const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/**
 * Bottom message box — a rounded floating composer.
 *
 * Compact when empty, expands smoothly on focus/typing (spring-like card
 * transition), and the field auto-grows with the text (capped, then it
 * scrolls internally). Enter sends, Shift+Enter inserts a newline, Escape
 * collapses an empty expanded composer.
 *
 * The control row under the field holds the model picker, the DeepThink
 * switch (both UI state only), an image-attach button with a thumbnail
 * strip, and one circular action button on the right: microphone when
 * empty, send arrow when there is something to send, stop while voice
 * mode records. Voice mode visualizes the platform microphone (no HPOS
 * backend, no transcription) and restores the composer on stop.
 */
export default function MessageComposer({
  onSend,
  model = 'instant',
  onModelChange,
  deepThink = false,
  onDeepThinkChange,
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [attachments, setAttachments] = useState([])
  const [reading, setReading] = useState(false)
  const [note, setNote] = useState(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const ta = useRef(null)
  const fileRef = useRef(null)
  const noteTimer = useRef(null)
  const { levels, live, denied } = useMicLevels(recording)

  // Focus once on mount — a chat should never make you hunt for the field.
  // NB: wrap it — an effect may not *return* anything but a cleanup fn.
  useEffect(() => {
    const id = requestAnimationFrame(() => ta.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Auto-grow up to the cap, then let the field scroll internally. Re-runs
  // when voice mode ends so a kept draft regains its height after remount.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
  }, [text, recording])

  // Recording clock.
  useEffect(() => {
    if (!recording) return
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [recording])

  // Escape cancels voice mode and restores the field.
  useEffect(() => {
    if (!recording) return
    const esc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setRecording(false)
        requestAnimationFrame(() => ta.current?.focus())
      }
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [recording])

  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
  }, [])

  const flashNote = (msg) => {
    setNote(msg)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 5000)
  }

  const focusField = () => requestAnimationFrame(() => ta.current?.focus())

  const send = () => {
    const content = text.trim()
    if (!content && attachments.length === 0) return
    onSend(content, { attachments })
    setText('')
    setAttachments([])
    focusField()
  }

  const startRecording = () => {
    setElapsed(0)
    setRecording(true)
  }
  const stopRecording = () => {
    setRecording(false)
    focusField()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && !text) {
      // Collapse an empty expanded composer.
      e.currentTarget.blur()
    }
  }

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length || recording) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      flashNote(`Only ${MAX_ATTACHMENTS} images per message.`)
      return
    }
    setReading(true)
    const errors = []
    const next = []
    for (const f of files.slice(0, room)) {
      const problem = validateImageFile(f)
      if (problem) {
        errors.push(`${f.name || 'file'}: ${problem}.`)
        continue
      }
      try {
        next.push(await readImageAttachment(f))
      } catch {
        errors.push(`${f.name || 'file'}: could not be read.`)
      }
    }
    if (files.length > room) errors.push(`Only ${MAX_ATTACHMENTS} images per message.`)
    if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS))
    setReading(false)
    if (errors.length) flashNote(errors.join(' '))
    focusField()
  }

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const empty = !text.trim() && attachments.length === 0
  const expanded = focused || !empty || recording
  const action = recording ? 'stop' : empty ? 'mic' : 'send'
  const current = action === 'stop'
    ? { label: 'Stop recording', title: 'Stop recording', Icon: Stop, style: S.stop, run: stopRecording }
    : action === 'send'
      ? { label: 'Send message', title: 'Send (Enter)', Icon: ArrowUp, style: S.send, run: send }
      : { label: 'Start voice input', title: 'Voice input', Icon: Mic, style: S.mic, run: startRecording }
  const ActionIcon = current.Icon

  return (
    <footer style={S.dock}>
      <div
        className="composer-card"
        data-expanded={expanded ? 'true' : 'false'}
        style={{ ...S.card, ...(expanded ? S.cardOpen : null) }}
      >
        {attachments.length > 0 && !recording && (
          <div className="composer-files-in" style={S.files} aria-label="Attached images">
            {attachments.map((a) => (
              <span key={a.id} style={S.file}>
                <img src={a.dataUrl} alt={a.name} style={S.thumb} />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="chat-focus"
                  aria-label={`Remove ${a.name}`}
                  title="Remove attachment"
                  style={S.unattach}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {recording ? (
          <div style={S.voice} aria-live="polite">
            <div style={S.voiceRow}>
              <VoiceVisualizer levels={levels} live={live} />
              <span style={S.voiceText}>
                {live ? 'Listening…' : denied ? 'Microphone blocked — preview only' : 'Starting microphone…'}
              </span>
              <span style={S.voiceTime}>{fmtElapsed(elapsed)}</span>
            </div>
            <span style={S.voiceNote}>Voice preview — transcription isn't connected yet.</span>
          </div>
        ) : (
          <textarea
            ref={ta}
            rows={1}
            value={text}
            className="composer-area"
            aria-label="Type a message"
            placeholder="Message AI chats…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={S.input}
          />
        )}

        {note && !recording && (
          <p style={S.note} role="status">{note}</p>
        )}

        <div style={S.controls}>
          <ModelSelector value={model} onChange={onModelChange} />
          <DeepThinkToggle checked={deepThink} onChange={onDeepThinkChange} />
          <span style={S.spacer} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={recording || reading}
            className="chat-focus composer-pill"
            aria-label="Attach images"
            title="Attach images"
            style={{ ...S.attach, ...((recording || reading) ? S.disabled : null) }}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={current.run}
            className="chat-focus composer-action"
            aria-label={current.label}
            title={current.title}
            style={current.style}
          >
            <span key={action} className="composer-action-icon">
              <ActionIcon size={action === 'stop' ? 13 : 16} />
            </span>
          </button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFiles}
      />
      <span style={S.hint}>Enter to send · Shift+Enter for a new line</span>
    </footer>
  )
}

const S = {
  dock: { flexShrink: 0, padding: '10px 24px 16px' },
  card: {
    maxWidth: 840, margin: '0 auto',
    display: 'flex', flexDirection: 'column',
    padding: '6px 8px 6px 15px',
    background: 'var(--surface)', border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 1px 2px rgba(0,0,0,.06)',
    transition: 'padding .26s cubic-bezier(.2,.8,.25,1), border-color .2s, box-shadow .25s',
  },
  cardOpen: {
    padding: '10px 8px 8px 15px',
    boxShadow: '0 8px 28px -12px rgba(0,0,0,.35)',
  },
  files: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 7px 6px 0' },
  file: { position: 'relative', width: 56, height: 56, flexShrink: 0 },
  thumb: {
    width: 56, height: 56, objectFit: 'cover', display: 'block',
    borderRadius: 10, border: '1px solid var(--line)',
  },
  unattach: {
    position: 'absolute', top: -7, right: -7, width: 20, height: 20,
    borderRadius: '50%', display: 'grid', placeItems: 'center',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    color: 'var(--text-2)', cursor: 'pointer',
  },
  input: {
    flex: 1, minWidth: 0, border: 'none', outline: 'none', resize: 'none',
    background: 'transparent', color: 'var(--text)',
    font: 'inherit', fontSize: 'var(--font)', lineHeight: 1.5,
    padding: '7px 0', maxHeight: MAX_H,
    transition: 'height .16s ease-out',
  },
  voice: { display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 0' },
  voiceRow: { display: 'flex', alignItems: 'center', gap: 10 },
  voiceText: { fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' },
  voiceTime: {
    marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: 'var(--muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  voiceNote: { fontSize: 11, color: 'var(--muted)' },
  note: { margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)' },
  controls: {
    display: 'flex', alignItems: 'center', gap: 8,
    flexWrap: 'wrap', paddingTop: 8,
  },
  spacer: { flex: 1, minWidth: 4 },
  attach: {
    width: 32, height: 32, flexShrink: 0, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    color: 'var(--text-2)', background: 'var(--surface-2)',
    border: '1px solid var(--line)', cursor: 'pointer',
    transition: 'border-color .15s, color .15s, background .15s, opacity .15s',
  },
  disabled: { opacity: 0.45, cursor: 'default' },
  mic: {
    width: 34, height: 34, flexShrink: 0, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    color: 'var(--text-2)', background: 'var(--surface-2)',
    border: '1px solid var(--line)', cursor: 'pointer',
    transition: 'background .18s, color .18s, border-color .18s',
  },
  send: {
    width: 34, height: 34, flexShrink: 0, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    border: '1px solid transparent', cursor: 'pointer',
    transition: 'background .18s, color .18s, border-color .18s',
  },
  stop: {
    width: 34, height: 34, flexShrink: 0, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    background: 'var(--danger)', color: '#fff',
    border: '1px solid transparent', cursor: 'pointer',
    transition: 'background .18s, color .18s, border-color .18s',
  },
  hint: {
    display: 'block', maxWidth: 840, margin: '7px auto 0', padding: '0 4px',
    fontSize: 10.5, color: 'var(--muted)', textAlign: 'right',
  },
}
