/**
 * Single source of truth for the app version (extension + phone page + 404 page).
 * Do not edit by hand: run `npm run bump`, which also syncs manifest.json and the
 * `?v=` cache-busting parameters (scripts/bump-version.mjs). Keep the literal format
 * `CR_VERSION = '…'` — the popup and the bump script parse it with a regex.
 */
(function (root) {
  'use strict';
  root.CR_VERSION = '1.0.6';
})(typeof globalThis !== 'undefined' ? globalThis : this);
