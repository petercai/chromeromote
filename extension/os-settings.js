/**
 * ChromeOS settings-page driver (iteration 30, design 3.16.5, option O-A).
 *
 * No extension API can connect a Bluetooth audio device or pick the system output. The ChromeOS
 * settings app is a web page (chrome://os-settings); with chrome://flags#extensions-on-chrome-urls on
 * and the host permission chrome://os-settings/* (manifest.json), chrome.scripting may run code in its
 * MAIN world. Facts from the self-test logs (1.0.33 / 1.0.34, 2026-11-27):
 *   - chrome.debugger is refused for chrome:// even with the flag; chrome.scripting works;
 *   - the audio page holds both lists: `outputDevices` (settings-audio, ids are BigInt, deviceType
 *     5 = HDMI, 6 = internal speaker) and `pairedDevices` (os-settings-bluetooth-page);
 *   - getBluetoothConfig() from chrome://resources/ash/common/bluetooth/cros_bluetooth_config.js has
 *     connect / disconnect; the audio page's config object has a setActive… method;
 *   - tabs.create is refused while the TV window is fullscreen: open a separate window instead.
 * Loaded by background.js with importScripts; uses its `log`, `sleep`, `ERR` and lib/outputs.js (`CROut`).
 */

// <all_urls> never covers chrome://: manifest.json names chrome://os-settings/* explicitly.
const OS_SETTINGS_ORIGIN = 'chrome://os-settings/';
const OS_SETTINGS_PAGES = Object.freeze({ bluetooth: 'bluetoothDevices', audio: 'audio' });
const SETTINGS_TAB_WAIT_MS = 8000; // the settings app window appears asynchronously
const SETTINGS_POLL_MS = 150;
const OUTPUT_BUDGET_MS = 25000; // one outputsGet / outputSet, opening the page included (phone waits 30 s)
const BT_OUTPUT_WAIT_MS = 12000; // after connect: until ChromeOS lists the device as an audio output
const ACTIVE_CONFIRM_MS = 3000; // after setActive: until the page reports the new active output
const PROBE_TEXT_MAX = 6000; // keeps one self-test log entry readable

const isSettingsUrl = (url) => String(url || '').indexOf(OS_SETTINGS_ORIGIN) === 0;
const errText = (e) => String((e && e.message) || e);
// chrome.scripting refusals that mean "flag off" (or not allowed at all), not a page problem.
const isAccessError = (msg) => /Cannot access|must request permission|chrome:\/\/ URL/i.test(msg);

/** Typed error for the worker: code is a CR.ERR value, step / reason go to the phone and the log. */
const outputError = (code, step, reason) => Object.assign(new Error(`${step}: ${reason}`), { code, step, reason: String(reason) });

/**
 * Runs INSIDE the settings page (MAIN world); serialized with toString, so it must stay
 * self-contained. ops: {action: 'read'} | {action: 'bt', op: 'connect' | 'disconnect', btId} |
 * {action: 'setActive', audioId} | {action: 'probe'}. Always resolves with JSON-safe data.
 */
