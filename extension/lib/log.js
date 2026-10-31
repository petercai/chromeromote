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

  /**
   * Observe ICE on a PeerJS data connection's RTCPeerConnection (listeners only, never mutates it):
   * - `ice.gathered`  local candidate counts by type once gathering completes (relay: 0 => TURN unreachable)
   * - `ice.state`     every iceConnectionState change
   * - `ice.selected`  the selected pair when connected / failed
   * Returns a getter for the current state, so timeout logs can say WHERE the connection stalled.
   */
  const watchIce = (pc, logger, fields = {}) => {
    if (!pc || typeof pc.addEventListener !== 'function') {
      logger.debug('ice.unobservable', fields);
      return () => 'unknown';
    }
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
      if (state !== 'connected' && state !== 'completed' && state !== 'failed') return;
      pc.getStats()
        .then((stats) => logger.info('ice.selected', { ...fields, state, pair: selectedIcePair(stats) }))
        .catch((e) => logger.warn('ice.stats_failed', { ...fields, error: String(e) }));
    });
    return () => pc.iceConnectionState;
  };

  root.CRLog = Object.freeze({ createLogger, redact, selectedIcePair, watchIce });
})(typeof globalThis !== 'undefined' ? globalThis : this);
