# End-to-end updater test plan (installed Linux `.deb`)

Two **real** versions, built and published for real — no same-version test
(`0.1.0 → 0.1.0` can never produce an update):

| Role | Version | How it is produced |
| --- | --- | --- |
| **Installed (old)** | `0.1.0` | the build already installed on the test machine |
| **Release (new)** | `0.1.1` | published GitHub Release with `latest-linux.yml` |

The automated half of this plan lives in `npm test`
(`HPOS-Desktop/linuxUpdate.test.mjs`, `HPOS-Desktop/updater.test.mjs`,
`scripts/release-check.test.mjs`, `packaging.test.mjs`). This document is the
manual half — the parts that need a real installed package, a real network and
a real Polkit prompt.

## 0. Prepare the two builds

```bash
# --- old build (0.1.0) -----------------------------------------------------
git checkout v0.1.0            # or: set both package.json versions to 0.1.0
npm ci
npm run dist:linux             # --publish never → release/hpos_0.1.0_amd64.deb
sudo apt install ./release/hpos_0.1.0_amd64.deb

# --- new build (0.1.1) -----------------------------------------------------
git checkout main              # package.json + HPOS-Desktop/package.json = 0.1.1
npm ci
npm run release:check          # refuses when 0.1.1 is not newer than published
GH_TOKEN=ghp_xxx npm run release:linux
```

Confirm the release really carries the metadata before testing the app:

```bash
curl -sSL https://github.com/hp635738-pro/HPOS/releases/latest/download/latest-linux.yml
# → version: 0.1.1, with BOTH HPOS-0.1.1.AppImage and hpos_0.1.1_amd64.deb entries
```

## 1. Happy path — `0.1.0` → `0.1.1`

| Step | Expected |
| --- | --- |
| Launch the installed 0.1.0 app → Settings → App | Version `0.1.0`, and the mechanism line reads **"Update method: Debian package (.deb) — installed with dpkg"** |
| Press **Check for Updates** | `Version 0.1.1 is available (you have 0.1.0)` + release notes + **Download Update** |
| Press **Download Update** | progress bar 0 → 100 %, state `ready`, **"0.1.1 is downloaded and verified"** |
| Press **Restart to Update** | **"HPOS needs administrator permission to install 0.1.1 — confirm the system prompt."** → the Polkit dialog names `dpkg` → **"Update installed — HPOS is restarting…"** |
| App restarts | Settings → App shows **0.1.1** |
| `dpkg -l hpos` | `0.1.1` |
| User data | prefs, theme, sidebar order, workspace files and runtime state all intact (see §7) |

Verify the version really changed:

```bash
dpkg-query -W -f='${Version}\n' hpos      # 0.1.1
```

## 2. Already latest

Run **Check for Updates** again on 0.1.1 (with no newer release published):

* version row shows the current version,
* green **"You're up to date — 0.1.1."**,
* the button stays **Check for Updates** (never a download).

## 3. Network failure

Disconnect the machine (or block `github.com` / `api.github.com`) and press
**Check for Updates**:

* category `ENETWORK` → *"Could not reach the update server. Check your
  connection and try again."* plus the raw reason,
* **Try Again** is offered; nothing is downloaded or installed,
* reconnect → the check succeeds.

## 4. Missing release metadata

Delete `latest-linux.yml` from the release (or point at a release that only
has binaries), then press **Check for Updates**:

* category `ERELEASE` → *"No published HPOS release with update metadata was
  found…"* with the raw `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` / 404 detail,
* **not** the old generic "The update check failed." and **not** an
  integrity error,
* re-uploading the metadata fixes it without touching the app.

## 5. Invalid / corrupt artifact

* **Wrong checksum in metadata:** edit the published `sha512` for the `.deb`
  → download fails/verification fails → category `EINVALID`, *"…failed
  integrity verification and was **NOT** installed."* → `dpkg -l hpos` still
  `0.1.0`, the app keeps running.
* **Corrupted download (truncated `.deb`):** same path — HPOS re-verifies the
  SHA-512 of the file on disk before it is handed to dpkg, so dpkg is never
  called.

