import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ModelIcon, PromptInputBox } from '@/components/ui/ai-prompt-box'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ThinkingOrb } from '@/components/ui/thinking-orbs'
import { useTheme } from '@/theme/ThemeContext'

/**
 * Chats — the full AI chat section from hp635738-pro/compo (demo page),
 * ported to HPOS. Composed of three registry components:
 *   - PromptInputBox (modes: text / search / code / models picker)
 *   - ThinkingOrb    (state-aware "thinking" animation while pending)
 *   - MarkdownRenderer (rich replies: tables, code blocks with copy)
 *
 * Changes vs upstream demo: rendered inside the HPOS shell (h-full, not
 * h-screen), `bg-[size:…]` → `bg-[length:…]` for Tailwind v3, removed the
 * /api/vh diagnostic ping, and conversations persist to localStorage.
 */

const STORE_KEY = 'hpos.chats.v1'

const ORB_STATE = {
  text: 'composing',
  search: 'searching',
  models: 'working',
  code: 'shaping',
}
const ORB_LABEL = {
  text: 'Thinking…',
  search: 'Searching…',
  models: 'Working…',
  code: 'Coding…',
}

const DUMMY_REPLIES = [
  "Here's a **structured demo response** rendered with the new Markdown engine ✨\n\n## What you get\n- **Headings**, *italics* and `inline code`\n- GitHub-style tables, lists and quotes\n- Syntax-highlighted code blocks with a copy button\n\n> Rich responses, just like ChatGPT / Claude — right in your chat UI.",
  "Sure! Here's a quick example in TypeScript:\n\n```typescript\ntype Model = { id: string; name: string; tier: 1 | 2 | 3 };\n\nexport function pickModel(models: Model[], tier: 1 | 2 | 3): Model | undefined {\n  return models.find((m) => m.tier === tier);\n}\n```\n\nCall it with `pickModel(MODELS, 1)` to get the best agent. Want it in Python instead?",
  "## Model comparison\n\n| Model | Strength | Speed |\n| --- | --- | --- |\n| claude-3-5-sonnet | Tool use & coding | Fast |\n| o3-mini | Reasoning loops | Faster |\n| gemini-2.0-flash | Latency | Fastest |\n\n---\n\n**Next steps:**\n1. Pick a model from the *Models* picker\n2. Toggle **Code** or **Search** for specialised lists\n3. Watch replies render with full Markdown 🎉",
]

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const s = raw ? JSON.parse(raw) : null
    if (s && Array.isArray(s.convos)) return { convos: s.convos, activeId: s.activeId ?? null }
  } catch { /* ignore */ }
  return { convos: [], activeId: null }
}

let seq = 0

