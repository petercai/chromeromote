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

  const renderQr = (text) => {
    const qr = qrcode(0, 'M'); // type 0 = auto-size
    qr.addData(text);
    qr.make();
    $('qr').innerHTML = qr.createImgTag(6, 0);
  };

  const render = async () => {
    const info = await bg('getStatus');
    const key = statusKey(info.status);
    $('dot').className = `dot ${key}`;
    $('statusText').textContent = STATUS_TEXT[key](info.status || {});
    $('baseUrl').value = info.remoteBaseUrl;
    $('baseWarn').hidden = !info.remoteBaseUrl.includes('YOUR_GITHUB_USER');
    renderQr(info.pairUrl);
  };

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
