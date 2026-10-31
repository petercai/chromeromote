/**
 * Episode list ("选集", design 3.11 option C): site adapters + pure parsing over plain data.
 * The DOM reading lives in content.js; everything here is pure so Node tests cover it.
 * Loaded as a classic script (content scripts, Node tests) and exposed as `globalThis.CRPlay`.
 *
 * Item shape (page order):   {label, id, href}
 * Range shape:               {index, label, from, to, active, playing}
 *   active  = the range whose episodes are rendered now
 *   playing = the range holding the current episode (iyf.tv renders one range at a time)
 */
(function (root) {
  'use strict';

  // Site adapters (pure data). iyf.tv selectors measured 2026-10-31 (implementation notes, iteration 18).
  // Ranges: the visible nav lives in `-inner`; a zero-height duplicate nav sits outside it.
  const SITE_ADAPTERS = Object.freeze([
    Object.freeze({
      site: 'iyf.tv',
      hostRe: /(^|\.)iyf\.tv$/i,
      item: 'app-list .n-media-list a.media-button',
      idParam: 'id',
      rangeButton: '.medias-selector-expandable-tabs-inner .medias-selector-expandable-tabs-nav > button',
      title: 'h4.d-inline.h4',
    }),
  ]);

  const adapterFor = (hostname) => SITE_ADAPTERS.find((a) => a.hostRe.test(String(hostname || ''))) || null;

  /** Episode id from a link (relative or absolute); null when missing. */
  const itemId = (href, idParam) => {
    try {
      return new URL(String(href || ''), 'https://host.invalid/').searchParams.get(idParam) || null;
    } catch (_) {
      return null;
    }
  };

  // A numbered episode ("01", "198"); anything else ("一生一瞬旁白版") is a special.
  const isEpisodeLabel = (label) => /^\d+$/.test(String(label || '').trim());

  /**
   * Split page-order items into episodes and specials and locate the current one.
   * Previous / next move between numbered episodes only (Q35); a special sits between the episode
   * before it (`afterIndex`) and the one after, so stepping from a special still works.
   */
  const parsePlaylist = (items, currentId) => {
    const episodes = [];
    const specials = [];
    (items || []).forEach((it) => {
      if (!it || !it.id) return;
      const entry = Object.freeze({ label: String(it.label).trim(), id: it.id, href: it.href || null });
      if (isEpisodeLabel(entry.label)) episodes.push(entry);
      else specials.push(Object.freeze({ ...entry, afterIndex: episodes.length - 1, after: episodes.length ? episodes[episodes.length - 1].label : null }));
    });
    const epIndex = episodes.findIndex((e) => e.id === currentId);
    const special = epIndex < 0 ? specials.find((s) => s.id === currentId) || null : null;
    // Position on the episode axis: integer for an episode, x.5 for a special after episode x.
    const pos = epIndex >= 0 ? epIndex : special ? special.afterIndex + 0.5 : null;
    const at = (i) => (pos === null ? null : episodes[i] || null);
    const current = epIndex >= 0 ? { ...episodes[epIndex], special: false } : special ? { ...special, special: true } : null;
    return Object.freeze({
      episodes: Object.freeze(episodes),
      specials: Object.freeze(specials),
      current: current && Object.freeze(current),
      prev: at(Math.ceil(pos) - 1),
      next: at(Math.floor(pos) + 1),
      isFirst: epIndex === 0,
      isLast: epIndex >= 0 && epIndex === episodes.length - 1,
    });
  };

  const RANGE_RE = /^\s*(\d+)\s*-\s*(\d+)\s*$/;

  /** Raw range buttons [{label, active, playing}] -> ranges with numeric bounds (unparsable kept, bounds null). */
  const buildRanges = (raw) =>
    Object.freeze(
      (raw || []).map((r, index) => {
        const m = RANGE_RE.exec(String(r.label || ''));
        return Object.freeze({
          index,
          label: String(r.label || '').trim(),
          from: m ? Number(m[1]) : null,
          to: m ? Number(m[2]) : null,
          active: Boolean(r.active),
          playing: Boolean(r.playing),
        });
      })
    );

  /** Total numbered episodes: the last range's upper bound, else the rendered count. */
  const totalEpisodes = (p, ranges) => {
    const bounds = (ranges || []).map((r) => r.to).filter((n) => Number.isFinite(n));
    return bounds.length ? Math.max(...bounds) : p.episodes.length;
  };

  /** Index of the range holding the current episode (playing), else the rendered one, else -1. */
  const playingRangeIndex = (ranges) => {
    const list = ranges || [];
    const playing = list.findIndex((r) => r.playing);
    return playing >= 0 ? playing : list.findIndex((r) => r.active);
  };

  /**
   * What previous / next (dir -1 / +1) should do:
   *   {kind: 'episode', target}            neighbour is rendered
   *   {kind: 'range', rangeIndex, pick}    at a range edge: switch range, then take its 'first' / 'last' episode
   *   {kind: 'none'}                       nothing in that direction (or no current episode)
   */
  const stepPlan = (p, ranges, dir) => {
    if (!p.current) return Object.freeze({ kind: 'none' });
    const target = dir < 0 ? p.prev : p.next;
    if (target) return Object.freeze({ kind: 'episode', target });
    const ri = playingRangeIndex(ranges);
    const nextRange = ri + (dir < 0 ? -1 : 1);
    if (ri >= 0 && nextRange >= 0 && nextRange < ranges.length) {
      return Object.freeze({ kind: 'range', rangeIndex: nextRange, pick: dir < 0 ? 'last' : 'first' });
    }
    return Object.freeze({ kind: 'none' });
  };

  /** Small summary pushed with every video state (drives the entry row and the previous / next buttons). */
  const summarize = (p, ranges, title) =>
    Object.freeze({
      title: String(title || '').trim(),
      current: p.current ? p.current.label : null,
      currentSpecial: Boolean(p.current && p.current.special),
      total: totalEpisodes(p, ranges),
      specials: p.specials.length,
      hasPrev: stepPlan(p, ranges, -1).kind !== 'none',
      hasNext: stepPlan(p, ranges, 1).kind !== 'none',
    });

  root.CRPlay = Object.freeze({
    SITE_ADAPTERS,
    adapterFor,
    itemId,
    isEpisodeLabel,
    parsePlaylist,
    buildRanges,
    totalEpisodes,
    playingRangeIndex,
    stepPlan,
    summarize,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
