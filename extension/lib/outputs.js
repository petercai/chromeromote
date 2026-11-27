/**
 * Chromebook sound outputs (iteration 30, design 3.16.5, option O-A): pure functions that turn what
 * the ChromeOS settings page knows into the phone's one list, and plan a switch.
 *
 * Inputs (read inside chrome://os-settings by os-settings.js, already JSON-safe):
 *   paired  : Bluetooth page, `pairedDevices`: [{deviceProperties: {id, publicName, connectionState,
 *             audioCapability, deviceType}, nickname?}]
 *   outputs : Audio page, `outputDevices`: [{id, displayName, isActive, deviceType}] (id: string)
 * Enum numbers follow the mojom definitions (CrosBluetoothConfig / CrosAudioConfig); names are accepted
 * too, so a renamed or string-valued enum still maps. To confirm against the self-test log (T236).
 *
 * Loaded as a classic script after lib/protocol.js (service worker importScripts, Node tests); exposed
 * as `globalThis.CROut`.
 */
(function (root) {
  'use strict';

  // CrosBluetoothConfig: DeviceConnectionState / AudioOutputCapability / DeviceType.
  const BT_CONNECTED = Object.freeze([2, 'kConnected', 'connected']);
  const BT_CONNECTING = Object.freeze([1, 'kConnecting', 'connecting']);
  const BT_AUDIO_CAPABLE = Object.freeze([1, 'kCapableOfAudioOutput', 'kSupported']);
  const BT_HEADSET_TYPES = Object.freeze([3, 'kHeadset']);
  // CrosAudioConfig AudioDeviceType (mirrors ash AudioDeviceType order).
  const AUDIO_TYPE_KIND = Object.freeze({ 0: 'other', 2: 'other', 3: 'bluetooth', 5: 'hdmi', 6: 'internal', 12: 'other', kHeadphone: 'other', kUsb: 'other', kBluetooth: 'bluetooth', kHdmi: 'hdmi', kInternalSpeaker: 'internal', kLineout: 'other' });
  const KIND_ORDER = Object.freeze(['hdmi', 'internal', 'other', 'bluetooth']);
  const ID_PREFIX = root.CR.OUTPUT_ID_PREFIX; // shared with the phone (lib/protocol.js, loaded first)

  const norm = (s) => String(s || '').trim().toLowerCase();
  const sameName = (a, b) => Boolean(norm(a) && norm(b)) && (norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a)));

  /** Kind of a settings-page output: the device type first, the name as a fallback. */
  const kindOfOutput = (o) => {
    const byType = AUDIO_TYPE_KIND[o && o.deviceType];
    if (byType) return byType;
    const l = norm(o && o.displayName);
    if (/bluetooth|蓝牙/.test(l)) return 'bluetooth';
    if (/hdmi|displayport|\bdp\b|monitor|tv|电视/.test(l)) return 'hdmi';
    if (/speaker|扬声器|internal|内置/.test(l)) return 'internal';
    return 'other';
  };

  /** A paired Bluetooth device, flattened; null when it cannot play audio (keyboards, mice, phones…). */
  const btDeviceOf = (item) => {
    const p = (item && item.deviceProperties) || {};
    if (!p.id) return null;
    const audio = BT_AUDIO_CAPABLE.includes(p.audioCapability) || BT_HEADSET_TYPES.includes(p.deviceType);
    if (!audio) return null;
    return {
      btId: String(p.id),
      label: String(item.nickname || p.publicName || p.id),
      connected: BT_CONNECTED.includes(p.connectionState),
      connecting: BT_CONNECTING.includes(p.connectionState),
    };
  };

  /**
   * One list for the phone: wired outputs, then every paired Bluetooth audio device (connected or not).
   * A connected Bluetooth device is linked to its audio output by name (audioId), which setActive needs.
   */
  const mergeOutputs = ({ paired = [], outputs = [] } = {}) => {
    const outs = (outputs || []).map((o) => ({ audioId: String(o.id), label: String(o.displayName || o.id), kind: kindOfOutput(o), active: Boolean(o.isActive) }));
    const btOuts = outs.filter((o) => o.kind === 'bluetooth');
    const devices = (paired || []).map(btDeviceOf).filter(Boolean);
    const linked = new Set();
    const btRows = devices.map((d) => {
      // Name match first; a lone connected device takes the lone Bluetooth output.
      const out = btOuts.find((o) => sameName(o.label, d.label)) || (d.connected && btOuts.length === 1 && devices.filter((x) => x.connected).length === 1 ? btOuts[0] : null);
      if (out) linked.add(out.audioId);
      return { id: ID_PREFIX.bt + d.btId, label: d.label, kind: 'bluetooth', connected: d.connected, connecting: d.connecting, active: Boolean(out && out.active && d.connected), btId: d.btId, audioId: out && d.connected ? out.audioId : null };
    });
    // Bluetooth outputs with no paired-device match (renamed device…) still show, as plain outputs.
    const wired = outs
      .filter((o) => o.kind !== 'bluetooth' || !linked.has(o.audioId))
      .map((o) => ({ id: ID_PREFIX.audio + o.audioId, label: o.label, kind: o.kind, connected: true, connecting: false, active: o.active, btId: null, audioId: o.audioId }));
    return [...wired, ...btRows].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  };

  /** What the phone gets (no internal ids). */
  const publicOutputs = (rows) => rows.map(({ id, label, kind, connected, connecting, active }) => ({ id, label, kind, connected, connecting, active }));

  const activeOf = (rows) => rows.find((r) => r.active) || null;

  /** Pushed state: label null while the TV (HDMI) plays, so the phone's pill reads "电视". */
  const audioStateOf = (rows) => {
    const a = activeOf(rows);
    return { label: a && a.kind !== 'hdmi' ? a.label : null, kind: a ? a.kind : null };
  };

  /**
   * Steps to make `id` the output (Q59: other Bluetooth audio devices are disconnected first).
   * Returns {error} | {noop: true} | {steps: [{op: 'disconnect' | 'connect', btId} | {op: 'setActive', id}]}.
   */
  const planSwitch = (rows, id) => {
    const target = rows.find((r) => r.id === id);
    if (!target) return { error: 'unknown_output' };
    if (target.active) return { noop: true, steps: [] };
    if (target.kind !== 'bluetooth' || !target.btId) return { steps: [{ op: 'setActive', id }] };
    const others = rows.filter((r) => r.btId && r.id !== id && (r.connected || r.connecting)).map((r) => ({ op: 'disconnect', btId: r.btId }));
    const connect = target.connected ? [] : [{ op: 'connect', btId: target.btId }];
    return { steps: [...others, ...connect, { op: 'setActive', id }] };
  };

  root.CROut = Object.freeze({ kindOfOutput, btDeviceOf, mergeOutputs, publicOutputs, activeOf, audioStateOf, planSwitch });
})(typeof globalThis !== 'undefined' ? globalThis : this);
