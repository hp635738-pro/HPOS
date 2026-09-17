# HPOS — Linux Setup Guide (Debian / Ubuntu / Mint / Pop!_OS)

Poori guide Hinglish mein — step by step. Aapke system (64-bit Debian/Ubuntu
type, x64) ko dhyan mein rakh kar likhi hai.

HPOS ek **desktop app shell** hai (Electron + React) jo apne saath ek runtime,
terminal, Git bridge aur Code Arena workspace launch karta hai. Linux pe ab
**teen tarike** se chal sakti hai:

| Tarika | Kab use karo | Command |
|---|---|---|
| **Dev mode (browser)** | UI/theming par kaam karna | `npm run dev` |
| **Desktop shell (unpackaged)** | Desktop app turant chalani hai | `npm run build:prod` + `npx electron HPOS-Desktop` |
| **Packaged app (AppImage/deb)** | Asli installable app banani hai | `npm run dist:linux` |

> Windows wali guide ke liye README ka *Production packaging (Windows)*
> section dekho — dono ka payload bilkul same hai.

---

## 1. Requirements

- **64-bit Linux** (x64) — Debian 11+/12, Ubuntu 20.04/22.04/24.04, Mint 20+,
  Pop!_OS, ya koi bhi modern distro (glibc ≥ 2.31)
- **Node.js 18 ya usse upar** (Node 22 par test kiya gaya hai)
- **Git** (Code Arena ke Git bridge ke liye; optional agar sirf app chalani ho)
- Internet **sirf pehli baar**: `npm install` aur packaging ke waqt Electron
  binary GitHub se download hota hai (~100 MB, `~/.cache` mein cache ho jata hai)
- RAM/disk: 4 GB RAM, ~1.5 GB free disk (repo + node_modules + cache)

Check kar lo:

```bash
uname -m          # x86_64 hona chahiye
node --version    # v18+ (v22 best)
git --version     # koi bhi recent version
```

---

## 2. Node.js install (agar nahi hai)

**Option A — NodeSource se LTS (recommended):**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Option B — apt wala (purana ho sakta hai):**

```bash
sudo apt-get install -y nodejs npm
node --version    # v18+ hai na confirm karo
```

**Option C — nvm (system ko touch nahi karna chahte ho):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# terminal restart karo, phir:
nvm install 22
```

---

## 3. Code lo aur dependencies install karo

```bash
# GitHub se clone karo
git clone https://github.com/hp635738-pro/HPOS.git
cd HPOS

# Root dependencies (React, Vite, Electron, electron-builder)
npm install

# Runtime dependencies (playwright-core — app ke saath packaged hota hai)
cd runtime && npm install && cd ..
```

Pehli baar 1–3 minute lagenge. `node_modules` git mein nahi jata — tension na lo.

---

## 4. Turant chalao — 3 tarike

### 4a. Browser dev mode (sabse fast)

```bash
npm run dev
# http://localhost:5173 kholo
```

Hot reload ke saath. Theming, sidebar, settings — sab UI kaam ke liye.

### 4b. Desktop shell (asli Electron window, unpackaged)

```bash
# pehle production frontend build (ek baar, ya jab UI badle)
npm run build:prod

# phir desktop app kholo
npx electron HPOS-Desktop
```

Dev mode (`app.isPackaged === false`) mein workspace **khud ye repository**
hoti hai — Explorer, editor, terminal aur Git bridge asli HPOS source pe
chalte hain.

### 4c. Dev frontend + desktop shell saath mein (UI badalte hue desktop mein dekhna)

Do terminal kholo:

```bash
# Terminal 1 — Vite dev server
npm run dev

