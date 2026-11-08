/**
 * Offscreen audio sink (design 3.15.10): plays the TV page's media audio on a chosen output device.
 *
 * The page's content script captures its <video> (captureStream, no site permission) and offers it over a
 * local WebRTC connection: one runtime message with a complete offer, answered with a complete answer
 * (no trickle ICE). Here each route gets an <audio> element whose output is set with setSinkId.
 * Output names / ids need the EXTENSION's own microphone permission (granted once on audio-setup.html);
 * the microphone itself is never opened here.
 *
 * Messages (runtime, target 'offscreen'):
 *   sinkOffer {routeId, sdp, level} -> {ok, sdp, label} | {ok:false, reason}   (from a content script)
 *   sinkClose {routeId}, sinkVolume {routeId, level}                              (from a content script)
 *   sinkList -> {outputs: [{id, label, kind}], needsSetup}                         (from the worker)
 *   sinkSet {id, label} -> {ok, label} | {ok:false, reason}                        (from the worker; '' = default)
 * Reports to the worker: {target:'bg', type:'audioLost', label} when the chosen device disappears.
 */
(function () {
  'use strict';

  const ICE_GATHER_MAX_MS = 2000;
  const toBg = (payload) => chrome.runtime.sendMessage({ target: 'bg', ...payload });
  const log = CRLog.createLogger('ext-audio', (entry) => toBg({ type: 'log', entry }).catch(() => {}));

  // Mutable state confined to this document
  const routes = new Map(); // routeId -> {pc, audio}
  let sink = { id: '', label: null }; // '' = the system default output

  const waitIceComplete = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, ICE_GATHER_MAX_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      resolve();
    });
  });

  /** All audio outputs except Chrome's aliases; names are empty until the one-time permission exists. */
  const listOutputs = async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const named = devices.filter((d) => d.deviceId && d.label);
    const def = devices.find((d) => d.deviceId === 'default');
    const defaultLabel = def && def.label ? def.label.replace(/^[^-]*-\s*/, '') : null; // "Default - HDMI" -> "HDMI"
    const outputs = [{ id: '', label: defaultLabel, kind: 'default' }].concat(
      named.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label, kind: CR.audioKindOf(d.label) }))
    );
    return { outputs, needsSetup: named.length === 0 };
  };

  const applySink = async (audio) => {
    if (typeof audio.setSinkId !== 'function') return;
    await audio.setSinkId(sink.id);
  };

  const closeRoute = (routeId, reason) => {
    const r = routes.get(routeId);
    if (!r) return;
    routes.delete(routeId);
    try {
      r.pc.close();
    } catch (_) {}
    r.audio.srcObject = null;
    log.info('audio.sink_closed', { route_id: routeId, reason, routes: routes.size });
  };

  const onOffer = async ({ routeId, sdp, level }) => {
    const started = Date.now();
    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.volume = typeof level === 'number' ? Math.min(1, Math.max(0, level)) : 1;
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch((err) => log.warn('audio.sink_play_failed', { route_id: routeId, error: String(err && err.name) }));
    };
    // The page navigated / closed: its end of the connection is gone.
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closeRoute(routeId, pc.connectionState);
    };
    try {
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIceComplete(pc);
      await applySink(audio);
    } catch (e) {
      pc.close();
      log.warn('audio.sink_failed', { route_id: routeId, error: String(e && e.message) });
      return { ok: false, reason: String(e && e.name) };
    }
    routes.set(routeId, { pc, audio });
    log.info('audio.sink_opened', { route_id: routeId, sink: sink.label, routes: routes.size, latency_ms: Date.now() - started });
    return { ok: true, sdp: pc.localDescription.toJSON(), label: sink.label };
  };

  const onSet = async ({ id, label }) => {
    const prev = sink;
    sink = { id: id || '', label: label || null };
    try {
      await Promise.all([...routes.values()].map((r) => applySink(r.audio)));
    } catch (e) {
      sink = prev;
      log.warn('audio.sink_set_failed', { label, error: String(e && e.message) });
      return { ok: false, reason: String(e && e.name) };
    }
    log.info('audio.sink_set', { label: sink.label, default: !sink.id, routes: routes.size });
    return { ok: true, label: sink.label };
  };

  // Nest switched off / out of range: play on the default output instead (the TV element stays muted,
  // so the default output is where the sound must come from) and tell the worker.
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    if (!sink.id) return;
    const { outputs } = await listOutputs();
    if (outputs.some((o) => o.id === sink.id)) return;
    const lost = sink.label;
    await onSet({ id: '', label: null });
    log.warn('audio.sink_lost', { label: lost });
    toBg({ type: 'audioLost', label: lost }).catch(() => {});
  });

  const HANDLERS = Object.freeze({
    sinkOffer: onOffer,
    sinkList: () => listOutputs(),
    sinkSet: onSet,
    sinkClose: ({ routeId }) => {
      closeRoute(routeId, 'page');
      return null;
    },
    sinkVolume: ({ routeId, level }) => {
      const r = routes.get(routeId);
      if (r && typeof level === 'number') r.audio.volume = Math.min(1, Math.max(0, level));
      return null;
    },
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen' || !HANDLERS[message.type]) return false;
    Promise.resolve()
      .then(() => HANDLERS[message.type](message))
      .then((res) => sendResponse(res))
      .catch((e) => {
        log.error('audio.handler_failed', { type: message.type, error: String(e && e.message) });
        sendResponse({ ok: false, reason: 'exception' });
      });
    return true;
  });
})();
