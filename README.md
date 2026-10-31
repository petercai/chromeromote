# Chrome Remote (Media)

Use an Android phone as the remote for Chrome on a Chromebook connected to a TV: browse site.com, play,
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
2. **Install the extension on the Chromebook**
   - Open `chrome://extensions` and turn on *Developer mode*.
   - Click *Load unpacked* and select the `extension/` folder.
3. **Set the page address**
   - Click the extension icon "Chrome 遥控".
   - Enter the GitHub Pages address from step 1 and click *保存地址* (Save address).
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

To cut off paired phones, click *重新生成密钥* (Generate new key) in the popup and scan again with the
phone you want to keep.

## Daily use

1. Turn on the TV, unlock the Chromebook and open Chrome. This part is done by hand.
2. On the phone, open "Chrome 遥控" from the home screen.
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
| Phone shows "还没有配对" (not paired yet) | You opened the page address directly, or the link opened outside Chrome. Follow setup step 4 and make sure it opens in Chrome |
| Toast says "页面上没有找到视频" (`NO_VIDEO`) | The active tab has no `<video>`, or the player has not loaded yet |
| Toast says "暂不支持点击嵌入框架内的内容" (`CLICK_IFRAME`) | The element under the pointer is inside an iframe, which v1 can't click (see the known limits in the implementation notes) |
| Toast says "已静音播放" (played muted, `AUTOPLAY_BLOCKED`) | Chrome's autoplay policy blocked playback with sound. Raise the volume slider, or click once on the page by hand |

- **Logs**: the extension popup has *查看日志* (view logs) and *导出日志* (export logs), saved as JSON
  lines. Every command carries a `cmd_id`, which you can match against the phone page's DevTools
  console.
- **Rollback**: disable or remove the extension. Nothing else on the Chromebook is changed.

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