# Terminal 2 — Electron shell, dev server ki taraf point karke
HPOS_DEV_URL=http://localhost:5173 npx electron HPOS-Desktop
```

`HPOS_DEV_URL` hatate hi Electron phir se `dist/` (production build) load karta hai.

---

## 5. Asli Linux app banao (AppImage + deb)

Ek hi command dono installable formats banati hai:

```bash
npm run dist:linux
```

Ye chain chalati hai: production React build → workspace project payload →
electron-builder (AppImage + deb, x64).

**Output (sab `release/` folder mein, gitignored):**

| File | Kya hai |
|---|---|
| `release/HPOS-0.1.0.AppImage` | Portable app — double-click/direct run, install ki zarurat nahi |
| `release/hpos_0.1.0_amd64.deb` | System install — apps menu, icons, uninstall support |
| `release/linux-unpacked/` | Raw unpacked app (smoke test ke liye) |

Sirf unpacked dir chahiye toh:

```bash
npm run dist:linux:dir     # release/linux-unpacked/HPOS
```

### AppImage chalana

```bash
chmod +x release/HPOS-0.1.0.AppImage
./release/HPOS-0.1.0.AppImage
```

> Debian 12 / Ubuntu 22.04+ pe ek baar `sudo apt install libfuse2` lagana
> pad sakta hai (AppImage ko FUSE chahiye).

### deb install karna

```bash
sudo apt install ./release/hpos_0.1.0_amd64.deb
# ya
sudo dpkg -i release/hpos_0.1.0_amd64.deb && sudo apt-get install -f
```

Install ke baad **HPOS** apps menu mein mil jayega (category: Development),
icon ke saath. Uninstall: `sudo apt remove hpos` — user data jaan boojh kar
delete nahi hoti (`~/.config/HPOS/` aur `~/.hpos/runtime` bachi rehti hain).

### Kya packaged hota hai (dono platforms same)

- `HPOS-Desktop/` — Electron main process (asar ke andar)
- `dist/` — Vite-built React frontend (asar ke andar)
- `runtime/` — HPOS runtime daemon (`resources/runtime` mein)
- `workspace-project/` — asli HPOS project payload jo pehli launch pe
  `<userData>/workspace` (~/.config/HPOS/workspace) mein seed hota hai
- Tests, `.env`, secrets, `.git`, node_modules — **kabhi package nahi hote**
  (`packaging.test.mjs` ye contract enforce karta hai)

---

## 6. App ko update karna — Settings → App → "Update from GitHub" (naya!)

Jab repo (`hp635738-pro/HPOS`) mein naye changes aa jayein, aapko kuch
manually karne ki zarurat **nahi** — app ke andar hi update button hai:

1. HPOS desktop app kholo → **Settings (gear icon)** → **App** section
2. **"Update from GitHub"** panel mein **Update** button dabao
3. Bas. App khud ye sab karta hai, live progress ke saath:
   - `origin/main` check (naya update hai ya nahi)
   - Fast-forward pull (aapke uncommitted changes honge toh **safe refuse** —
     pehle commit kar lo)
   - `package.json` badla ho toh `npm install`
   - Frontend sources badli hain toh `npm run build:prod`
   - Ant mein jo zaruri ho: windows reload **ya** poori app restart

Aapke is doubt ka jawab — *"code local par laane se app mein badlav hoga ya
nahi?"* — button isi liye bana hai: pull ke baad changed files dekh kar app
**khud decide karta hai** ki install/build/restart kya chahiye, aur naya code
running app mein apply ho jata hai. Kuch manually nahi karna padta.

> Ye button dev-shell (repo se chalane) ke liye hai. AppImage/deb install mein
> panel hidden hai — wahan app updates **Check for Updates** (Releases) se
> aate hain. Code Arena ke andar workspace pull wala button pehle se hai —
> ye Settings wala uska app-updating bada bhai hai.

---

## 7. Windows installer Linux pe banana ho toh (optional)

electron-builder Linux se NSIS `.exe` cross-build kar sakta hai, par uske liye
**Wine** chahiye hota hai — practical nahi. Better hai Windows installer apne
Windows machine pe banao (`npm run dist:win`) ya CI use karo.

---

## 8. Zaroori paths aur env vars

| Cheez | Value |
|---|---|
| Workspace (packaged) | `~/.config/HPOS/workspace` |
| Workspace override | `HPOS_WORKSPACE_ROOT=/abs/path` (packaged mode, pehle se exist karna chahiye) |
| Runtime state | `~/.hpos/runtime` |
| Dev URL flag | `HPOS_DEV_URL=http://localhost:5173` |
| Electron mirror (proxy ho toh) | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |

App ki prefs file: `~/.config/HPOS/hpos-prefs.json` (themes, sidebar order, etc.)

---

## 9. Troubleshooting

**`AppImages require FUSE to run`**
```bash
sudo apt install libfuse2
```

**App khulte hi band / `error while loading shared libraries`**
Electron ki shared libs missing hain:
```bash
sudo apt install libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6
# Ubuntu 24+ pe libasound2 na mile toh: sudo apt install libasound2t64
```

**`The SUID sandbox helper binary was found, but is not configured correctly`**
Kernel user-namespaces allowed nahi hain. Do fixes:
```bash
# Fix A — sandbox helper ko proper permissions do (AppImage/deb extract karke):
sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

# Fix B — user namespaces enable karo:
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

**Ubuntu 24.04+: `Futhark...` / Electron crashes on launch**
Ubuntu 24.04 ne unprivileged user namespaces pe AppArmor restriction lagayi hai:
```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# permanent karne ke liye /etc/sysctl.d/ mein file daal do
```
(ya app ko `--no-sandbox` se chalao — sirf trusted local use ke liye)

**Wayland pe blank window**
Electron 31 default XWayland use karta hai — normally theek hai. Native Wayland
chahiye toh:
```bash
./HPOS-0.1.0.AppImage --ozone-platform-hint=auto
```

**`npm install` / `dist:linux` Electron download pe atka**
GitHub release assets (`objects.githubusercontent.com`) network se blocked ho
sakta hai (kuch offices/ISPs/sandboxes). Mirror try karo:
```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

**deb install mein dependency error**
`dpkg -i` ke baad `sudo apt-get install -f` chala do, ya seedha
`sudo apt install ./file.deb` use karo (dependencies khud resolve hoti hain).

**Port 5173 already in use**
`npm run dev` chalne se pehle purana Vite band karo: `kill $(lsof -t -i:5173)`

---

## 10. Tests chalana (sab kuch verify karo)

```bash
npm test          # 551+ assertions — packaging, bridge, runtime, terminal, themes
npm run lint      # oxlint
npm run bridge:check
```

`packaging.test.mjs` Windows **aur** dono ka packaging contract validate karta
hai bina kuch build kiye (icon, targets, payload excludes, scripts) — config
todne wala change pehle test mein pakda jayega.

---

## TL;DR

```bash
git clone https://github.com/hp635738-pro/HPOS.git && cd HPOS
npm install && (cd runtime && npm install)
npm run dev                       # browser mein turant
npm run build:prod && npx electron HPOS-Desktop   # desktop window
npm run dist:linux                # AppImage + deb banao
sudo apt install ./release/hpos_0.1.0_amd64.deb   # system mein install
```

App update? App ke andar **Settings → App → Update from GitHub → Update** —
bas ek click (section 6 dekho).
