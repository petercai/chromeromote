/**
 * ChromeOS settings-page access (iteration 30, design 3.16; grilling rounds 11–12).
 *
 * No extension API can connect a Bluetooth audio device or pick the system output. The ChromeOS
 * settings app is a web page (chrome://os-settings), and with chrome://flags#extensions-on-chrome-urls
 * turned on an extension may script it. This file holds the pieces to reach that page and, for now,
 * the self-test ("系统控制自检", T222) that proves on the real Chromebook which route works:
 *   1. open chrome://os-settings/<page> without stealing focus;
 *   2. find it as a tab (chrome.tabs) or a DevTools target (chrome.debugger.getTargets);
 *   3. run a read-only probe inside it: chrome.scripting (MAIN world) first, chrome.debugger second;
 *   4. report paired Bluetooth devices / audio outputs and the page's own connect / set-active
 *      functions (never called by the self-test).
 * Loaded by background.js with importScripts; uses its `log` and `sleep`.
 */

const OS_SETTINGS_ORIGIN = 'chrome://os-settings/';
const OS_SETTINGS_PAGES = Object.freeze({ bluetooth: 'bluetoothDevices', audio: 'audio' });
const OS_SETTINGS_LOAD_MS = 3000; // the settings app renders its subpage asynchronously
const PROBE_TEXT_MAX = 6000; // keeps one log entry readable in the popup / export
const DEBUGGER_PROTOCOL = '1.3';

const isSettingsUrl = (url) => String(url || '').indexOf(OS_SETTINGS_ORIGIN) === 0;
const errText = (e) => String((e && e.message) || e);

/**
 * Runs INSIDE the settings page (MAIN world). Must stay self-contained: it is serialized with
 * Function.prototype.toString for chrome.scripting and Runtime.evaluate. Read-only by design.
 */
async function osSettingsPageProbe() {
  const KEY = /config|propert|device|output|paired/i;
  const BT_MODULES = [
    'chrome://resources/ash/common/bluetooth/cros_bluetooth_config.js',
    'chrome://resources/mojo/chromeos/ash/services/bluetooth_config/public/mojom/cros_bluetooth_config.mojom-webui.js',
  ];
  // Every element, including the settings app's nested shadow roots.
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  // mojo String16 arrives as {data: [codes]}; turn it into text so device names are readable.
  const text16 = (v) => (v && Array.isArray(v.data) && v.data.every((c) => typeof c === 'number') ? String.fromCharCode(...v.data) : null);
  const summarize = (v, depth) => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.slice(0, 80);
    if (typeof v === 'function') return '[fn]';
    const t = text16(v);
    if (t !== null) return t;
    if (depth >= 4) return Array.isArray(v) ? `[array ${v.length}]` : '[object]';
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => summarize(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v).slice(0, 15)) {
      try {
        out[k] = summarize(v[k], depth + 1);
      } catch (e) {
        out[k] = `!${e.message}`;
      }
    }
    return out;
  };
  const methodsOf = (obj) => {
    const names = new Set();
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      Object.getOwnPropertyNames(o).forEach((n) => {
        try {
          if (typeof obj[n] === 'function' && n !== 'constructor') names.add(n);
        } catch (_) {
          /* getter threw: skip */
        }
      });
    }
    return [...names].slice(0, 40);
  };
  const propNames = (el) => {
    const names = new Set();
    for (let o = el; o && o !== HTMLElement.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    return [...names].filter((n) => KEY.test(n));
  };

  const out = { url: location.href, elements: all.length, tags: [], props: {}, paired: null, outputs: null, remotes: {} };
  const tags = [...new Set(all.map((e) => e.localName).filter((t) => /bluetooth|audio/.test(t)))];
  out.tags = tags.slice(0, 40);
  for (const tag of tags) {
    const el = all.find((e) => e.localName === tag);
    const entries = [];
    for (const name of propNames(el).slice(0, 20)) {
      let v;
      try {
        v = el[name];
      } catch (e) {
        entries.push([name, `!${e.message}`]);
        continue;
      }
      // The data we are after: paired devices (Bluetooth page) and output devices (Audio page).
      if (v && Array.isArray(v.pairedDevices) && !out.paired) out.paired = summarize(v.pairedDevices, 1);
      if (v && Array.isArray(v.outputDevices) && !out.outputs) out.outputs = summarize(v.outputDevices, 1);
      // A mojo remote kept by the element (e.g. crosAudioConfig_): list its callable methods.
      if (v && typeof v === 'object' && /config/i.test(name)) out.remotes[`${tag}.${name}`] = methodsOf(v);
      entries.push([name, summarize(v, 2)]);
    }
    out.props[tag] = entries;
  }
  out.modules = performance
    .getEntriesByType('resource')
    .map((r) => r.name)
    .filter((n) => /bluetooth|audio/i.test(n))
    .slice(0, 30);
  out.btImport = [];
  for (const url of BT_MODULES) {
    try {
      const m = await import(url);
      const entry = { url, exports: Object.keys(m).slice(0, 20) };
      if (typeof m.getBluetoothConfig === 'function') entry.configMethods = methodsOf(m.getBluetoothConfig());
      out.btImport.push(entry);
    } catch (e) {
      out.btImport.push({ url, error: String(e.message).slice(0, 120) });
    }
  }
  return out;
}

