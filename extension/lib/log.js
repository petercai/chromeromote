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

  root.CRLog = Object.freeze({ createLogger, redact });
})(typeof globalThis !== 'undefined' ? globalThis : this);
