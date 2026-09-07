import { useMemo, useState } from 'react'
import ChatHeader from '../components/chat/ChatHeader'
import MessageList from '../components/chat/MessageList'
import MessageComposer from '../components/chat/MessageComposer'
import { createMessage, getAssistantReply } from '../lib/chat/mock'

/**
 * The AI chats page. Owns the conversation state; everything else is a dumb
 * component. The only async dependency is `getAssistantReply` from the mock
 * module — swap that one function for a real connector in a later step.
 */
export default function ChatPage() {
  const [messages, setMessages] = useState([])

  const send = (content) => {
    const userMsg = createMessage({ role: 'user', content })
    const pending = createMessage({ role: 'assistant', content: '', status: 'thinking' })
    setMessages((ms) => [...ms, userMsg, pending])

    // Mock responder — isolated in src/lib/chat/mock.js for easy replacement.
    getAssistantReply(content).then((reply) => {
      setMessages((ms) =>
        ms.map((m) => (m.id === pending.id ? { ...pending, content: reply, status: 'sent' } : m)),
      )
    })
  }

  // Conversation title = first user message, clipped — like real chat apps.
  const title = useMemo(() => {
    const first = messages.find((m) => m.role === 'user')?.content
    if (!first) return 'New conversation'
    const flat = first.replace(/\s+/g, ' ')
    return flat.length > 44 ? `${flat.slice(0, 44)}…` : flat
  }, [messages])

  return (
    <section style={S.page} aria-label="AI chats">
      <ChatHeader
        title={title}
        count={messages.length}
        onNewChat={() => setMessages([])}
      />
      <MessageList messages={messages} onSuggestion={send} />
      <MessageComposer onSend={send} />
    </section>
  )
}

const S = {
  page: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    background: 'var(--bg)',
  },
}