async function osSettingsPage(op) {
  const WAIT_MS = 6000;
  const POLL_MS = 150;
  const BT_MODULE = 'chrome://resources/ash/common/bluetooth/cros_bluetooth_config.js';
  const KEY = /config|propert|device|output|paired/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const elements = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };
  // mojo String16 = {data: [codes]}; uint64 ids = BigInt (not structured-cloneable): make both plain.
  const text16 = (v) => (v && Array.isArray(v.data) && v.data.every((c) => typeof c === 'number') ? String.fromCharCode(...v.data) : null);
  const safe = (v, depth = 0) => {
    if (typeof v === 'bigint') return String(v);
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.slice(0, 120);
    if (typeof v === 'function') return '[fn]';
    const t = text16(v);
    if (t !== null) return t;
    if (depth >= 5) return Array.isArray(v) ? `[array ${v.length}]` : '[object]';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => safe(x, depth + 1));
    const o = {};
    for (const k of Object.keys(v).slice(0, 20)) {
      try {
        o[k] = safe(v[k], depth + 1);
      } catch (e) {
        o[k] = `!${e.message}`;
      }
    }
    return o;
  };
  const methodsOf = (obj) => {
    const names = new Set();
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) {
        try {
          if (n !== 'constructor' && typeof obj[n] === 'function') names.add(n);
        } catch (_) {
          /* getter threw */
        }
      }
    }
    return [...names];
  };
  const setActiveName = (obj) => {
    const m = methodsOf(obj);
    return m.includes('setActiveDevice') ? 'setActiveDevice' : m.find((n) => /^setActive/i.test(n)) || null;
  };
  const propNames = (el) => {
    const names = new Set();
    for (let o = el; o && o !== HTMLElement.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    return [...names].filter((n) => KEY.test(n));
  };
  // Where the settings app keeps the data we need (found by shape, not by private names).
  const scan = () => {
    const f = { paired: null, outputs: null, audioConfig: null, where: {} };
    for (const el of elements()) {
      if (el.localName.indexOf('-') < 0) continue; // custom elements only
      for (const name of propNames(el)) {
        let v;
        try {
          v = el[name];
        } catch (_) {
          continue;
        }
        if (!v || typeof v !== 'object') continue;
        const at = `${el.localName}.${name}`;
        if (!f.paired && Array.isArray(v.pairedDevices)) [f.paired, f.where.paired] = [v.pairedDevices, at];
        if (!f.outputs && Array.isArray(v.outputDevices)) [f.outputs, f.where.outputs] = [v.outputDevices, at];
        if (!f.audioConfig && /config/i.test(name) && setActiveName(v)) [f.audioConfig, f.where.audioConfig] = [v, at];
      }
    }
    return f;
  };
  const waitFor = async (ready) => {
    const end = Date.now() + WAIT_MS;
    for (;;) {
      const f = scan();
      if (ready(f) || Date.now() > end) return f;
      await sleep(POLL_MS);
    }
  };
  const btConfig = async () => (await import(BT_MODULE)).getBluetoothConfig();

  try {
    if (op.action === 'read') {
      const f = await waitFor((x) => x.paired && x.outputs);
      return { ok: true, paired: safe(f.paired), outputs: safe(f.outputs), where: f.where };
    }
    if (op.action === 'bt') {
      const cfg = await btConfig();
      if (typeof cfg[op.op] !== 'function') return { ok: false, reason: `no_${op.op}` };
      const res = await cfg[op.op](op.btId);
      return { ok: !res || res.success !== false, result: safe(res) };
    }
    if (op.action === 'setActive') {
      const f = await waitFor((x) => x.audioConfig && x.outputs && x.outputs.some((d) => String(d.id) === op.audioId));
      const dev = f.outputs && f.outputs.find((d) => String(d.id) === op.audioId);
      if (!dev) return { ok: false, reason: 'no_device', where: f.where };
      if (!f.audioConfig) return { ok: false, reason: 'no_audio_config', where: f.where };
      const method = setActiveName(f.audioConfig);
      await f.audioConfig[method](dev.id); // the original BigInt id
      return { ok: true, method, where: f.where };
    }
    if (op.action === 'probe') {
      const f = await waitFor((x) => x.paired || x.outputs);
      let btMethods = null;
      try {
        btMethods = methodsOf(await btConfig());
      } catch (e) {
        btMethods = `!${e.message}`;
      }
      return { ok: true, url: location.href, where: f.where, paired: safe(f.paired), outputs: safe(f.outputs), audioMethods: f.audioConfig ? methodsOf(f.audioConfig) : null, btMethods };
    }
    return { ok: false, reason: 'unknown_action' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Session: one settings page opened minimized, used for a whole command, then closed.
// ---------------------------------------------------------------------------
const settingsTabs = async () => (await chrome.tabs.query({})).filter((t) => isSettingsUrl(t.url || t.pendingUrl));

let settingsChain = Promise.resolve();
/** One settings session at a time (two phones, or a tap during a running switch). */
const serialized = (fn) => {
  const run = settingsChain.then(fn, fn);
  settingsChain = run.catch(() => {});
  return run;
};

const withTimeout = (promise, ms, step) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(outputError(ERR.OUTPUT_FAILED, step, `timeout_${ms}ms`)), ms))]);

