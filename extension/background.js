/**
 * Service worker: the command router of the extension.
 *
 * Responsibilities
 *  - Own the persistent config (peer id, pairing key, remote page base URL).
 *  - Keep the offscreen document (WebRTC endpoint) alive.
 *  - Execute browser-level commands (chrome.tabs / chrome.windows) and forward page/video
 *    commands to the content scripts of the active tab.
 *  - Forward video state from the active tab to the phone (via offscreen).
 *  - Persist structured logs in a ring buffer (chrome.storage.session) for the popup.
 *
 * Message routing convention: every runtime message carries `target` ('bg' | 'offscreen')
 * or comes from a content script with `type` 'videoState'.
 */
importScripts('lib/version.js', 'lib/protocol.js', 'lib/log.js', 'lib/library.js', 'lib/youtube.js');

const { CMD, ERR, TAB_NEED, ok, fail, executorOf, tabNeedOf, buildPairUrl, newKey } = CR;

// ---------------------------------------------------------------------------
// Immutable settings
// ---------------------------------------------------------------------------
const LOG_BUFFER_MAX = 500;
const LOG_FLUSH_MS = 300;
// The published phone page (GitHub Pages; the repo path is case-sensitive). A fresh install pairs with
// no setup. Older installs that saved the original placeholder are migrated in loadConfig.
const DEFAULT_REMOTE_BASE_URL = 'https://petercai.github.io/chromeromote/remote/';
const LEGACY_PLACEHOLDER_MARK = 'YOUR_GITHUB_USER';
const OFFSCREEN_URL = 'offscreen.html';

// ---------------------------------------------------------------------------
// Logging with a batched ring-buffer sink (mutable queue kept local to this module)
// ---------------------------------------------------------------------------
let pendingLogs = [];
let flushTimer = null;

const flushLogs = async () => {
  flushTimer = null;
  const batch = pendingLogs;
  pendingLogs = [];
  if (batch.length === 0) return;
  const { logs = [] } = await chrome.storage.session.get('logs');
  await chrome.storage.session.set({ logs: logs.concat(batch).slice(-LOG_BUFFER_MAX) });
};

const logSink = (entry) => {
  pendingLogs.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
};

const log = CRLog.createLogger('ext-sw', logSink);

// ---------------------------------------------------------------------------
// Config (source of truth: chrome.storage.local)
// ---------------------------------------------------------------------------
const CONFIG_KEYS = Object.freeze(['peerId', 'peerToken', 'key', 'remoteBaseUrl', 'deviceName']);

// Shown on the phone to tell Chromebooks apart; editable in the popup.
const defaultDeviceName = (peerId) => `Chromebook-${String(peerId).replace(/-/g, '').slice(-4).toUpperCase()}`;
const DEVICE_NAME_MAX = 40;

/** Unset or legacy-placeholder address -> the default; a user-entered address is kept as is. */
const migrateBaseUrl = (stored) => {
  if (!stored) return DEFAULT_REMOTE_BASE_URL;
  if (!stored.includes(LEGACY_PLACEHOLDER_MARK)) return stored;
  log.info('config.base_url_migrated', { from: stored, to: DEFAULT_REMOTE_BASE_URL });
  return DEFAULT_REMOTE_BASE_URL;
};

const loadConfig = async () => {
  const stored = await chrome.storage.local.get([...CONFIG_KEYS]);
  const config = {
    peerId: stored.peerId || `cr-${CR.newId()}`,
    // PeerJS only lets an ID be re-registered with the SAME token while the server still holds the
    // old session (abrupt drop, sleep, restart). A persisted token makes the ID reclaimable at once;
    // a fresh random token per Peer caused "unavailable-id" (verified against 0.peerjs.com).
    peerToken: stored.peerToken || newKey(),
    key: stored.key || newKey(),
    remoteBaseUrl: migrateBaseUrl(stored.remoteBaseUrl),
  };
  config.deviceName = stored.deviceName || defaultDeviceName(config.peerId);
  const missing = CONFIG_KEYS.filter((k) => config[k] !== stored[k]);
  if (missing.length > 0) {
    await chrome.storage.local.set(config);
    log.info('config.initialized', { peer_id: config.peerId, filled: missing, key: CRLog.redact(config.key) });
  }
  return config;
};

const updateConfig = async (patch) => {
  await chrome.storage.local.set(patch);
  return loadConfig();
};

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
let creatingOffscreen = null;

const ensureOffscreen = async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WEB_RTC', 'AUDIO_PLAYBACK'],
      justification: 'Hold the WebRTC data channel to the phone remote; play the TV page audio on a chosen output.',
    })
    .then(() => log.info('offscreen.created'))
    .catch((e) => log.error('offscreen.create_failed', { error: String(e) }))
    .finally(() => {
      creatingOffscreen = null;
    });
  return creatingOffscreen;
};

const sendToOffscreen = (payload) =>
  chrome.runtime.sendMessage({ target: 'offscreen', ...payload }).catch(() => {
    // Offscreen not ready yet; state is periodic so dropping one frame is harmless.
  });

// ---------------------------------------------------------------------------
// Badge reflects the connection status reported by offscreen
// ---------------------------------------------------------------------------
const BADGE = Object.freeze({
  connected: { text: 'ON', color: '#2E7D32' },
  online: { text: '', color: '#757575' },
  connecting: { text: '…', color: '#757575' },
  error: { text: '!', color: '#E5484D' },
});

const applyStatus = async (status) => {
  const key = status.peer === 'online' && status.clients > 0 ? 'connected' : status.peer;
  const badge = BADGE[key] || BADGE.connecting;
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.storage.session.set({ status: { ...status, updatedAt: Date.now() } });
};

// ---------------------------------------------------------------------------
// Target tab resolution
// ---------------------------------------------------------------------------
const getTargetTab = async () => {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (focused) return focused;
  const [anyActive] = await chrome.tabs.query({ active: true, windowType: 'normal' });
  return anyActive || null;
};

// ChromeOS keeps the extension (and the phone link) alive after the last browser window closes:
// a "launch" command then opens a fresh maximized window and runs in its tab.
const launchWindow = async (cmd) => {
  const started = Date.now();
  const win = await chrome.windows.create({ focused: true, state: 'maximized' });
  const tab = (win.tabs && win.tabs[0]) || null;
  log.info('window.launched', { cmd, window_id: win.id, tab_id: tab && tab.id, latency_ms: Date.now() - started });
  return tab;
};

