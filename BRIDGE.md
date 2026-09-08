# HPOS Browser Bridge + DeepSeek Connector

HPOS chat ko user ke **already-open** DeepSeek tab se jodta hai. DeepSeek API, cookies, passwords, tokens, CAPTCHA/login bypass **nahi** hain.

```
HPOS Chat  →  BrowserBridge  →  Extension SW  →  DeepSeek tab adapter
                 ↑ PING/PONG          ↓ COMPOSER + visible markdown
                 CONNECTOR_EVENT  ←  START / DELTA / COMPLETE / ERROR
```

```
BrowserBridge
  └─ WebsiteConnector
       └─ DeepSeekConnector     ← Step 4
       └─ FutureConnector
```

BrowserBridge sirf messages forward karta hai (Step 2, unchanged). DeepSeek DOM logic `extension/adapters/` mein hai — selectors `deepseek.config.js`, observe/fill `deepseek.js`, snapshot fold `reconcile.js`.

---

## Message flow (Step 4)

1. User HPOS composer mein type karta hai (Enter / Send). User bubble turant dikhti hai.
2. Assistant bubble **isi request** ke liye ek hi baar banti hai (`thinking`).
3. `DeepSeekConnector.sendMessage` → `DS_SEND` `{ text, messageId }`. Bridge `requestId` ack envelope se wapas aata hai.
4. Overlap (pehle response abhi generating/streaming): **reject `BUSY`**, queue nahi. User text conversation mein rehti hai; in-flight bubble drop nahi hoti.
5. SW already-open `https://chat.deepseek.com/*` tab dhoondhta hai.
6. Adapter composer fill + Send/Enter. Session pin: naya `.ds-markdown` node (warna last node jiska text badla).
7. Lifecycle: `idle → sending → generating → streaming → complete` (ya `error`).
8. Events (allowlist):
   - `RESPONSE_START` — observe shuru, abhi text nahi
   - `RESPONSE_DELTA` — **poora** current snapshot (replace, append nahi)
   - `RESPONSE_COMPLETE` — text `stableMs` se same **aur** Stop/generating nahi
   - `ERROR` — detect fail / nav / timeout / composer gone
9. HPOS usi assistant bubble ka `content` **replace** karta hai. `"Hel" → "Hello"` concat karke `"HelHello"` nahi banta.
10. Fake tokens nahi. DOM text na badle to delta nahi.

Agar extension attached nahi: Step 1 local replies (chat toot-ta nahi). UI pe “offline/mock” label nahi.

Agar extension connected hai lekin DeepSeek tab nahi: assistant bubble mein error, crash nahi. Auto-resend nahi.

---

## Reconcile (full-text snapshots)

DeepSeek DOM aksar poori `innerText` dubara likhta hai:

| Tick | Snapshot | Concat (galat) | Replace (sahi) |
| --- | --- | --- | --- |
| 1 | `Hel` | `Hel` | `Hel` |
| 2 | `Hello` | `HelHello` | `Hello` |
| 3 | `Hello world` | `HelHelloHello world` | `Hello world` |

`reconcileAssistantText(prev, snap)`:

- `snap` prev ka prefix-growth ho to `snap`
- `snap` prev ka stale chhota prefix ho to `prev`
- warna **replace**, kabhi concatenate nahi

COMPLETE tabhi jab `shouldComplete`: text last emitted ke barabar, `stableMs` (1.6s) se change nahi, Stop/generating nahi. Text abhi badal raha ho to COMPLETE nahi.

---

## Stop

`DS_STOP` sirf tab chalega jab DeepSeek page par **visible Stop** control ho. Adapter us button ko click karta hai; page reload **kabhi nahi**.

Agar Stop nahi dikhta / koi in-flight session nahi: `STOP_NOT_AVAILABLE`, HPOS notice dikhata hai, conversation drop nahi.

Thinking bubble ke neeche chhota **Stop** — in-flight assistant par.

---

## Supported page detection

Sirf `https://chat.deepseek.com/*`.

| Page | Result |
| --- | --- |
| `chat.deepseek.com` chat UI, composer visible | `ready` |
| `chat.deepseek.com/sign_in` (login) | `UNSUPPORTED_PAGE` |
| koi aur origin | content script inject nahi; `DEEPSEEK_TAB_UNAVAILABLE` / `UNSUPPORTED_PAGE` |

Popup: **Use this tab as DeepSeek** — active tab `chat.deepseek.com` ho to usko preferred tab mark karta hai. Warna `UNSUPPORTED_PAGE`.

