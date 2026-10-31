/**
 * Offscreen document: the WebRTC endpoint.
 *
 * - Registers a stable PeerJS id (from the service worker's config) on the public PeerJS
 *   signaling server; after the handshake the data channel is direct over the LAN.
 * - Authenticates each phone connection with the pairing key (hello -> welcome / denied).
 * - Relays commands to the service worker and replies (with cmd_id) to the phone.
 * - Broadcasts video state pushed by the service worker to all authenticated phones.
 *
 * Offscreen documents only have chrome.runtime, so config and logs go through the worker.
 */
(function () {
  'use strict';

  const { MSG, ERR, makeReply, validateCmd, needsAck, PROTOCOL_VERSION } = CR;

  // Immutable tuning
  const OPEN_TIMEOUT_MS = 30000; // offer received -> data channel open (ICE, possibly via TURN relay)
  const AUTH_TIMEOUT_MS = 5000; // data channel open -> valid hello
  const RETRY_MIN_MS = 2000;
  const RETRY_MAX_MS = 30000;
  // Signaling-level errors that heal by reconnecting (with the persisted token, even 'unavailable-id').
  const RECOVERABLE_PEER_ERRORS = Object.freeze(['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);

  const toBg = (payload) => chrome.runtime.sendMessage({ target: 'bg', ...payload });
  const log = CRLog.createLogger('ext-offscreen', (entry) => toBg({ type: 'log', entry }).catch(() => {}));

  // Mutable runtime state (confined to this document)
  let config = null;
  let peer = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let lastError = null;
  const clients = new Map(); // connectionId -> {conn, authed, clientId}

  const authedClients = () => [...clients.values()].filter((c) => c.authed);

  const reportStatus = (peerState) =>
    toBg({
      type: 'status',
      status: { peer: peerState, clients: authedClients().length, error: lastError, peerId: config && config.peerId },
    }).catch(() => {});

  const safeSend = (conn, payload) => {
    try {
      if (conn.open) conn.send(payload);
    } catch (e) {
      log.warn('conn.send_failed', { client: conn.connectionId, error: String(e) });
    }
  };

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------
  const authenticate = (entry, data) => {
    const { conn } = entry;
    if (data && data.type === MSG.HELLO && data.key === config.key) {
      entry.authed = true;
      entry.clientId = String(data.client_id || conn.peer);
      // name + version let the phone show WHICH Chromebook it controls (multi-device switcher).
      safeSend(conn, { type: MSG.WELCOME, v: PROTOCOL_VERSION, name: config.deviceName, version: globalThis.CR_VERSION });
      log.info('conn.authed', { client_id: entry.clientId, remote_peer: conn.peer });
      reportStatus('online');
      return;
    }
    log.warn('conn.denied', { remote_peer: conn.peer, got_type: data && data.type, key: CRLog.redact(data && data.key) });
    safeSend(conn, { type: MSG.DENIED, error_code: ERR.NOT_PAIRED });
    setTimeout(() => conn.close(), 200);
  };

  const handleCommand = async (entry, data) => {
    const validation = validateCmd(data);
    if (!validation.ok) {
      log.warn('cmd.invalid', { client_id: entry.clientId, cmd_id: data && data.cmd_id, error_code: validation.errorCode });
      safeSend(entry.conn, makeReply({ cmdId: data && data.cmd_id, ok: false, errorCode: validation.errorCode }));
      return;
    }
    const result = await toBg({ type: 'cmd', msg: data, clientId: entry.clientId }).catch((e) => {
      log.error('cmd.bg_unreachable', { cmd_id: data.cmd_id, error: String(e) });
      return { ok: false, errorCode: ERR.INTERNAL };
    });
    if (!needsAck(data.cmd)) return;
    const res = result || { ok: false, errorCode: ERR.INTERNAL };
    safeSend(entry.conn, makeReply({ cmdId: data.cmd_id, ok: res.ok, errorCode: res.errorCode, data: res.data }));
  };

  const onData = (entry, data) => {
    if (!entry.authed) return authenticate(entry, data);
    if (data && data.type === MSG.CMD) return handleCommand(entry, data);
    log.warn('conn.unknown_message', { client_id: entry.clientId, type: data && data.type });
  };

  const onConnection = (conn) => {
    const entry = { conn, authed: false, clientId: null };
    clients.set(conn.connectionId, entry);
    log.info('conn.incoming', { remote_peer: conn.peer, connection_id: conn.connectionId });

    const ice = CRLog.watchIce(conn.peerConnection, log, { remote_peer: conn.peer });

    // Two phases: ICE may need a STUN / TURN-relay path (slow on some networks, e.g. ChromeOS), so the
    // short hello deadline only starts once the data channel is open.
    let timer = setTimeout(() => {
      log.warn('conn.open_timeout', { remote_peer: conn.peer, ice_state: ice.state(), timeout_ms: OPEN_TIMEOUT_MS });
      ice.report('open_timeout').finally(() => conn.close()); // stats first: a closed connection has none
    }, OPEN_TIMEOUT_MS);

    conn.on('open', () => {
      clearTimeout(timer);
      log.info('conn.open', { remote_peer: conn.peer, ice_state: ice.state() });
      timer = setTimeout(() => {
        if (entry.authed) return;
        log.warn('conn.auth_timeout', { remote_peer: conn.peer, timeout_ms: AUTH_TIMEOUT_MS });
        conn.close();
      }, AUTH_TIMEOUT_MS);
    });
    conn.on('data', (data) => onData(entry, data));
    conn.on('close', () => {
      clearTimeout(timer);
      clients.delete(conn.connectionId);
      log.info('conn.closed', { client_id: entry.clientId, remote_peer: conn.peer });
      reportStatus(peer && peer.open ? 'online' : 'connecting');
    });
    conn.on('error', (e) => log.warn('conn.error', { client_id: entry.clientId, error: String(e) }));
  };

  // -------------------------------------------------------------------------
  // Peer lifecycle with exponential backoff
  // -------------------------------------------------------------------------
  // Signaling-server trouble is recovered IN PLACE: peer.reconnect() keeps the same id + token, so the
  // server accepts it even while it still holds the old session. Established phone data channels are
  // peer-to-peer and survive signaling loss, so they are never closed here.
  const closeAllClients = (reason) => {
    if (clients.size > 0) log.info('conn.close_all', { reason, count: clients.size });
    clients.forEach(({ conn }) => conn.close());
    clients.clear();
  };

  const scheduleRecover = (reason) => {
    if (retryTimer) return;
    const action = peer && !peer.destroyed ? 'reconnect' : 'recreate';
    log.warn('peer.recover', { reason, action, retry_ms: retryMs });
    reportStatus('connecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (peer && !peer.destroyed && peer.disconnected) return peer.reconnect();
      if (!peer || peer.destroyed) return createPeer();
      // Peer still connected (transient error already resolved): nothing to do.
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const createPeer = () => {
    if (peer && !peer.destroyed) peer.destroy();
    log.info('peer.creating', { peer_id: config.peerId });
    reportStatus('connecting');
    // Persisted token: the server lets this id be re-registered immediately (see background loadConfig).
    peer = new Peer(config.peerId, { debug: 1, token: config.peerToken, config: { iceServers: CR.ICE_SERVERS } });

    peer.on('open', (id) => {
      retryMs = RETRY_MIN_MS;
      lastError = null;
      log.info('peer.open', { peer_id: id });
      reportStatus('online');
    });
    peer.on('connection', onConnection);
    peer.on('disconnected', () => scheduleRecover('signaling_disconnected'));
    peer.on('close', () => log.warn('peer.closed'));
    peer.on('error', (err) => {
      lastError = `${ERR.PEER_UNAVAILABLE}:${err.type}`;
      if (RECOVERABLE_PEER_ERRORS.includes(err.type)) {
        log.warn('peer.error_recoverable', { type: err.type, error: String(err) });
        scheduleRecover(err.type);
        return;
      }
      log.error('peer.error', { type: err.type, error: String(err) });
      reportStatus('error');
    });
  };

  const loadRemoteConfig = async () => {
    const next = await toBg({ type: 'getConfig' });
    if (!next || !next.peerId || !next.peerToken) throw new Error('config incomplete');
    return next;
  };

  const start = async () => {
    try {
      config = await loadRemoteConfig();
    } catch (e) {
      log.error('config.missing', { error: String(e) });
      setTimeout(start, RETRY_MIN_MS);
      return;
    }
    createPeer();
  };

  // Key regenerated: only phones must re-authenticate. Keep the Peer (same id + token) to avoid churn.
  const reloadConfig = async () => {
    const next = await loadRemoteConfig();
    const identityChanged = next.peerId !== config.peerId || next.peerToken !== config.peerToken;
    config = next;
    closeAllClients('config_reload');
    log.info('config.reload', { identity_changed: identityChanged });
    if (identityChanged) createPeer();
    else reportStatus(peer && peer.open ? 'online' : 'connecting');
  };

  // -------------------------------------------------------------------------
  // Messages from the service worker
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'offscreen') return false;
    if (message.type === 'state') {
      authedClients().forEach(({ conn }) => safeSend(conn, { type: MSG.STATE, state: message.state }));
      return false;
    }
    if (message.type === 'reloadConfig') {
      reloadConfig().catch((e) => log.error('config.reload_failed', { error: String(e) }));
    }
    return false;
  });

  start();
})();
