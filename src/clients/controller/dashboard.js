import QRCode from 'qrcode';

const PHASES = {
  idle: { label: '待机', number: '00', note: '声部已静音，等待研究者开始。' },
  familiarization: { label: '熟悉阶段', number: '01', note: '各自的倾斜与动作强度，控制各自的声部。' },
  division: { label: '分工', number: '02', note: '一人控制音高，一人控制节奏密度。' },
  modulation: { label: '调制', number: '03', note: '各自独立发声，对方的动作强度改变音色。' },
  consensus: { label: '共识', number: '04', note: '动作峰值对齐时，共同层加入，个人声部减弱。' },
  'latency-test': { label: '延迟测量', number: 'T', note: '峰值触发本机与对方的 click，仅供设备测量。' },
};

const ORDERS = [
  ['division', 'modulation', 'consensus'],
  ['division', 'consensus', 'modulation'],
  ['modulation', 'division', 'consensus'],
  ['modulation', 'consensus', 'division'],
  ['consensus', 'division', 'modulation'],
  ['consensus', 'modulation', 'division'],
];

const clamp = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]));
const latency = (value) => Number.isFinite(value) && value >= 0 ? `${(value * 1000).toFixed(1)} ms` : '未提供';

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function playerMarkup(index) {
  const letter = index === 0 ? 'A' : 'B';
  return `<article class="phone-card" data-player="${index}" aria-label="手机 ${letter}">
    <header class="phone-heading">
      <div class="phone-identity"><span class="phone-letter">${letter}</span><div><h3>手机 ${letter}</h3><span class="muted small">声部 ${index}</span></div></div>
      <span class="status-pill is-offline" data-field="status"><i></i>未连接</span>
    </header>
    <div class="phone-empty" data-field="empty"><span class="phone-outline" aria-hidden="true"></span><p>等待手机加入</p><span>扫描“连接手机”中的二维码</span></div>
    <div class="phone-data" data-field="data" hidden>
      <div class="signal-row"><span><i class="legend-dot tilt"></i>倾斜</span><strong data-field="tilt">—</strong></div>
      <svg class="signal-chart" viewBox="0 0 320 46" preserveAspectRatio="none" role="img" aria-label="最近 10 秒的倾斜曲线"><path class="chart-grid" d="M0 1H320M0 23H320M0 45H320"/><path class="chart-line tilt" data-field="tilt-path"/></svg>
      <div class="signal-row"><span><i class="legend-dot intensity"></i>动作强度</span><strong data-field="intensity">—</strong></div>
      <svg class="signal-chart" viewBox="0 0 320 46" preserveAspectRatio="none" role="img" aria-label="最近 10 秒的动作强度曲线"><path class="chart-grid" d="M0 1H320M0 23H320M0 45H320"/><path class="chart-line intensity" data-field="intensity-path"/></svg>
      <div class="peak-line"><span class="peak-indicator" data-field="peak-dot"></span><span>动作峰值</span><span class="muted" data-field="peak-label">尚未检测到</span></div>
      <dl class="device-facts"><div><dt>传感器</dt><dd data-field="sensor">—</dd></div><div><dt>音频</dt><dd data-field="audio">—</dd></div><div><dt>防锁屏</dt><dd data-field="wake">—</dd></div><div><dt>页面</dt><dd data-field="visibility">—</dd></div><div><dt>基础延迟</dt><dd data-field="base">—</dd></div><div><dt>输出延迟</dt><dd data-field="output">—</dd></div></dl>
    </div>
  </article>`;
}

