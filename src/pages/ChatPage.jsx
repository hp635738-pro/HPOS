import { useEffect, useRef, useState } from 'react'
import MessageList from '../components/chat/MessageList'
import MessageComposer from '../components/chat/MessageComposer'
import ChatHistorySidebar from '../components/chat/ChatHistorySidebar'
import RuntimeDetailsPanel from '../components/chat/RuntimeDetailsPanel'
import { createMessage } from '../lib/chat/mock'
import {
  DEEPSEEK_RUNTIME_ERROR,
  getDeepSeekRuntimeClient,
} from '../lib/bridge/DeepSeekRuntimeClient.js'
import { useConversations } from '../lib/chat/useConversations.js'
import {
  createConversation,
  getActiveId,
  getConversation,
  patchMessage,
  saveMessage,
} from '../lib/storage/conversationStore.js'
import { loadChatUiPrefs, saveChatUiPrefs } from '../lib/chat/chatUiPrefs.js'
import { startNewChat } from '../lib/chat/history.js'
import { sendFailureText } from '../lib/chat/sendFailure.js'

const EDIT_RESPONSE_RE = /<hpos-file-edit>\s*([\s\S]*?)\s*<\/hpos-file-edit>/i

function parseEditResponse(text) {
  const match = typeof text === 'string' ? text.match(EDIT_RESPONSE_RE) : null
  if (!match) return null

  let payload
  try {
    payload = JSON.parse(match[1])
  } catch {
    return { error: 'The AI edit proposal was not valid JSON.' }
  }
  const name = typeof payload?.name === 'string' ? payload.name : payload?.path
  const proposed = typeof payload?.proposed === 'string' ? payload.proposed : payload?.content
  if (payload?.type !== 'file_edit' || typeof name !== 'string' || !name || typeof proposed !== 'string') {
    return { error: 'The AI edit proposal is missing a file path or complete replacement content.' }
  }
  return { name, proposed }
}

function isEditRequest(text) {
  return /\b(edit|modify|change|update|rewrite|refactor|fix|replace)\b/i.test(text)
}

function promptForAi(content) {
  if (!isEditRequest(content)) return content
  return `${content}\n\nIf this request requires a project-file change, respond with exactly one proposal in this format and no other edit format:\n<hpos-file-edit>{"type":"file_edit","name":"project-relative/path","content":"complete replacement file content"}</hpos-file-edit>\nDo not apply the change yourself. For normal questions, respond conversationally as usual.`
}

async function prepareEditProposal(response) {
  const parsed = parseEditResponse(response)
  if (!parsed) return { ok: true, proposal: false }
  if (parsed.error) return parsed
  if (!window.hpos || typeof window.hpos.aiReadFile !== 'function') {
    return { error: 'The secure AI file-read bridge is unavailable; no edit proposal was sent.' }
  }

  try {
    const original = await window.hpos.aiReadFile(parsed.name)
    if (!original || !original.ok || typeof original.content !== 'string') {
      return { error: original?.error || `Could not read ${parsed.name}; no edit proposal was sent.` }
    }
    if (typeof window.hpos.sendAiEditProposal !== 'function') {
      return { error: 'The Code Arena proposal bridge is unavailable; no edit proposal was sent.' }
    }
    const sent = await window.hpos.sendAiEditProposal({
      name: parsed.name,
      original: original.content,
      proposed: parsed.proposed,
    })
    if (!sent || !sent.ok) return { error: sent?.error || 'Code Arena could not receive the edit proposal.' }
    return { ok: true, proposal: true, name: sent.name || parsed.name }
  } catch (error) {
    return { error: error?.message || 'Could not prepare the AI edit proposal.' }
  }
}

