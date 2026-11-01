/**
 * YouTube adapter (design 3.13, option A): pure functions only.
 *
 * Turns InnerTube responses (the private API youtube.com's own pages call) into small "cards" the
 * phone renders, and builds the requests for each section. Network and DOM work live elsewhere
 * (background.js runs the requests inside a youtube.com tab), so everything here is unit-tested
 * against the saved responses in tests/fixtures/youtube/. A YouTube redesign should only touch
 * this file. Loaded by the service worker and the phone page: ES2019 syntax only (iOS 12).
 * Exposed as `globalThis.CRYt`.
 */
(function (root) {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  const { YT_SECTION } = root.CR;

  // Sections that only exist for a signed-in account; an anonymous answer means "sign in first".
  const SIGNED_IN_SECTIONS = Object.freeze([YT_SECTION.HOME, YT_SECTION.SUBSCRIPTIONS, YT_SECTION.PLAYLISTS, YT_SECTION.WATCH_LATER]);
  const BROWSE_IDS = Object.freeze({
    [YT_SECTION.HOME]: 'FEwhat_to_watch',
    [YT_SECTION.SUBSCRIPTIONS]: 'FEsubscriptions',
    [YT_SECTION.PLAYLISTS]: 'FEplaylist_aggregation',
    [YT_SECTION.WATCH_LATER]: 'VLWL',
  });
  // A channel's "Videos" tab: its params are base64 protobuf starting with "videos"; tab titles are
  // localized, so the tab is found by params, never by title.
  const CHANNEL_VIDEOS_PARAMS_PREFIX = 'EgZ2aWRlb3';
  const LOCKUP_VIDEO = 'LOCKUP_CONTENT_TYPE_VIDEO';
  const LOCKUP_LISTS = Object.freeze(['LOCKUP_CONTENT_TYPE_PLAYLIST', 'LOCKUP_CONTENT_TYPE_ALBUM', 'LOCKUP_CONTENT_TYPE_PODCAST']);
  const LEGACY_VIDEO_KEYS = Object.freeze(['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer']);
  const LEGACY_LIST_KEYS = Object.freeze(['playlistRenderer', 'gridPlaylistRenderer']);
  const SHORTS_KEYS = Object.freeze(['reelItemRenderer', 'shortsLockupViewModel']); // vertical videos: not for a TV
  const CONTINUATION_KEYS = Object.freeze(['continuationItemRenderer', 'continuationItemViewModel']);
  // Video-bearing parts of a page that are not list entries (end screens, autoplay overlay, channel trailer).
  const NOT_ITEMS = Object.freeze(['endScreenVideoRenderer', 'endScreenPlaylistRenderer', 'playerOverlayAutoplayRenderer', 'channelVideoPlayerRenderer']);
  const DURATION_RE = /^\d{1,2}(:\d{2}){1,2}$/;

  // ---------------------------------------------------------------------------
  // Generic helpers over untyped JSON
  // ---------------------------------------------------------------------------
  const isObj = (v) => v !== null && typeof v === 'object';
  const get = (obj, path) => path.split('.').reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);

  /** Plain text from any InnerTube text shape: "str", {simpleText}, {content}, {runs:[{text}]}. */
  const textOf = (t) => {
    if (t == null) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (typeof t.content === 'string') return t.content;
    return Array.isArray(t.runs) ? t.runs.map((r) => r.text || '').join('') : '';
  };

  /** Depth-first search; `pick(key, value)` returns a result to stop, or undefined to go on. */
  const findFirst = (node, pick) => {
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (!isObj(cur)) continue;
      const entries = Array.isArray(cur) ? cur.map((v, i) => [i, v]) : Object.entries(cur);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [k, v] = entries[i];
        const hit = pick(k, v);
        if (hit !== undefined) return hit;
        stack.push(v);
      }
    }
    return undefined;
  };

  const browseIdOf = (node) => findFirst(node, (k, v) => (k === 'browseEndpoint' && isObj(v) && /^UC/.test(v.browseId || '') ? v.browseId : undefined));
  const percentOf = (node) =>
    findFirst(node, (k, v) => ((k === 'startPercent' || k === 'percentDurationWatched') && typeof v === 'number' ? Math.max(0, Math.min(100, Math.round(v))) : undefined));
  const thumbOf = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  /** Largest image source no wider than 480 px (phone cards are ~136 px wide at 2-3x). */
  const imageOf = (node) => {
    const sources = findFirst(node, (k, v) => (k === 'sources' && Array.isArray(v) && v.length && v[0] && v[0].url ? v : undefined)) ||
      findFirst(node, (k, v) => (k === 'thumbnails' && Array.isArray(v) && v.length && v[0] && v[0].url ? v : undefined)) || [];
    const fit = sources.filter((s) => !s.width || s.width <= 480);
    const best = (fit.length ? fit : sources).reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a), sources[0] || {});
    return best && best.url ? String(best.url).replace(/^\/\//, 'https://') : null;
  };

  // ---------------------------------------------------------------------------
  // Item -> card
  // ---------------------------------------------------------------------------
  const card = (c) => Object.freeze({
    kind: c.kind,
    id: c.id,
    title: c.title,
    channel: c.channel || null,
    channelId: c.channelId || null,
    meta: c.meta || '',
    duration: c.duration || null,
    count: c.count || null,
    thumb: c.thumb || null,
    progress: c.progress == null ? null : c.progress,
  });

  /** Current format (2025+): lockupViewModel for videos and playlists. */
  const fromLockup = (l) => {
    const id = l.contentId;
    const meta = get(l, 'metadata.lockupMetadataViewModel') || {};
    const title = textOf(meta.title);
    if (!id || !title) return null;
    const rows = get(meta, 'metadata.contentMetadataViewModel.metadataRows') || [];
    // Row layout: [channel] then [views, age]; the channel part usually links to the channel (UC…).
    // Without a link (e.g. "Up next"), a first row of several rows is still the channel.
    const rowTexts = rows.map((row) => (row.metadataParts || []).map((p) => ({ text: textOf(p.text), cid: browseIdOf(p) })).filter((p) => p.text));
    const linked = [].concat(...rowTexts).find((p) => p.cid);
    const firstRow = rowTexts.length >= 2 && rowTexts[0].length === 1 ? rowTexts[0][0] : null;
    const channelPart = linked || firstRow;
    const channel = channelPart ? channelPart.text : null;
    // The channel avatar's tap target carries the channel id even when the name row is not a link.
    const channelId = channelPart ? channelPart.cid || browseIdOf(meta.image) || null : null;
    const parts = [].concat(...rowTexts).filter((p) => p !== channelPart).map((p) => p.text);
    const badges = [];
    findFirst(l.contentImage, (k, v) => {
      if (k === 'thumbnailBadgeViewModel' && isObj(v) && v.text) badges.push(String(v.text));
      return undefined;
    });
    const duration = badges.find((b) => DURATION_RE.test(b)) || null;
    if (l.contentType === LOCKUP_VIDEO) {
      return card({ kind: 'video', id, title, channel, channelId, meta: parts.join(' · '), duration, thumb: thumbOf(id), progress: percentOf(l.contentImage) });
    }
    if (LOCKUP_LISTS.indexOf(l.contentType) >= 0) {
      return card({ kind: 'playlist', id, title, channel, channelId, meta: parts.join(' · '), count: badges.find((b) => !DURATION_RE.test(b)) || null, thumb: imageOf(l.contentImage) });
    }
    return null;
  };

  /** Older formats, still seen on some pages. */
  const fromLegacyVideo = (v) => {
    const id = v.videoId;
    const title = textOf(v.title) || textOf(v.headline);
    if (!id || !title) return null;
    const owner = v.ownerText || v.shortBylineText || v.longBylineText;
    const meta = [textOf(v.viewCountText) || textOf(v.shortViewCountText), textOf(v.publishedTimeText)].filter(Boolean).join(' · ') || textOf(v.videoInfo);
    const overlayTime = findFirst(v.thumbnailOverlays, (k, x) => (k === 'thumbnailOverlayTimeStatusRenderer' ? textOf(x.text) : undefined));
    return card({ kind: 'video', id, title, channel: textOf(owner) || null, channelId: browseIdOf(owner), meta, duration: textOf(v.lengthText) || overlayTime || null, thumb: thumbOf(id), progress: percentOf(v.thumbnailOverlays) });
  };

  const fromLegacyList = (p) => {
    const id = p.playlistId;
    const title = textOf(p.title);
    if (!id || !title) return null;
    return card({ kind: 'playlist', id, title, channel: textOf(p.shortBylineText || p.longBylineText) || null, count: textOf(p.videoCountText) || textOf(p.videoCountShortText) || null, thumb: imageOf(p.thumbnail || p.thumbnails) });
  };

  const continuationToken = (v) => get(v, 'continuationEndpoint.continuationCommand.token') || findFirst(v, (k, x) => (k === 'continuationCommand' && isObj(x) && x.token ? x.token : undefined)) || null;

  /**
   * All cards in a browse / next / continuation response, in page order, de-duplicated.
   * stats.unknown counts item-like objects (with a videoId / contentId) that no rule understood:
   * a jump there after a YouTube redesign points straight at this file.
   */
  const parseItems = (json) => {
    const items = [];
    const seen = new Set();
    const stats = { videos: 0, playlists: 0, skipped: 0, unknown: 0 };
    let cursor = null;
    const push = (c) => {
      if (!c) return;
      const key = `${c.kind}:${c.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(c);
      stats[c.kind === 'video' ? 'videos' : 'playlists'] += 1;
    };
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isObj(node)) return;
      Object.keys(node).forEach((k) => {
        const v = node[k];
        if (!isObj(v)) return;
        // A recognised item is not descended into (its nested parts are not items of their own).
        if (k === 'lockupViewModel') {
          const c = fromLockup(v);
          if (c) push(c);
          else stats.unknown += 1; // e.g. a new contentType
          return;
        }
        if (LEGACY_VIDEO_KEYS.indexOf(k) >= 0) return push(fromLegacyVideo(v));
        if (LEGACY_LIST_KEYS.indexOf(k) >= 0) return push(fromLegacyList(v));
        if (NOT_ITEMS.indexOf(k) >= 0) return;
        if (SHORTS_KEYS.indexOf(k) >= 0) {
          stats.skipped += 1;
          return;
        }
        if (CONTINUATION_KEYS.indexOf(k) >= 0) {
          cursor = continuationToken(v) || cursor;
          return;
        }
        if (/(Renderer|ViewModel)$/.test(k) && (typeof v.videoId === 'string' || typeof v.contentId === 'string')) stats.unknown += 1;
        walk(v);
      });
    };
    walk(json);
    return { items, cursor, stats };
  };

  // ---------------------------------------------------------------------------
  // Requests and response facts
  // ---------------------------------------------------------------------------
  /** InnerTube browse body for a section (or the next page of it); null when not applicable. */
  const browseRequest = ({ section, id, cursor }) => {
    if (cursor) return { continuation: cursor };
    if (BROWSE_IDS[section]) return { browseId: BROWSE_IDS[section] };
    if (section === YT_SECTION.PLAYLIST) return { browseId: `VL${id}` };
    if (section === YT_SECTION.CHANNEL) return { browseId: id };
    return null;
  };

  const needsSignIn = (section) => SIGNED_IN_SECTIONS.indexOf(section) >= 0;
  const isLoggedOut = (json) => get(json, 'responseContext.mainAppWebResponseContext.loggedOut') === true;

  /** params of the channel's "Videos" tab, or null (then the channel's home tab is used). */
  const channelVideosParams = (json) => {
    const tabs = get(json, 'contents.twoColumnBrowseResultsRenderer.tabs') || [];
    const tab = tabs.map((t) => t.tabRenderer).find((t) => {
      const params = t && get(t, 'endpoint.browseEndpoint.params');
      return params && decodeURIComponent(params).indexOf(CHANNEL_VIDEOS_PARAMS_PREFIX) === 0;
    });
    return tab ? get(tab, 'endpoint.browseEndpoint.params') : null;
  };

  /** Page title: playlist / channel name (null for feeds). */
  const titleOf = (json) => get(json, 'metadata.playlistMetadataRenderer.title') || get(json, 'metadata.channelMetadataRenderer.title') || null;

  /** "Up next" for the video playing now: the watch page's side list, without the video itself. */
  const upNextItems = (json, videoId) => parseItems(get(json, 'contents.twoColumnWatchNextResults.secondaryResults') || json).items.filter((c) => !(c.kind === 'video' && c.id === videoId));

  const watchUrl = ({ videoId, playlistId }) =>
    `${ORIGIN}/watch?v=${encodeURIComponent(videoId)}${playlistId ? `&list=${encodeURIComponent(playlistId)}` : ''}`;

  /** Video id of a YouTube watch URL (www / m / music / youtu.be), else null. */
  const videoIdOf = (url) => {
    try {
      const u = new URL(url);
      if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
      if (!/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname !== '/watch') return null;
      return u.searchParams.get('v');
    } catch (_) {
      return null;
    }
  };
  const isYoutubeUrl = (url) => /^https:\/\/(www\.|m\.)?youtube\.com\//.test(String(url || ''));
  const isMusicUrl = (url) => /^https:\/\/music\.youtube\.com\//.test(String(url || ''));

  root.CRYt = Object.freeze({
    ORIGIN,
    textOf,
    parseItems,
    browseRequest,
    needsSignIn,
    isLoggedOut,
    channelVideosParams,
    titleOf,
    upNextItems,
    watchUrl,
    videoIdOf,
    isYoutubeUrl,
    isMusicUrl,
    thumbOf,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