/** The controller is the only surface that exposes experiment rules and state. */
export function mountController({ container, global, players, sync, sendCommand, params }) {
  let globalValues = global.getValues();
  let disposed = false;
  let busy = false;
  let endSyncReady = false;
  let commandMessage = '';
  let commandError = '';
  const histories = [[], []];
  const lastPeaks = [null, null];
  const peakFlashes = [-Infinity, -Infinity];
  const cleanups = [];
  const pendingTimers = new Set();
  let selectedUrl = null;
  let participantUrl = '';
  let qrRequest = 0;

  container.classList.add('controller-root');
  container.innerHTML = `<div class="controller-shell">
    <header class="page-heading"><a class="brand" href="/controller"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Interdependent<br><strong>Instrument</strong></span></a><div class="heading-meta"><span class="eyebrow">双人声音交互 · 研究原型</span><span class="connection-label"><i></i>控制端已连接</span></div></header>
    <div class="overview-heading"><div><span class="eyebrow">RESEARCH CONSOLE</span><h1>一起，听见动作。</h1><p>控制体验进程，观察两部手机的实时响应。</p></div><span class="session-badge" data-ui="session-badge">尚未记录</span></div>
    <div class="workspace-grid">
      <main class="main-column">
        <section class="phase-panel panel" aria-labelledby="phase-panel-title">
          <div class="section-heading"><h2 id="phase-panel-title">体验阶段</h2><span class="muted small">手动切换 · 统一提示音</span></div>
          <div class="phase-hero"><div class="phase-current"><span class="phase-number" data-ui="phase-number">00</span><div><span class="eyebrow">当前阶段</span><h3 data-ui="phase-title">待机</h3></div></div><div class="phase-clock"><span data-ui="timer">00:00</span><small>阶段已进行</small></div></div>
          <p class="phase-description" data-ui="phase-description"></p>
          <div class="phase-buttons" aria-label="切换体验阶段">${['familiarization', 'division', 'modulation', 'consensus'].map((phase, index) => `<button type="button" class="phase-button" data-phase="${phase}" aria-pressed="false"><span>0${index + 1}</span>${PHASES[phase].label}</button>`).join('')}</div>
          <div class="phase-bottom"><button type="button" class="quiet-button" data-phase="idle" aria-pressed="false"><span class="stop-icon" aria-hidden="true"></span>待机 / 静音</button><label class="swap-control"><input type="checkbox" data-ui="swap"><span class="switch-track" aria-hidden="true"></span>交换分工角色</label></div>
          <div class="division-note" data-ui="division-note" hidden></div>
        </section>
        <section class="devices-section" aria-labelledby="devices-title"><div class="section-heading devices-heading"><div class="heading-with-count"><h2 id="devices-title">参与者设备</h2><span data-ui="device-count">0 / 2</span></div><span class="muted small">实时特征 · 最近 10 秒</span></div><div class="phone-grid">${playerMarkup(0)}${playerMarkup(1)}</div></section>
        <section class="joint-panel" aria-label="共识共同层"><div><span class="joint-symbol" aria-hidden="true"><i></i><i></i></span><div><h3>共同层</h3><p data-ui="joint-note">仅在共识阶段，由服务器判断动作峰值对齐。</p></div></div><span class="status-pill is-offline" data-ui="joint-status"><i></i>未激活</span></section>
      </main>
      <aside class="side-column">
        <section class="record-panel panel" aria-labelledby="record-title"><div class="section-heading"><h2 id="record-title">记录一组体验</h2><span class="record-light" data-ui="record-light" aria-hidden="true"></span></div>
          <label class="field-label" for="group-id">组别编号</label><input id="group-id" data-ui="group-id" class="text-input" type="text" maxlength="40" placeholder="例如 G01" autocomplete="off" value="${escapeHtml(globalValues.groupId)}">
          <label class="field-label" for="phase-order">阶段顺序</label><select id="phase-order" class="select-input" data-ui="order">${ORDERS.map((order, i) => `<option value="${i}">${order.map((phase) => PHASES[phase].label).join(' → ')}</option>`).join('')}</select><p class="field-help">熟悉阶段固定在最前；顺序写入日志，阶段由研究者手动切换。</p>
          <button class="primary-button" type="button" data-ui="record-start"><span class="record-icon" aria-hidden="true"></span>开始记录</button>
          <div class="recording-controls" data-ui="recording-controls" hidden><div class="recording-label"><i></i>正在记录 <strong data-ui="record-group"></strong></div><div class="sync-buttons"><button type="button" class="secondary-button" data-ui="start-beep">起始同步音</button><button type="button" class="secondary-button" data-ui="end-beep">结束同步音</button></div><button type="button" class="stop-record-button" data-ui="record-stop" disabled>停止记录</button><p class="field-help" data-ui="stop-help">开始与结束各发一次同步音。发送结束同步音后，即可停止记录。</p></div>
          <div class="recording-footnote"><span class="small-label">录像对齐</span><p>先开启录像，再记录和发送起始同步音。结束同步音应同时出现在录像与日志中。</p></div>
          <div class="log-detail" data-ui="log-detail" hidden><span class="small-label">日志文件</span><code data-ui="log-file"></code></div>
        </section>
        <section class="connect-panel panel" aria-labelledby="connect-title"><div class="section-heading"><h2 id="connect-title">连接手机</h2><span class="link-symbol" aria-hidden="true">↗</span></div><p>两部手机与电脑连接同一 Wi-Fi，用相机扫码打开：</p><div class="qr-code is-empty" data-ui="qr" role="img" aria-label="参与者网址二维码">等待局域网地址</div><div class="link-choices" data-ui="link-choices" aria-label="选择网络接口" hidden></div><a class="participant-url" target="_blank" rel="noopener" data-ui="participant-url" hidden></a><button class="copy-button" type="button" data-ui="copy-url" disabled>复制参与者网址 <span aria-hidden="true">⧉</span></button><p class="field-help" data-ui="address-note"></p></section>
        <section class="setup-note"><span class="small-label">试运行前</span><p data-ui="duration-note"></p><p>双机音频同步、传感器方向、防锁屏与实际延迟仍需在真实手机上验收。</p><button class="text-button" type="button" data-phase="latency-test" aria-pressed="false">进入延迟测量 <span aria-hidden="true">↗</span></button><p class="field-help">本地与经网络路径各测至少 30 次。</p></section>
      </aside>
    </div>
    <div class="command-feedback" data-ui="feedback" role="status" aria-live="polite" hidden></div>
    <footer class="page-footer"><span>动作相同，关系不同。</span><span>soundworks v5 · 研究者界面</span></footer>
  </div>`;

  const ui = (key) => container.querySelector(`[data-ui="${key}"]`);
  const cards = [0, 1].map((index) => {
    const element = container.querySelector(`[data-player="${index}"]`);
    return { element, field: (key) => element.querySelector(`[data-field="${key}"]`) };
  });

  function now() {
    try {
      return sync.getSyncTime();
    } catch {
      return 0;
    }
  }

  function later(callback, delay) {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!disposed) {
        callback();
      }
    }, delay);
    pendingTimers.add(timer);
  }

  function updateFeedback() {
    const message = commandError || globalValues.error || commandMessage;
    ui('feedback').hidden = !message;
    ui('feedback').textContent = message;
    ui('feedback').classList.toggle('is-error', Boolean(commandError || globalValues.error));
  }

  function updateControls() {
    const recording = Boolean(globalValues.recording);
    container.querySelectorAll('button[data-phase]').forEach((button) => {
      button.disabled = busy;
    });
    ui('record-start').disabled = busy || recording;
    ui('record-start').hidden = recording;
    ui('recording-controls').hidden = !recording;
    ui('group-id').disabled = busy || recording;
    ui('order').disabled = busy || recording;
    ui('start-beep').disabled = busy || !recording;
    ui('end-beep').disabled = busy || !recording;
    ui('record-stop').disabled = busy || !recording;
    ui('swap').disabled = busy;
    ui('stop-help').textContent = endSyncReady ? '结束同步音已安排。确认录像保留了这一声后，停止记录。' : '停止记录前，请先发送结束同步音，并确认录像收到了这一声。';
  }

  async function command(action, payload = {}, successMessage = '') {
    if (busy || disposed) {
      return false;
    }
    busy = true;
    commandError = '';
    commandMessage = '';
    updateFeedback();
    updateControls();
    try {
      await sendCommand(action, payload);
      if (disposed) {
        return false;
      }
      commandMessage = successMessage;
      return true;
    } catch (error) {
      commandError = error?.message || '操作未完成，请检查服务器连接后重试。';
      return false;
    } finally {
      busy = false;
      if (!disposed) {
        updateControls();
        updateFeedback();
      }
    }
  }

  function renderGlobal(updates = {}) {
    const wasRecording = Boolean(globalValues.recording);
    globalValues = { ...globalValues, ...global.getValues(), ...updates };
    const phase = PHASES[globalValues.phase] || PHASES.idle;
    ui('phase-number').textContent = phase.number;
    ui('phase-title').textContent = phase.label;
    ui('phase-description').textContent = phase.note;
    container.querySelectorAll('[data-phase]').forEach((button) => {
      const active = button.dataset.phase === globalValues.phase;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ui('swap').checked = Boolean(globalValues.divisionSwap);
    ui('division-note').hidden = globalValues.phase !== 'division';
    ui('division-note').textContent = globalValues.divisionSwap ? '手机 B → 音高　·　手机 A → 节奏密度' : '手机 A → 音高　·　手机 B → 节奏密度';
    const recording = Boolean(globalValues.recording);
    if (wasRecording !== recording) {
      endSyncReady = false;
    }
    if (recording && document.activeElement !== ui('group-id')) {
      ui('group-id').value = globalValues.groupId || '';
    }
    ui('record-group').textContent = globalValues.groupId || '';
    ui('session-badge').textContent = recording ? `${globalValues.groupId || '本组'} · 记录中` : globalValues.logFile ? '记录已结束' : '尚未记录';
    ui('session-badge').classList.toggle('is-recording', recording);
    ui('record-light').classList.toggle('is-recording', recording);
    ui('log-detail').hidden = !globalValues.logFile;
    ui('log-file').textContent = globalValues.logFile || '';
    const jointActive = Boolean(globalValues.jointActive);
    ui('joint-status').className = `status-pill ${jointActive ? 'is-ready' : 'is-offline'}`;
    ui('joint-status').innerHTML = `<i></i>${jointActive ? '已激活' : '未激活'}`;
    container.querySelector('.joint-panel').classList.toggle('is-active', jointActive);
    ui('joint-note').textContent = jointActive ? `共同层已启动 · 个人声部增益 ${Math.round((params.duckGain ?? 0.6) * 100)}%` : globalValues.phase === 'consensus' ? `等待两人动作峰值对齐 · 窗口 ${Math.round((params.alignWindow ?? 0.2) * 1000)} ms` : '仅在共识阶段，由服务器判断动作峰值对齐。';
    if ('participantLinks' in updates) {
      renderLinks();
    }
    updateControls();
    updateFeedback();
    renderClock();
  }

  async function drawQr(url) {
    const request = ++qrRequest;
    const box = ui('qr');
    if (!url) {
      box.classList.add('is-empty');
      box.textContent = '等待局域网地址';
      return;
    }
    try {
      const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#23332f', light: '#ffffff' } });
      if (disposed || request !== qrRequest) {
        return;
      }
      // Markup produced by the QR library from a server-built URL.
      box.innerHTML = svg;
      box.classList.remove('is-empty');
    } catch {
      if (!disposed && request === qrRequest) {
        box.classList.add('is-empty');
        box.textContent = '二维码生成失败，请手动输入网址';
      }
    }
  }

  function renderLinks() {
    const links = Array.isArray(globalValues.participantLinks) ? globalValues.participantLinks : [];
    // A controller opened from a LAN address already uses one that works.
    const link = links.find((entry) => entry.url === selectedUrl)
      ?? links.find((entry) => new URL(entry.url).hostname === window.location.hostname)
      ?? links[0]
      ?? null;
    selectedUrl = link?.url ?? null;
    ui('link-choices').hidden = links.length < 2;
    ui('link-choices').innerHTML = links.map((entry) => `<button type="button" class="link-choice${entry.url === selectedUrl ? ' is-active' : ''}" data-url="${escapeHtml(entry.url)}" aria-pressed="${entry.url === selectedUrl}">${escapeHtml(entry.name)}</button>`).join('');
    ui('participant-url').hidden = !link;
    ui('participant-url').href = link?.url ?? '#';
    ui('participant-url').textContent = link?.url ?? '';
    ui('copy-url').disabled = !link;
    const note = ui('address-note');
    note.classList.toggle('is-warning', link?.trusted === false || !link);
    note.textContent = !link
      ? '未检测到局域网地址。请让电脑连接 Wi-Fi，二维码会自动出现。'
      : link.trusted === false
        ? '证书不包含这个地址，手机会出现证书警告。请按 README 用当前 IP 重新生成 mkcert 证书并重启服务器。'
        : `${link.trusted ? '已信任本机根证书的手机扫码后直接打开。' : '当前为自签名证书，手机首次打开需在证书警告中选择继续。'}请用系统浏览器（微信内选“在浏览器打开”）；连接中断时刷新手机页面重新加入。`;
    if (selectedUrl !== (participantUrl || null)) {
      participantUrl = selectedUrl ?? '';
      drawQr(participantUrl);
    }
  }

  function renderClock() {
    const elapsed = globalValues.phase === 'idle' || !globalValues.phaseStarted ? 0 : now() - globalValues.phaseStarted;
    ui('timer').textContent = formatTime(elapsed);
  }

  function collectPlayers() {
    const result = [null, null];
    for (const entry of players) {
      const state = Array.isArray(entry) ? entry[1] : entry;
      if (!state?.getValues) {
        continue;
      }
      const values = state.getValues();
      if (values.index === 0 || values.index === 1) {
        result[values.index] = values;
      }
    }
    return result;
  }

  function chartPath(history, key, time) {
    return history.map((point, index) => `${index === 0 ? 'M' : 'L'}${Math.min(320, Math.max(0, 320 - (time - point.t) * 32)).toFixed(1)},${(45 - clamp(point[key]) * 44).toFixed(1)}`).join(' ');
  }

  function renderPlayers(sample = false) {
    const time = now();
    const values = collectPlayers();
    ui('device-count').textContent = `${values.filter(Boolean).length} / 2`;
    values.forEach((player, index) => {
      const { element, field } = cards[index];
      element.classList.toggle('is-connected', Boolean(player));
      field('empty').hidden = Boolean(player);
      field('data').hidden = !player;
      if (!player) {
        field('status').className = 'status-pill is-offline';
        field('status').innerHTML = '<i></i>未连接';
        histories[index] = [];
        lastPeaks[index] = null;
        return;
      }
      const stale = Number.isFinite(player.lastSeen) && player.lastSeen > 0 && time - player.lastSeen > 5;
      const ready = player.ready && !stale;
      field('status').className = `status-pill ${ready ? 'is-ready' : 'is-waiting'}`;
      field('status').innerHTML = `<i></i>${stale ? '更新中断' : ready ? '已就绪' : '等待开始'}`;
      if (sample && !stale && player.sensorAvailable) {
        histories[index].push({ t: time, tilt: player.tilt, intensity: player.intensity });
      }
      histories[index] = histories[index].filter((point) => time - point.t <= 10);
      field('tilt').textContent = Number.isFinite(player.tilt) ? player.tilt.toFixed(2) : '—';
      field('intensity').textContent = Number.isFinite(player.intensity) ? player.intensity.toFixed(2) : '—';
      field('tilt-path').setAttribute('d', chartPath(histories[index], 'tilt', time));
      field('intensity-path').setAttribute('d', chartPath(histories[index], 'intensity', time));
      const flashing = performance.now() - peakFlashes[index] < 350;
      field('peak-dot').classList.toggle('is-active', flashing);
      field('peak-label').textContent = lastPeaks[index] === null ? '尚未检测到' : flashing ? '检测到峰值' : `${Math.max(0, time - lastPeaks[index]).toFixed(1)} 秒前`;
      field('sensor').textContent = player.sensorAvailable ? '可用' : '未就绪';
      field('audio').textContent = ({ running: '运行中', suspended: '已暂停', closed: '已关闭', interrupted: '已中断' })[player.audioState] || '未启动';
      field('wake').textContent = player.wakeLock ? '保持唤醒' : '未启用';
      field('visibility').textContent = player.visibility === 'visible' ? '前台' : player.visibility === 'hidden' ? '后台' : '未知';
      field('base').textContent = latency(player.baseLatency);
      field('output').textContent = latency(player.outputLatency);
    });
  }

  container.querySelectorAll('button[data-phase]').forEach((button) => {
    button.addEventListener('click', () => command('phase', { phase: button.dataset.phase }));
  });
  ui('swap').addEventListener('change', async () => {
    const changed = await command('division-swap', { value: ui('swap').checked });
    if (!changed && !disposed) {
      ui('swap').checked = Boolean(globalValues.divisionSwap);
    }
  });
  ui('record-start').addEventListener('click', async () => {
    const groupId = ui('group-id').value.trim();
    if (!groupId) {
      commandError = '请输入本组的组别编号，再开始记录。';
      updateFeedback();
      ui('group-id').focus();
      return;
    }
    await command('record-start', { groupId, order: ['familiarization', ...ORDERS[Number(ui('order').value) || 0]] });
  });
  ui('start-beep').addEventListener('click', () => command('sync-beep', {}, '起始同步音已安排，请确认录像收到了这一声。'));
  ui('end-beep').addEventListener('click', async () => {
    if (await command('sync-beep', {}, '结束同步音已安排。')) {
      endSyncReady = true;
      updateControls();
    }
  });
  ui('record-stop').addEventListener('click', async () => {
    await command('record-stop');
  });
  ui('link-choices').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-url]');
    if (choice) {
      selectedUrl = choice.dataset.url;
      renderLinks();
    }
  });
  ui('copy-url').addEventListener('click', async () => {
    if (!participantUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(participantUrl);
      if (disposed) {
        return;
      }
      ui('copy-url').textContent = '网址已复制 ✓';
      later(() => {
        ui('copy-url').innerHTML = '复制参与者网址 <span aria-hidden="true">⧉</span>';
      }, 2000);
    } catch {
      if (disposed) {
        return;
      }
      commandError = '浏览器未允许复制，请选择上方参与者网址手动复制。';
      updateFeedback();
    }
  });

  ui('duration-note').textContent = params.phaseDuration == null ? '阶段时长尚未确定（附录 4.A 的【X】）。请在试运行后填写参数。' : `阶段时长参数：${params.phaseDuration} 分钟。计时供观察，阶段不会自动切换。`;

  for (const unsubscribe of [
    global.onUpdate((updates) => renderGlobal(updates)),
    players.onAttach(() => renderPlayers()),
    players.onDetach(() => renderPlayers()),
    players.onUpdate((state, updates) => {
      const index = state.get('index');
      if ((index === 0 || index === 1) && Number.isFinite(updates.peak) && updates.peak > 0) {
        lastPeaks[index] = updates.peak;
        peakFlashes[index] = performance.now();
      }
    }),
  ]) {
    if (typeof unsubscribe === 'function') {
      cleanups.push(unsubscribe);
    }
  }

  renderGlobal();
  renderLinks();
  renderPlayers(true);
  const signalInterval = setInterval(() => renderPlayers(true), 100);
  const clockInterval = setInterval(renderClock, 250);

  return {
    destroy() {
      disposed = true;
      clearInterval(signalInterval);
      clearInterval(clockInterval);
      pendingTimers.forEach(clearTimeout);
      cleanups.forEach((cleanup) => cleanup());
      container.replaceChildren();
      container.classList.remove('controller-root');
    },
  };
}
