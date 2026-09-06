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

**Requirements:** Node 18+ (Node 20 pe test kiya hua)

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
│   └── colour.js           hex/rgb/hsv/hsl, contrast, harmony
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
