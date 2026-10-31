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
importScripts('lib/version.js', 'lib/protocol.js', 'lib/log.js', 'lib/library.js');

const { CMD, ERR, TAB_NEED, ok, fail, executorOf, tabNeedOf, buildPairUrl, newKey, DEFAULT_HOME_URL } = CR;

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
      reasons: ['WEB_RTC'],
      justification: 'Hold the WebRTC data channel to the phone remote.',
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
    files: ['lib/protocol.js', 'lib/log.js', 'content.js'],
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
const toggleFullscreen = async (tab) => {
  const win = await chrome.windows.get(tab.windowId);
  const entering = win.state !== 'fullscreen';
  if (entering) {
    await chrome.storage.session.set({ [`prevState:${win.id}`]: win.state });
  }
  const restoreKey = `prevState:${win.id}`;
  const { [restoreKey]: prev = 'maximized' } = await chrome.storage.session.get(restoreKey);
  await chrome.windows.update(win.id, { state: entering ? 'fullscreen' : prev === 'fullscreen' ? 'maximized' : prev });
  // Fill is best-effort: the window fullscreen alone is still a useful result.
  await sendToTab(tab.id, { type: 'fill', on: entering }).catch((e) =>
    log.warn('fullscreen.fill_failed', { tab_id: tab.id, error: String(e) })
  );
  return ok({ fullscreen: entering });
};

// ---------------------------------------------------------------------------
// Watch library: recent (last 10) + bookmarks, synced across the user's Chromebooks via
// chrome.storage.sync (the source of truth; layout in lib/library.js). List logic is pure.
// Resume = open the page, then seek ONCE to resumePosition() as soon as the video reports a
// duration (pending seek per tab in storage.session, survives a worker restart during load).
// ---------------------------------------------------------------------------
const RECENT_WRITE_INTERVAL_MS = 10000;
const lastVideoByTab = new Map(); // tabId -> latest video state (for bookmarking "where I am")
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
    if (args.time > 0) await chrome.storage.session.set({ [pendingSeekKey(tab.id)]: { key, time: args.time } });
    await chrome.tabs.update(tab.id, { url: args.url });
    log.info('library.open', { tab_id: tab.id, key, time: args.time || 0 });
    return ok();
  },
});

// ---------------------------------------------------------------------------
// Executors (each returns {ok, errorCode, data}; never throws)
// ---------------------------------------------------------------------------
const BROWSER_ACTIONS = Object.freeze({
  ...LIBRARY_ACTIONS,
  [CMD.BACK]: (tab) => historyNavigate(tab, -1),
  [CMD.FORWARD]: (tab) => historyNavigate(tab, 1),
  [CMD.RELOAD]: (tab) => chrome.tabs.reload(tab.id).then(() => ok()),
  [CMD.HOME]: (tab) => chrome.tabs.update(tab.id, { url: DEFAULT_HOME_URL }).then(() => ok()),
  [CMD.FULLSCREEN]: (tab) => toggleFullscreen(tab),
  [CMD.PING]: () => Promise.resolve(ok({ ts: Date.now() })),
});

const runBrowser = (tab, msg) => BROWSER_ACTIONS[msg.cmd](tab, msg.args || {});

// Page commands only make sense in the top frame (pointer overlay lives there).
const runPage = async (tab, msg) => {
  const result = await sendToTab(tab.id, { type: 'exec', msg }, { frameId: 0 });
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

const EXECUTORS = Object.freeze({ browser: runBrowser, page: runPage, video: runVideo });

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
const forwardVideoState = async (state, sender) => {
  const tab = await getTargetTab();
  if (!tab || !sender.tab || sender.tab.id !== tab.id) return;
  sendToOffscreen({ type: 'state', state: { ...state, title: tab.title || '', url: tab.url || '', ts: Date.now() } });
  // Library side effects never block or break state forwarding.
  lastVideoByTab.set(tab.id, state);
  recordRecent(tab, state).catch((e) => log.warn('library.recent_failed', { error: String(e) }));
  applyPendingSeek(tab, state).catch((e) => log.warn('library.resume_failed', { error: String(e) }));
};

// Reset the phone's view when the user switches tab or navigates.
const announceNoVideo = async () => {
  const tab = await getTargetTab();
  sendToOffscreen({ type: 'state', state: { hasVideo: false, title: tab ? tab.title : '', url: tab ? tab.url : '', ts: Date.now() } });
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
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') announceNoVideo();
});

// Any wake-up of the worker re-checks the offscreen document (cheap, idempotent).
ensureOffscreen();
