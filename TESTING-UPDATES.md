> # ⚠️ STATUS: **the installed-app test is NOT VERIFIED** (the release is real)
>
> **Release 0.1.1 is published** (`v0.1.1`, commit `d3798b2`):
> <https://github.com/hp635738-pro/HPOS/releases/tag/v0.1.1> — with
> `hpos_0.1.1_amd64.deb`, `HPOS-0.1.1.AppImage` and `latest-linux.yml`, all
> sha512-verified by a CI job that downloaded the published assets back.
>
> **What is still NOT verified:** the flow
> *installed 0.1.0 → Settings → App → Check for Updates → 0.1.1 detected →
> Download → Restart to Update → running 0.1.1* has **never been executed**.
> The agent machine has no HPOS installed (`dpkg-query -W hpos` → not
> installed, `/opt/HPOS` does not exist) and is not root, so it cannot run it.
> **Nothing in §1–§9 has been run.** PR #36 stays NOT VERIFIED until the
> machine that has HPOS 0.1.0 installed has run §1–§9.
>
> **Read this before judging the result** — the two sides are different code:
>
> | | HPOS **0.1.0** (installed now) | HPOS **0.1.1** (this release) |
> | --- | --- | --- |
> | updater object | `require('electron-updater').autoUpdater`, which reads `resources/package-type` and resolves to the library's own `DebUpdater` | `DebUpdater` (deb) / `AppImageUpdater` (AppImage), chosen explicitly in `main.js` |
> | install | library: `dpkg -i` (fallback `apt-get install -f -y`) through `runCommandWithSudoIfNeeded` (pkexec) | `linuxUpdate.js`: re-verify sha512 → `pkexec --disable-internal-agent dpkg -i` → apt repair → `app.relaunch()` |
> | failure reporting | a generic "The update check failed." | categorised (`ERELEASE`/`EINTEGRITY`/`EPRIV`/…) |
>
> So a successful §1–§9 run on 0.1.0 proves the **release metadata, artifact
> naming and sha512** are right, and that the library's own deb path works.
> The PR #36 install backend (`linuxUpdate.js`) only ships *inside* 0.1.1 and
> is exercised by the **next** update (0.1.1 → 0.1.2). Both matter; they are
> different tests.

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

## 2b. A press is never silent

On any of the three buttons (Check / Download / Restart):

| What happens | What the panel must show |
| --- | --- |
| The press itself | the started state **immediately** — *"Checking the release source for a newer version…"* with a disabled **Checking…** button, or *Downloading … 0 %* / *"Installing the update — HPOS is restarting…"* |
| The call answers | the status it returns, whether or not a pushed event arrived in the window (up to date / version available / error) |
| The call is refused or rejects | a visible error with its code + raw reason (e.g. `EUNTRUSTED`, or *"HPOS could not reach its updater — restart the app and try again."*) and **Try Again** |
| Nothing answers at all | after 30 s: *"The update check did not answer in time — the release source may be unreachable. Try again."* + **Try Again** — never an endless *Checking…* and never a dead button |