/** Target tab for a command per its TAB_NEED; null means "none available" (or not needed). */
const resolveTab = async (cmd) => {
  const need = tabNeedOf(cmd);
  const tab = await getTargetTab();
  if (need !== TAB_NEED.LAUNCH) return tab;
  if (tab) {
    // Navigating commands also bring a minimized / background window to the front.
    await chrome.windows.update(tab.windowId, { focused: true }).catch((e) => log.warn('window.focus_failed', { cmd, window_id: tab.windowId, error: String(e) }));
    return tab;
  }
  return launchWindow(cmd).catch((e) => {
    log.error('window.launch_failed', { cmd, error: String(e && e.message) });
    return null;
  });
};

// ---------------------------------------------------------------------------
// Content-script messaging with one self-healing re-injection
// (tabs opened before the extension was installed/reloaded have no content script)
// ---------------------------------------------------------------------------
const injectContentScripts = (tabId) =>
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['lib/protocol.js', 'lib/log.js', 'lib/playlist.js', 'lib/music.js', 'content.js'],
  });

const isNoReceiver = (e) => /Receiving end does not exist|Could not establish connection/i.test(String(e && e.message));

const sendToTab = async (tabId, message, options) => {
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch (e) {
    if (!isNoReceiver(e)) throw e;
    log.warn('content.missing_reinject', { tab_id: tabId });
    await injectContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, message, options);
  }
};

// ---------------------------------------------------------------------------
// Back / forward = the PAGE's own history (history.back() in the top frame), not chrome.tabs.goBack:
// with nothing to go back to it is a no-op, so it can never close the tab (tabs opened by
// target=_blank / window.open have no history; tab-level back failed or closed them). Works for
// SPA routes too. Whether we really moved is confirmed by watching the tab's URL / loading state.
// ---------------------------------------------------------------------------
const HISTORY_WAIT_MS = 1500;
const HISTORY_POLL_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForNavigation = async (tabId, fromUrl) => {
  const started = Date.now();
  while (Date.now() - started < HISTORY_WAIT_MS) {
    await sleep(HISTORY_POLL_MS);
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { navigated: false, waited: Date.now() - started };
    if (t.url !== fromUrl || t.status === 'loading') return { navigated: true, waited: Date.now() - started };
  }
  return { navigated: false, waited: Date.now() - started };
};

const historyNavigate = async (tab, direction) => {
  await sendToTab(tab.id, { type: 'history', direction }, { frameId: 0 });
  const { navigated, waited } = await waitForNavigation(tab.id, tab.url);
  log.info('history.navigate', { direction: direction < 0 ? 'back' : 'forward', tab_id: tab.id, from_url: tab.url, navigated, waited_ms: waited });
  return navigated ? ok() : fail(ERR.NO_HISTORY);
};

// ---------------------------------------------------------------------------
// Fullscreen: window fullscreen (no user gesture needed) + in-page video fill
// ---------------------------------------------------------------------------
/** Window fullscreen on / off (restoring the previous state) + in-page video fill. */
const setFullscreen = async (tab, on) => {
  const win = await chrome.windows.get(tab.windowId);
  const restoreKey = `prevState:${win.id}`;
  if (on && win.state !== 'fullscreen') await chrome.storage.session.set({ [restoreKey]: win.state });
  const { [restoreKey]: prev = 'maximized' } = await chrome.storage.session.get(restoreKey);
  const target = on ? 'fullscreen' : prev === 'fullscreen' ? 'maximized' : prev;
  if (win.state !== target) await chrome.windows.update(win.id, { state: target });
  // Fill is best-effort: the window fullscreen alone is still a useful result.
  await sendToTab(tab.id, { type: 'fill', on }).catch((e) =>
    log.warn('fullscreen.fill_failed', { tab_id: tab.id, error: String(e) })
  );
  return ok({ fullscreen: on });
};

const toggleFullscreen = async (tab) => {
  const win = await chrome.windows.get(tab.windowId);
  return setFullscreen(tab, win.state !== 'fullscreen');
};

// A page opened "to play full screen" (ytOpen) has no video yet: fill it once ITS video reports.
// The page being left can still report its own video during the navigation; that state must not
// consume the pending fill (iteration 23), so the pending entry names the video it is for and only a
// state sent from a frame showing that video applies it.
const pendingFillKey = (tabId) => `pendingFill:${tabId}`;
const applyPendingFill = async (tab, state, senderUrl) => {
  if (!state.hasVideo) return;
  const key = pendingFillKey(tab.id);
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  if (CRYt.videoIdOf(senderUrl) !== pending.videoId) {
    log.debug('fullscreen.fill_wait', { tab_id: tab.id, video_id: pending.videoId, sender_url: String(senderUrl || '').slice(0, 80) });
    return;
  }
  await chrome.storage.session.remove(key);
  await sendToTab(tab.id, { type: 'fill', on: true });
  log.info('fullscreen.fill_applied', { tab_id: tab.id, video_id: pending.videoId, after_ms: Date.now() - pending.at });
};

// ---------------------------------------------------------------------------
// Watch library: recent (last 10) + bookmarks, synced across the user's Chromebooks via
// chrome.storage.sync (the source of truth; layout in lib/library.js). List logic is pure.
// Resume = open the page, then seek ONCE to resumePosition() as soon as the video reports a
// duration (pending seek per tab in storage.session, survives a worker restart during load).
// ---------------------------------------------------------------------------
const RECENT_WRITE_INTERVAL_MS = 10000;
const lastVideoByTab = new Map(); // tabId -> latest video state (for bookmarking "where I am")
// tabId -> {playlist, music}: latest page summaries from the top frame (episode list 3.11, YouTube Music 3.13.14)
const lastSummariesByTab = new Map();
const SUMMARY_KINDS = Object.freeze(['playlist', 'music']);
const summariesOf = (tabId) => {
  const s = lastSummariesByTab.get(tabId) || {};
  return Object.fromEntries(SUMMARY_KINDS.map((k) => [k, s[k] || null]));
};
const lastRecentWrite = new Map(); // entry key -> ts of last write (throttle, sync write quota)

const syncStore = chrome.storage.sync;

/** Write to sync storage; quota / sync-service errors become a logged SYNC_FAILED result. */
const syncWrite = async (op, payload, context) => {
  try {
    await (op === 'remove' ? syncStore.remove(payload) : syncStore.set(payload));
    await chrome.storage.local.set({ libraryLastWrite: Date.now() });
    return ok();
  } catch (e) {
    log.error('library.sync_write_failed', { ...context, op, error: String(e && e.message) });
    return fail(ERR.SYNC_FAILED, { message: String(e && e.message) });
  }
};

const readLibrary = async () => {
  const all = await syncStore.get(null);
  return { recent: all.recent || [], bookmarks: CRLib.bookmarksFromStore(all) };
};