/**
 * AI Chat → local runtime → supervised browser.deepseek task.
 *
 * The legacy extension bridge remains available elsewhere, but it is not the
 * execution path here. Every prompt is submitted once to the runtime and is
 * correlated by the pending assistant-message id. Streaming patches the same
 * persisted HPOS conversation even when the visible conversation changes.
 *
 * Layout: current conversation + composer on the left, dedicated chat history
 * sidebar docked on the right (opposite the main navigation rail). Model and
 * DeepThink are session-level UI state only — they are never sent anywhere.
 * Runtime status lives in the header container; holding it opens the
 * full-panel runtime details overlay (chat underneath stays mounted).
 */
export default function ChatPage({ historyOpen = true, onCloseHistory, detailsOpen = false, onBackFromDetails }) {
  const { ready, active } = useConversations()
  const inflight = useRef(null)
  const [uiPrefs, setUiPrefs] = useState(() => loadChatUiPrefs())

  useEffect(() => {
    saveChatUiPrefs(uiPrefs)
  }, [uiPrefs])

  const ensureConversation = () => {
    const existing = getActiveId()
    if (existing) return existing
    return createConversation({ provider: 'deepseek' }).id
  }

  const stop = (messageId) => {
    const current = inflight.current
    if (!current || current.messageId !== messageId || !current.taskId) {
      const convId = current?.conversationId || getActiveId()
      if (convId) {
        patchMessage(convId, messageId, {
          notice: 'The runtime task is not ready to stop yet.',
        }, { persist: 'flush' })
      }
      return
    }
    getDeepSeekRuntimeClient().stop(current.taskId).then((result) => {
      if (result.ok) return
      patchMessage(current.conversationId, messageId, {
        notice: 'Could not stop the runtime task.',
      }, { persist: 'flush' })
    })
  }

  const send = (content, extras = null) => {
    const convId = ensureConversation()
    // Composer attachments ride on the local user message only — the
    // runtime send payload further below is unchanged (text-only contract).
    const attachments = extras?.attachments?.length ? extras.attachments : null

    // UI-only demo: `/image <prompt>` renders the representative
    // image-generation result state locally. It never touches the runtime,
    // DeepSeek, Browser Bridge, or auth — and never uses the inflight slot.
    const imageMatch = content.match(/^\/image(?:\s+(.*))?$/s)
    if (imageMatch) {
      const promptText = (imageMatch[1] || '').trim()
      saveMessage(convId, createMessage({
        role: 'user',
        content,
        ...(attachments ? { meta: { attachments } } : null),
      }), { persist: 'flush' })
      saveMessage(convId, createMessage({
        role: 'assistant',
        content: '',
        status: 'sent',
        meta: {
          kind: 'image-generation',
          ...(promptText ? { prompt: promptText } : {}),
        },
      }), { persist: 'flush' })
      return
    }

    const userMsg = createMessage({
      role: 'user',
      content,
      ...(attachments ? { meta: { attachments } } : null),
    })
    const pending = createMessage({ role: 'assistant', content: '', status: 'thinking' })

    if (inflight.current) {
      const blocked = createMessage({
        role: 'assistant',
        content: 'A DeepSeek response is still running. Stop it or wait before sending another message.',
        status: 'sent',
        meta: { error: true, code: DEEPSEEK_RUNTIME_ERROR.BUSY },
      })
      saveMessage(convId, userMsg, { persist: 'flush' })
      saveMessage(convId, blocked, { persist: 'flush' })
      return
    }

    saveMessage(convId, userMsg, { persist: 'flush' })
    saveMessage(convId, { ...pending, stoppable: true }, { persist: 'flush' })
    inflight.current = {
      conversationId: convId,
      messageId: pending.id,
      taskId: null,
    }

    const clearIfCurrent = () => {
      if (inflight.current?.messageId === pending.id) inflight.current = null
    }

    content = promptForAi(content)
    getDeepSeekRuntimeClient().send(content, {
      correlationId: pending.id,
      conversationId: convId,
      messageId: pending.id,
      timeoutMs: 180000,
      onQueued: ({ taskId }) => {
        if (inflight.current?.messageId === pending.id) inflight.current.taskId = taskId
      },
      onGenerating: () => {
        patchMessage(convId, pending.id, {
          status: 'thinking',
          stoppable: true,
          notice: null,
        }, { persist: 'debounce' })
      },
      onDelta: (text) => {
        patchMessage(convId, pending.id, {
          content: text,
          status: 'thinking',
          stoppable: true,
          notice: null,
        }, { persist: 'debounce' })
      },
      onComplete: (text) => {
        patchMessage(convId, pending.id, {
          content: text,
          status: 'sent',
          stoppable: false,
          notice: null,
          meta: { provider: 'deepseek', executor: 'runtime-browser' },
        }, { persist: 'flush' })
        clearIfCurrent()
      },
    }).then(async (text) => {
      const edit = await prepareEditProposal(text || '')
      patchMessage(convId, pending.id, {
        content: text || '',
        status: 'sent',
        stoppable: false,
        notice: null,
        meta: {
          provider: 'deepseek',
          executor: 'runtime-browser',
          ...(edit.proposal ? { editProposal: { name: edit.name, reviewed: true } } : {}),
          ...(edit.error ? { editProposalError: edit.error } : {}),
        },
      }, { persist: 'flush' })
      if (edit.error) {
        patchMessage(convId, pending.id, { notice: edit.error }, { persist: 'flush' })
      }
      clearIfCurrent()
    }).catch((err) => {
      const cancelled = err?.code === DEEPSEEK_RUNTIME_ERROR.CANCELLED || err?.cancelled === true
      const interrupted = err?.code === DEEPSEEK_RUNTIME_ERROR.INTERRUPTED
      const partial = getConversation(convId)?.messages.find((message) => message.id === pending.id)?.content || ''
      // Availability failures collapse to a neutral message — runtime state
      // lives in the header container, never in the conversation.
      const failureText = sendFailureText(err)
      patchMessage(convId, pending.id, {
        /* Streaming text already persisted by onDelta; never erase it with an
           error. With no partial output, the structured failure is the bubble. */
        ...(!partial ? { content: failureText } : {}),
        status: 'sent',
        stoppable: false,
        notice: cancelled
          ? 'Generation stopped.'
          : interrupted
            ? (err?.message || 'Runtime interrupted. The prompt was not sent again.')
            : partial
              ? failureText
              : null,
        meta: {
          error: !cancelled,
          interrupted,
          cancelled,
          code: err?.code || DEEPSEEK_RUNTIME_ERROR.INTERRUPTED,
          executor: 'runtime-browser',
        },
      }, { persist: 'flush' })
      clearIfCurrent()
    })
  }

  const messages = active?.messages || []
  const empty = !ready ? 'loading' : (!active ? 'none' : 'idle')

  return (
    <section style={S.page} aria-label="AI chats">
      <div style={S.main} inert={detailsOpen ? true : undefined}>
        <MessageList
          messages={messages}
          empty={empty}
          onSuggestion={send}
          onStop={stop}
        />
        <MessageComposer
          key={active?.id || 'none'}
          onSend={send}
          model={uiPrefs.model}
          onModelChange={(model) => setUiPrefs((p) => ({ ...p, model }))}
          deepThink={uiPrefs.deepThink}
          onDeepThinkChange={(deepThink) => setUiPrefs((p) => ({ ...p, deepThink }))}
        />
      </div>
      <ChatHistorySidebar
        open={historyOpen}
        onClose={onCloseHistory}
        onNewChat={() => startNewChat()}
        inert={detailsOpen}
      />
      <button
        type="button"
        className="chat-history-scrim"
        data-open={historyOpen ? 'true' : 'false'}
        onClick={onCloseHistory}
        aria-label="Close chat history"
        tabIndex={-1}
      />
      {detailsOpen && <RuntimeDetailsPanel onBack={onBackFromDetails} />}
    </section>
  )
}

const S = {
  page: {
    flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'row',
    background: 'var(--bg)', position: 'relative',
  },
  main: {
    flex: 1, minWidth: 0, minHeight: 0,
    display: 'flex', flexDirection: 'column',
  },
}
