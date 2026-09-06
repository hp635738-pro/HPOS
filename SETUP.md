# VS Code mein setup

## 1. Zip extract karo

Kahin bhi rakh do, jaise `C:\Projects\hpos` ya `~/projects/hpos`.

## 2. VS Code mein kholo

```
File → Open Folder → hpos folder chuno
```

VS Code kuch extensions suggest karega (`.vscode/extensions.json` se) —
install kar lena, kaam aasan ho jayega.

## 3. Dependencies install karo

Terminal kholo (`` Ctrl+` ``) aur:

```bash
npm install
```

Pehli baar 1-2 minute lagenge. `node_modules` folder ban jayega —
usko kabhi zip/git mein daalne ki zarurat nahi.

## 4. Chalao

```bash
npm run dev
```

Browser mein `http://localhost:5173` kholo. Code save karoge toh
page apne aap update hoga.

---

## Node nahi hai?

[nodejs.org](https://nodejs.org) se **LTS** version download karo.
Install ke baad check karo:

```bash
node --version    # v18 ya usse upar
npm --version
```

---

## Git shuru karna ho

```bash
git init
git add .
git commit -m "Initial commit"
```

`.gitignore` pehle se sahi set hai — `node_modules`, `dist`, aur
local prefs file skip ho jayengi.

---

## Build karna

```bash
npm run build     # dist/ folder banega
npm run preview   # build ko test karo
```

`dist/` folder kisi bhi static host pe daal sakte ho.

---

## Aage desktop app banana ho (Tauri)

Ye baad ka kaam hai, par jab karna ho:

1. Rust install karo — [rustup.rs](https://rustup.rs)
2. `npm install -D @tauri-apps/cli`
3. `npx tauri init`
4. `npx tauri build` → `.exe` / `.dmg` / `.deb`

React code bilkul same rahega, kuch badalna nahi padega.