// One-time move of pre-1.0.11 local data (recent array + bookmarks array) into sync storage.
const migrateLibraryToSync = async () => {
  const { recent, bookmarks, libraryMigrated } = await chrome.storage.local.get(['recent', 'bookmarks', 'libraryMigrated']);
  if (libraryMigrated) return;
  const payload = {};
  if (Array.isArray(recent) && recent.length) payload.recent = recent.slice(0, CRLib.RECENT_MAX);
  (Array.isArray(bookmarks) ? bookmarks : []).slice(0, CRLib.BOOKMARK_MAX).forEach((b) => {
    if (b && b.key) payload[CRLib.bookmarkStorageKey(b.key)] = b;
  });
  if (Object.keys(payload).length) await syncWrite('set', payload, { reason: 'migrate' });
  await chrome.storage.local.set({ libraryMigrated: true });
  await chrome.storage.local.remove(['recent', 'bookmarks']);
  log.info('library.migrated', { recent: (payload.recent || []).length, bookmarks: Object.keys(payload).filter(CRLib.isBookmarkStorageKey).length });
};

const recordRecent = async (tab, state) => {
  if (!CRLib.shouldRecord(state)) return;
  const { deviceName } = await loadConfig();
  const entry = CRLib.makeEntry({ url: tab.url, title: tab.title, time: state.t, duration: state.dur, device: deviceName });
  if (!entry) return;
  const now = Date.now();
  if (now - (lastRecentWrite.get(entry.key) || 0) < RECENT_WRITE_INTERVAL_MS) return;
  lastRecentWrite.set(entry.key, now);
  const { recent } = await readLibrary();
  const res = await syncWrite('set', { recent: CRLib.upsertRecent(recent, entry) }, { key: entry.key });
  if (res.ok) log.debug('library.recent_saved', { key: entry.key, time: entry.time });
};

const pendingSeekKey = (tabId) => `pendingSeek:${tabId}`;

// Called on every video state of the target tab: apply a pending resume seek exactly once.
const applyPendingSeek = async (tab, state) => {
  const k = pendingSeekKey(tab.id);
  const { [k]: pending } = await chrome.storage.session.get(k);
  if (!pending || !state.hasVideo || !state.dur) return;
  if (CRLib.entryKey(tab.url) !== pending.key) return; // still on another page (redirect, ads)
  await chrome.storage.session.remove(k);
  const time = CRLib.resumePosition(pending.time, state.dur);
  const res = await runVideo(tab, CR.makeCmd({ cmd: CMD.SEEK_TO, args: { time } })).catch((e) => fail(ERR.INTERNAL, { message: String(e) }));
  log.info('library.resume_seek', { tab_id: tab.id, key: pending.key, saved: pending.time, time, ok: res.ok, error_code: res.errorCode });
};

const LIBRARY_ACTIONS = Object.freeze({
  [CMD.LIBRARY_LIST]: async () => ok(await readLibrary()),
  [CMD.BOOKMARK_ADD]: async (tab) => {
    const state = lastVideoByTab.get(tab.id);
    const { deviceName } = await loadConfig();
    const entry = CRLib.makeEntry({
      url: tab.url,
      title: tab.title,
      time: state && state.hasVideo ? state.t : 0,
      duration: state && state.dur,
      device: deviceName,
    });
    if (!entry) return fail(ERR.NO_TARGET);
    const { bookmarks } = await readLibrary();
    const isNew = !bookmarks.some((b) => b.key === entry.key);
    if (isNew && bookmarks.length >= CRLib.BOOKMARK_MAX) {
      // Evict the oldest bookmark to stay within the cap (and the sync item quota).
      await syncWrite('remove', CRLib.bookmarkStorageKey(bookmarks[bookmarks.length - 1].key), { reason: 'evict' });
    }
    const res = await syncWrite('set', { [CRLib.bookmarkStorageKey(entry.key)]: entry }, { key: entry.key });
    if (!res.ok) return res;
    log.info('library.bookmark_added', { key: entry.key, time: entry.time });
    return ok({ entry });
  },
  [CMD.BOOKMARK_REMOVE]: async (tab, args) => {
    const res = await syncWrite('remove', CRLib.bookmarkStorageKey(args.key), { key: args.key });
    if (res.ok) log.info('library.bookmark_removed', { key: args.key });
    return res;
  },
  [CMD.RECENT_REMOVE]: async (tab, args) => {
    const { recent } = await readLibrary();
    const res = await syncWrite('set', { recent: CRLib.removeRecent(recent, args.key) }, { key: args.key });
    if (res.ok) log.info('library.recent_removed', { key: args.key });
    return res;
  },
  [CMD.OPEN_ENTRY]: async (tab, args) => {
    const key = CRLib.entryKey(args.url);
    if (!key) return fail(ERR.BAD_MESSAGE);
    // Saved entries are on the canonical host: open them on the preferred mirror (design 3.15.3).
    const url = CR.onSite(args.url, site.preferred);
    if (args.time > 0) await chrome.storage.session.set({ [pendingSeekKey(tab.id)]: { key, time: args.time } });
    await chrome.tabs.update(tab.id, { url });
    log.info('library.open', { tab_id: tab.id, key, time: args.time || 0, site: CR.mirrorOfUrl(url) ? site.preferred : null });
    return ok();
  },
});

// ---------------------------------------------------------------------------
// Mirror domains (design 3.15, option S-A): the preferred site is synced across the user's Chromebooks
// (chrome.storage.sync) and used by Home, library entries and the phone's dropdown. Switching keeps the
// page: same path on the other domain, resumed at the same time (the pending-seek path of the library).
// ---------------------------------------------------------------------------
const site = { preferred: CR.DEFAULT_SITE }; // cache of chrome.storage.sync 'sitePreferred'

const loadSitePreference = async () => {
  const { sitePreferred } = await syncStore.get('sitePreferred');
  site.preferred = CR.siteById(sitePreferred) ? sitePreferred : CR.DEFAULT_SITE;
  return site.preferred;
};

/** Site part of the phone state: the mirror the TV is on (null elsewhere) and the preferred one. */
const siteStateOf = (url) => {
  const m = CR.mirrorOfUrl(url);
  return { current: m ? m.id : null, preferred: site.preferred };
};

const siteSwitch = async (tab, { site: to }) => {
  const from = CR.mirrorOfUrl(tab.url);
  // Always record the explicit choice (also when it equals the default), so every synced Chromebook follows it.
  const res = await syncWrite('set', { sitePreferred: to }, { reason: 'site_preferred' });
  if (!res.ok) log.warn('site.preferred_not_synced', { site: to }); // still switch on this machine
  site.preferred = to;
  if (from && from.id === to) {
    log.info('site.switch', { tab_id: tab.id, from: from.id, to, unchanged: true });
    return ok({ url: tab.url });
  }
  const url = from ? CR.onSite(tab.url, to) : CR.siteHome(to);
  const state = lastVideoByTab.get(tab.id);
  const time = from && state && state.hasVideo && state.t > 0 ? state.t : 0;
  if (time > 0) await chrome.storage.session.set({ [pendingSeekKey(tab.id)]: { key: CRLib.entryKey(url), time } });
  await chrome.tabs.update(tab.id, { url });
  log.info('site.switch', { tab_id: tab.id, from: from ? from.id : null, to, path: from ? new URL(url).pathname : '/', resume_at: Math.floor(time) });
  return ok({ url });
};