const waitSettingsTab = async (before) => {
  const end = Date.now() + SETTINGS_TAB_WAIT_MS;
  for (;;) {
    const tabs = await settingsTabs();
    const fresh = tabs.find((t) => !before.has(t.id) && t.status === 'complete');
    if (fresh) return { tab: fresh, reused: false };
    // The user already had Settings open: ChromeOS may navigate that one instead of opening another.
    if (Date.now() > end) return tabs.length ? { tab: tabs[0], reused: true } : null;
    await sleep(SETTINGS_POLL_MS);
  }
};

const openSettings = async (page) => {
  const started = Date.now();
  const before = new Set((await settingsTabs()).map((t) => t.id));
  // A separate unfocused, minimized window: works while the TV window is fullscreen and does not cover it.
  const win = await chrome.windows.create({ url: OS_SETTINGS_ORIGIN + OS_SETTINGS_PAGES[page], focused: false, state: 'minimized' });
  const found = await waitSettingsTab(before);
  if (!found) {
    await chrome.windows.remove(win.id).catch(() => {});
    throw outputError(ERR.NO_SETTINGS_ACCESS, 'open', 'settings_page_not_found');
  }
  const { tab, reused } = found;
  // ChromeOS opens the settings app in its own window: keep that one out of sight too.
  if (tab.windowId !== win.id && !reused) await chrome.windows.update(tab.windowId, { state: 'minimized' }).catch(() => {});
  log.info('output.settings_open', { page, latency_ms: Date.now() - started, same_window: tab.windowId === win.id, reused });
  return { tabId: tab.id, ownWindowId: win.id, reused, page };
};

const closeSettings = async (s) => {
  if (!s.reused) await chrome.tabs.remove(s.tabId).catch(() => {});
  await chrome.windows.remove(s.ownWindowId).catch(() => {});
};

const runSettingsPage = async (s, op) => {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: s.tabId }, world: 'MAIN', func: osSettingsPage, args: [op] });
  } catch (e) {
    const msg = errText(e);
    throw outputError(isAccessError(msg) ? ERR.NO_SETTINGS_ACCESS : ERR.OUTPUT_FAILED, op.action, msg);
  }
  return (res && res.result) || { ok: false, reason: 'no_result' };
};

/** Platform guard + serialized session + overall time budget. */
const withSettings = (page, fn) =>
  serialized(async () => {
    const { os } = await chrome.runtime.getPlatformInfo();
    if (os !== 'cros') throw outputError(ERR.NO_SETTINGS_ACCESS, 'platform', `not_chromeos:${os}`);
    const s = await openSettings(page);
    try {
      return await withTimeout(fn(s), OUTPUT_BUDGET_MS, 'budget');
    } finally {
      await closeSettings(s);
    }
  });

/** Both lists from the audio page, merged into the phone's rows (lib/outputs.js). */
const readRows = async (s) => {
  const r = await runSettingsPage(s, { action: 'read' });
  if (!r.ok) throw outputError(ERR.OUTPUT_FAILED, 'read', r.reason);
  if (!r.outputs) throw outputError(ERR.OUTPUT_FAILED, 'read', 'no_output_list');
  return { rows: CROut.mergeOutputs({ paired: r.paired || [], outputs: r.outputs }), where: r.where, hasPaired: Boolean(r.paired) };
};

/** Re-read until `done(rows)` or the time is up; returns the last rows. */
const pollRows = async (s, done, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const { rows } = await readRows(s);
    if (done(rows) || Date.now() > end) return rows;
    await sleep(500);
  }
};

const summarizeRows = (rows) => rows.map((r) => `${r.kind}:${r.label}${r.active ? '*' : ''}${r.kind === 'bluetooth' ? (r.connected ? '+' : '-') : ''}`);

/** outputsGet: the merged list. */
const osOutputsRead = () =>
  withSettings('audio', async (s) => {
    const { rows, where, hasPaired } = await readRows(s);
    log.info('output.list', { count: rows.length, rows: summarizeRows(rows), where, has_paired: hasPaired });
    return rows;
  });