Tab band / navigate away mid-send: `PAGE_CHANGED` event, crash nahi, auto-resend nahi.

---

## Extension load (development)

1. `npm run dev` → **http://localhost:5173** Chrome/Edge mein **directly** kholo.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`
3. HPOS tab reload. Chip: **Browser connected**.
4. Alag tab mein https://chat.deepseek.com kholo, normally login karo.
5. DeepSeek tab reload (extension pehli baar load ki ho).
6. HPOS → AI chats. Chip: **DeepSeek ready**.
7. HPOS mein `Hello DeepSeek` send karo.

Agar auto-detect na ho: DeepSeek tab active rakho → extension popup → **Use this tab as DeepSeek**.

Preview/iframe hosts: HPOS tab pe **Attach HPOS tab**.

---

## PING / PONG (Step 2, unchanged)

| Chip | Matlab |
| --- | --- |
| Browser connected | Extension PONG |
| Connecting | handshake |
| Browser disconnected | extension nahi / timeout |

---

## Connector status (Step 4)

Browser connected hone par doosri chip:

| Chip | Matlab |
| --- | --- |
| DeepSeek ready | composer mila, send allowed |
| Sending | prompt insert + send (`DS_SEND` ack) |
| Generating | `RESPONSE_START`, pehla DOM text abhi nahi |
| Streaming | asli DOM `RESPONSE_DELTA` |
| Unsupported page | login / galat origin |
| DeepSeek tab not connected | koi DeepSeek tab nahi |
| Connection error | timeout / adapter fail |

Chip click = dubara detect (in-flight request ko overwrite nahi karta).

---

## Protocol allowlist (0.7.0)

Page → extension requests: `PING`, `DS_STATUS`, `DS_SEND`, `DS_STOP`, `DS_IDENTITY`, `DS_NEW_CHAT`.

Connector events: `RESPONSE_START`, `RESPONSE_DELTA`, `RESPONSE_COMPLETE`, `ERROR`.

`SCRAPE`, `GET_COOKIES`, `EVAL`, fake `RESPONSE_TOKEN`, page reload — reject.

`DS_IDENTITY` payload: `{ tabId }` (that tab only, no fallback), `{ scan: true }` (every open DeepSeek tab’s identity), `{ wantIdentity }` (first tab whose identity matches). Stale `tabId` → `DEEPSEEK_TAB_NOT_READY`, never an arbitrary other tab.

`DS_SEND` may include `tabId` + `conversationId` so a bound chat cannot land on the wrong DeepSeek tab.

`DS_NEW_CHAT` payload: `{ tabId, previousIdentity }`. The adapter clicks the normal visible **New chat** control on *that* tab, waits for the conversation identity to actually change (URL may not change instantly), and returns the new identity. If the identity cannot be verified → `DEEPSEEK_NEW_CONVERSATION_UNVERIFIED` and nothing is sent. Older extensions reject it as `UNKNOWN_ACTION`; HPOS maps that to `DEEPSEEK_NEW_CONVERSATION_UNVERIFIED` and does not send either.

---

## Conversation binding (Step 6)

An HPOS conversation binds to its **own** DeepSeek conversation:

- **First send on a genuinely new HPOS chat** (no binding): `DS_IDENTITY` picks the DeepSeek tab → `DS_NEW_CHAT` clicks the visible **New chat** control there → the adapter waits for the identity change (`newChatWaitMs`) and re-reads it. Verified == identity differs from the thread that was open, or the page was already on a fresh home/new-chat state. Only then is the binding persisted (`hpos.deepseek.bindings`) and the message sent. If verification fails → `DEEPSEEK_NEW_CONVERSATION_UNVERIFIED`, the old state is untouched, and **the message is not sent**.
- **Existing bound chat**: the stored thread identity is re-verified against the open tab(s); mismatch → `DEEPSEEK_CONVERSATION_MISMATCH`, no send. No new DeepSeek chat is created.
- DeepSeek assigns the real thread id only after the first message, so a first-time binding can be the low-confidence “new chat” state; after the send it upgrades low→high on the same tab (existing Step 6 rule).

Binding order is always: create → detect → verify → persist → send. Old conversations never silently rebind; deleting a chat deletes its binding. No cookies/tokens.

---

## Multi-tab + recovery (Step 7)

Structured connection overlay (`getConnectionState()`), not a second machine:

| State | Meaning |
| --- | --- |
| `DISCONNECTED` / `CONNECTING` | BrowserBridge |
| `CONNECTED` | extension up, DeepSeek not classified |
| `DEEPSEEK_READY` | composer usable / bound / sending |
| `DEEPSEEK_UNAVAILABLE` | no usable DeepSeek tab |
| `BINDING_UNVERIFIED` | identity could not be confirmed |
| `BINDING_MISMATCH` | open thread ≠ stored binding |

Tab pick for a **bound** chat:

1. Stored `tabId` if it still exists **and** identity matches.
2. Another already-open DeepSeek tab whose identity **exactly** matches the binding → adopt that `tabId` only.
3. Otherwise `DEEPSEEK_TAB_NOT_READY` (or mismatch if the stored tab is open on a different thread).

Never silently rebind to a different DeepSeek conversation. Never pick “the only DeepSeek tab” if it is the wrong thread. Closing a tab does **not** delete the binding.

Request lifecycle: `QUEUED → SENT → GENERATING → STREAMING → COMPLETE | FAILED | INTERRUPTED`.

If the bridge drops after `DS_SEND` was acked: keep partial assistant text, same bubble, `REQUEST_INTERRUPTED`, **do not resend**. Explicit retry (user sends again) is allowed. Chip click = `recoverConnection` (rediscover + verify), not resend.

Copy (no raw ids):

- DeepSeek disconnected. Reconnect to continue.
- The bound DeepSeek conversation is not open. Open the matching conversation and retry.
- DeepSeek is on a different conversation. No message was sent.
- DeepSeek could not verify the current conversation. No message was sent.

---

## Errors

| Code | Matlab |
| --- | --- |
| `DEEPSEEK_TAB_UNAVAILABLE` | DeepSeek tab nahi |
| `UNSUPPORTED_PAGE` | host/login allowed nahi |
| `INPUT_NOT_FOUND` | composer textarea nahi mila |
| `SEND_NOT_FOUND` | send button nahi, Enter bhi fail |
| `RESPONSE_NOT_DETECTED` | ~25s mein naya assistant text nahi |
| `PAGE_CHANGED` | navigate/reload/tab close mid-send |
| `CONNECTOR_TIMEOUT` | ~3 min, complete nahi |
| `BUSY` | pehle response abhi chal raha; overlap reject |
| `STOP_NOT_AVAILABLE` | visible Stop nahi / koi session nahi |
| `COMPOSER_GONE` | input mid-wait gayab, token nahi aaya |
| `DEEPSEEK_CONVERSATION_MISMATCH` | bound thread current page se match nahi |
| `DEEPSEEK_CONVERSATION_UNVERIFIED` | identity confirm nahi hui |
| `DEEPSEEK_TAB_NOT_READY` | DeepSeek tab usable nahi |
| `BRIDGE_DISCONNECTED` | extension/bridge down |
| `BRIDGE_TIMEOUT` | PING/handshake timed out |
| `BRIDGE_VERSION_MISMATCH` | extension too old — “Extension update required.” |
| `DEEPSEEK_IDENTITY_TIMEOUT` | identity scan timed out; no send |
| `DEEPSEEK_SEND_TIMEOUT` | send ack timed out; not resent |
| `DEEPSEEK_RESPONSE_TIMEOUT` | no first token / complete; not resent |
| `REQUEST_INTERRUPTED` | stream cut; auto-resend nahi |
| `RECOVERY_TIMEOUT` | matching tab not found in time |
| `not_available` / `disconnected` / `timeout` | bridge |

App crash nahi karti. Overlap par user text lose nahi hoti.

---

## DOM / selector assumptions

Config: `extension/adapters/deepseek.config.js`

**Input (order):**
- `textarea[name="search"]` — current DeepSeek composer (community reports, 2026)
- `textarea#chat-input`
- `textarea[placeholder*="Message DeepSeek"]` / `Ask` / `DeepSeek` / `发送`
- `textarea[spellcheck="false"]`
- visible `textarea` fallback

**Send:**
- `button[aria-label="Send"]` / `发送` / `Send message`
- `button[data-testid="send-button"]`
- composer ke andar last enabled `button`
- fallback: Enter on the textarea (Shift nahi)

**Stop:**
- `button[aria-label="Stop"]` / `停止` (visible + enabled). Nahi mila to stop fail — reload nahi.