// ---------------------------------------------------------------------------
// Audio output (design 3.15.10, N-A revised): the TV page's media plays on a chosen output (a Bluetooth
// Nest Mini, HDMI, built-in speakers). The choice is per Chromebook (Bluetooth pairing is per machine):
// chrome.storage.local 'audioSink' {id, label}; '' = the default output = no routing. Every page that
// reports a video while a sink is chosen gets routed (content.js captureStream -> offscreen-audio.js).
// ---------------------------------------------------------------------------
const AUDIO_ROUTE_RETRY_MS = 5000;
// cache of 'audioSink' + the last lost device; loaded = the cache was read (a restarted worker must not
// stop a running route because its cache still says "default").
const audio = { sink: { id: '', label: null }, lost: null, loaded: false };
const audioRouteAsked = new Map(); // tabId -> ts of the last route request (no request storm while it starts)

const loadAudioSink = async () => {
  const { audioSink } = await chrome.storage.local.get('audioSink');
  audio.sink = audioSink && typeof audioSink.id === 'string' ? audioSink : { id: '', label: null };
  audio.loaded = true;
  return audio.sink;
};

const toOffscreen = async (payload) => {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
};

/** Ask a tab to start / stop routing (all frames; the one with the player answers). */
const requestAudioRoute = async (tab, on, reason) => {
  if (on) {
    audioRouteAsked.set(tab.id, Date.now());
    // A recreated offscreen document starts on the default output: tell it the chosen one first.
    await toOffscreen({ type: 'sinkSet', id: audio.sink.id, label: audio.sink.label }).catch((e) => log.warn('audio.sink_restore_failed', { error: String(e) }));
  } else audioRouteAsked.delete(tab.id);
  const res = await sendToTab(tab.id, { type: 'audioRoute', on }).catch((e) => fail(ERR.AUDIO_FAILED, { reason: String(e && e.message) }));
  log[res && res.ok === false ? 'warn' : 'info']('audio.route_request', { tab_id: tab.id, on, reason, ok: res ? res.ok !== false : null, error_code: res && res.errorCode, detail: res && res.data && res.data.reason });
  return res;
};

/** Called with every video state of the TV tab: start the route when a sink is chosen and it is not up. */
const syncAudioRoute = (tab, state) => {
  if (!state.hasVideo || !audio.loaded) return;
  const want = Boolean(audio.sink.id);
  if (want && !state.routed && Date.now() - (audioRouteAsked.get(tab.id) || 0) > AUDIO_ROUTE_RETRY_MS) requestAudioRoute(tab, true, 'state');
  if (!want && state.routed) requestAudioRoute(tab, false, 'state');
};

const audioOutputs = async () => {
  const res = await toOffscreen({ type: 'sinkList' }).catch((e) => ({ error: String(e && e.message) }));
  if (!res || res.error) return fail(ERR.AUDIO_FAILED, { reason: (res && res.error) || 'offscreen_unreachable' });
  log.info('audio.outputs', { count: res.outputs.length, kinds: res.outputs.map((o) => o.kind), needs_setup: res.needsSetup });
  return ok({ outputs: res.outputs, current: audio.sink.id, needsSetup: res.needsSetup });
};

const audioOutputSet = async (tab, { id }) => {
  let label = null;
  if (id) {
    const list = await audioOutputs();
    if (!list.ok) return list;
    if (list.data.needsSetup) return fail(ERR.NO_AUDIO_SETUP);
    const device = list.data.outputs.find((o) => o.id === id);
    if (!device) return fail(ERR.AUDIO_FAILED, { reason: 'unknown_device' });
    label = device.label;
  }
  const res = await toOffscreen({ type: 'sinkSet', id, label }).catch((e) => ({ ok: false, reason: String(e && e.message) }));
  if (!res || !res.ok) {
    log.warn('audio.sink_set_failed', { label, reason: res && res.reason });
    return fail(ERR.AUDIO_FAILED, { reason: (res && res.reason) || 'sink_set_failed' });
  }
  audio.sink = { id, label };
  audio.lost = null;
  await chrome.storage.local.set({ audioSink: audio.sink });
  log.info('audio.sink_chosen', { label, default: !id });
  // Apply to the TV's page now instead of waiting for its next state.
  const target = tab || (await getTargetTab());
  if (target) await requestAudioRoute(target, Boolean(id), 'phone');
  return ok({ label });
};

const audioSetup = async () => {
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('audio-setup.html'), active: true });
  log.info('audio.setup_opened', { tab_id: tab.id });
  return ok();
};

// ---------------------------------------------------------------------------
// YouTube catalog (design 3.13, option A). Requests go to InnerTube (the API youtube.com's own pages
// call) from INSIDE a youtube.com tab's page world, so they carry the user's sign-in. That "data tab"
// is any open youtube.com tab, else a background tab we open once; the TV's tab is never touched
// while the phone browses (Q40). Parsing is pure (lib/youtube.js).
// ---------------------------------------------------------------------------
// One data tab per site: music sections need music.youtube.com's own InnerTube client (design 3.13.15).
const YT_DATA_TAB_URLS = Object.freeze({ [CRYt.ORIGIN]: `${CRYt.ORIGIN}/feed/you`, [CRYt.MUSIC_ORIGIN]: `${CRYt.MUSIC_ORIGIN}/` });
const YT_TAB_READY_MS = 15000;
const YT_UP_NEXT_MAX = 20;
const ytDataTabIds = new Map(); // origin -> last data tab; re-validated before each use

/**
 * Runs in the youtube.com page (world MAIN): one InnerTube POST with the page's own client config.
 * Self-contained (serialized by chrome.scripting). Signed-in feeds need the SAPISIDHASH header:
 * SHA-1 of "<ts> <SAPISID cookie> <origin>", as youtube.com computes it.
 */
