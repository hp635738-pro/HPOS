> # ⚠️ RELEASE STATUS: **nothing has been published yet — PR #36 is END-TO-END NOT VERIFIED**
>
> **No release and no tag have been created for 0.1.1.** `hp635738-pro/HPOS`
> still has **0 releases / 0 tags**. Deliberately so: publishing a release
> without the real `hpos_0.1.1_amd64.deb` **and** `latest-linux.yml` would put
> every installed HPOS into exactly the failure this work fixes, and creating
> the tag `v0.1.1` would make `release:check` refuse that version forever.
>
> The workflow below is **verified structurally and by integration test only**
> (real electron-updater parsing of electron-builder-shaped metadata, see
> `HPOS-Desktop/releaseMetadata.integration.test.mjs`). It has **not** produced
> a real release yet, because the sandbox cannot download the Electron binary
> needed to build the artifacts. Run step 1–3 on a normal machine, then
> `TESTING-UPDATES.md` §1–§9, before merging PR #36.

# Releasing HPOS (the in-app updater's source of truth)

The updater in **Settings → App → Check for Updates** can only see a release
that electron-builder **published**, because publishing is what writes the
update metadata next to the artifacts:

| File | Written for | Contains |
| --- | --- | --- |
| `latest-linux.yml` | Linux | version, release notes, and one entry per Linux artifact with `url`, `sha512`, `size` (both `HPOS-<v>.AppImage` and `hpos_<v>_amd64.deb`) |
| `latest.yml` | Windows | same for the NSIS installer + blockmap |

Without those `.yml` files the app cannot know that a newer version exists,
no matter how many binaries are attached to the release. That was the state of
the repository before this change: every `dist*` script passed
`--publish never` and no release workflow existed, so the installed Linux
`.deb` had nothing to update against and reported a generic failure.

## 1. Versioning (semver, incremented every release)

* `package.json` **and** `HPOS-Desktop/package.json` must carry the same
  version (enforced by `packaging.test.mjs` and `scripts/release-check.mjs`).
* Increment strictly — `0.1.0 → 0.1.1 → 0.2.0 → 1.0.0`. An installed app only
  updates when the release version is **greater than** its own version, so
  re-publishing `0.1.0` over `0.1.0` is invisible to every installation
  (that is exactly the trap this release process now blocks).
* `scripts/release-check.mjs` reads the published releases of
  `hp635738-pro/HPOS` and refuses to publish when the local version is not
  newer than the newest published release.

```bash
# edit package.json + HPOS-Desktop/package.json → 0.1.1
npm test                  # includes the release-gate + version tests
git commit -am "release: 0.1.1"
git tag v0.1.1
git push origin main --tags
```

## 2. Publishing (deliberate, never from a developer build)

| Command | What it does |
| --- | --- |
| `npm run dist`, `dist:win`, `dist:linux`, `dist:dir`, `dist:linux:dir` | **Build only.** Always `--publish never`. Safe to run any time. |
| `npm run release:check` | The gate: semver/sync check, pinning check, `dist*` never publish, token present in the **environment**, and version > newest published release. |
| `npm run release:linux` | gate → `build:prod` → workspace payload → `electron-builder --linux appimage deb --publish always` |
| `npm run release:win` | gate → `build:prod` → workspace payload → `electron-builder --win nsis --publish always` |
| `npm run release` | `release:linux` then `release:win` |

Authentication comes from the environment only — never from `package.json`:

```bash
export GH_TOKEN=ghp_xxx        # or GITHUB_TOKEN (what CI provides)
npm run release:linux
```

`build.publish` stays a bare pin with no secrets:

```json
"publish": { "provider": "github", "owner": "hp635738-pro", "repo": "HPOS" }
```

### CI (recommended path)

`.github/workflows/release.yml` runs on **pushed `v*` tags** and on a manual
`workflow_dispatch`. Ordinary branch pushes and pull requests only build and
test — they never publish. The job runs `verify` (lint + tests) first, then
`npm run release:check` and the publish step with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

## 3. What ends up in the release

*(Naming verified against electron-builder 26.15.3: `FpmTarget` uses
`${name}_${version}_${arch}.deb` → **`hpos_0.1.1_amd64.deb`**, and
`updateInfoBuilder.writeUpdateInfoFiles` merges every Linux artifact into the
single `latest-linux.yml`, which `DebUpdater` then filters with
`findFile(files,'deb',…)`. The updater cache directory is
`~/.cache/hpos-updater/pending/`, so the package it hands to dpkg is
`~/.cache/hpos-updater/pending/hpos_0.1.1_amd64.deb`.)*

```
release/
├── HPOS-0.1.1.AppImage            ← AppImage artifact
├── hpos_0.1.1_amd64.deb           ← deb artifact
├── HPOS Setup 0.1.1.exe           ← NSIS artifact (Windows job)
├── latest-linux.yml               ← Linux updater metadata (AppImage + deb)
└── latest.yml                     ← Windows updater metadata
```

Verify a published release before announcing it:

```bash
curl -sSL https://github.com/hp635738-pro/HPOS/releases/latest/download/latest-linux.yml
```

It must contain **both** Linux artifacts with their `sha512` values, e.g.

```yaml
version: 0.1.1
files:
  - url: HPOS-0.1.1.AppImage
    sha512: <base64 sha512>
    size: 123456789
  - url: hpos_0.1.1_amd64.deb
    sha512: <base64 sha512>
    size: 98765432
path: hpos_0.1.1_amd64.deb
sha512: <base64 sha512>
releaseDate: '2026-09-18T…'
```

## 4. How each installation consumes it

| Installation | Check + download | Install | Restart |
| --- | --- | --- | --- |
| Windows NSIS | electron-updater | electron-updater runs the installer | library |
| Linux AppImage | electron-updater (delta download when possible) | electron-updater replaces the running AppImage | library |
| Linux **.deb** | electron-updater `DebUpdater` (picks the `.deb` entry, verifies SHA-512) | `pkexec --disable-internal-agent dpkg -i <verified .deb>` (+ `apt-get install -f -y` repair), re-verified by HPOS first | HPOS: `app.relaunch()` + `app.quit()` **after** dpkg succeeded |
| Snap / Flatpak / unpacked | refused up front with the reason | — | — |

The deb install uses **pkexec (Polkit)** — the standard Linux privilege
prompt, which shows the user exactly what is being authorised. HPOS never
stores, pipes or prompts for a password itself: no `sudo -S`, no embedded
credentials. If `pkexec` is unavailable and the app is not running as root,
the update stops with `EPRIV` and tells the user what to do.

## 5. Rollback

Publish a fixed, higher version (`0.1.2`) — the updater only ever moves
forward, so there is no silent downgrade path. To make a release invisible
(unpublish a mistake), delete it on GitHub; installed apps then report
`ERELEASE` ("no published release with update metadata") instead of failing
mysteriously.