**Assistant text:**
- observer pins the **`.ds-message` turn row** (config `message:`), so a DeepThink turn that contains both a think block and an answer block is treated as one turn
- final answer (preferred): `.ds-assistant-message-main-content` / `[class*="ds-assistant-message-main-content"]` (config `answer:`)
- fallback: `.ds-markdown` / `[class*="ds-markdown"]` nodes **not inside** a thinking container
- DeepThink reasoning: `.ds-think-content` / `[class*="ds-think-content"]` (config `thinking:`) — tracked internally only; **never** emitted as a delta and never completes a response
- sirf visible transcript, cookies/localStorage nahi

**DeepThink (response model):**

Internally the turn is split into `{ reasoningText, answerText, phase }`:

- THINKING — `.ds-think-content` is changing; HPOS deltas pause (bubble stays on “thinking”)
- ANSWERING — final-answer text streams as normal `RESPONSE_DELTA` snapshots
- COMPLETE — `RESPONSE_COMPLETE` fires only when **answer text exists**, it stayed stable for `stableMs`, and generation ended (no Stop control)

Thinking mutations count as activity (they reset the first-token timeout) but **can never** complete the response. If generation ends and no final answer appears within `thinkAnswerGapMs` (30s), the adapter reports `RESPONSE_NOT_DETECTED` (“Thinking finished without a final answer”) instead of falsely completing with reasoning text. Normal (DeepThink OFF) mode is untouched.

**New chat control:**
- config `newChat:` — `[data-testid="new-chat"]`, `button/[role="button"][aria-label*="New chat"]`, `a[href="/a/chat"]`
- exact text fallback (`newChatText:`): “New chat” / “新对话” / “开启新对话” among visible controls
- the adapter waits for the real navigation/identity change (`newChatWaitMs` / `newChatPollMs`); it never invents a conversation id

**Observe root:** `.ds-scroll-area`, `main`, warna `document.body`

**Streaming:**
- MutationObserver (childList + characterData) — `setInterval` fake chunks nahi
- `RESPONSE_DELTA` tabhi jab reconciled text **asli** change ho
- Complete: `stableMs` (1.6s) + Stop nahi + generating nahi
- Agar DeepSeek ek hi dump mein likhe, ek delta + complete — ye limitation hai, fake stream nahi

**Hashed classes** (`.dad65929`, `.fbb737a4`, …) config mein last-resort nahi rakhe gaye kyunki jaldi toot-te hain. UI change ho to pehle `deepseek.config.js` update karo.

Fill: native `<textarea>.value` setter + `input`/`change` events (React-aware `_valueTracker` reset). Security bypass nahi — user jo type karta wahi composer mein jaata hai.

---

## Permissions

- `activeTab` + `scripting` — HPOS/DeepSeek tab pe user-gesture inject (popup)
- content_scripts matches:
  - `http://localhost:5173|4173` / `127.0.0.1` — HPOS bridge
  - `https://chat.deepseek.com/*` — DeepSeek adapter

Naya host match **technically required** hai: DeepSeek tab ke composer ko padhe/likhe bina send possible nahi. `<all_urls>`, `cookies`, `storage`, `debugger`, `webRequest` nahi.

---

## Test procedure

### Fixtures (is workspace mein)

```bash
npm run bridge:check
npm run build
npx oxlint src/lib/bridge src/pages/ChatPage.jsx src/components/chat extension
```

`sync.test.mjs` A–L fixtures chalata hai (live Chrome/DeepSeek **nahi**). Live A–13 yahan claim nahi.

### Real Chrome/Edge (manual, jab session ho)

A. HPOS + unpacked extension → **Browser connected**
B. DeepSeek tab open/login/reload → **DeepSeek ready**
C. HPOS: `Hello DeepSeek` + Enter
D. DeepSeek composer mein wahi text jaaye, Send fire ho
E. DeepSeek assistant response page par aaye
F. HPOS **usi** assistant bubble mein wahi text aaye; growing snapshots replace hon, duplicate nahi
G. google.com pe “Use this tab as DeepSeek” → Unsupported page
H. DeepSeek band karke send → “DeepSeek tab not connected”
I. extension disable → **Browser disconnected**, local replies, koi “offline” chip nahi
J. New chat / Shift+Enter / auto-scroll pehle jaisa
K. Doosra send jab pehla stream ho → BUSY, pehla bubble chalta rahe, user text rahe
L. Stop: visible Stop pe click; Stop na ho to notice, reload nahi
M. Navigate away mid-send → error, crash/auto-resend nahi

---

## Hardening (Step 8)