async function innertubeInPage(endpoint, body, waitMs) {
  const started = Date.now();
  while (!(window.ytcfg && window.ytcfg.get && window.ytcfg.get('INNERTUBE_CONTEXT'))) {
    if (Date.now() - started > waitMs) return { error: 'no_ytcfg' };
    await new Promise((r) => setTimeout(r, 200));
  }
  const cfg = window.ytcfg;
  const headers = {
    'content-type': 'application/json',
    'x-youtube-client-name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
    'x-youtube-client-version': String(cfg.get('INNERTUBE_CLIENT_VERSION') || ''),
    'x-origin': location.origin,
    'x-goog-authuser': String(cfg.get('SESSION_INDEX') || 0),
  };
  const sapisid = (document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/) || [])[1];
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${location.origin}`));
    headers.authorization = `SAPISIDHASH ${ts}_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  try {
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    return { status: res.status, json: await res.json().catch(() => null), auth: Boolean(sapisid) };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message) };
  }
}

const waitTabComplete = async (tabId) => {
  const started = Date.now();
  while (Date.now() - started < YT_TAB_READY_MS) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === 'complete') return true;
    await sleep(200);
  }
  return false;
};

const onOrigin = (url, origin) => String(url || '').indexOf(`${origin}/`) === 0;

/** A tab of `origin` to run requests in: the last one, any open one (background first), or a new background tab. */
const ytDataTab = async (origin) => {
  const lastId = ytDataTabIds.get(origin);
  const last = lastId === undefined ? null : await chrome.tabs.get(lastId).catch(() => null);
  if (last && onOrigin(last.url, origin)) return last;
  const open = await chrome.tabs.query({ url: `${origin}/*` });
  const pick = open.find((t) => !t.active) || open[0];
  const target = await getTargetTab();
  const tab = pick || (await chrome.tabs.create({ url: YT_DATA_TAB_URLS[origin], active: false, ...(target ? { windowId: target.windowId } : {}) }));
  ytDataTabIds.set(origin, tab.id);
  log.info('yt.data_tab', { origin, action: pick ? 'reuse' : 'create', tab_id: tab.id, active: Boolean(tab.active) });
  return tab;
};

/** One InnerTube call on the section's site; ok(json) or fail(YT_FAILED, {reason}). */
const ytRequest = async (endpoint, body, section) => {
  const started = Date.now();
  const tab = await ytDataTab(CRYt.originOf(section));
  if (!(await waitTabComplete(tab.id))) return fail(ERR.YT_FAILED, { reason: 'data_tab_not_ready' });
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: innertubeInPage, args: [endpoint, body, YT_TAB_READY_MS] });
  const r = (injection && injection.result) || { error: 'no_result' };
  const reason = r.error || (r.status >= 400 ? `http_${r.status}` : !r.json ? 'bad_json' : null);
  log[reason ? 'warn' : 'info']('yt.request', {
    endpoint, section, tab_id: tab.id, status: r.status, auth: r.auth, reason, latency_ms: Date.now() - started,
    logged_out: r.json ? CRYt.isLoggedOut(r.json) : null,
  });
  return reason ? fail(ERR.YT_FAILED, { reason }) : ok(r.json);
};

/** ytBrowse: a section's cards (a channel shows its Videos tab). */
const ytBrowse = async (args) => {
  const { section, id, cursor } = args;
  let res = await ytRequest('browse', CRYt.browseRequest({ section, id, cursor }), section);
  if (res.ok && section === CR.YT_SECTION.CHANNEL && !cursor) {
    const params = CRYt.channelVideosParams(res.data);
    if (params) res = await ytRequest('browse', { browseId: id, params }, section);
  }
  if (!res.ok) return res;
  if (CRYt.needsSignIn(section) && CRYt.isLoggedOut(res.data)) return fail(ERR.YT_SIGNED_OUT);
  const { items, cursor: next, stats } = CRYt.parseItems(res.data);
  log[stats.unknown ? 'warn' : 'info']('yt.parsed', { section, items: items.length, ...stats, has_cursor: Boolean(next), page: cursor ? 'more' : 'first' });
  return ok({ title: CRYt.titleOf(res.data), items, cursor: next });
};

/** ytUpNext: "待播" (the playlist, or the autoplay video) + "相关" (side list) for the TV's video (design 3.15.13). */
const ytUpNext = async ({ videoId, playlistId }) => {
  const res = await ytRequest('next', { videoId, ...(playlistId ? { playlistId } : {}) }, 'upNext');
  if (!res.ok) return res;
  const { queue, related } = CRYt.watchNext(res.data, videoId);
  const items = related.slice(0, YT_UP_NEXT_MAX);
  log.info('yt.parsed', { section: 'upNext', items: items.length, queue: queue ? queue.items.length : 0, autoplay: Boolean(queue && queue.autoplay), playlist_id: playlistId || null, current: queue ? queue.current : null });
  // `items` keeps its meaning (the side list) for phones older than 1.0.32.
  return ok({ items, queue });
};

/**
 * ytOpen: play on the TV, full screen (Q45); a bare playlist starts at its first video.
 * music: the song opens in the YouTube Music player (its queue, the phone's music layout), and the
 * video is not filled over that player.
 */
const ytOpen = async (tab, { videoId, playlistId, music = false }) => {
  let first = videoId;
  if (!first) {
    const list = await ytBrowse(music ? { section: CR.YT_SECTION.MUSIC_LIST, id: `VL${playlistId}` } : { section: CR.YT_SECTION.PLAYLIST, id: playlistId });
    if (!list.ok) return list;
    const firstVideo = list.data.items.find((c) => c.kind === 'video');
    if (!firstVideo) return fail(ERR.YT_FAILED, { reason: 'empty_playlist' });
    first = firstVideo.id;
  }
  const url = CRYt.watchUrl({ videoId: first, playlistId, music });
  if (!music) await chrome.storage.session.set({ [pendingFillKey(tab.id)]: { at: Date.now(), videoId: first } });
  await chrome.tabs.update(tab.id, { url, active: true });
  await setFullscreen(tab, true).catch((e) => log.warn('yt.fullscreen_failed', { tab_id: tab.id, error: String(e) }));
  log.info('yt.open', { video_id: first, playlist_id: playlistId || null, music, tab_id: tab.id });
  return ok({ url });
};

const ytWatchLater = async ({ videoId }) => {
  const res = await ytRequest('browse/edit_playlist', { playlistId: 'WL', actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }] }, 'watchLater');
  const done = res.ok && res.data.status === 'STATUS_SUCCEEDED';
  log[done ? 'info' : 'warn']('yt.watch_later', { video_id: videoId, ok: done, status: res.ok ? res.data.status : res.errorCode });
  if (done) return ok();
  return res.ok ? fail(CRYt.isLoggedOut(res.data) ? ERR.YT_SIGNED_OUT : ERR.YT_FAILED, { reason: String(res.data.status || 'not_saved') }) : res;
};

