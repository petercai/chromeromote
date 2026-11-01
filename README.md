# Chrome Remote (Media)

Use an Android phone or an iPad (iOS 12+) as the remote for Chrome on a Chromebook connected to a TV: browse site.com, play,
seek, change volume and toggle fullscreen, all from the phone screen. No Bluetooth keyboard and no
server to install.

```text
Phone (remote/ PWA on GitHub Pages)  ⇄  WebRTC data channel (PeerJS)  ⇄  Chrome extension (extension/)
```

Design and decisions: [docs/media-remote/](docs/media-remote/), with the
[design doc (zh)](docs/media-remote/media-remote-DESIGN-2026-10-30-zh.md) and the
[implementation notes (zh)](docs/media-remote/media-remote-IMPL-2026-10-30-zh.md).

## Layout

| Path | What it is |
|------|------------|
| `extension/` | MV3 Chrome extension: service worker (command router), offscreen document (WebRTC endpoint), content script (virtual pointer and video control), popup (pairing QR code and logs) |
| `extension/lib/` | Wire protocol and logger, **shared** by the extension and the phone page |
| `remote/` | Phone remote PWA (layout B: Browse / Play tabs) |
| `tests/` | Unit tests (protocol) and an end-to-end test (real extension + real PeerJS) |

## Setup (one time)