Protocol **0.7.0** is compatible with **0.6.0** (same envelopes). Older than 0.6 → `BRIDGE_VERSION_MISMATCH` (chip: **DeepSeek · Extension update required.**). PING/PONG = extension reachable + protocol ok; it does **not** mean DeepSeek is ready.

Diagnostics: `src/lib/diagnostics/logger.js` (page) and `extension/diagnostics/logger.js` (SW). Structured events only. Default level `warn`. Debug: `localStorage['hpos.debug']='1'`. Never cookies/tokens/passwords/HTML/full message text (length only).

Timeouts (generous): bridge 4s, identity 6s, send ack 12s, first token 28s, complete 185s, recovery 10s. Timeout after a send may already have reached DeepSeek → interrupted, **no auto-resend**.

Races: overlapping Enter → `BUSY`; one recovery at a time; identity scan cached ~800ms; stale tab/request/conversation events dropped; duplicate snapshots reconciled; `COMPLETE → STREAMING` forbidden.

Stores (`hpos.conversations`, `hpos.deepseek.bindings`) have explicit `version: 1`. Old docs migrate forward; future schema loads what it can; corrupt JSON is empty, not a crash. Deleting a chat still deletes its binding.

### Manual checklist (real Chrome/Edge)

**Requires real Chrome/Edge + logged-in DeepSeek session.** Not run in this workspace. Do not treat fixtures as a live pass.

**Test A — New Chat (binding isolation, not yet run against live DeepSeek):**

1. Open HPOS.
2. Open a logged-in DeepSeek tab.
3. Create/send in HPOS Chat A.
4. Confirm DeepSeek has Thread A.
5. Click HPOS New Chat.
6. Send a different message.
7. Confirm DeepSeek moved to a NEW Thread B (sidebar shows a fresh conversation; Thread A untouched).
8. Confirm HPOS Chat B receives B's response.
9. Switch back to Chat A.
10. Send another message.
11. Confirm it goes to Thread A (Chat B / Thread B untouched).
12. If New chat creation cannot be verified (e.g. blocked UI): the message is NOT sent and the chip reads *DeepSeek could not start a new conversation.*

**Test B — DeepThink (final answer, not yet run against live DeepSeek):**

1. Open/create a new HPOS chat.
2. Enable DeepThink in DeepSeek's normal UI (the DeepThink switch next to the composer).
3. Send a prompt from HPOS.
4. Observe DeepSeek thinking. HPOS bubble stays on “thinking” — reasoning text must NOT appear in it.
5. Wait for the final answer.
6. Confirm HPOS displays the FINAL answer only.
7. Confirm exactly one assistant bubble (no duplicate).
8. Confirm completion happens after the final answer, NOT during thinking (chip leaves “Streaming” only at the end).

**Regression checks:**

1. HPOS connects (Browser connected).
2. DeepSeek is detected (DeepSeek ready / Bound).
3. Send a message.
4. Response streams into the same assistant bubble.
5. Create a second HPOS chat.
6. Bind it to another DeepSeek thread.
7. Switch between HPOS chats — transcripts stay separate.
8. Switch DeepSeek tabs — HPOS A still targets thread A.
9. Close the bound DeepSeek tab.
10. Matching alternate tab is recovered (Recheck DeepSeek).
11. Non-matching tab is rejected (no silent rebind).
12. Reload HPOS — conversations + bindings remain.
13. Reload DeepSeek tab — identity re-verified.
14. Reload the unpacked extension — reconnect, no auto-resend.
15. Interrupt a stream (disable extension / close DeepSeek) — partial text kept.
16. No duplicate send after reconnect.
17. No duplicate assistant bubble.
18. Binding identity unchanged unless first-bind / same-tab upgrade.
19. Recheck DeepSeek recovers a matching open tab.

---

## Limitations

- Chrome/Edge MV3 only.
- DeepSeek tab user khud kholta/login karta hai. HPOS naya tab create nahi karta.
- Login session extension nahi chhutaati — browser ka existing session.
- Selectors UI change par toot sakte hain; config file alag rakhi hai.
- Streaming DeepSeek ke DOM update frequency par depend karti hai. Fake tokens nahi.
- DeepThink reasoning (`.ds-think-content`) HPOS bubble mein nahi aata; final answer hi aata hai.
- Prompt cap 8000 chars; observed reply cap 100k chars.
- Arena iframe preview mein extension auto-inject nahi.
- Koi API call DeepSeek servers pe HPOS/extension se nahi (page khud karti hai, jaise user type kare).
- Live DeepSeek handshake is environment mein run nahi hua.