const probeExpression = `(${osSettingsPageProbe.toString()})()`;

/** Run the probe through chrome.scripting in the page's MAIN world. */
const probeViaScripting = async (tabId) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: osSettingsPageProbe });
  return res && res.result;
};

/** Run the probe through the DevTools protocol (works for targets chrome.tabs cannot see). */
const probeViaDebugger = async (debuggee) => {
  await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL);
  try {
    const res = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: probeExpression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate exception');
    return res.result && res.result.value;
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
};

const settingsTabs = async () => (await chrome.tabs.query({})).filter((t) => isSettingsUrl(t.url || t.pendingUrl));
const settingsTargets = async () => (chrome.debugger ? (await chrome.debugger.getTargets()).filter((t) => isSettingsUrl(t.url)) : []);

/** One settings page: open, locate, probe (scripting, then debugger), close what we opened. */
const probeSettingsPage = async (page) => {
  const url = OS_SETTINGS_ORIGIN + OS_SETTINGS_PAGES[page];
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    log.info('sys.probe.step', { page, step: name, ok, detail });
  };
  const before = new Set((await settingsTabs()).map((t) => t.id));

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    step('open', true, { tab_id: tab.id });
  } catch (e) {
    step('open', false, errText(e));
  }
  await sleep(OS_SETTINGS_LOAD_MS);

  const tabs = await settingsTabs();
  step('find_tab', tabs.length > 0, tabs.map((t) => ({ id: t.id, url: t.url || t.pendingUrl, window: t.windowId })));
  const targets = await settingsTargets().catch((e) => (step('find_target', false, errText(e)), []));
  if (targets.length) step('find_target', true, targets.map((t) => ({ id: t.id, type: t.type, url: t.url, tab_id: t.tabId, attached: t.attached })));

  let result = null;
  let via = null;
  for (const t of tabs) {
    if (result) break;
    try {
      result = await probeViaScripting(t.id);
      via = 'scripting';
      step('scripting', true, { tab_id: t.id });
    } catch (e) {
      step('scripting', false, errText(e));
    }
  }
  for (const t of targets) {
    if (result) break;
    try {
      result = await probeViaDebugger({ targetId: t.id });
      via = 'debugger';
      step('debugger', true, { target: t.id });
    } catch (e) {
      step('debugger', false, errText(e));
    }
  }

  // Close only the settings tabs this probe opened; a settings window the user had open stays.
  const opened = (await settingsTabs()).filter((t) => !before.has(t.id)).map((t) => t.id);
  if (opened.length) await chrome.tabs.remove(opened).catch((e) => step('close', false, errText(e)));

  const text = JSON.stringify(result);
  log.info('sys.probe.page_result', { page, via, result: text ? text.slice(0, PROBE_TEXT_MAX) : null, truncated: Boolean(text && text.length > PROBE_TEXT_MAX) });
  return { page, via, steps, result };
};

/** Short verdict per page, for the popup and a one-line log. */
const probeVerdict = ({ page, via, result }) => {
  if (!result) return { page, reachable: false };
  const methods = [].concat(...Object.values(result.remotes || {}), ...(result.btImport || []).map((m) => m.configMethods || []));
  return {
    page,
    reachable: true,
    via,
    paired: Array.isArray(result.paired) ? result.paired.length : null,
    outputs: Array.isArray(result.outputs) ? result.outputs.length : null,
    connect: methods.includes('connect'),
    setActive: methods.some((m) => /setActive/i.test(m)),
  };
};

/** Self-test entry point (popup button "系统控制自检"). Read-only: nothing is connected or switched. */
const osSettingsSelfTest = async () => {
  const started = Date.now();
  const platform = await chrome.runtime.getPlatformInfo();
  log.info('sys.probe.start', { os: platform.os, has_debugger: Boolean(chrome.debugger) });
  if (platform.os !== 'cros') {
    log.warn('sys.probe.not_chromeos', { os: platform.os });
    return { ok: false, os: platform.os, error: '只能在 Chromebook 上自检' };
  }
  const pages = [];
  for (const page of Object.keys(OS_SETTINGS_PAGES)) pages.push(await probeSettingsPage(page)); // one at a time: one settings window
  const verdicts = pages.map(probeVerdict);
  log.info('sys.probe.done', { latency_ms: Date.now() - started, verdicts });
  // Kept for the popup: opening the settings window may close the popup before this call returns.
  await chrome.storage.session.set({ sysSelfTest: { ts: Date.now(), verdicts } });
  return { ok: verdicts.some((v) => v.reachable), os: platform.os, verdicts, pages };
};