/** outputSet: disconnect the other Bluetooth audio device, connect, set active, confirm (design 3.16.5). */
const osOutputSwitch = (id) =>
  withSettings('audio', async (s) => {
    const started = Date.now();
    const done = [];
    const { rows } = await readRows(s);
    const plan = CROut.planSwitch(rows, id);
    if (plan.error) throw outputError(ERR.OUTPUT_FAILED, 'plan', plan.error);
    log.info('output.plan', { id, steps: plan.steps.map((x) => x.op), rows: summarizeRows(rows) });
    if (plan.noop) return { rows, steps: done };

    for (const step of plan.steps) {
      const t0 = Date.now();
      if (step.op === 'setActive') {
        // A just-connected device shows up as an output a few seconds later.
        const ready = await pollRows(s, (rs) => Boolean((rs.find((r) => r.id === id) || {}).audioId), BT_OUTPUT_WAIT_MS);
        const target = ready.find((r) => r.id === id);
        if (!target || !target.audioId) throw outputError(ERR.OUTPUT_FAILED, 'wait_output', 'device_not_an_output');
        const r = await runSettingsPage(s, { action: 'setActive', audioId: target.audioId });
        if (!r.ok) throw outputError(ERR.OUTPUT_FAILED, 'setActive', r.reason);
      } else {
        const r = await runSettingsPage(s, { action: 'bt', op: step.op, btId: step.btId });
        // A failed disconnect of the other device must not block the switch; a failed connect does.
        if (!r.ok && step.op === 'connect') throw outputError(ERR.OUTPUT_FAILED, 'connect', r.reason || JSON.stringify(r.result));
        if (!r.ok) log.warn('output.step_failed', { op: step.op, reason: r.reason, result: r.result });
      }
      done.push({ op: step.op, ms: Date.now() - t0 });
    }
    const final = await pollRows(s, (rs) => Boolean((rs.find((r) => r.id === id) || {}).active), ACTIVE_CONFIRM_MS);
    const confirmed = Boolean((final.find((r) => r.id === id) || {}).active);
    log[confirmed ? 'info' : 'warn']('output.set', { id, steps: done, confirmed, latency_ms: Date.now() - started, rows: summarizeRows(final) });
    return { rows: final, steps: done };
  });

// ---------------------------------------------------------------------------
// Self-test ("系统控制自检" in the popup, T222): read-only probe of both settings pages.
// ---------------------------------------------------------------------------
const probeVerdict = (page, r) => ({
  page,
  reachable: Boolean(r && r.ok),
  via: 'scripting',
  paired: r && Array.isArray(r.paired) ? r.paired.length : null,
  outputs: r && Array.isArray(r.outputs) ? r.outputs.length : null,
  connect: Boolean(r && Array.isArray(r.btMethods) && r.btMethods.includes('connect')),
  setActive: Boolean(r && Array.isArray(r.audioMethods) && r.audioMethods.some((m) => /^setActive/i.test(m))),
});

const osSettingsSelfTest = async () => {
  const started = Date.now();
  const verdicts = [];
  for (const page of Object.keys(OS_SETTINGS_PAGES)) {
    try {
      const r = await withSettings(page, (s) => runSettingsPage(s, { action: 'probe' }));
      const text = JSON.stringify(r);
      log.info('sys.probe.page_result', { page, result: text.slice(0, PROBE_TEXT_MAX), truncated: text.length > PROBE_TEXT_MAX });
      verdicts.push(probeVerdict(page, r));
    } catch (e) {
      log.warn('sys.probe.page_failed', { page, code: e.code, step: e.step, reason: e.reason || errText(e) });
      verdicts.push({ page, reachable: false, reason: e.reason || errText(e) });
    }
  }
  log.info('sys.probe.done', { latency_ms: Date.now() - started, verdicts });
  // Kept for the popup: opening the settings window may close the popup before this call returns.
  await chrome.storage.session.set({ sysSelfTest: { ts: Date.now(), verdicts } });
  return { ok: verdicts.some((v) => v.reachable), verdicts };
};