Covered automatically by `src/lib/updaterStatus.test.mjs` (the click contract)
and `src/pages/Settings.test.mjs` (the panel's states).

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



---

## 12. Why the agent could not run this (and what it ran instead)

| Blocker | Evidence |
| --- | --- |
| The sandbox cannot build the .deb | `npm run dist:linux` reaches `packaging platform=linux arch=x64 electron=31.0.0` and then fails with `RequestError: unable to verify the first certificate`. Electron is downloaded from `objects.githubusercontent.com`, which this sandbox's egress proxy hard-blocks (`curl` → `SSL_ERROR_SYSCALL`); `npmmirror.com` is blocked too. |
| No installed HPOS here | `node scripts/verify-deb-install.mjs` → `dpkg reports package hpos — not installed`, `/opt/HPOS/hpos — ENOENT`. This machine is **not** the machine described in the task. |
| No root, no Polkit here | `id -u` → `1001`, no `sudo`, no `pkexec` — a real `dpkg -i` into `/` and a real Polkit prompt are both impossible. |
| ~~No release may be published yet~~ — **solved with GitHub Actions** | The sandbox cannot build (Electron download blocked), so CI became the build environment: workflow run [35311956443](https://github.com/hp635738-pro/HPOS/actions/runs/35311956443) built AppImage + deb + `latest-linux.yml`, published release `v0.1.1`, re-downloaded every asset from the release and compared its sha512 with the metadata. |

What the agent *did* run, for real (no mocks of the library):

* **The real electron-updater release pipeline** over an injected HTTP
  executor (`HPOS-Desktop/releaseMetadata.integration.test.mjs`):
  `GitHubProvider.getLatestVersion()` parses a real releases `.atom` feed,
  resolves the `latest` tag, fetches `latest-linux.yml`, `Provider.resolveFiles`
  + `findFile(files,'deb',…)` selects **exactly**
  `…/releases/download/v0.1.1/hpos_0.1.1_amd64.deb`, and the real
  `AppUpdater.isUpdateAvailable` accepts 0.1.1 for a 0.1.0 install while
  refusing 0.1.0-again and downgrades. The metadata used there is generated in
  the byte-level shape electron-builder writes (`files[].url/sha512/size`,
  `path`, `sha512`, `releaseDate`) and its SHA-512 is hashed from a `.deb`
  built for real with `dpkg-deb`.
* **The whole chain** from that metadata into HPOS code: `readVerifiedArtifact`
  → `verifyFileSha512` → `planPackageInstall` → the shared state machine →
  `pkexec --disable-internal-agent dpkg -i ~/.cache/hpos-updater/pending/hpos_0.1.1_amd64.deb`
  → relaunch with 0.1.1.
* **A real `dpkg -i` driven by `runInstallPlan`** (non-root, redirected
  `--root`): SHA-512 verified → dpkg exit 0 → payload unpacked to
  `/opt/HPOS/resources/` → `dpkg -l hpos` → `0.1.1`. So the install command
  this PR issues really installs a package.

**Plus, in GitHub Actions (real machines, real Electron, real network):**

* `verify` — `npm run lint`, `npm test` (637 assertions, 31 suites) and
  `npm run release:check`.
* `validate` — `npm run dist:linux` really built `hpos_0.1.1_amd64.deb` and
  `HPOS-0.1.1.AppImage`, and `npm run verify:artifacts` asserted that every
  `sha512`/`size` in `latest-linux.yml` is the hash of the file that gets
  uploaded and resolves to `…/releases/download/v0.1.1/<file>`.
* `release-linux` — `npm run release:linux` published the release, then
  `npm run verify:release` proved it is not a draft, that
  `/releases/latest` → `v0.1.1`, that `latest-linux.yml` is downloadable at
  the URL the updater requests, that **every entry points at an asset that
  really exists**, and that the downloaded asset's sha512 equals the metadata.
  The report is published as commit statuses (`hpos/verify/release/*`) on
  commit `d3798b2`.
* `release-win` — published `HPOS-Setup-0.1.1.exe` + `latest.yml` into the
  same release.

None of that exercises: the installed 0.1.0 app, the Settings → App buttons,
the download as seen by a real installed app, the real Polkit dialog, or the
restart. **Those are still untested — they are §1–§9 below.**

---

## 13. Pre/post verification helper

`scripts/verify-deb-install.mjs` checks, on the machine that has HPOS
installed, everything item 7 of the request asks for:

```bash
# BEFORE (on HPOS 0.1.0)
node scripts/verify-deb-install.mjs --expect-version 0.1.0 --out /tmp/before.json

# …run the update through the app UI…

# AFTER (expecting 0.1.1)
node scripts/verify-deb-install.mjs --expect-version 0.1.1 --baseline /tmp/before.json --check-release
```

It asserts: `dpkg-query -W hpos` = expected version, `dpkg -V hpos` clean
(so `/opt/HPOS` really matches the package), `/opt/HPOS/hpos` is a runnable
ELF, `resources/package-type` = `deb`, `app-update.yml` still pins
`github/hp635738-pro/HPOS`, every user-data file survives with an identical
checksum, and (with `--check-release`) that the installed version equals the
newest published `latest-linux.yml` version.

---

## 14. Automated coverage

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
| **The real electron-updater release pipeline** (atom feed → latest-linux.yml → deb selection → version gate → dpkg argv) | `HPOS-Desktop/releaseMetadata.integration.test.mjs` |
| Settings UI (mechanism + failure detail, null-safe) | `src/pages/Settings.test.mjs` §6 |