// YouTube Music "歌词 / 相关" (design 3.15.11): `next` names both tabs by a browse id; read in the music
// data tab, so the TV's own page (and its Lyrics tab) is never switched.
const musicTab = async (videoId, which) => {
  const next = await ytRequest('next', { videoId }, CR.YT_SECTION.MUSIC_HOME);
  if (!next.ok) return next;
  const browseId = CRYt.musicTabIds(next.data)[which];
  if (!browseId) {
    log.info('music.tab_missing', { video_id: videoId, which });
    return ok(null);
  }
  const res = await ytRequest('browse', { browseId }, CR.YT_SECTION.MUSIC_HOME);
  return res.ok ? ok(res.data) : res;
};

const musicLyrics = async ({ videoId }) => {
  const started = Date.now();
  const res = await musicTab(videoId, 'lyrics');
  if (!res.ok) return res;
  const lyrics = res.data ? CRYt.parseLyrics(res.data) : null;
  log.info('music.lyrics', { video_id: videoId, has_lyrics: Boolean(lyrics), latency_ms: Date.now() - started });
  return ok(lyrics || { text: null, source: null });
};

const musicRelated = async ({ videoId }) => {
  const started = Date.now();
  const res = await musicTab(videoId, 'related');
  if (!res.ok) return res;
  const shelves = res.data ? CRYt.parseRelated(res.data) : [];
  log.info('music.related', { video_id: videoId, shelves: shelves.length, items: shelves.reduce((n, s) => n + s.items.length, 0), latency_ms: Date.now() - started });
  return ok({ shelves });
};

const YOUTUBE_ACTIONS = Object.freeze({
  [CMD.MUSIC_LYRICS]: (tab, args) => musicLyrics(args),
  [CMD.MUSIC_RELATED]: (tab, args) => musicRelated(args),
  [CMD.YT_BROWSE]: (tab, args) => ytBrowse(args),
  [CMD.YT_UP_NEXT]: (tab, args) => ytUpNext(args),
  [CMD.YT_OPEN]: (tab, args) => ytOpen(tab, args),
  [CMD.YT_WATCH_LATER]: (tab, args) => ytWatchLater(args),
});

// ---------------------------------------------------------------------------
// Page zoom (design 3.14, option A). Chrome keeps zoom per site ("per-origin" scope), so iyf.tv stays
// enlarged on every iyf.tv page and next time, on this Chromebook only. Levels: CR.ZOOM_LEVELS.
// ---------------------------------------------------------------------------
const zoomByTab = new Map(); // tabId -> factor; kept fresh by onZoomChange

/** The tab's zoom factor (cached; 1 when Chrome can't tell, e.g. the tab is gone). */
const zoomOf = async (tabId) => {
  if (zoomByTab.has(tabId)) return zoomByTab.get(tabId);
  const factor = await chrome.tabs.getZoom(tabId).catch(() => 1);
  zoomByTab.set(tabId, factor);
  return factor;
};

/** zoom {step} / {reset}: one Chrome level up / down, or back to 100%. Replies with the factor now in effect. */
const zoomTab = async (tab, { step, reset }) => {
  const from = await chrome.tabs.getZoom(tab.id);
  const to = reset ? 1 : CR.stepZoom(from, step);
  const origin = (() => {
    try {
      return new URL(tab.url).origin;
    } catch (_) {
      return null;
    }
  })();
  if (Math.abs(to - from) < 0.001) {
    log.debug('zoom.unchanged', { tab_id: tab.id, zoom: from, step: step || null, reset: Boolean(reset) });
    return ok({ zoom: from });
  }
  try {
    await chrome.tabs.setZoom(tab.id, to);
  } catch (e) {
    log.warn('zoom.failed', { tab_id: tab.id, origin, from, to, error: String(e && e.message) });
    return fail(ERR.NO_ZOOM, { reason: String(e && e.message) });
  }
  zoomByTab.set(tab.id, to);
  log.info('zoom.set', { tab_id: tab.id, origin, from, to, source: 'phone' });
  return ok({ zoom: to });
};

// ---------------------------------------------------------------------------
// Executors (each returns {ok, errorCode, data}; never throws)
// ---------------------------------------------------------------------------
const BROWSER_ACTIONS = Object.freeze({
  ...LIBRARY_ACTIONS,
  [CMD.BACK]: (tab) => historyNavigate(tab, -1),
  [CMD.FORWARD]: (tab) => historyNavigate(tab, 1),
  [CMD.RELOAD]: (tab) => chrome.tabs.reload(tab.id).then(() => ok()),
  [CMD.HOME]: (tab) => chrome.tabs.update(tab.id, { url: CR.siteHome(site.preferred) }).then(() => ok()),
  [CMD.FULLSCREEN]: (tab) => toggleFullscreen(tab),
  [CMD.ZOOM]: (tab, args) => zoomTab(tab, args),
  [CMD.SITE_SWITCH]: (tab, args) => siteSwitch(tab, args),
  [CMD.AUDIO_OUTPUTS]: () => audioOutputs(),
  [CMD.AUDIO_OUTPUT_SET]: (tab, args) => audioOutputSet(tab, args),
  [CMD.AUDIO_SETUP]: () => audioSetup(),
  [CMD.PING]: () => Promise.resolve(ok({ ts: Date.now() })),
});

const runBrowser = (tab, msg) => BROWSER_ACTIONS[msg.cmd](tab, msg.args || {});

// Page commands only make sense in the top frame (pointer overlay lives there).
const runPage = async (tab, msg) => {
  // The pointer moves in CSS pixels: tell the page its zoom so a finger stroke covers the same
  // screen distance at any zoom (design 3.14.2).
  const sent = msg.cmd === CMD.MOVE ? { ...msg, args: { ...msg.args, zoom: await zoomOf(tab.id) } } : msg;
  const result = await sendToTab(tab.id, { type: 'exec', msg: sent }, { frameId: 0 });
  return result || fail(ERR.NO_TARGET);
};

// Video commands go to all frames; only the frame owning a <video> answers.
const runVideo = async (tab, msg) => {
  const result = await sendToTab(tab.id, { type: 'exec', msg }).catch((e) => {
    if (/message port closed/i.test(String(e && e.message))) return null;
    throw e;
  });
  return result || fail(ERR.NO_VIDEO);
};

const runYoutube = (tab, msg) => YOUTUBE_ACTIONS[msg.cmd](tab, msg.args || {});

const EXECUTORS = Object.freeze({ browser: runBrowser, page: runPage, video: runVideo, youtube: runYoutube });

