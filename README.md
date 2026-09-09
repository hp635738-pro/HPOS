# HPOS

A fully themeable desktop app shell — sidebar, header, and a Windows 11 style
settings explorer where almost every visual detail is user-editable.

Built with React 19 + Vite. No UI libraries, no icon packages, no remote fonts.

---

## Chalane ke liye

```bash
npm install     # ek baar
npm run dev     # http://localhost:5173
```

Aur commands:

```bash
npm run build   # production build -> dist/
npm run preview # build ko locally serve karo
npm run lint    # oxlint
```

**Requirements:** Node 18+ (Step 6 verification Node 22 par chali hai)

Browser bridge + DeepSeek connector — Chrome/Edge extension load karne ke steps `BRIDGE.md` mein hain.

Conversations local `localStorage` mein persist hoti hain — koi cloud sync ya
DeepSeek API nahi; Step 6 execution localhost runtime ke through hota hai.

### Local runtime + browser DeepSeek (Step 6)

The local `hpos-runtime` daemon is connected during Vite development and now
owns the AI task lifecycle:

```bash
cd runtime
npm install     # playwright-core transport only; no browser download
npm start       # listens on 127.0.0.1:5190 and writes ~/.hpos/runtime/endpoints.json
```

Start a visible Chromium/Chrome instance with a dedicated profile and loopback
CDP, open exactly one `https://chat.deepseek.com/` tab, then sign in normally:

```bash
chromium --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.hpos/deepseek-browser"
```

HPOS Chat submits the fixed `browser.deepseek` service to the runtime; it does
not use the extension Browser Bridge as its primary execution path. The runtime
never receives browser credentials/session data, never reads cookies/storage,
and never retries a prompt after an uncertain send, timeout, disconnect or
restart. See `runtime/README.md` for browser variants, lifecycle and security.

With `npm run dev` running from the project root, the browser uses the fixed
same-origin routes `/hpos-runtime/health`, `/hpos-runtime/rpc` and (Step 4)
`/hpos-runtime/events` (SSE). The Vite development proxy reads the local
endpoint file, keeps the target on `127.0.0.1`, and adds `X-HPOS-Token`
server-side. `LocalRuntimeBridge` never receives, stores, or sends that
credential. `Runtime connected` means authenticated `PING` and `RT_STATUS` both
succeeded; `/health` is liveness only.

The runtime publishes allowlisted lifecycle events (`runtime.*`, `task.*`) over
SSE, including `GENERATING`/`STREAMING` and the bounded final assistant response
for Chat. The header **Runtime Activity** popover shows connection/stream state,
running DeepSeek tasks with Stop, bounded recent tasks, counters, and safe
process metrics; it deliberately discards chat output and remains **not a
terminal**. There is no arbitrary task, browser, command or shell UI.

Details: `runtime/README.md` (`/events`, event types, history/reconnect,
metrics availability, Activity UI non-goals).

```bash
npm test        # bridge, runtime-connection, runtime-event-stream, runtime-activity,
                # proxy, and storage checks (root) + `cd runtime && npm test`
```

---

## Kya bana hua hai

### Shell
- Sidebar — 8 pages, drag-to-reorder, right-click se pin/lock, collapse mode
- Header — page title, Wide Notch (Settings/File pill), theme toggle
- Pages abhi blank hain, content ka intezaar

### Theming
- Light / Dark / System
- 8 accent presets + custom colour picker
- 11 colour tokens editable, light aur dark ke alag overrides
- Density, radius, aur poora typography control

### Systems
- **Command palette** (`Ctrl+K`) — fuzzy search, pages + settings + actions
- **Advanced settings** — 12 panels, search, breadcrumb, related suggestions
- **Workspaces** — poora look naam se save karo, switch karo
- **Undo / Redo** — settings ke liye, 50-step history
- **Export / Import** — settings JSON file
- **Toast + Modal** — mounted aur available
- **Component kit** — 28 reusable components (`ui/Kit.jsx`)

---

## File structure

```
src/
├── App.jsx                 shell, routing, palette wiring
├── main.jsx                providers: Theme -> Toast -> Modal
├── index.css               tokens, animations, global styles
│
├── theme/
│   └── ThemeContext.jsx    prefs store, palettes, undo/redo engine
│
├── lib/
│   ├── colour.js           hex/rgb/hsv/hsl, contrast, harmony
│   ├── chat/               message factory + conversation hook
│   ├── storage/            local conversation store (Step 5)
│   └── bridge/             BrowserBridge compatibility + runtime DeepSeek client
│
├── pages/
│   ├── Blank.jsx           empty canvas
│   └── Settings.jsx        Appearance + Danger zone
│
└── components/
    ├── Sidebar.jsx         nav, drag, pin/lock, context menu
    ├── Topbar.jsx          header shell
    ├── Notch.jsx           the header pill
    ├── Icons.jsx           55+ inline SVG icons
    ├── CommandPalette.jsx  Ctrl+K launcher
    ├── ColourField.jsx     swatch + hex input
    ├── ColourPicker.jsx    full picker popover
    ├── AdvancedEditor.jsx  settings explorer shell
    │
    ├── WorkspacePanel.jsx  ┐
    ├── ColoursPanel.jsx    │
    ├── TypePanel.jsx       │
    ├── ComponentPanel.jsx  │
    ├── PickerPanel.jsx     │  advanced settings pages
    ├── NotchPanel.jsx      │
    ├── SidebarPanel.jsx    │
    ├── HeaderPanel.jsx     │
    ├── PalettePanel.jsx    │
    ├── ShortcutsPanel.jsx  │
    ├── BackupPanel.jsx     ┘
    │
    └── ui/
        ├── Bits.jsx        panel primitives (in use)
        ├── Kit.jsx         28 components (not applied yet)
        ├── Modal.jsx       dialog system (mounted)
        └── Toast.jsx       notifications (mounted)
```

