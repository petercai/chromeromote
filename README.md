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
   - The remote page will be at `https://github.com/petercai/chromeromote/remote/`.
   - The page loads `../extension/lib/*.js`, so the whole repository root must be published.
2. **Install the extension on the Chromebook**
   - Open `chrome://extensions` and turn on *Developer mode*.
   - Click *Load unpacked* and select the `extension/` folder.
3. **Set the page address**
   - Click the extension icon "Chrome 遥控".
   - Enter the GitHub Pages address from step 1 and click *保存地址* (Save address).
4. **Pair the phone**
   - Scan the QR code in the popup with the phone. The remote page opens and connects.
   - In the phone browser, use *Add to Home screen*. From then on, opening it from the home screen
     reconnects automatically, with no scanning needed.

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
```

Third-party code in `extension/vendor/`:

- PeerJS 1.5.5 (MIT)
- qrcode-generator 1.4.4 (MIT)
