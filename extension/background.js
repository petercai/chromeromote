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
importScripts('lib/version.js', 'lib/protocol.js', 'lib/log.js');

const { CMD, ERR, ok, fail, executorOf, buildPairUrl, newKey, DEFAULT_HOME_URL } = CR;

// ---------------------------------------------------------------------------
// Immutable settings
// ---------------------------------------------------------------------------
const LOG_BUFFER_MAX = 500;
const LOG_FLUSH_MS = 300;
const DEFAULT_REMOTE_BASE_URL = 'https://YOUR_GITHUB_USER.github.io/chrome-remote/remote/';
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
const loadConfig = async () => {
  const stored = await chrome.storage.local.get(['peerId', 'key', 'remoteBaseUrl']);
  const config = {
    peerId: stored.peerId || `cr-${CR.newId()}`,
    key: stored.key || newKey(),
    remoteBaseUrl: stored.remoteBaseUrl || DEFAULT_REMOTE_BASE_URL,
  };
  const changed = config.peerId !== stored.peerId || config.key !== stored.key || config.remoteBaseUrl !== stored.remoteBaseUrl;
  if (changed) {
    await chrome.storage.local.set(config);
    log.info('config.created', { peer_id: config.peerId, key: CRLog.redact(config.key) });
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
// Executors (each returns {ok, errorCode, data}; never throws)
// ---------------------------------------------------------------------------
const BROWSER_ACTIONS = Object.freeze({
  [CMD.BACK]: (tab) => chrome.tabs.goBack(tab.id).then(() => ok()),
  [CMD.FORWARD]: (tab) => chrome.tabs.goForward(tab.id).then(() => ok()),
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

  const tab = await getTargetTab();
  if (!tab) {
    log.warn('cmd.no_tab', base);
    return fail(ERR.NO_TAB);
  }

  try {
    const result = await executor(tab, msg);
    const level = result.ok ? 'debug' : 'warn';
    log[level]('cmd.result', { ...base, tab_id: tab.id, ok: result.ok, error_code: result.errorCode, latency_ms: Date.now() - started });
    return result;
  } catch (e) {
    log.error('cmd.exception', { ...base, tab_id: tab.id, error: String(e), latency_ms: Date.now() - started });
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
  let result;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS) });
    result = { ok: res.ok, status: res.status, checkedAt: Date.now() };
  } catch (e) {
    result = { ok: false, status: 0, error: String(e && e.name), checkedAt: Date.now() };
  }
  // Compare the deployed version with ours, so a stale GitHub Pages deploy is visible at a glance.
  result.localVersion = CR_VERSION;
  result.remoteVersion = result.ok ? await fetchRemoteVersion(url) : null;
  remoteCheckCache = { url, at: Date.now(), result };
  log[result.ok ? 'info' : 'warn']('remote_url.check', {
    url,
    ok: result.ok,
    http_status: result.status,
    error: result.error,
    local_version: result.localVersion,
    remote_version: result.remoteVersion,
  });
  return result;
};

// The phone page loads ../extension/lib/version.js, so the deployed copy sits next to it.
const VERSION_RE = /CR_VERSION\s*=\s*'([^']+)'/;
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
const isPlaceholderUrl = (url) => url.includes('YOUR_GITHUB_USER');

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
    pairUrl: buildPairUrl({ baseUrl: config.remoteBaseUrl, peerId: config.peerId, key: config.key, nonce }),
    logCount: logs.length,
  };
};

const BG_HANDLERS = Object.freeze({
  getConfig: async () => {
    const { peerId, key } = await loadConfig();
    return { peerId, key };
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
  log.info('lifecycle.startup');
  ensureOffscreen();
});
chrome.runtime.onInstalled.addListener((details) => {
  log.info('lifecycle.installed', { reason: details.reason });
  loadConfig().then(ensureOffscreen);
});
chrome.tabs.onActivated.addListener(() => announceNoVideo());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') announceNoVideo();
});

// Any wake-up of the worker re-checks the offscreen document (cheap, idempotent).
ensureOffscreen();