const executeCommand = async (msg, clientId) => {
  const started = Date.now();
  const base = { cmd_id: msg.cmd_id, cmd: msg.cmd, client_id: clientId };
  const executor = EXECUTORS[executorOf(msg.cmd)];
  if (!executor) return fail(ERR.UNKNOWN_CMD);

  const tab = await resolveTab(msg.cmd);
  if (!tab && tabNeedOf(msg.cmd) !== TAB_NEED.NONE) {
    log.warn('cmd.no_tab', { ...base, tab_need: tabNeedOf(msg.cmd) });
    return fail(ERR.NO_TAB);
  }
  const tabId = tab ? tab.id : null;

  try {
    const result = await executor(tab, msg); // tab is null only for TAB_NEED.NONE commands
    const level = result.ok ? 'debug' : 'warn';
    log[level]('cmd.result', { ...base, tab_id: tabId, ok: result.ok, error_code: result.errorCode, latency_ms: Date.now() - started });
    return result;
  } catch (e) {
    log.error('cmd.exception', { ...base, tab_id: tabId, error: String(e), latency_ms: Date.now() - started });
    return fail(ERR.INTERNAL, { message: String(e && e.message) });
  }
};

// ---------------------------------------------------------------------------
// Video state forwarding (only the active tab is relevant to the phone)
// ---------------------------------------------------------------------------
/** Everything the phone shows about the TV tab besides the video itself (one shape for every push). */
const pageContext = async (tab) => ({
  title: (tab && tab.title) || '',
  url: (tab && tab.url) || '',
  ...(tab ? summariesOf(tab.id) : {}),
  zoom: tab ? await zoomOf(tab.id) : 1,
  // The TV window's full screen, so the music layout's button can say 全屏 / 退出全屏 (design 3.15.11).
  fullscreen: tab ? (await chrome.windows.get(tab.windowId).catch(() => ({}))).state === 'fullscreen' : false,
  site: siteStateOf(tab && tab.url),
  audio: { label: audio.sink.id ? audio.sink.label : null, lost: audio.lost },
  ts: Date.now(),
});
const pushState = async (tab, video) => sendToOffscreen({ type: 'state', state: { ...(video || { hasVideo: false }), ...(await pageContext(tab)) } });

const forwardVideoState = async (state, sender) => {
  const tab = await getTargetTab();
  if (!tab || !sender.tab || sender.tab.id !== tab.id) return;
  pushState(tab, state);
  // Library / audio side effects never block or break state forwarding.
  lastVideoByTab.set(tab.id, state);
  recordRecent(tab, state).catch((e) => log.warn('library.recent_failed', { error: String(e) }));
  applyPendingSeek(tab, state).catch((e) => log.warn('library.resume_failed', { error: String(e) }));
  applyPendingFill(tab, state, sender.url).catch((e) => log.warn('fullscreen.fill_failed', { tab_id: tab.id, error: String(e) }));
  syncAudioRoute(tab, state);
};

// Reset the phone's view when the user switches tab or navigates.
const announceNoVideo = async () => pushState(await getTargetTab(), null);

/** The TV tab's zoom changed (from the phone or on the Chromebook): the phone shows the new value. */
const onZoomChanged = async ({ tabId, oldZoomFactor, newZoomFactor }) => {
  zoomByTab.set(tabId, newZoomFactor);
  const tab = await getTargetTab();
  log.debug('zoom.changed', { tab_id: tabId, from: oldZoomFactor, to: newZoomFactor, target: Boolean(tab && tab.id === tabId) });
  if (!tab || tab.id !== tabId) return;
  pushState(tab, lastVideoByTab.get(tabId));
};

// ---------------------------------------------------------------------------
// Remote page reachability: catch "GitHub Pages not deployed / wrong repo name" (HTTP 404)
// before the user scans the QR code. Cached briefly because the popup polls every 2 s.
// ---------------------------------------------------------------------------
const REMOTE_CHECK_TTL_MS = 60000;
const REMOTE_CHECK_TIMEOUT_MS = 8000;
let remoteCheckCache = { url: null, at: 0, result: null };

const checkRemoteUrl = async (url, { force = false } = {}) => {
  const fresh = remoteCheckCache.url === url && Date.now() - remoteCheckCache.at < REMOTE_CHECK_TTL_MS;
  if (fresh && !force) return remoteCheckCache.result;
  const probe = await probeRemote(url);
  // A wrong-case / wrong-name repo path gets GitHub's generic 404: suggest the lowercase path if it works.
  const lower = lowercasePathVariant(url);
  const suggestion = !probe.isApp && lower ? await probeRemote(lower) : null;
  const result = {
    ...probe,
    localVersion: CR_VERSION,
    suggestedUrl: suggestion && suggestion.isApp ? lower : null,
    checkedAt: Date.now(),
  };
  remoteCheckCache = { url, at: Date.now(), result };
  log[result.isApp ? 'info' : 'warn']('remote_url.check', {
    url,
    ok: result.ok,
    is_app: result.isApp,
    http_status: result.status,
    error: result.error,
    local_version: result.localVersion,
    remote_version: result.remoteVersion,
    suggested_url: result.suggestedUrl,
  });
  return result;
};

/**
 * Probe one base URL. `isApp` is the gate for showing a QR code: the page loads (200) AND the
 * deployed extension/lib/version.js is readable, i.e. it really is this app, not some other page.
 */
const probeRemote = async (url) => {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS) });
    const remoteVersion = res.ok ? await fetchRemoteVersion(url) : null;
    return { ok: res.ok, status: res.status, remoteVersion, isApp: res.ok && Boolean(remoteVersion) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.name), remoteVersion: null, isApp: false };
  }
};

/** Same URL with a lowercase path, or null when the path is already lowercase. */
const lowercasePathVariant = (url) => {
  try {
    const u = new URL(url);
    const lowered = u.pathname.toLowerCase();
    if (lowered === u.pathname) return null;
    u.pathname = lowered;
    return u.toString();
  } catch (_) {
    return null;
  }
};

