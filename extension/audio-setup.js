/**
 * One-time audio-output setup page (design 3.15.10). getUserMedia shows Chrome's permission question for
 * THIS extension's origin; once allowed, the offscreen document (same origin) can read output names and
 * route audio with setSinkId. The microphone track is stopped immediately: nothing is ever recorded.
 */
(function () {
  'use strict';

  const CLOSE_AFTER_MS = 4000;
  const toBg = (payload) => chrome.runtime.sendMessage({ target: 'bg', ...payload });
  const log = CRLog.createLogger('ext-audio-setup', (entry) => toBg({ type: 'log', entry }).catch(() => {}));
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');

  const show = (text, kind) => {
    status.textContent = text;
    status.className = kind || '';
  };

  const ask = async () => {
    retry.hidden = true;
    show('正在等待你的选择…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // only the permission is needed, never the audio
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.label);
      log.info('audio.setup', { ok: true, outputs: outputs.length });
      toBg({ type: 'audioSetupDone', ok: true }).catch(() => {});
      show(`已允许 ✓ 找到 ${outputs.length} 个声音输出。回到手机，在播放页点喇叭按钮选择 Nest。这个页面马上自动关闭。`, 'ok');
      setTimeout(() => window.close(), CLOSE_AFTER_MS);
    } catch (e) {
      log.warn('audio.setup', { ok: false, error: String(e && e.name) });
      toBg({ type: 'audioSetupDone', ok: false }).catch(() => {});
      show('没有得到允许。点“再试一次”；如果 Chrome 不再询问，点地址栏左边的图标，把“麦克风”改成“允许”。', 'fail');
      retry.hidden = false;
    }
  };

  retry.addEventListener('click', ask);
  ask();
})();
