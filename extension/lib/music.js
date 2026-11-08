/**
 * YouTube Music adapter (design 3.13.14, M1 step 1): selectors + pure functions.
 *
 * content.js reads the raw page data with these selectors and calls musicState() to build the
 * now-playing summary the phone renders. Selectors use class / id only: button labels are localized
 * (zh-CN: "赞", "随机播放"…). Measured on the real music.youtube.com on 2026-11-01; a YouTube Music
 * redesign should only touch this file. Exposed as `globalThis.CRMusic`.
 *
 * Raw page data (plain objects, see content.js readMusicRaw):
 *   {items: [{title, artist, duration, thumb, selected, automix}], barTitle, barByline,
 *    session: {title, artist, album, artwork: [{src, sizes}]} | null, ad, likeStatus, repeatMode,
 *    av: {disabled, videoPressed} | null}   (the "歌曲 / 视频" switch, design 3.15.11; null = not on the page)
 */
(function (root) {
  'use strict';

  const SITE = Object.freeze({
    hostRe: /^music\.youtube\.com$/i,
    queueItem: 'ytmusic-player-queue-item',
    itemTitle: '.song-title',
    itemArtist: '.byline',
    itemDuration: '.duration',
    itemPlay: 'ytmusic-play-button-renderer',
    bar: 'ytmusic-player-bar',
    barTitle: 'ytmusic-player-bar .title',
    barByline: 'ytmusic-player-bar .byline',
    likeRenderer: 'ytmusic-player-bar #like-button-renderer',
    adPlayer: '#movie_player',
    adClass: 'ad-showing',
    // "歌曲 / 视频" switch (measured 2026-11-08). toggle-disabled = it cannot switch now: during an ad,
    // or the track has a single version; aria-pressed on the buttons says which side is on.
    avToggle: 'ytmusic-av-toggle',
    avVideoButton: 'ytmusic-av-toggle .video-button',
    avDisabledAttr: 'toggle-disabled',
    // The expanded player (art / video over the page). Open = attribute player-page-open.
    playerPage: 'ytmusic-player-page',
    playerPageOpenAttr: 'player-page-open',
    playerPageToggle: 'ytmusic-player-bar .toggle-player-page-button',
  });

  // Player-bar buttons per action (the expanded-menu duplicates live outside .right-controls-buttons).
  const CONTROL_SELECTORS = Object.freeze({
    previous: 'ytmusic-player-bar .previous-button button',
    next: 'ytmusic-player-bar .next-button button',
    like: 'ytmusic-player-bar #like-button-renderer .like-button-wrapper button',
    dislike: 'ytmusic-player-bar #like-button-renderer > yt-button-shape button',
    repeat: 'ytmusic-player-bar .right-controls-buttons .repeat button',
    shuffle: 'ytmusic-player-bar .right-controls-buttons .shuffle button',
    avSong: 'ytmusic-av-toggle .song-button',
    avVideo: 'ytmusic-av-toggle .video-button',
  });
  const ACTIONS = Object.freeze(Object.keys(CONTROL_SELECTORS));

  const REPEAT_MODES = Object.freeze(['NONE', 'ALL', 'ONE']);
  const LIKE_STATES = Object.freeze(['LIKE', 'DISLIKE', 'INDIFFERENT']);
  const QUEUE_BEFORE = 2; // songs shown before the current one
  const QUEUE_AFTER = 30; // and after it

  const isMusicHost = (hostname) => SITE.hostRe.test(String(hostname || ''));
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const normalizeRepeat = (v) => (REPEAT_MODES.indexOf(v) >= 0 ? v : 'NONE');
  const normalizeLike = (v) => (LIKE_STATES.indexOf(v) >= 0 ? v : 'INDIFFERENT');

  /** Largest artwork by its "WxH" sizes (YouTube Music offers several); null when none. */
  const pickArt = (artwork) => {
    const area = (a) => String(a.sizes || '').split('x').reduce((p, n) => p * (Number(n) || 0), 1);
    const best = (artwork || []).filter((a) => a && a.src).reduce((b, a) => (!b || area(a) > area(b) ? a : b), null);
    return best ? best.src : null;
  };

  /** The queue around the current song, keeping each song's real page index (for musicQueuePlay). */
  const queueWindow = (items, current, before = QUEUE_BEFORE, after = QUEUE_AFTER) => {
    const from = Math.max(0, (current < 0 ? 0 : current) - before);
    const to = Math.min(items.length, (current < 0 ? 0 : current) + after + 1);
    return items.slice(from, to).map((it, k) =>
      Object.freeze({
        index: from + k,
        title: clean(it.title),
        artist: clean(it.artist),
        duration: clean(it.duration) || null,
        thumb: it.thumb || null,
        current: from + k === current,
        automix: Boolean(it.automix),
      })
    );
  };

  /** The "歌曲 / 视频" switch for the phone: {disabled, mode: 'song' | 'video'}, or null when the page has none. */
  const avState = (av) => (av ? Object.freeze({ disabled: Boolean(av.disabled), mode: av.videoPressed ? 'video' : 'song' }) : null);

  /** Identity of the song playing now (queue position + title), for "once per song" decisions; null when unknown. */
  const songKey = (raw) => {
    if (!raw) return null;
    const items = raw.items || [];
    const current = items.findIndex((it) => it.selected);
    const title = clean(current >= 0 ? items[current].title : raw.barTitle);
    return title ? `${current}|${title}` : null;
  };

  /**
   * Q53 "有视频就总是放视频": switch this song to Video? Only once per song (the phone may switch it back),
   * only when the switch can act (not during an ad, not for a single-version track) and it is on Song.
   */
  const shouldAutoVideo = (raw, handledKey) => {
    const key = songKey(raw);
    const av = avState(raw && raw.av);
    return Boolean(key && key !== handledKey && av && !av.disabled && av.mode === 'song');
  };

  /**
   * Now-playing summary for the phone; null when the page has no music player.
   * The selected queue item names the song even during an ad (the Media Session then describes the ad),
   * so it wins; the Media Session only adds the album and the large artwork outside ads.
   */
  const musicState = (raw) => {
    if (!raw) return null;
    const items = raw.items || [];
    const current = items.findIndex((it) => it.selected);
    const cur = current >= 0 ? items[current] : null;
    const session = raw.ad ? null : raw.session;
    const title = clean(cur && cur.title) || clean(raw.barTitle) || clean(session && session.title);
    if (!title && !items.length) return null;
    return Object.freeze({
      title: title || null,
      artist: clean(cur && cur.artist) || clean(session && session.artist) || null,
      album: clean(session && session.album) || null,
      art: pickArt(session && session.artwork) || (cur && cur.thumb) || null,
      ad: Boolean(raw.ad),
      like: normalizeLike(raw.likeStatus),
      repeat: normalizeRepeat(raw.repeatMode),
      current,
      total: items.length,
      queue: queueWindow(items, current),
      av: avState(raw.av),
    });
  };

  root.CRMusic = Object.freeze({ SITE, CONTROL_SELECTORS, ACTIONS, isMusicHost, pickArt, queueWindow, musicState, normalizeRepeat, normalizeLike, avState, songKey, shouldAutoVideo });
})(typeof globalThis !== 'undefined' ? globalThis : this);