// The phone page loads ../extension/lib/version.js, so the deployed copy sits next to it.
// Digits only: version.js's own doc comment contains the literal example `CR_VERSION = '…'`.
const VERSION_RE = /CR_VERSION\s*=\s*'(\d+(?:\.\d+)+)'/;
const fetchRemoteVersion = async (baseUrl) => {
  try {
    const res = await fetch(new URL('../extension/lib/version.js', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const match = (await res.text()).match(VERSION_RE);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Popup API
// ---------------------------------------------------------------------------
const isPlaceholderUrl = (url) => url.includes(LEGACY_PLACEHOLDER_MARK);

const librarySummary = async () => {
  const { recent, bookmarks } = await readLibrary();
  const { libraryLastWrite = null } = await chrome.storage.local.get('libraryLastWrite');
  return { recent: recent.length, bookmarks: bookmarks.length, lastWrite: libraryLastWrite };
};

const getPopupStatus = async ({ nonce = '' } = {}) => {
  const config = await loadConfig();
  const { status = null, logs = [] } = await chrome.storage.session.get(['status', 'logs']);
  const remoteCheck = isPlaceholderUrl(config.remoteBaseUrl) ? null : await checkRemoteUrl(config.remoteBaseUrl);
  return {
    status,
    peerId: config.peerId,
    remoteBaseUrl: config.remoteBaseUrl,
    remoteCheck,
    version: CR_VERSION,
    deviceName: config.deviceName,
    library: await librarySummary(),
    pairUrl: buildPairUrl({ baseUrl: config.remoteBaseUrl, peerId: config.peerId, key: config.key, nonce }),
    logCount: logs.length,
  };
};

const BG_HANDLERS = Object.freeze({
  getConfig: async () => {
    const { peerId, peerToken, key, deviceName } = await loadConfig();
    return { peerId, peerToken, key, deviceName };
  },
  cmd: ({ msg, clientId }) => executeCommand(msg, clientId),
  status: ({ status }) => applyStatus(status).then(() => true),
  log: ({ entry }) => {
    logSink(entry);
    return Promise.resolve(true);
  },
  getStatus: ({ nonce }) => getPopupStatus({ nonce }),
  recheckRemote: async () => {
    const { remoteBaseUrl } = await loadConfig();
    return checkRemoteUrl(remoteBaseUrl, { force: true });
  },
  getLogs: async () => (await chrome.storage.session.get('logs')).logs || [],
  clearLogs: () => chrome.storage.session.set({ logs: [] }).then(() => true),
  setBaseUrl: async ({ remoteBaseUrl }) => {
    const url = String(remoteBaseUrl || '').trim();
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'URL must start with https://' };
    const normalized = url.endsWith('/') ? url : `${url}/`;
    await updateConfig({ remoteBaseUrl: normalized });
    log.info('config.base_url_changed', { remote_base_url: normalized });
    // Check immediately so the popup can warn right after saving.
    const check = await checkRemoteUrl(normalized, { force: true });
    return { ok: true, check };
  },
  setDeviceName: async ({ deviceName }) => {
    const name = String(deviceName || '').trim().slice(0, DEVICE_NAME_MAX);
    if (!name) return { ok: false, error: '名称不能为空' };
    await updateConfig({ deviceName: name });
    log.info('config.device_name_changed', { device_name: name });
    await sendToOffscreen({ type: 'reloadConfig' }); // phones re-authenticate and receive the new name
    return { ok: true };
  },
  // Audio (design 3.15.10): the chosen device vanished (offscreen fell back to the default output).
  audioLost: async ({ label }) => {
    audio.lost = label || null;
    log.warn('audio.sink_lost', { label });
    const tab = await getTargetTab();
    if (tab) await pushState(tab, lastVideoByTab.get(tab.id));
    return true;
  },
  audioSetupDone: ({ ok: granted }) => {
    log.info('audio.setup_done', { ok: Boolean(granted) });
    return Promise.resolve(true);
  },
  regenerateKey: async () => {
    await updateConfig({ key: newKey() });
    log.info('config.key_regenerated');
    await sendToOffscreen({ type: 'reloadConfig' });
    return { ok: true };
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'videoState' && sender.tab) {
    forwardVideoState(message.state, sender);
    return false;
  }
  // Page summaries (episode list, YouTube Music): sent by the top frame only when they change;
  // merged into the next video state.
  if (message && message.type === 'pageSummary' && sender.tab && SUMMARY_KINDS.includes(message.kind)) {
    const s = message.summary;
    log.debug('summary.state', { tab_id: sender.tab.id, kind: message.kind, current: s && s.current, total: s && s.total });
    lastSummariesByTab.set(sender.tab.id, { ...(lastSummariesByTab.get(sender.tab.id) || {}), [message.kind]: s || null });
    return false;
  }
  if (!message || message.target !== 'bg') return false;
  const handler = BG_HANDLERS[message.type];
  if (!handler) {
    log.warn('bg.unknown_message', { type: message.type });
    return false;
  }
  Promise.resolve(handler(message))
    .then(sendResponse)
    .catch((e) => {
      log.error('bg.handler_failed', { type: message.type, error: String(e) });
      sendResponse(fail(ERR.INTERNAL));
    });
  return true; // async response
});

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
chrome.runtime.onStartup.addListener(() => {
  log.info('lifecycle.startup', { ext_id: chrome.runtime.id });
  ensureOffscreen();
  migrateLibraryToSync().catch((e) => log.error('library.migrate_failed', { error: String(e) }));
});
chrome.runtime.onInstalled.addListener((details) => {
  log.info('lifecycle.installed', { reason: details.reason, ext_id: chrome.runtime.id });
  loadConfig().then(ensureOffscreen);
  migrateLibraryToSync().catch((e) => log.error('library.migrate_failed', { error: String(e) }));
});
// Library changes arriving through Chrome sync (another machine, same account, same fixed ext_id).
// Local writes also fire this; libraryLastWrite (set right after our own writes) tells them apart.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (changes.sitePreferred) loadSitePreference().catch(() => {}); // another Chromebook switched site
  const keys = Object.keys(changes);
  const { libraryLastWrite = 0 } = await chrome.storage.local.get('libraryLastWrite');
  const { recent, bookmarks } = await readLibrary();
  log.info('library.sync_changed', {
    origin: Date.now() - libraryLastWrite < 2000 ? 'local' : 'remote',
    changed: keys.length,
    bookmark_keys: keys.filter(CRLib.isBookmarkStorageKey).length,
    recent: recent.length,
    bookmarks: bookmarks.length,
  });
});
chrome.tabs.onActivated.addListener(() => announceNoVideo());
chrome.tabs.onZoomChange.addListener((info) => onZoomChanged(info).catch((e) => log.warn('zoom.push_failed', { error: String(e) })));
chrome.tabs.onRemoved.addListener((tabId) => {
  zoomByTab.delete(tabId);
  audioRouteAsked.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    lastSummariesByTab.delete(tabId); // the new page's content script pushes its own summaries
    zoomByTab.delete(tabId); // another site may have its own saved zoom: read it again
    announceNoVideo();
  }
});

// Any wake-up of the worker re-checks the offscreen document (cheap, idempotent) and reloads the cached
// preferences (the worker may have been restarted since they were last read).
ensureOffscreen();
loadSitePreference().catch((e) => log.warn('site.preference_load_failed', { error: String(e) }));
// The offscreen document may be newer than the worker (or recreated): give it the chosen output again.
loadAudioSink()
  .then((sink) => (sink.id ? toOffscreen({ type: 'sinkSet', id: sink.id, label: sink.label }) : null))
  .catch((e) => log.warn('audio.sink_restore_failed', { error: String(e) }));