## 6. Interrupted download / cancelled or closed during update

| Interruption | Expected |
| --- | --- |
| Network dropped mid-download | state returns to `error` (`ENETWORK`), progress resets, **Try Again** works, nothing installed |
| App closed mid-download | nothing is applied (the download lives in the updater cache, the app is untouched) |
| Polkit prompt dismissed / cancelled | dpkg exits non-zero → `EINSTALL` (or `EPRIV` when pkexec is missing) → app stays on the old version and reports the failure; services (runtime daemon) are restarted |
| App closed during the install itself | dpkg finishes in the background (it is a privileged child); the next launch is the new version |
| Double-press **Restart to Update** | the second call is refused (`EBUSY`) |

## 7. User-data preservation

Before the update, create state that must survive:

```bash
# preferences / theme / sidebar order
cat ~/.config/HPOS/hpos-prefs.json
# workspace (packaged default)
ls ~/.config/HPOS/workspace
```

Run the update (§1) and compare:

* `~/.config/HPOS/hpos-prefs.json` — unchanged,
* `~/.config/HPOS/workspace/**` — unchanged,
* `dpkg -L hpos` — only system paths (`/opt/HPOS/**`, `/usr/share/...`); the
  install commands never reference the user data directory
  (asserted by `linuxUpdate.test.mjs` §11).

## 8. AppImage (different mechanism — test separately)

```bash
./release/HPOS-0.1.0.AppImage      # old image, not installed system-wide
```

* Settings → App reports **"Update method: AppImage — replaced in place"**,
* Check → Download → **Restart to Update** replaces the single AppImage file
  (electron-updater: chmod + x + `mv`), no Polkit prompt, no package manager,
* the relaunched image reports `0.1.1`.

## 9. Unsupported installation types

| Install | Expected |
| --- | --- |
| Snap / Flatpak | mechanism shown as unsupported with the reason ("updated by snapd/flatpak"), no fake flow |
| `npm run dist:linux:dir` (unpacked) | unsupported — no install metadata |
| Dev instance (`npm run dev` / Launch HPOS) | "development instance — updates only in the installed app" |

## 10. Machine without Polkit

On a system without `pkexec` (and not running as root), the deb path stops
with `EPRIV`: *"Administrator permission is needed… no supported privilege
tool (pkexec/Polkit) was found."* — never a `sudo` password prompt, never a
silent failure. Installing `policykit-1` makes the normal flow work.

## 11. Automated coverage

```bash
npm test          # 28 suites, incl. the four updater/release suites
npm run lint
npm run build:prod
```

| Concern | Test |
| --- | --- |
| Linux install-kind detection (AppImage/deb/snap/unknown) | `HPOS-Desktop/linuxUpdate.test.mjs` §1 |
| Per-mechanism labels (deb ≠ AppImage ≠ NSIS) | §2 + `updater.test.mjs` §11 |
| Version comparison (no same-version, no downgrade) | `linuxUpdate.test.mjs` §3, `updater.test.mjs` §10, `release-check.test.mjs` §1 |
| Release-metadata → verified artifact | `linuxUpdate.test.mjs` §4 |
| Install plan (dpkg + pkexec, path allow-list) | §5, §10 |
| Failure states (dpkg fails, repair, dismissed prompt, missing escalator) | §6, §8 |
| Inactive updater (the old silent hang) | `updater.test.mjs` §8 |
| Error categories (ENETWORK / EINVALID / ERELEASE / EPRIV / EDISABLED) | `updater.test.mjs` §5, §9 |
| Renderer IPC boundary (no arguments, no URL surface) | `updater.test.mjs` §7, §11, `linuxUpdate.test.mjs` §10 |
| User-data preservation | `linuxUpdate.test.mjs` §11 |
| Release gate / publishing contract | `scripts/release-check.test.mjs`, `packaging.test.mjs` |
| Settings UI (mechanism + failure detail, null-safe) | `src/pages/Settings.test.mjs` §6 |
