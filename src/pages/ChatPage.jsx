import { useRef } from 'react'
import MessageList from '../components/chat/MessageList'
import MessageComposer from '../components/chat/MessageComposer'
import RuntimeDeepSeekStatus from '../components/chat/RuntimeDeepSeekStatus'
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

/**
 * AI Chat → local runtime → supervised browser.deepseek task.
 *
 * The legacy extension bridge remains available elsewhere, but it is not the
 * execution path here. Every prompt is submitted once to the runtime and is
 * correlated by the pending assistant-message id. Streaming patches the same
 * persisted HPOS conversation even when the visible conversation changes.
 */
export default function ChatPage() {
  const { ready, active } = useConversations()
  const inflight = useRef(null)

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

  const send = (content) => {
    const convId = ensureConversation()
    const userMsg = createMessage({ role: 'user', content })
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
    }).then((text) => {
      patchMessage(convId, pending.id, {
        content: text || '',
        status: 'sent',
        stoppable: false,
        notice: null,
        meta: { provider: 'deepseek', executor: 'runtime-browser' },
      }, { persist: 'flush' })
      clearIfCurrent()
    }).catch((err) => {
      const cancelled = err?.code === DEEPSEEK_RUNTIME_ERROR.CANCELLED || err?.cancelled === true
      const interrupted = err?.code === DEEPSEEK_RUNTIME_ERROR.INTERRUPTED
      const partial = getConversation(convId)?.messages.find((message) => message.id === pending.id)?.content || ''
      patchMessage(convId, pending.id, {
        /* Streaming text already persisted by onDelta; never erase it with an
           error. With no partial output, the structured failure is the bubble. */
        ...(!partial ? { content: err?.message || 'DeepSeek runtime task failed.' } : {}),
        status: 'sent',
        stoppable: false,
        notice: cancelled
          ? 'Generation stopped.'
          : interrupted
            ? (err?.message || 'Runtime interrupted. The prompt was not sent again.')
            : partial
              ? (err?.message || 'DeepSeek runtime task failed.')
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
      <MessageList
        messages={messages}
        empty={empty}
        onSuggestion={send}
        onStop={stop}
      />
      <RuntimeDeepSeekStatus />
      <MessageComposer key={active?.id || 'none'} onSend={send} />
    </section>
  )
}

const S = {
  page: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    background: 'var(--bg)',
  },
}
