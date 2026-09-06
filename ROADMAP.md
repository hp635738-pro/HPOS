# HPOS — Roadmap

Kya ban chuka hai aur kya baaki hai, ek jagah.

**Last updated:** 2026-09-05
**Stack:** React 19 + Vite · no external runtime deps · system fonts only

---

## ✅ Ban chuka hai

### Shell
- [x] Full-screen layout — sidebar + header + content
- [x] **Sidebar** — 8 pages, custom icons, collapse mode
  - drag-to-reorder (order localStorage mein save)
  - right-click → Pin to top / Lock position
  - pinned items upar, divider ke saath
- [x] **Header** — page title + Wide Notch (Settings/File) + theme toggle
- [x] **Blank pages** — content aane ka intezaar

### Theming
- [x] Light / Dark / System, live switching
- [x] 8 accent presets + **custom colour** (hex + picker)
- [x] Text-on-accent: Auto / White / Black (contrast-aware)
- [x] Tint strength slider
- [x] **11 colour tokens** editable — light aur dark ke alag overrides
- [x] Density (Compact / Comfortable / Spacious) + global radius

### Typography
- [x] 9 OS-native font stacks + custom CSS stack
- [x] ⭐ Star karke fonts ko top pe pin karna
- [x] Size scale, line height, letter spacing
- [x] Body weight, heading weight + tracking, smoothing
- [x] Text colours (Primary / Secondary / Muted)

### Advanced settings (Win11-style explorer)
- [x] Full-screen overlay, nav pane + search + breadcrumb
- [x] Sidebar page pe asli rail visible rehta hai (live editing)
- [x] Har page ke end mein **Related settings** suggestions
- [x] Save / Cancel with snapshot-revert

**Panels:**
- [x] Workspaces
- [x] Theme colours
- [x] System text
- [x] Colour picker
- [x] Wide Notch
- [x] Sidebar
- [x] Header
- [x] Command palette
- [x] Keyboard shortcuts *(record only — wired nahi)*
- [x] Backup and reset

### Systems
- [x] **Colour picker** — SV plane, hue slider, HEX/RGB/HSL, harmony suggestions, recents, WCAG contrast
- [x] **Command palette** (Ctrl+K) — fuzzy search, pages + panels + actions + workspaces, on/off switch, rebindable key
- [x] **Toast notifications** — 4 tones, actions, auto-dismiss · mounted
- [x] **Modal / dialog** — confirm, alert, custom render, stacking · mounted
- [x] **Workspaces** — poora look naam se save, scope-selectable, 4 starter looks
- [x] **Undo / Redo** — settings ke liye, 50-step history, on/off toggle
- [x] **Export / Import** — JSON file, validated import with summary
- [x] **Component kit** — 28 reusable components *(banaya, apply nahi kiya)*

---

## ⬜ Baaki hai

### Zaroori — shell poora karne ke liye

- [ ] **Shortcuts ko wire karna**
  20 bindings record ho chuke hain par kaam nahi karte. Ek `useHotkeys` hook chahiye jo bindings padhe aur actions se jode.

- [ ] **Component kit ko apply karna**
  `ui/Kit.jsx` mein 28 components ready hain. Purane panels ko inpe migrate karna hai — abhi har panel apna Row/Slider/Toggle rakhta hai.

- [ ] **Empty states har blank page pe**
  8 pages bilkul khaali hain. Har page pe icon + naam + ek line — finished dikhega.

- [ ] **Favourites page ka content**
  Sidebar mein "Favourites" hai par blank. Isko starred pages/panels ka hub banana hai.

### App features

- [ ] **Status bar** — neeche patli bar: active page, theme, zoom %, live info. On/off ke saath.
- [ ] **Tabs / Split view** — do pages ek saath, ya browser jaisi tabs
- [ ] **Search across settings** — Advanced ke bahar bhi, poori app mein
- [ ] **First-run tour** — 4-5 step walkthrough
- [ ] **Notifications centre** — toasts ka history, bell icon ke saath
- [ ] **Sidebar groups** — nav items ko sections mein baantna (headings ke saath)
- [ ] **Custom icons per page** — user apna icon chun sake

### Settings mein aur

- [ ] **Motion / animation controls** — speed, reduce-motion, disable transitions
- [ ] **Scrollbar styling** — width, colour, auto-hide
- [ ] **Focus ring customisation** — keyboard navigation ka outline
- [ ] **Per-page theme override** — har page ka apna accent
- [ ] **Import/export ek single workspace ka** — abhi sirf poore prefs export hote hain
- [ ] **Settings diff view** — default se kya-kya alag hai, ek list mein

### Data layer *(backend design ke baad)*

- [ ] Page content — Input terminal, Analyzing, Topics, Bord, AI analyz, Chats, Assistant
- [ ] State management — jab data aayega
- [ ] Persistence — localStorage se aage (file system / DB)
- [ ] Error boundaries + loading states

### Packaging *(baad mein)*

- [ ] **Tauri desktop build** — `.exe` / `.dmg` / `.deb`
  Rust chahiye hoga, build user ke apne PC pe chalegi. Code change nahi hoga.
- [ ] App icon + installer
- [ ] Auto-update
- [ ] Offline mode

---

## 📁 File structure

```
app/src/
├── App.jsx                    shell + routing + palette wiring
├── main.jsx                   providers: Theme → Toast → Modal
├── index.css                  tokens, animations, global styles
│
├── theme/
│   └── ThemeContext.jsx       prefs store, palettes, undo/redo engine
│
├── lib/
│   └── colour.js              hex/rgb/hsv/hsl, contrast, harmony
│
├── pages/
│   ├── Blank.jsx              empty canvas
│   └── Settings.jsx           Appearance + Danger zone
│
└── components/
    ├── Sidebar.jsx            nav, drag, pin/lock, context menu
    ├── Topbar.jsx             header shell
    ├── Notch.jsx              the header pill
    ├── Icons.jsx              50+ inline SVG icons
    ├── CommandPalette.jsx     Ctrl+K launcher
    ├── ColourField.jsx        swatch + hex input
    ├── ColourPicker.jsx       full picker popover
    ├── AdvancedEditor.jsx     Win11 settings explorer
    │
    ├── WorkspacePanel.jsx     ┐
    ├── ColoursPanel.jsx       │
    ├── TypePanel.jsx          │
    ├── PickerPanel.jsx        │  advanced settings pages
    ├── NotchPanel.jsx         │
    ├── SidebarPanel.jsx       │
    ├── HeaderPanel.jsx        │
    ├── PalettePanel.jsx       │
    ├── ShortcutsPanel.jsx     │
    ├── BackupPanel.jsx        ┘
    │
    └── ui/
        ├── Bits.jsx           shared panel primitives (in use)
        ├── Kit.jsx            28 components (NOT applied yet)
        ├── Modal.jsx          dialog system (mounted)
        └── Toast.jsx          notifications (mounted)
```

---

## 📝 Notes

- Sab kuch **CSS variables** pe chalta hai — naya component apne aap theme follow karega
- **Koi remote font nahi** — sandbox mein blocked hai, sirf system stacks
- Prefs `localStorage['nexa.prefs']` mein
- Undo history **memory mein** hai — reload pe clear ho jaati hai (by design)
- `node_modules` workspace snapshot mein save nahi hota — session ke shuru mein `npm install`
