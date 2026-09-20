> # ✅ Release 0.1.1 is PUBLISHED — ⚠️ the installed-app test is still NOT VERIFIED
>
> **Published:** `v0.1.1` (tag → commit `d3798b2` on `arena/01a0b2b5-hpos`),
> 2026-09-18T05:46:21Z — <https://github.com/hp635738-pro/HPOS/releases/tag/v0.1.1>
>
> | asset | bytes | sha512 (verified by downloading the published asset) |
> | --- | --- | --- |
> | `hpos_0.1.1_amd64.deb` | 84,763,828 | `JcFOMg2D/ylQR1cQuf75zn98q3I8Y17TyelJhywCnSbe1WEmIQ0mtNn24wqZm0bbdzCltVcMl0CM2TmOQBjmLA==` |
> | `HPOS-0.1.1.AppImage` | 108,100,152 | `CpszNIVgbWlpjc5d+OD6N1E2vQHm6LMcGTY2fOcDftcqdBvN1AL0ers57MAgrsPPnkRXlsj98PBrNmyFGQqEmQ==` |
> | `latest-linux.yml` | 510 | (metadata: version 0.1.1, one entry per artifact) |
> | `HPOS-Setup-0.1.1.exe` / `.exe.blockmap` / `latest.yml` | 77,889,238 / 82,318 / 336 | Windows |
>
> The release is **not a draft and not a pre-release**, and
> `GET /releases/latest` resolves to `v0.1.1`. A CI job downloaded every asset
> listed in `latest-linux.yml` back from the release and compared its sha512
> with the metadata — that is the integrity check the updater performs before
> `dpkg` ever sees the file.
>
> **What has NOT been verified:** no installed HPOS has ever run
> Settings → App → Check for Updates against this release. That single test is
> performed on the machine that has HPOS 0.1.0 installed from the `.deb`.
> PR #36 stays NOT VERIFIED until it is done. See `TESTING-UPDATES.md` §0.

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

## 1. Versioning (semver, bumped automatically on every push to main)

* Four files carry the version — `package.json`, `package-lock.json`,
  `HPOS-Desktop/package.json`, `HPOS-Desktop/package-lock.json` — and must
  agree (enforced by `packaging.test.mjs` and `scripts/release-check.mjs`).
* You never bump by hand: every push to `main` makes the workflow's **bump**
  job compute the next patch version from the newest published release
  (`0.1.2 → 0.1.3 → 0.1.4 …`), sync the four files, commit
  `chore(release): vX.Y.Z [skip ci]` and tag `vX.Y.Z` — then verify, validate
  and publish that exact commit in the same run.
* Increment strictly — an installed app only updates when the release version
  is **greater than** its own version, so re-publishing `0.1.0` over `0.1.0`
  is invisible to every installation (that is exactly the trap this release
  process blocks).
* `scripts/next-version.mjs` decides the version (newest of published
  releases + `v*` tags, plus one patch; a checked-in version that is already
  newer is released as-is and never skipped over);
  `scripts/bump-version.mjs` writes it; `scripts/release-check.mjs` still
  refuses to publish when the version is not newer than the newest published
  release.

```bash
# the normal release path — just push to main:
git push origin main
# → bump to 0.1.3 → commit → tag v0.1.3 → verify → validate →
#   publish AppImage + deb + latest-linux.yml → verify the release
```

Escape hatches:

* Put `[skip release]` (or `[skip ci]`) in the head commit message and the
  push is validated but never bumped or published.
* The manual fallback stays: push a `v*` tag (or run the workflow with
  `dry_run` switched off) and the tag path publishes exactly like before.

## 2. Publishing (deliberate, never from a developer build)