---

## Kaise kaam karta hai

### Everything is a CSS variable

`ThemeContext` har preference ko `:root` pe CSS variable ke roop mein likhta hai.
Koi bhi naya component agar `var(--accent)`, `var(--surface)` waghera use kare,
toh wo apne aap theme follow karega — alag se kuch karne ki zarurat nahi.

```jsx
const { prefs, set, resolved, accentHex } = useTheme()

set('accent', 'violet')       // ek preference badlo
prefs.railWidth               // koi bhi value padho
resolved                      // 'light' ya 'dark' (system resolve ho ke)
```

### Naya settings panel add karna

1. `src/components/` mein panel banao, `ui/Bits` ke primitives use karke
2. `AdvancedEditor.jsx` ke `PAGES` array mein ek entry add karo
3. Bas — search, breadcrumb, related suggestions sab apne aap jud jayenge

### Palette mein command add karna

`CommandPalette.jsx` ke `commands` memo mein ek object push karo:

```js
{ id: 'act:something', group: 'Actions', name: 'Do the thing', run: () => {} }
```

---

## Conversations (Step 5)

AI chat transcripts **local** persistent conversations hain. Koi cloud sync,
DeepSeek API, ya AI title API nahi; browser execution localhost runtime own karta hai.

### Storage

- **Key:** `localStorage['hpos.conversations']`
- **Schema version:** `1`
- **Module:** `src/lib/storage/conversationStore.js` — UI is module ko use karti hai; components khud `localStorage` nahi chhuute.

```json
{
  "version": 1,
  "activeId": "c-…",
  "conversations": [
    {
      "id": "c-…",
      "title": "Explain quantum computing",
      "createdAt": 1710000000000,
      "updatedAt": 1710000000000,
      "provider": "deepseek",
      "messages": [
        { "id": "m-…", "role": "user", "content": "…", "ts": 1710000000000, "status": "sent" }
      ]
    }
  ]
}
```

`ts` existing chat timestamp hai (`MessageBubble` usi ko use karta hai). Cookies, passwords, tokens persist **nahi** hote.

Corrupt JSON / invalid records ignore ho jaate hain — app crash nahi karti, empty state dikhti hai. Future schema: `migrate()` `version` ke through chalta hai.

### New chat

Header ka standalone **New chat** naya conversation create karta hai (`title: "New chat"`, `provider: "deepseek"`), usko active karta hai, aur chat area empty state dikhata hai. Composer turant usable hai. Har click ek naya conversation banata hai — mount par auto-create nahi.

Pehli meaningful user message se title **local** truncate hota hai (koi API nahi): `"Explain quantum computing"` → wahi title.

### Sidebar list

AI tools → AI chats ke neeche conversations: title + subtle time. Selected row highlight. Hover par trash; confirm ke baad delete.

Delete active conversation: remaining mein sabse recent active ho jaati hai. Last wali delete ho to “Start a new chat”.

### Switch + refresh

Conversation click → selected load, composer reset, messages mix nahi hote. Streaming deltas **usi** conversation id par patch hoti hain, visible chat chahe switch ho chuka ho.

Refresh: conversations aur messages `localStorage` se wapas.

Streaming: memory har delta par update, disk ~280ms debounce, complete par flush.

### Limitations

- Sirf is browser origin ka localStorage. Dusre device / profile par copy nahi.
- DeepSeek tab/session persist nahi — sirf HPOS transcript.
- `provider` abhi `"deepseek"` (future providers ke liye field reserved).
- Title rename UI is step mein nahi.

---

## Settings kahan save hote hain

- **`localStorage['nexa.prefs']`** — primary
- **`.hpos-prefs.json`** — dev server ke through disk mirror

Dusra wala isliye hai kyunki localStorage page origin se juda hota hai.
Dev sandbox restart pe naya host deta hai, toh settings reset dikhte the.
Local VS Code pe ye zaroori nahi, par nuksaan bhi nahi karta.

---

## Notes

- **Koi remote font nahi** — sirf OS-native stacks. Sandbox mein Google Fonts
  blocked tha, aur waise bhi offline desktop app ke liye yahi sahi hai.
- **Saare icons inline SVG** hain `Icons.jsx` mein — koi icon package nahi.
- **Desktop-first** — mobile ke liye responsive pass abhi nahi hua.
- **Undo history memory mein** hai, reload pe clear ho jaati hai (by design).

---

## Aage kya

Poori list `ROADMAP.md` mein hai. Sabse upar:

1. Keyboard shortcuts ko wire karna (bindings record hote hain, kaam nahi karte)
2. Component kit ko baaki panels pe apply karna
3. Blank pages pe empty states
4. Favourites page ka content
5. Tauri desktop packaging
