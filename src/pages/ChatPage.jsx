import { useRef } from 'react'
import MessageList from '../components/chat/MessageList'
import MessageComposer from '../components/chat/MessageComposer'
import BridgeStatus from '../components/chat/BridgeStatus'
import { createMessage, getAssistantReply } from '../lib/chat/mock'
import { getBrowserBridge } from '../lib/bridge'
import { getDeepSeekConnector } from '../lib/bridge/DeepSeekConnector.js'
import { ERROR } from '../lib/bridge/protocol.js'
import { getBinding } from '../lib/storage/deepseekBindingStore.js'
import { useConversations } from '../lib/chat/useConversations.js'
import {
  createConversation,
  getActiveId,
  patchMessage,
  saveMessage,
} from '../lib/storage/conversationStore.js'

/**
 * The AI chats page. Renders the active conversation from the store.
 * When the browser bridge is connected, prompts route to DeepSeekConnector.
 * Otherwise Step 1 local replies keep the composer usable.
 *
 * Streaming patches the same assistant message in the store (debounced to
 * disk; flushed on complete) so switching chats never mixes transcripts.
 */
export default function ChatPage() {
  const { ready, active } = useConversations()
  const inflight = useRef(null)

  const ensureConversation = () => {
    const existing = getActiveId()
    if (existing) return existing
    return createConversation({ provider: 'deepseek' }).id
  }

  const stop = (id) => {
    const convId = inflight.current?.conversationId || getActiveId()
    const ds = getDeepSeekConnector()
    ds.stop().catch((err) => {
      if (!convId) return
      patchMessage(convId, id, {
        notice: err?.code === ERROR.STOP_NOT_AVAILABLE
          ? (err.message || 'Stop is not available on this page')
          : (err?.message || 'Could not stop'),
      }, { persist: 'flush' })
    })
  }

  const send = (content) => {
    const convId = ensureConversation()
    const userMsg = createMessage({ role: 'user', content })
    const pending = createMessage({ role: 'assistant', content: '', status: 'thinking' })

    const bridge = getBrowserBridge()
    if (bridge.getStatus() === 'connected') {
      const ds = getDeepSeekConnector()
      if (ds.isBusy() || inflight.current) {
        const blocked = createMessage({
          role: 'assistant',
          content: 'A response is still generating',
          status: 'sent',
          meta: { error: true, code: ERROR.BUSY },
        })
        saveMessage(convId, userMsg, { persist: 'flush' })
        saveMessage(convId, blocked, { persist: 'flush' })
        return
      }
      if (ds.getStatus() === 'version') {
        saveMessage(convId, userMsg, { persist: 'flush' })
        saveMessage(convId, {
          ...pending,
          content: 'Extension update required.',
          status: 'sent',
          meta: { error: true, code: ERROR.BRIDGE_VERSION_MISMATCH },
        }, { persist: 'flush' })
        return
      }

      saveMessage(convId, userMsg, { persist: 'flush' })
      saveMessage(convId, { ...pending, stoppable: true }, { persist: 'flush' })
      inflight.current = { conversationId: convId, messageId: pending.id }

      ds.sendMessage(content, {
        messageId: pending.id,
        conversationId: convId,
        onDelta: (text) => {
          patchMessage(convId, pending.id, { content: text, status: 'thinking' }, { persist: 'debounce' })
        },
        onComplete: (text) => {
          patchMessage(convId, pending.id, {
            content: text,
            status: 'sent',
            stoppable: false,
            notice: null,
          }, { persist: 'flush' })
          if (inflight.current?.messageId === pending.id) inflight.current = null
        },
      }).then((text) => {
        patchMessage(convId, pending.id, {
          content: text || '',
          status: 'sent',
          stoppable: false,
          notice: null,
        }, { persist: 'flush' })
        if (inflight.current?.messageId === pending.id) inflight.current = null
      }).catch((err) => {
        const interrupted = Boolean(err?.interrupted || err?.code === ERROR.REQUEST_INTERRUPTED)
        const patch = {
          status: 'sent',
          stoppable: false,
          meta: { error: !interrupted, code: err?.code, interrupted },
        }
        if (interrupted) {
          patch.notice = err?.message || 'Connection dropped. Response may be incomplete.'
          if (typeof err.partial === 'string' && err.partial) patch.content = err.partial
        } else {
          patch.content = err?.message || 'Connection error'
        }
        patchMessage(convId, pending.id, patch, { persist: 'flush' })
        if (inflight.current?.messageId === pending.id) inflight.current = null
      })
      return
    }

    if (getBinding(convId)) {
      saveMessage(convId, userMsg, { persist: 'flush' })
      saveMessage(convId, {
        ...pending,
        content: 'DeepSeek disconnected. Reconnect to continue.',
        status: 'sent',
        meta: { error: true, code: ERROR.BRIDGE_DISCONNECTED },
      }, { persist: 'flush' })
      return
    }

    saveMessage(convId, userMsg, { persist: 'flush' })
    saveMessage(convId, pending, { persist: 'flush' })
    inflight.current = { conversationId: convId, messageId: pending.id }
    getAssistantReply(content).then((reply) => {
      patchMessage(convId, pending.id, { content: reply, status: 'sent' }, { persist: 'flush' })
      if (inflight.current?.messageId === pending.id) inflight.current = null
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
      <BridgeStatus />
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
