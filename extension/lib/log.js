/**
 * Structured JSON-line logger shared by every component.
 *
 * Each entry: {ts, level, component, event, ...fields}. Entries go to the console and to an
 * optional `sink(entry)` (the service worker persists them to a ring buffer in
 * chrome.storage.session so the popup can show / export them). Secrets must never be logged:
 * callers pass `key` fields through `redact` first.
 */
(function (root) {
  'use strict';

  const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

  /** Mask a secret, keeping only a short prefix for correlation. */
  const redact = (secret) => (typeof secret === 'string' && secret.length > 4 ? `${secret.slice(0, 4)}…` : '***');

  const createLogger = (component, sink = null) => {
    const emit = (level, event, fields = {}) => {
      const entry = { ts: new Date().toISOString(), level, component, event, ...fields };
      const line = JSON.stringify(entry);
      const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      out(line);
      if (sink) {
        try {
          sink(entry);
        } catch (_) {
          // Logging must never break the caller.
        }
      }
      return entry;
    };
    return Object.freeze(Object.fromEntries(LEVELS.map((lvl) => [lvl, (event, fields) => emit(lvl, event, fields)])));
  };

  /**
   * Pure: the selected ICE candidate pair from an RTCStatsReport (or any iterable of stats), as
   * {local, remote, protocol, rtt_ms} — local/remote are 'host' | 'srflx' | 'prflx' | 'relay'.
   * null while no pair has succeeded. Tells a LAN path apart from a TURN relay.
   */
  const selectedIcePair = (stats) => {
    const all = [...stats.values()];
    const byId = new Map(all.map((s) => [s.id, s]));
    const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    const pair =
      (transport && byId.get(transport.selectedCandidatePairId)) ||
      all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId) || {};
    const remote = byId.get(pair.remoteCandidateId) || {};
    return {
      local: local.candidateType || null,
      remote: remote.candidateType || null,
      protocol: local.protocol || null,
      rtt_ms: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  };

  /** Pure: what kind of address a candidate carries (mDNS names hide the LAN IP from the other side). */
  const addressKind = (address) => {
    if (!address) return 'hidden';
    if (address.endsWith('.local')) return 'mdns';
    if (address.includes(':')) return 'ipv6';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address)) return 'lan';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'cgnat';
    return 'public';
  };

  const countBy = (items, keyOf) =>
    items.reduce((acc, item) => {
      const k = keyOf(item);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

  /**
   * Pure: where ICE stands, from an RTCStatsReport. Candidates as "<type>/<address kind>" counts
   * (e.g. {"host/mdns":1,"srflx/public":1}), pair states, and STUN check totals:
   * requests_received 0 while requests_sent > 0 => the other side's checks never arrive (firewall/NAT).
   */
  const iceSummary = (stats) => {
    const all = [...stats.values()];
    const ofType = (type) => all.filter((s) => s.type === type);
    const candidateKey = (c) => `${c.candidateType}/${addressKind(c.address || c.ip)}`;
    const pairs = ofType('candidate-pair');
    const sum = (field) => pairs.reduce((n, p) => n + (p[field] || 0), 0);
    return {
      local: countBy(ofType('local-candidate'), candidateKey),
      remote: countBy(ofType('remote-candidate'), candidateKey),
      pairs: countBy(pairs, (p) => p.state),
      requests_sent: sum('requestsSent'),
      requests_received: sum('requestsReceived'),
      responses_received: sum('responsesReceived'),
    };
  };

  /**
   * Observe ICE on a PeerJS data connection's RTCPeerConnection (listeners only, never mutates it):
   * - `ice.gathered`  local candidate counts by type once gathering completes (relay: 0 => no TURN)
   * - `ice.state`     every iceConnectionState change
   * - `ice.selected`  the selected pair when connected / completed
   * - `ice.summary`   candidates + checks snapshot when disconnected / failed, or on report(reason)
   * Returns {state(), report(reason)}: timeout handlers log WHERE the connection stalled (call report
   * BEFORE closing the connection; a closed RTCPeerConnection has no stats).
   */
  const watchIce = (pc, logger, fields = {}) => {
    if (!pc || typeof pc.addEventListener !== 'function') {
      logger.debug('ice.unobservable', fields);
      return Object.freeze({ state: () => 'unknown', report: () => Promise.resolve() });
    }
    const report = (reason) =>
      pc
        .getStats()
        .then((stats) => logger.warn('ice.summary', { ...fields, reason, state: pc.iceConnectionState, ...iceSummary(stats) }))
        .catch((e) => logger.warn('ice.stats_failed', { ...fields, reason, error: String(e) }));
    const gathered = { host: 0, srflx: 0, prflx: 0, relay: 0 };
    const startedAt = Date.now();
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate && e.candidate.type in gathered) gathered[e.candidate.type] += 1;
    });
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') logger.info('ice.gathered', { ...fields, ...gathered, ms: Date.now() - startedAt });
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      const level = state === 'failed' ? 'warn' : 'info';
      logger[level]('ice.state', { ...fields, state, ms: Date.now() - startedAt });
      if (state === 'disconnected' || state === 'failed') return report(`ice_${state}`);
      if (state !== 'connected' && state !== 'completed') return;
      pc.getStats()
        .then((stats) => logger.info('ice.selected', { ...fields, state, pair: selectedIcePair(stats) }))
        .catch((e) => logger.warn('ice.stats_failed', { ...fields, error: String(e) }));
    });
    return Object.freeze({ state: () => pc.iceConnectionState, report });
  };

  root.CRLog = Object.freeze({ createLogger, redact, addressKind, selectedIcePair, iceSummary, watchIce });
})(typeof globalThis !== 'undefined' ? globalThis : this);
