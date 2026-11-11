# CoFilm

A static, browser-only OneDrive movie library. GitHub Pages serves native JavaScript modules and CSS; no framework, install step, server, or bundler is required.

## Structure
- `app.js`: browser UI, OneDrive access, cached metadata and playback orchestration.
- `lib/catalog.mjs`: shared filename parsing, stable library keys, title matching and cache rules.
- `theme.js` / `style.css`: automatic theme, common geometry and refractive glass.
- `scripts/ratings.mjs`: scheduled IMDb (via Cinemeta), Rotten Tomatoes critics and Douban lookups.
- `vendor/movi-player/`: self-hosted backup of the pinned player (`element.js` embeds its WASM; `SOURCE.json` records the SHA-256).
- `scripts/vendor-movi.mjs`: refreshes that copy. Upgrade with `node scripts/vendor-movi.mjs <version>`, then set `MOVI_VERSION` in `app.js` to match; `npm run check` fails if the two or the checksum disagree.
- `scripts/ratings-store.mjs`: encrypted storage, atomic writes and fail-closed recovery.

The multi-megabyte Movi player is downloaded only after PLAY/RESUME, not during ordinary browsing. It loads from jsDelivr, pinned to one exact version; if the CDN fails or does not answer within 12 seconds, the byte-identical copy in `vendor/movi-player/<version>/` (served by this site, ~3.6 MB gzipped) is used instead. Cached titles appear before OneDrive revalidation; fresh metadata is not fetched or processed twice.

## Using the site
- **Movies page**: sort by recently added, year, rating, title, country or 4K first; filter by genre, decade, country or 4K only (Genres is a filter here, not a separate page). The choice is remembered on this device.
- **Detail page**: besides "More like this", rows for the same director and for shared leading cast, taken from this library only.
- **Install as an app**: iPhone/iPad Safari, Share > Add to Home Screen. Android Chrome, menu > Install app. It opens full screen with the cat icon. The service worker caches nothing, so every release arrives immediately.
- **Player keys**: Space pause/play, F fullscreen, M mute, Up/Down volume, Left/Right skip 10 seconds. Cmd/Ctrl/Alt combinations are left to the browser.

## Check changes
Use Node.js 22+ and run `npm run check`. There are no npm dependencies to install. This checks syntax, local HTML assets and the automated tests. The same checks run on pushes and pull requests.

The ratings workflow is scheduled every 3 hours (GitHub may delay scheduled runs) and can be dispatched manually. A failed read/decrypt/listing leaves the previous file untouched. Observation timestamps alone do not trigger a new encrypted file or Pages build; `updated` therefore means the last data change, not the last lookup attempt. Existing records are retained on partial lookup failures. Workflow logs report aggregate counts, not individual movie titles.

## Privacy and access
`config.enc.json` and `ratings.enc.json` are AES-GCM encrypted. OneDrive and TMDB settings are also stored in the authorized browser's localStorage, not as plaintext files in this repository. The rating job obtains them from GitHub Actions secrets.

The access code is a convenience gate, not server-side authorization. Anyone with the underlying anonymous OneDrive share link can read that shared folder; changing the website code does not revoke an already-disclosed link. Revoke or replace the OneDrive share link when access must be withdrawn.

## Deliberately unchanged
Playback range caching, resume positions, sidecar subtitle loading, movie-grid columns, cast paging and poster-arrow click isolation are not rewritten by this maintenance pass. Further module extraction should be incremental, not a framework migration.
