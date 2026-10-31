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

  const renderNoQr = () => {
    const el = $('qr');
    el.className = 'empty';
    el.textContent = '还没有设置遥控网页地址,二维码暂不显示';
  };

  // Human-readable reason for an unreachable remote page (most often: Pages not deployed yet).
  const remoteWarnText = (check) =>
    check.status === 404
      ? '遥控网页地址打不开(HTTP 404),扫码后手机也会显示 404。请确认:① 代码已推送到 GitHub;② 仓库 Settings → Pages 已开启(分支 main,目录 / root);③ 地址里的用户名和仓库名拼写正确。刚推送时要等几分钟。'
      : `遥控网页地址打不开(${check.status ? 'HTTP ' + check.status : check.error || '网络错误'})。请检查网络或地址拼写。`;

  const versionMismatchText = (check) =>
    `线上遥控网页的版本是 ${check.remoteVersion || '未知(旧版本没有版本号)'},扩展的版本是 ${check.localVersion}。GitHub Pages 还没有更新到最新代码:请推送代码,等几分钟后点"重新检查"。`;

  const renderRemoteCheck = (check) => {
    const unreachable = Boolean(check && !check.ok);
    const mismatch = Boolean(check && check.ok && check.remoteVersion !== check.localVersion);
    $('remoteWarn').hidden = !(unreachable || mismatch);
    if (unreachable) $('remoteWarnText').textContent = remoteWarnText(check);
    else if (mismatch) $('remoteWarnText').textContent = versionMismatchText(check);
    if (check) $('versions').textContent = `扩展版本 ${check.localVersion} · 线上网页版本 ${check.remoteVersion || '—'}`;
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

  let lastPairUrl = '';

  const render = async () => {
    const info = await bg('getStatus', { nonce });
    if (!info.remoteCheck) $('versions').textContent = `扩展版本 ${info.version}`;
    const key = statusKey(info.status);
    $('dot').className = `dot ${key}`;
    $('statusText').textContent = STATUS_TEXT[key](info.status || {});
    if (document.activeElement !== $('baseUrl')) $('baseUrl').value = info.remoteBaseUrl;
    const placeholder = info.remoteBaseUrl.includes(PLACEHOLDER_MARK);
    $('baseWarn').hidden = !placeholder;
    $('copyUrl').disabled = placeholder;
    $('pairUrl').textContent = placeholder ? '(未设置)' : info.pairUrl;
    renderRemoteCheck(info.remoteCheck);
    // Re-render only when the link changes (the popup refreshes status every 2 s).
    if (info.pairUrl === lastPairUrl) return;
    lastPairUrl = info.pairUrl;
    if (placeholder) return renderNoQr();
    renderQr(info.pairUrl);
  };

  $('recheck').addEventListener('click', async () => {
    $('recheck').textContent = '检查中…';
    renderRemoteCheck(await bg('recheckRemote'));
    $('recheck').textContent = '重新检查';
  });

  $('copyUrl').addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastPairUrl);
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
