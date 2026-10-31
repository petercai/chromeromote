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
  const AUTH_TIMEOUT_MS = 5000;
  const RETRY_MIN_MS = 2000;
  const RETRY_MAX_MS = 30000;
  const FATAL_PEER_ERRORS = Object.freeze(['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed']);

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
      safeSend(conn, { type: MSG.WELCOME, v: PROTOCOL_VERSION });
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

    const authTimer = setTimeout(() => {
      if (entry.authed) return;
      log.warn('conn.auth_timeout', { remote_peer: conn.peer });
      conn.close();
    }, AUTH_TIMEOUT_MS);

    conn.on('data', (data) => onData(entry, data));
    conn.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(conn.connectionId);
      log.info('conn.closed', { client_id: entry.clientId, remote_peer: conn.peer });
      reportStatus(peer && peer.open ? 'online' : 'connecting');
    });
    conn.on('error', (e) => log.warn('conn.error', { client_id: entry.clientId, error: String(e) }));
  };

  // -------------------------------------------------------------------------
  // Peer lifecycle with exponential backoff
  // -------------------------------------------------------------------------
  const scheduleRestart = (reason) => {
    if (retryTimer) return;
    log.warn('peer.restart_scheduled', { reason, retry_ms: retryMs });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      createPeer();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const destroyPeer = () => {
    clients.forEach(({ conn }) => conn.close());
    clients.clear();
    if (peer) {
      peer.destroy();
      peer = null;
    }
  };

  const createPeer = () => {
    destroyPeer();
    reportStatus('connecting');
    log.info('peer.creating', { peer_id: config.peerId });
    peer = new Peer(config.peerId, { debug: 1 });

    peer.on('open', (id) => {
      retryMs = RETRY_MIN_MS;
      lastError = null;
      log.info('peer.open', { peer_id: id });
      reportStatus('online');
    });
    peer.on('connection', onConnection);
    peer.on('disconnected', () => {
      // Lost the signaling server only; existing data channels keep working.
      log.warn('peer.signaling_disconnected');
      if (peer && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', (err) => {
      lastError = `${ERR.PEER_UNAVAILABLE}:${err.type}`;
      log.error('peer.error', { type: err.type, error: String(err) });
      reportStatus('error');
      if (FATAL_PEER_ERRORS.includes(err.type)) scheduleRestart(err.type);
    });
  };

  const start = async () => {
    config = await toBg({ type: 'getConfig' });
    if (!config || !config.peerId) {
      log.error('config.missing');
      setTimeout(start, RETRY_MIN_MS);
      return;
    }
    createPeer();
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
      log.info('config.reload');
      start();
    }
    return false;
  });

  start();
})();
