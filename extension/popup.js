/**
 * Popup controller: renders status + pairing QR and exposes config / log actions.
 * All state lives in the service worker; the popup is a thin view over `target:'bg'` calls.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const bg = (type, extra = {}) => chrome.runtime.sendMessage({ target: 'bg', type, ...extra });

  const STATUS_TEXT = Object.freeze({
    connected: (s) => `已连接 ${s.clients} 台手机`,
    online: () => '等待手机连接',
    connecting: () => '正在连接信令服务器…',
    error: (s) => `错误:${s.error || '未知'}`,
  });

  const statusKey = (s) => {
    if (!s) return 'connecting';
    if (s.peer === 'online' && s.clients > 0) return 'connected';
    return s.peer || 'connecting';
  };

  // QR rendering tuned for a phone camera reading a TV screen:
  // - level 'L' keeps modules large (the URL is long), 4-module quiet zone per the QR spec,
  // - integer cell size chosen to fit ~300px so no fractional CSS scaling blurs the modules.
  const QR_TARGET_PX = 300;
  const QR_QUIET_MODULES = 4;
  const PLACEHOLDER_MARK = 'YOUR_GITHUB_USER';

  const renderQr = (text) => {
    const qr = qrcode(0, 'L'); // type 0 = auto-size
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount() + QR_QUIET_MODULES * 2;
    const cell = Math.max(2, Math.floor(QR_TARGET_PX / modules));
    const el = $('qr');
    el.className = '';
    el.innerHTML = qr.createImgTag(cell, cell * QR_QUIET_MODULES);
    return { modules: qr.getModuleCount(), cell };
  };

  const renderNoQr = (reason) => {
    const el = $('qr');
    el.className = 'empty';
    el.textContent = reason;
  };

  /**
   * Pure decision: may we show a QR code for this address, and what should the user be told?
   * A QR is shown ONLY when the address provably serves this app (page 200 + version.js readable);
   * otherwise the phone would land on a 404 (GitHub's generic one for a wrong repo path / case).
   */
  const assessRemote = ({ remoteBaseUrl, remoteCheck: c }) => {
    if (remoteBaseUrl.includes(PLACEHOLDER_MARK)) {
      return { showQr: false, qrReason: '还没有设置遥控网页地址,二维码暂不显示', warn: null };
    }
    if (!c) return { showQr: false, qrReason: '正在检查遥控网页地址…', warn: null };
    if (!c.isApp) {
      const why = !c.ok
        ? `这个地址打不开(${c.status ? 'HTTP ' + c.status : c.error || '网络错误'})`
        : '这个地址能打开,但不是遥控网页(读不到 extension/lib/version.js)';
      return {
        showQr: false,
        qrReason: '地址不对,二维码暂不显示',
        warn: `${why},扫码后手机会显示 404。请检查:① 地址里的仓库名拼写和大小写(GitHub 区分大小写);② 代码已推送,Settings → Pages 已开启(main / root);③ 刚推送要等几分钟。`,
        suggestedUrl: c.suggestedUrl,
      };
    }
    const order = CR.compareVersions(c.remoteVersion, c.localVersion);
    if (order > 0) {
      return { showQr: true, warn: `Chromebook 上的扩展是旧版本(${c.localVersion}),线上已经是 ${c.remoteVersion}。请更新扩展文件夹并在 chrome://extensions 点"重新加载"(见 README)。` };
    }
    if (order < 0) {
      return { showQr: true, warn: `线上遥控网页还是旧版本(${c.remoteVersion}),扩展是 ${c.localVersion}。请推送代码,等几分钟后点"重新检查"。` };
    }
    return { showQr: true, warn: null };
  };

  const renderAssessment = (info, verdict) => {
    const c = info.remoteCheck;
    $('versions').textContent = `线上网页版本 ${c && c.remoteVersion ? c.remoteVersion : '—'}`;
    $('remoteWarn').hidden = !verdict.warn;
    $('remoteWarnText').textContent = verdict.warn || '';
    $('suggest').hidden = !verdict.suggestedUrl;
    $('suggest').textContent = verdict.suggestedUrl ? `改用 ${verdict.suggestedUrl}` : '';
    $('suggest').dataset.url = verdict.suggestedUrl || '';
  };

  // Fresh "?t=" value every 20 s, even while the popup stays open: each scan yields a different URL,
  // so Chrome (which reuses one tab for links from Lens / the Google app) always does a real reload
  // instead of a same-document hash jump onto a stale tab.
  const NONCE_ROTATE_MS = 20000;
  const newNonce = () => Date.now().toString(36);
  let nonce = newNonce();
  setInterval(() => {
    nonce = newNonce();
  }, NONCE_ROTATE_MS);

  let lastQrKey = '';

  const render = async () => {
    const info = await bg('getStatus', { nonce });
    $('extVersion').textContent = `v${info.version}`;
    const key = statusKey(info.status);
    $('dot').className = `dot ${key}`;
    $('statusText').textContent = STATUS_TEXT[key](info.status || {});
    if (document.activeElement !== $('baseUrl')) $('baseUrl').value = info.remoteBaseUrl;
    const placeholder = info.remoteBaseUrl.includes(PLACEHOLDER_MARK);
    $('baseWarn').hidden = !placeholder;
    const verdict = assessRemote(info);
    renderAssessment(info, verdict);
    $('copyUrl').disabled = !verdict.showQr;
    $('pairUrl').textContent = verdict.showQr ? info.pairUrl : '(地址检查通过后才会显示)';
    // Re-render the QR only when its content or visibility changes (status refreshes every 2 s).
    const qrKey = verdict.showQr ? info.pairUrl : `none:${verdict.qrReason}`;
    if (qrKey === lastQrKey) return;
    lastQrKey = qrKey;
    if (!verdict.showQr) return renderNoQr(verdict.qrReason);
    renderQr(info.pairUrl);
  };

  $('recheck').addEventListener('click', async () => {
    $('recheck').textContent = '检查中…';
    await bg('recheckRemote');
    await render();
    $('recheck').textContent = '重新检查';
  });

  $('suggest').addEventListener('click', async () => {
    const url = $('suggest').dataset.url;
    if (!url) return;
    await bg('setBaseUrl', { remoteBaseUrl: url });
    await render();
  });

  $('copyUrl').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('pairUrl').textContent);
    $('copyUrl').textContent = '已复制';
    setTimeout(() => {
      $('copyUrl').textContent = '复制配对链接';
    }, 1500);
  });

  const showLogs = async () => {
    const logs = await bg('getLogs');
    const pre = $('logs');
    pre.hidden = false;
    pre.textContent = logs.slice(-50).reverse().map((e) => JSON.stringify(e)).join('\n') || '(空)';
  };

  const exportLogs = async () => {
    const logs = await bg('getLogs');
    const blob = new Blob([logs.map((e) => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chrome-remote-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    a.click();
  };

  $('saveUrl').addEventListener('click', async () => {
    const res = await bg('setBaseUrl', { remoteBaseUrl: $('baseUrl').value });
    if (!res.ok) alert(res.error);
    render();
  });
  $('regen').addEventListener('click', async () => {
    if (!confirm('重新生成密钥后,已配对的手机需要重新扫码。继续吗?')) return;
    await bg('regenerateKey');
    render();
  });
  $('showLogs').addEventListener('click', showLogs);
  $('exportLogs').addEventListener('click', exportLogs);
  $('clearLogs').addEventListener('click', async () => {
    await bg('clearLogs');
    showLogs();
  });

  render();
  setInterval(render, 2000);
})();