export default function Chats() {
  const [{ convos, activeId }, setStore] = useState(loadStore)
  const [pending, setPending] = useState(false)
  const [mode, setMode] = useState('text')
  const replyIdx = useRef(0)
  const mainRef = useRef(null)
  const footerRef = useRef(null)
  const [composerH, setComposerH] = useState(0)

  const active = convos.find((c) => c.id === activeId) ?? null
  const isEmpty = !active && !pending

  // Width the chat area has while the sidebar is EXPANDED (viewport minus
  // rail minus the main's 16px+16px padding). Capping the messages + composer
  // at this value keeps them from growing when the sidebar collapses — they
  // simply re-center in the freed space instead.
  const { prefs } = useTheme()
  const chatMaxW = `calc(100vw - ${prefs.railWidth}px - 32px)`

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ convos, activeId })) } catch { /* ignore */ }
  }, [convos, activeId])

  // Scroll the message area (only) to the bottom. scrollIntoView would also
  // scroll every scrollable ancestor — the decorative background's negative
  // offsets make the Chats root programmatically scrollable, which shifted
  // the whole page up and left a dead band under the composer.
  useEffect(() => {
    const el = mainRef.current
    el?.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' })
  }, [convos, pending])

  // Track the composer's rendered height as a safety cap on the message
  // area ("available height − composer − gap"). main is flex-1 in every
  // state, so the composer stays bottom-anchored and the message area
  // scrolls once the conversation fills the viewport.
  useEffect(() => {
    if (isEmpty) return undefined
    const el = footerRef.current
    if (!el) return undefined
    const measure = () => setComposerH(el.offsetHeight)
    measure()
    if (typeof window.ResizeObserver !== 'function') return undefined
    const ro = new window.ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isEmpty])

  const startNewChat = () => {
    setStore((s) => ({ ...s, activeId: null }))
    setPending(false)
  }

  const handleSend = (message, files, meta) => {
    const fileNote = files && files.length > 0 ? '  ·  📎 ' + files.length + ' file(s)' : ''
    const modelUsed = meta?.model ?? 'Max'
    const userMsg = { role: 'user', text: message + fileNote }
    let id = activeId
    if (!id || !convos.some((c) => c.id === id)) {
      seq += 1
      id = `c${Date.now()}-${seq}`
      const convo = {
        id,
        title: message.slice(0, 42) || 'New chat',
        msgs: [userMsg],
        createdAt: Date.now(),
        model: modelUsed,
      }
      setStore((s) => ({ convos: [convo, ...s.convos], activeId: id }))
    } else {
      setStore((s) => ({
        ...s,
        convos: s.convos.map((c) =>
          c.id === id ? { ...c, model: modelUsed, msgs: [...c.msgs, userMsg] } : c,
        ),
      }))
    }
    setPending(true)
    window.setTimeout(() => {
      const reply = DUMMY_REPLIES[replyIdx.current % DUMMY_REPLIES.length]
      replyIdx.current += 1
      setStore((s) => ({
        ...s,
        convos: s.convos.map((c) =>
          c.id === id
            ? { ...c, msgs: [...c.msgs, { role: 'assistant', text: reply, model: modelUsed }] }
            : c,
        ),
      }))
      setPending(false)
    }, 1400)
  }

  // overflow-clip (not hidden): hidden still allows programmatic scrolling,
  // which would let the negative-offset background glows drag the page up.
  return (
    <div className="relative flex h-full w-full overflow-clip bg-black">
      {/* decorative background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[length:56px_56px] [mask-image:radial-gradient(75%_65%_at_50%_35%,black,transparent)]" />
        <div className="absolute -top-28 left-1/2 h-72 w-[38rem] -translate-x-1/2 rounded-full bg-[#F97316]/15 blur-3xl" />
        <div className="absolute top-1/3 -left-24 h-64 w-64 rounded-full bg-[#8B5CF6]/10 blur-3xl" />
        <div className="absolute -right-24 -bottom-24 h-72 w-72 rounded-full bg-[#1EAEDB]/10 blur-3xl" />
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col gap-3">
        <main
          ref={mainRef}
          // flex-1 in BOTH states: the composer must stay bottom-anchored
          // through the empty -> chat transition. If chat-state main shrank
          // to content height, the footer composer would fly up under the
          // first message on send (while the empty-state composer is still
          // fading out at the bottom) and only settle back at the bottom
          // when the reply arrived — a visible whole-screen fadup. With a
          // bottom-anchored composer in both states, the two composers
          // crossfade in place and the screen never shifts.
          className={`flex-1 min-h-0 ${isEmpty ? 'overflow-hidden pt-4 pb-3' : 'overflow-y-auto pt-4'} px-4`}
          style={!isEmpty && composerH > 0 ? { maxHeight: `calc(100% - ${composerH}px - 12px)` } : undefined}
        >
          <AnimatePresence mode="wait" initial={false}>
            {isEmpty ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -24, scale: 0.98 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="flex h-full flex-col"
              >
                {/* Hero text vertically centered in the space above the
                    composer (flex-1 + items-center); the box stays pinned
                    to the bottom as before. */}
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <h1 className="text-3xl font-light text-white/85">
                      How can I help today?
                    </h1>
                    <p className="mt-3 text-sm text-white/40">
                      Type a command or ask a question
                    </p>
                  </div>
                </div>
                <div className="mx-auto w-full max-w-2xl">
                  <PromptInputBox
                    onSend={handleSend}
                    placeholder="Type your message here...."
                    hasConversation={false}
                    onNewChat={startNewChat}
                    onModeChange={setMode}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="chat"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="mx-auto flex min-h-full w-full flex-col"
                style={{ maxWidth: chatMaxW }}
              >
                {active?.msgs.map((m, i) => {
                  // user input -> assistant output sits tight (4px) so the
                  // reply reads as a direct answer; other message pairs keep
                  // the looser 12px rhythm
                  const mt = i > 0
                    ? (m.role === 'assistant' && active.msgs[i - 1].role === 'user' ? 'mt-1' : 'mt-3')
                    : ''
                  return m.role === 'user' ? (
                    <div
                      key={i}
                      className={`max-w-[80%] self-end rounded-2xl border border-[#F97316]/40 bg-[#F97316]/15 px-4 py-2 text-sm break-words whitespace-pre-wrap text-orange-50 ${mt}`}
                    >
                      {m.text}
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`max-w-[80%] self-start rounded-2xl border border-white/10 bg-neutral-900/80 px-4 py-3 text-sm break-words whitespace-pre-wrap text-white/90 backdrop-blur ${mt}`}
                    >
                      {m.model && (
                        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] tracking-wide text-white/45">
                          <ModelIcon
                            name={m.model}
                            className="h-3.5 w-3.5 text-[#F97316]"
                          />
                          <span>{m.model}</span>
                        </div>
                      )}
                      <MarkdownRenderer content={m.text} />
                    </div>
                  )
                })}
                {pending && (
                  <div
                    className="mt-1 inline-flex items-center gap-2 self-start rounded-full pr-4 pl-1"
                    style={{
                      background: 'rgba(29,29,29,0.42)',
                      boxShadow: 'inset 0 0 0 1px rgba(44,47,54,0.31)',
                    }}
                  >
                    <ThinkingOrb state={ORB_STATE[mode]} size={32} theme="dark" />
                    <span className="text-xs whitespace-nowrap text-white/50">
                      {ORB_LABEL[mode]}
                    </span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {!isEmpty && (
          <motion.footer
            ref={footerRef}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            // In-flow (was `absolute bottom-0`): the 12px gap-3 above keeps a
            // small, consistent space between the last message and the box.
            // pb-3 lifts the box slightly off the viewport's bottom edge.
            className="relative z-10 w-full px-4 pb-3"
          >
            <div className="mx-auto w-full" style={{ maxWidth: chatMaxW }}>
              <PromptInputBox
                onSend={handleSend}
                placeholder="Type your message here...."
                hasConversation={!!active && active.msgs.length > 0}
                onNewChat={startNewChat}
                onModeChange={setMode}
              />
            </div>
          </motion.footer>
        )}
      </div>
    </div>
  )
}