1. **Publish the phone page on GitHub Pages**
   - Push this repository to GitHub.
   - Open the repository's *Settings → Pages → Deploy from a branch*, then choose `main` / `/ (root)`.
   - The remote page will be at `https://petercai.github.io/chromeromote/remote/`.
   - The page loads `../extension/lib/*.js`, so the whole repository root must be published.
     The `.nojekyll` file makes Pages serve files as they are, without Jekyll processing.
   - **Wait for the deployment to finish.** After each push, Pages needs a few minutes (watch the
     repository's *Actions* tab until "pages build and deployment" turns green), and its CDN caches
     pages for up to 10 minutes. Until then the address returns **404** or an old version.
   - **Before scanning, open the address in a desktop browser** and make sure you see the
     "还没有配对" (not paired yet) page, not a GitHub 404. The extension popup checks this too: if the
     address doesn't load, it shows a red warning with the HTTP status code.
2. **Install the extension on the Chromebook (from GitHub Releases)**
   - Every push to `main` that changes the extension version (`npm run bump` rewrites
     `extension/manifest.json`) runs the GitHub Actions workflow
     [release-extension.yml](.github/workflows/release-extension.yml): `npm run pack`, then a
     GitHub Release `v<version>` with **`chrome-remote-extension.zip`** attached. A version that is
     already released is skipped; *Actions → Release extension → Run workflow* starts it by hand.
   - On the Chromebook, open the always-latest download in Chrome:
     `https://github.com/petercai/chromeromote/releases/latest/download/chrome-remote-extension.zip`
     (for a fork: `https://github.com/<user>/<repo>/releases/latest/download/chrome-remote-extension.zip`).
   - In the *Files* app, open the ZIP from *Downloads* and copy its contents to a folder, for example
     *My files → chrome-remote-extension* (`manifest.json` must be directly inside that folder).
   - Open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked* and select that
     folder.
   - Why not a packed `.crx` that updates itself? Chrome and ChromeOS refuse to install `.crx` files that
     don't come from the Chrome Web Store (unless the device is enterprise-managed). A ZIP plus *Load
     unpacked* is the route that works, so updates are a manual download.
   - **Updating** (after every new release, or the Chromebook keeps running the old code): download the
     ZIP again from the same address, copy its contents over the **same folder** (replace the files),
     then click ⟳ *Reload* on the extension in `chrome://extensions`. When the extension is older than
     the live remote page, the popup says so and shows this download address.
   - **Fixed extension ID** `bikeapbfiblpjkpmafaenamcofldneme` (from 1.0.19): `manifest.json` carries a
     public `key`, so the ID is the same on every machine and in every folder. That is what lets the
     library (片单) sync between machines (`chrome.storage.sync` is per extension ID), and an update no
     longer has to reuse the same folder. **Upgrading from 1.0.18 or older changes the ID once**: scan
     the QR code again on the phone and re-add your bookmarks (the old ID's data can't be read).
   - Local build without Actions: the VS Code task **"扩展:升级版本并打包"** (bump version and pack), or
     `npm run pack`, writes the same `dist/chrome-remote-extension.zip` (any file transfer works,
     e.g. Google Drive).
   - **How to tell which version is running:** the top of the extension popup shows the version in
     large type (for example `v1.0.6`). **No version number there means a very old extension that must
     be updated**; it generates fixed, outdated QR codes.
3. **Page address (normally nothing to do)**
   - The extension's default address is already `https://petercai.github.io/chromeromote/remote/`
     (from 1.0.8), so a fresh install on a new Chromebook shows the QR code right away.
     Installs that still have the old placeholder address saved switch to it automatically.
   - Only if you publish elsewhere (a fork or a different repository name): click the "Chrome 遥控"
     icon, enter your GitHub Pages address and click *保存地址* (Save address).
4. **Pair the phone (once)**

   > The remote page on the phone **does not scan QR codes itself**, and opening its address directly
   > shows "还没有配对" (not paired yet). The QR code is shown on the **Chromebook** (the TV), and you
   > scan it with the phone's own camera.

   1. On the Chromebook, click the **"Chrome 遥控"** extension icon in the top-right toolbar. If you
      don't see it, click the puzzle-piece icon 🧩 and pin "Chrome 遥控".
   2. The popup shows a QR code. If it says the page address isn't set, finish step 3 first.
   3. On the Android phone, open the **Camera** app (or **Google Lens**) and point it at the QR code
      on the TV. Tap the link that appears.
   4. The link must open in **Chrome**. If it opens inside the Google app (Lens often does this), tap
      ⋮ → **"在 Chrome 中打开"** (Open in Chrome). Otherwise the pairing is saved in the wrong browser,
      and Chrome later shows "not paired".
   5. When the status bar at the top of the phone page shows **"已连接"** (connected), open Chrome's
      menu ⋮ → **"添加到主屏幕"** (Add to Home screen). From then on, open "Chrome 遥控" from the home
      screen; it reconnects by itself.

   **Can't scan?**
   - Click **"复制配对链接"** (copy pairing link) in the popup and send the link to the phone any way
     you like (messaging app, email, Google Keep and so on), then open it in Chrome on the phone.
   - If the camera won't focus: move closer to the TV or reduce glare, and make sure the whole QR code
     including its white border is in frame.
   - If the camera app doesn't react to QR codes: turn on "Scan QR codes" in the camera settings, or
     use the "Scan QR code" quick-settings tile on Android 13 and later.

   **iPad / iPhone (iOS 12.5.8 and later, 1.0.21):**

   1. Open the iPad **Camera**, point it at the QR code on the TV, and tap the notification at the
      top. The page opens in **Safari** and connects.
   2. Tap Safari's **Share** button → **"添加到主屏幕"** (Add to Home Screen). The orange hint at the
      bottom of the page says the same. Safari keeps the pairing in the address bar, so the
      home-screen icon "遥控" already carries it.
   3. From then on, open "遥控" from the home screen. It runs full screen, without Safari's bars.
   4. To add another Chromebook, scan its QR code the same way and add to the home screen again. You
      can delete the extra icon afterwards; the pairing stays.

   On iOS 12, the home-screen app and Safari keep separate storage, which is why the pairing travels in
   the saved link. Some iOS 12 home-screen apps have no WebRTC. If that happens, the app shows
   **"这里不能建立遥控连接"** (cannot connect here) with a button **"在 Safari 中打开"** (open in
   Safari) that carries the pairing. Then use the remote in Safari.

To cut off paired phones, click *重新生成密钥* (Generate new key) in the popup and scan again with the
phone you want to keep.

## Daily use

1. Turn on the TV and log in to the Chromebook. You **don't need to open a Chrome window**: the
   extension starts by itself at every login and runs in the background, so it is ready to connect
   (it retries as soon as Wi-Fi comes up). The toolbar badge shows the state: `ON` means a phone is
   connected and `!` means an error. Keep *Developer mode* on in `chrome://extensions`, because
   ChromeOS disables unpacked extensions when it is turned off. There is no separate "app" to
   install: Chrome Apps are no longer supported on ChromeOS, and a web app can't control Chrome tabs.
2. On the phone, open "Chrome 遥控" from the home screen. If no Chrome window is open, tap 首页
   (Home) to open one (1.0.17).
3. **Browse** tab: slide one finger to move the pointer, tap to click, and slide two fingers to
   scroll. The buttons are Back, Reload, Home (site.com), Page up and Page down.
4. When a video starts, the phone switches to the **Play** tab by itself. It has play/pause, −10 / +10
   / +30 s, a seek slider (the video jumps when you let go), a volume slider and fullscreen.

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| Phone shows "电视端不在线" (TV is offline) | Is Chrome running? Is the extension badge `!`? Open the popup and check the status and the logs |
| Phone shows "配对失效" (pairing invalid) | The key was regenerated. Scan the QR code again |
| Phone shows a GitHub **404** after scanning / the popup shows a red "地址打不开" (address won't load) warning | GitHub Pages isn't published at that address yet. ① Is the code pushed? ② Under *Settings → Pages*, is the source `main` / `/ (root)`? ③ Are the user and repository names in the address spelled correctly? (The address is case-sensitive, and `chrome-remote` and `chromeromote` are different.) ④ After a push, wait a few minutes, then click *重新检查* (Check again) in the popup |
| Phone shows **GitHub's own** 404 page ("There isn't a GitHub Pages site here") | The address in the QR code points **outside** this site, because our site answers any missing page with its own Chinese 404 page. ① Look at the top of the popup: no version number means the Chromebook runs an old extension; update it (setup step 2). ② Check that the page address saved in the popup matches the repository name exactly, including capitalisation (`ChromeRomote` ≠ `chromeromote`). From 1.0.6 the popup shows no QR code for a bad address and offers "改用 …" (use this address instead). ③ Close the old 404 tab on the phone and scan the new QR code |
| `…/remote/` works, but the `#peer=…` link from the QR code shows 404 | ① **Close the old Chrome tab on the phone.** Lens and the Google app always open links in the same tab, and that tab may still be showing GitHub's old 404. ② Reopen the extension popup and scan the **new** QR code; the link changes every 20 s. ③ From 1.0.4 on, the site's 404 page and the remote page recover the pairing from any mangled form (`#` encoded once, twice, or moved elsewhere) and redirect automatically. ④ If you still see the Chinese 404 page, tap *复制地址* (copy address) and send the address to the developer |
| Phone stays on "连接中…" (connecting) after reopening, and the popup shows `PEER_UNAVAILABLE:unavailable-id` | Fixed in 1.0.7. The extension now saves its PeerJS token, so after sleep, a restart or a network drop it reclaims its connection ID at once. Before, it took over a minute and dropped the phone in the meantime. The phone also retries on its own if it gets no answer within 12 s. Update the Chromebook extension to 1.0.7 (the popup header shows `v1.0.7`) |
| Pressing 返回 (Back) closed the current page | Fixed in 1.0.9. Back now uses the page's own history (`history.back()`), so it goes to the previous page and stays put when there is none; it never closes a tab. A page that iyf.tv opened in a **new tab** has no previous page, so Back shows "已经是第一页了" (already on the first page). Use 首页 (Home) or the touchpad to go elsewhere |
| Phone shows "还没有配对" (not paired yet) | You opened the page address directly, or the link opened outside Chrome. Follow setup step 4 and make sure it opens in Chrome |
| Toast says "页面上没有找到视频" (`NO_VIDEO`) | The active tab has no `<video>`, or the player has not loaded yet |
| Bookmarks made on one Chromebook don't show up on another | ① Both must show the same ID `bikeapbfiblpjkpmafaenamcofldneme` in `chrome://extensions` (1.0.19 or newer; before that every machine had its own ID and never shared data). ② Both are signed in to the same Google account with sync on, and *Settings → Sync → Extensions* is on. ③ Chrome syncs by itself, usually within a minute; there is no manual sync button. The extension log shows `library.sync_changed` with `origin: remote` when data arrives |
| Toast says "Chrome 没有打开的窗口,点「首页」打开" (no open Chrome window, `TAB_NOT_FOUND`) | All Chrome windows are closed. On ChromeOS the extension and the phone link stay connected anyway. From 1.0.17, tapping 首页 (Home) or opening a library entry opens a new maximized Chrome window; the library list keeps working without a window |
| Toast says "暂不支持点击嵌入框架内的内容" (`CLICK_IFRAME`) | The element under the pointer is inside an iframe, which v1 can't click (see the known limits in the implementation notes) |
| Toast says "已静音播放" (played muted, `AUTOPLAY_BLOCKED`) | Chrome's autoplay policy blocked playback with sound. Raise the volume slider, or click once on the page by hand |

- **Logs**: the extension popup has *查看日志* (view logs) and *导出日志* (export logs), saved as JSON
  lines. Every command carries a `cmd_id`, which you can match against the phone page's DevTools
  console.
- **Rollback**: disable or remove the extension. Nothing else on the Chromebook is changed.

## VS Code tasks

Open *Terminal → Run Task…* (the default build task is `Ctrl+Shift+B`):

| Task | What it does |
|------|--------------|
| 扩展:升级版本号 (bump version) | `npm run bump`: version +1 in `version.js`, `manifest.json` and the `?v=` cache-busting parameters |
| 扩展:打包 (pack extension) | `npm run pack`: writes `dist/chrome-remote-extension.zip` locally (the same file the release workflow publishes) |
| 扩展:升级版本并打包 (bump + pack) | Runs both in order (**default build task**) |

## Library (片单), several Chromebooks, sync (1.0.13)

- **片单 tab (Library):** the third tab at the bottom has two lists, **最近** (Recent) and **收藏** (Bookmarks).
  - Tap a row to open it on the TV; playback **resumes 5 s before** where you stopped.
  - Use 🗑 to delete a row (with a confirmation).
- **Bookmark the current video:** tap ☆ next to the title on the 播放 (Play) tab. It turns into ★; tap again to
  remove the bookmark.
- **Sync:** Recent (10 entries) and Bookmarks (up to 100) are stored with `chrome.storage.sync`, so every
  Chromebook signed in to the same Google account sees the same lists. Each entry shows which device it
  was watched on.
- **Several Chromebooks:**
  - Pair each one by scanning its popup QR code. The phone keeps them all.
  - The status bar always shows **which Chromebook you control**; tap the name to switch, delete a
    pairing, or add a new device.
  - Name each Chromebook in its extension popup ("这台 Chromebook 的名称", this Chromebook's name).
- **Device offline:** if the selected Chromebook is turned off, the phone notices within about 15 s (heartbeat)
  and shows "<name> 不在线" (offline). It keeps retrying and offers the other devices; it never switches by
  itself, so you never control the wrong TV.
- **Diagnostics:** in the phone page's DevTools console, `CRRemote.send('libraryList')` and
  `CRRemote.devices()`.

## Episode list (选集, 1.0.20)

- On an iyf.tv play page, the 播放 (Play) tab shows a **选集** row, for example "第 27 集 / 共 27 集 + 2 个特别篇".
- **⏮ / ⏭** at both ends of the play controls open the previous / next **numbered** episode. Specials
  (text items such as "一生一瞬旁白版") are skipped. Long shows split into ranges (01-50, 51-100, …) cross the
  range edge by themselves.
- Tap the 选集 row for the full list: range tabs for long shows, a grid of numbered episodes, and the
  specials listed separately with where they sit ("在 09 之后"). Tap one to play it on the TV.
- Only iyf.tv for now. Another site is one more entry in the adapter table in `extension/lib/playlist.js`.
- If the row doesn't appear on an iyf.tv episode page, the site's layout probably changed: the extension log
  shows `playlist.not_found` with the selector that no longer matches.

## YouTube (1.0.23)

Browse YouTube on the phone and play on the TV, without the pointer. Chrome on the Chromebook must be
**signed in to YouTube**; the phone uses that account.

- The **YouTube** tab has four sections: **首页** (Home recommendations), **订阅** (Subscriptions),
  **播放列表** (Playlists) and **稍后观看** (Watch later). Scroll down and more videos load by themselves.
- Tap a video: the TV opens it full screen. While you browse, the TV keeps playing what it plays; it only
  changes when you tap.
- Tap a playlist to see its videos on the phone; **▶ 全部播放** (Play all) plays it from the start.
- **Long press** a video: **加入稍后观看** (Save to Watch later) or **打开频道** (Go to channel, which lists the
  channel's videos on the phone).
- While the TV plays a YouTube video, the **播放** (Play) tab lists **接下来播放** (Up next).
- When the TV is on YouTube, the phone opens on the YouTube tab.
- The first time, the extension opens youtube.com in a **background tab** to read the lists; leave it open
  (it is reused). Shorts are not shown.
- "请先在 Chromebook 的 Chrome 里登录 YouTube" means Chrome on the Chromebook is not signed in to YouTube.
- If the lists stop loading after a YouTube update, the extension log shows `yt.request` (did the request
  work?) and `yt.parsed` (`unknown` > 0 means YouTube changed its data format; the fix goes in
  `extension/lib/youtube.js`).
- No search and no YouTube Music player yet (design doc 3.13.10 lists the next phases).

## Version number: is GitHub serving my latest code?

- The version (for example `1.0.3`) is defined in exactly one place:
  [extension/lib/version.js](extension/lib/version.js).
- **Run `npm run bump` after every code change.** It updates `version.js`, `extension/manifest.json`
  and the `?v=` cache-busting parameter on every file in `remote/index.html` in one go. A unit test
  fails if these three ever disagree.
- Where the version shows up:
  - **Phone page:** right end of the top status bar (`v1.0.3`), and on the "还没有配对" (not paired
    yet) screen.
  - **Extension popup:** `扩展版本 X · 线上网页版本 Y` (extension version X · live page version Y).
    The popup reads the deployed `extension/lib/version.js` from GitHub Pages. If it differs from the
    extension's version, the popup shows a red warning: GitHub Pages hasn't updated yet.
  - **The site's 404 page.**
- After pushing, wait until the popup shows matching versions, or until the phone's status bar shows
  the new version, before testing on the phone.

## Development and tests

```bash
npm install          # installs playwright-core (e2e only)
npm test             # protocol unit tests
# End-to-end: needs a Chromium build (branded Chrome ignores --load-extension) and internet for 0.peerjs.com
CHROMIUM_PATH=/path/to/chromium/chrome npm run e2e
# Same test, but the "phone" opens the published GitHub Pages page (checks the deployment)
CHROMIUM_PATH=/path/to/chromium/chrome REMOTE_BASE=https://<user>.github.io/<repo>/remote/ npm run e2e
```

Third-party code in `extension/vendor/`:

- PeerJS 1.5.5 (MIT)
- qrcode-generator 1.4.4 (MIT)