| Command | What it does |
| --- | --- |
| `npm run dist`, `dist:win`, `dist:linux`, `dist:dir`, `dist:linux:dir` | **Build only.** Always `--publish never`. Safe to run any time. |
| `node scripts/next-version.mjs` | Decides the next patch version (published releases + `v*` tags + checked-in version). Used by the bump job; `--json` / `--offline` / `--github-output` for CI. |
| `node scripts/bump-version.mjs <x.y.z>` | Syncs the version across `package.json` + `package-lock.json` (+ the `HPOS-Desktop` copies). `--dry-run` previews, `--json` reports. |
| `npm run release:check` | The gate: semver/sync check, pinning check, `dist*` never publish, token present in the **environment**, and version > newest published release. |
| `npm run release:linux` | gate → `build:prod` → workspace payload → `electron-builder --linux appimage deb --publish always` |
| `npm run release:win` | gate → `build:prod` → workspace payload → `electron-builder --win nsis --publish always` |
| `npm run release` | `release:linux` then `release:win` |
| `npm run verify:artifacts` | **Local/CI gate, no network, no publish.** Checks `release/` really contains `hpos_<v>_amd64.deb` + `HPOS-<v>.AppImage` + `latest-linux.yml`, that every `sha512`/`size` in that file is the real hash of the file that will be uploaded, and that each entry resolves to `…/releases/download/v<v>/<file>`. |
| `npm run verify:release` | Checks a **published** release: not a draft, `/releases/latest` resolves to it, the assets exist, `latest-linux.yml` is downloadable, every entry points at a real asset, and the downloaded asset's sha512 equals the one in the metadata. `--wait` polls, `--summary` writes a GitHub job summary. |

Authentication comes from the environment only — never from `package.json`:

```bash
export GH_TOKEN=ghp_xxx        # or GITHUB_TOKEN (what CI provides)
npm run release:linux
```

`build.publish` stays a bare pin with no secrets:

```json
"publish": { "provider": "github", "owner": "hp635738-pro", "repo": "HPOS", "releaseType": "release" }
```

`releaseType: "release"` is not decoration: electron-builder defaults to a
**draft** release, and `electron-updater` reads `GET /releases/latest`, which
skips drafts and pre-releases. A draft release is invisible to every installed
app.

### CI (the only path — fully automatic)

`.github/workflows/release.yml` has five jobs; **publishing can only happen
after the first three succeeded**:

| Job | Runs on | Does |
| --- | --- | --- |
| `bump` | every run (acts only on pushes to `main`) | computes the next patch (`scripts/next-version.mjs`), syncs the version files (`scripts/bump-version.mjs`), commits `chore(release): vX.Y.Z [skip ci]`, pushes the commit + the `vX.Y.Z` tag |
| `verify` | every run | checks out the bumped commit, then `npm run lint`, `npm test`, `npm run release:check` (version increment + pinned source + token) |
| `validate` | every run | `npm run dist:linux` (**`--publish never`**) and `npm run verify:artifacts` — proves, in CI, that the exact artifacts and hashes the updater needs are produced, then uploads them for inspection |
| `release-linux` | push to `main` (automatic), `v*` tag push, or `workflow_dispatch` with `dry_run` off | `npm run release:linux`, then `gh release edit … --draft=false --prerelease=false`, then `npm run verify:release -- --wait --summary` |
| `release-win` | `v*` tag push, or `workflow_dispatch` with `dry_run` off | `npm run release:win` (uploads NSIS + `latest.yml` into the same release, after Linux) |

Triggers:

* `git push origin main` — **the normal release path.** One push = one patch
  release (`0.1.2 → 0.1.3`), committed, tagged, built and published by the
  same run. The bump commit carries `[skip ci]` so it never starts a
  follow-up run; a head commit that already carries `[skip ci]` /
  `[skip release]`, or is already tagged, is never bumped again.
* `git push origin v0.1.1` — the manual fallback. The workflow file is read
  from the **pushed commit**, so a tag pushed on any branch (not just `main`)
  runs the pipeline as it exists in that commit.
* `workflow_dispatch` — manual, from the Actions UI / `gh workflow run`, with
  `dry_run` (default **true**: validation only) and `target`
  (`all` / `linux` / `win`). GitHub resolves `workflow_dispatch` against the
  **default branch**.
* ordinary branch pushes (`arena/**`) — `verify` + `validate` only, never a
  publish. This is what makes "the workflow configuration is validated" a
  gate rather than a claim.

Auth: `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` with
`permissions: contents: write`. The `release-*` jobs set
`HPOS_RELEASE_OFFLINE=1` because the version-increment gate already ran in
`verify` — otherwise the second platform job would trip over the release this
same run creates.

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
npm run verify:release -- --tag v0.1.1        # assets + metadata + sha512, fails loudly
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
