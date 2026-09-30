import QRCode from 'qrcode';

const PHASES = {
  idle: { label: 'Idle', number: '00', note: 'Voices are muted, waiting for the researcher to begin.' },
  familiarization: { label: 'Familiarization', number: '01', note: 'Each player’s tilt and motion intensity control their own voice.' },
  division: { label: 'Division', number: '02', note: 'One player controls pitch, the other controls rhythmic density.' },
  modulation: { label: 'Modulation', number: '03', note: 'Each voice sounds independently; the partner’s motion intensity shapes its timbre.' },
  consensus: { label: 'Consensus', number: '04', note: 'When motion peaks align, the joint layer comes in and the individual voices duck.' },
  'latency-test': { label: 'Latency test', number: 'T', note: 'Each peak triggers a click on the same phone and on the partner’s. For device measurement only.' },
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
const latency = (value) => Number.isFinite(value) && value >= 0 ? `${(value * 1000).toFixed(1)} ms` : 'n/a';

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function playerMarkup(index) {
  const letter = index === 0 ? 'A' : 'B';
  return `<article class="phone-card" data-player="${index}" aria-label="Phone ${letter}">
    <header class="phone-heading">
      <div class="phone-identity"><span class="phone-letter">${letter}</span><div><h3>Phone ${letter}</h3><span class="muted small">Voice ${index}</span></div></div>
      <span class="status-pill is-offline" data-field="status"><i></i>Not connected</span>
    </header>
    <div class="phone-empty" data-field="empty"><span class="phone-outline" aria-hidden="true"></span><p>Waiting for a phone to join</p><span>Scan the QR code under “Connect phones”</span></div>
    <div class="phone-data" data-field="data" hidden>
      <div class="signal-row"><span><i class="legend-dot tilt"></i>Tilt</span><strong data-field="tilt">—</strong></div>
      <svg class="signal-chart" viewBox="0 0 320 46" preserveAspectRatio="none" role="img" aria-label="Tilt over the last 10 seconds"><path class="chart-grid" d="M0 1H320M0 23H320M0 45H320"/><path class="chart-line tilt" data-field="tilt-path"/></svg>
      <div class="signal-row"><span><i class="legend-dot intensity"></i>Motion intensity</span><strong data-field="intensity">—</strong></div>
      <svg class="signal-chart" viewBox="0 0 320 46" preserveAspectRatio="none" role="img" aria-label="Motion intensity over the last 10 seconds"><path class="chart-grid" d="M0 1H320M0 23H320M0 45H320"/><path class="chart-line intensity" data-field="intensity-path"/></svg>
      <div class="peak-line"><span class="peak-indicator" data-field="peak-dot"></span><span>Motion peak</span><span class="muted" data-field="peak-label">None detected yet</span></div>
      <dl class="device-facts"><div><dt>Sensor</dt><dd data-field="sensor">—</dd></div><div><dt>Audio</dt><dd data-field="audio">—</dd></div><div><dt>Wake lock</dt><dd data-field="wake">—</dd></div><div><dt>Page</dt><dd data-field="visibility">—</dd></div><div><dt>Base latency</dt><dd data-field="base">—</dd></div><div><dt>Output latency</dt><dd data-field="output">—</dd></div></dl>
    </div>
  </article>`;
}

/** The controller is the only surface that exposes experiment state; phones show only their current rule. */
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
    <header class="page-heading"><a class="brand" href="/controller"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Interdependent<br><strong>Instrument</strong></span></a><div class="heading-meta"><span class="eyebrow">Two-person sound interaction · Research prototype</span><span class="connection-label"><i></i>Controller connected</span></div></header>
    <div class="overview-heading"><div><span class="eyebrow">RESEARCH CONSOLE</span><h1>Hear movement, together.</h1><p>Run the session and watch both phones respond in real time.</p></div><span class="session-badge" data-ui="session-badge">Not recording</span></div>
    <div class="workspace-grid">
      <main class="main-column">
        <section class="phase-panel panel" aria-labelledby="phase-panel-title">
          <div class="section-heading"><h2 id="phase-panel-title">Phases</h2><span class="muted small">Switched manually · same cue tone for every phase</span></div>
          <div class="phase-hero"><div class="phase-current"><span class="phase-number" data-ui="phase-number">00</span><div><span class="eyebrow">Current phase</span><h3 data-ui="phase-title">Idle</h3></div></div><div class="phase-clock"><span data-ui="timer">00:00</span><small>Time in phase</small></div></div>
          <p class="phase-description" data-ui="phase-description"></p>
          <div class="phase-buttons" aria-label="Switch phase">${['familiarization', 'division', 'modulation', 'consensus'].map((phase, index) => `<button type="button" class="phase-button" data-phase="${phase}" aria-pressed="false"><span>0${index + 1}</span>${PHASES[phase].label}</button>`).join('')}</div>
          <div class="phase-bottom"><button type="button" class="quiet-button" data-phase="idle" aria-pressed="false"><span class="stop-icon" aria-hidden="true"></span>Idle / mute</button><label class="swap-control"><input type="checkbox" data-ui="swap"><span class="switch-track" aria-hidden="true"></span>Swap division roles</label></div>
          <div class="division-note" data-ui="division-note" hidden></div>
        </section>
        <section class="devices-section" aria-labelledby="devices-title"><div class="section-heading devices-heading"><div class="heading-with-count"><h2 id="devices-title">Participant devices</h2><span data-ui="device-count">0 / 2</span></div><span class="muted small">Live features · last 10 seconds</span></div><div class="phone-grid">${playerMarkup(0)}${playerMarkup(1)}</div></section>
        <section class="joint-panel" aria-label="Consensus joint layer"><div><span class="joint-symbol" aria-hidden="true"><i></i><i></i></span><div><h3>Joint layer</h3><p data-ui="joint-note">Consensus phase only: the server detects when motion peaks align.</p></div></div><span class="status-pill is-offline" data-ui="joint-status"><i></i>Inactive</span></section>
      </main>
      <aside class="side-column">
        <section class="record-panel panel" aria-labelledby="record-title"><div class="section-heading"><h2 id="record-title">Record a session</h2><span class="record-light" data-ui="record-light" aria-hidden="true"></span></div>
          <label class="field-label" for="group-id">Group ID</label><input id="group-id" data-ui="group-id" class="text-input" type="text" maxlength="40" placeholder="e.g. G01" autocomplete="off" value="${escapeHtml(globalValues.groupId)}">
          <label class="field-label" for="phase-order">Phase order</label><select id="phase-order" class="select-input" data-ui="order">${ORDERS.map((order, i) => `<option value="${i}">${order.map((phase) => PHASES[phase].label).join(' → ')}</option>`).join('')}</select><p class="field-help">Familiarization always comes first. The order is written to the log; the researcher still switches phases by hand.</p>
          <button class="primary-button" type="button" data-ui="record-start"><span class="record-icon" aria-hidden="true"></span>Start recording</button>
          <div class="recording-controls" data-ui="recording-controls" hidden><div class="recording-label"><i></i>Recording <strong data-ui="record-group"></strong></div><button type="button" class="mark-button" data-ui="mark" title="Note this moment to revisit in the interview (shortcut: M)"><span class="mark-icon" aria-hidden="true"></span>Mark this moment<kbd>M</kbd></button><div class="sync-buttons"><button type="button" class="secondary-button" data-ui="start-beep">Start sync beep</button><button type="button" class="secondary-button" data-ui="end-beep">End sync beep</button></div><button type="button" class="stop-record-button" data-ui="record-stop" disabled>Stop recording</button><p class="field-help" data-ui="stop-help">Send one sync beep at the start and one at the end. Once the end sync beep is sent, you can stop recording.</p></div>
          <div class="recording-footnote"><span class="small-label">Video alignment</span><p>Start the video first, then start recording and send the start sync beep. The end sync beep should appear in both the video and the log.</p></div>
          <div class="log-detail" data-ui="log-detail" hidden><span class="small-label">Log file</span><code data-ui="log-file"></code></div>
        </section>
        <section class="marks-panel panel" aria-labelledby="marks-title"><div class="section-heading"><h2 id="marks-title">Interview marks</h2><span class="muted small" data-ui="mark-count">0 marks</span></div><p class="field-help" data-ui="marks-help">While recording, press “Mark this moment” or the M key to note moments worth revisiting in the interview. Notes can be added later.</p><ol class="mark-list" data-ui="mark-list"></ol><button class="copy-button" type="button" data-ui="copy-marks" disabled>Copy mark list <span aria-hidden="true">⧉</span></button></section>
        <section class="reset-panel" aria-labelledby="reset-title"><span class="small-label" id="reset-title">Next group or recovery</span><p>Disconnects both phones and returns to idle. Each phone then shows “Please scan the QR code again to join” and must rescan. Unavailable while recording.</p><button type="button" class="reset-button" data-ui="reset">Reset system</button></section>
        <section class="connect-panel panel" aria-labelledby="connect-title"><div class="section-heading"><h2 id="connect-title">Connect phones</h2><span class="link-symbol" aria-hidden="true">↗</span></div><p>Connect both phones to the same Wi-Fi as this computer, then scan with the camera to open:</p><div class="qr-code is-empty" data-ui="qr" role="img" aria-label="QR code for the participant URL">Waiting for a local network address</div><div class="link-choices" data-ui="link-choices" aria-label="Choose a network interface" hidden></div><a class="participant-url" target="_blank" rel="noopener" data-ui="participant-url" hidden></a><button class="copy-button" type="button" data-ui="copy-url" disabled>Copy participant URL <span aria-hidden="true">⧉</span></button><p class="field-help" data-ui="address-note"></p></section>
        <section class="setup-note"><span class="small-label">Before piloting</span><p data-ui="duration-note"></p><p>Audio sync between the two phones, sensor orientation, wake lock and actual latency still need to be verified on real phones.</p><button class="text-button" type="button" data-phase="latency-test" aria-pressed="false">Switch to latency test <span aria-hidden="true">↗</span></button><p class="field-help">Measure the local and the network path at least 30 times each.</p></section>
      </aside>
    </div>
    <div class="command-feedback" data-ui="feedback" role="status" aria-live="polite" hidden></div>
    <footer class="page-footer"><span>Same movements, different relationships.</span><span>soundworks v5 · Researcher interface</span></footer>
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
    ui('mark').disabled = !recording;
    ui('reset').disabled = busy || recording;
    ui('mark-list').querySelectorAll('input').forEach((input) => {
      input.disabled = !recording;
    });
    ui('stop-help').textContent = endSyncReady ? 'End sync beep scheduled. Once you’ve confirmed the video caught it, stop recording.' : 'Before you stop recording, send the end sync beep and check that the video caught it.';
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
      commandError = error?.message || 'The action did not complete. Check the server connection and try again.';
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
    ui('division-note').textContent = globalValues.divisionSwap ? 'Phone B → pitch · Phone A → rhythmic density' : 'Phone A → pitch · Phone B → rhythmic density';
    const recording = Boolean(globalValues.recording);
    if (wasRecording !== recording) {
      endSyncReady = false;
    }
    if (recording && document.activeElement !== ui('group-id')) {
      ui('group-id').value = globalValues.groupId || '';
    }
    ui('record-group').textContent = globalValues.groupId || '';
    ui('session-badge').textContent = recording ? `${globalValues.groupId || 'This group'} · Recording` : globalValues.logFile ? 'Recording ended' : 'Not recording';
    ui('session-badge').classList.toggle('is-recording', recording);
    ui('record-light').classList.toggle('is-recording', recording);
    ui('log-detail').hidden = !globalValues.logFile;
    ui('log-file').textContent = globalValues.logFile || '';
    const jointActive = Boolean(globalValues.jointActive);
    ui('joint-status').className = `status-pill ${jointActive ? 'is-ready' : 'is-offline'}`;
    ui('joint-status').innerHTML = `<i></i>${jointActive ? 'Active' : 'Inactive'}`;
    container.querySelector('.joint-panel').classList.toggle('is-active', jointActive);
    ui('joint-note').textContent = jointActive ? `Joint layer on · individual voice gain ${Math.round((params.duckGain ?? 0.6) * 100)}%` : globalValues.phase === 'consensus' ? `Waiting for both players’ motion peaks to align · window ${Math.round((params.alignWindow ?? 0.2) * 1000)} ms` : 'Consensus phase only: the server detects when motion peaks align.';
    if ('participantLinks' in updates) {
      renderLinks();
    }
    renderMarks();
    updateControls();
    updateFeedback();
    renderClock();
  }

  async function drawQr(url) {
    const request = ++qrRequest;
    const box = ui('qr');
    if (!url) {
      box.classList.add('is-empty');
      box.textContent = 'Waiting for a local network address';
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
        box.textContent = 'Could not create the QR code. Enter the URL manually.';
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
      ? 'No local network address found. Connect this computer to Wi-Fi and the QR code will appear automatically.'
      : link.trusted === false
        ? 'The certificate does not cover this address, so phones will show a certificate warning. Regenerate the mkcert certificate for the current IP (see README) and restart the server.'
        : `${link.trusted ? 'Phones that trust this computer’s root certificate open it directly. ' : 'The certificate is self-signed: on first visit, each phone must continue past the certificate warning. '}Use the system browser, not an in-app one (in WeChat, choose “Open in browser”). If the connection drops, reload the page on the phone to rejoin.`;
    if (selectedUrl !== (participantUrl || null)) {
      participantUrl = selectedUrl ?? '';
      drawQr(participantUrl);
    }
  }

  const marks = () => (Array.isArray(globalValues.marks) ? globalValues.marks : []);
  const videoTime = (mark) => mark.sinceBeep === null || mark.sinceBeep === undefined
    ? 'No start sync beep'
    : mark.sinceBeep < 0 ? 'Before start sync beep' : `Video ${formatTime(mark.sinceBeep)}`;
  const phaseTime = (mark) => mark.phaseElapsed === null || mark.phaseElapsed === undefined ? '' : `In phase ${formatTime(mark.phaseElapsed)}`;
  const phaseLabel = (mark) => (PHASES[mark.phase] || PHASES.idle).label;

  // Rows are updated in place so a note being typed is not overwritten.
  function renderMarks() {
    const list = ui('mark-list');
    const entries = marks();
    const keep = new Set(entries.map((mark) => String(mark.n)));
    list.querySelectorAll('[data-mark]').forEach((row) => {
      if (!keep.has(row.dataset.mark)) {
        row.remove();
      }
    });
    entries.forEach((mark) => {
      let row = list.querySelector(`[data-mark="${mark.n}"]`);
      if (!row) {
        row = document.createElement('li');
        row.className = 'mark-row';
        row.dataset.mark = String(mark.n);
        row.innerHTML = `<div class="mark-meta"><strong>M${mark.n}</strong><span data-field="phase"></span><span data-field="video"></span><span class="muted" data-field="phase-time"></span></div><input class="mark-note" type="text" maxlength="200" placeholder="Note, e.g. joint layer appears, both stop" aria-label="Note for mark M${mark.n}">`;
        list.prepend(row);
      }
      row.querySelector('[data-field="phase"]').textContent = phaseLabel(mark);
      row.querySelector('[data-field="video"]').textContent = videoTime(mark);
      row.querySelector('[data-field="phase-time"]').textContent = phaseTime(mark);
      const input = row.querySelector('input');
      if (document.activeElement !== input) {
        input.value = mark.note || '';
      }
      input.disabled = !globalValues.recording;
    });
    ui('mark-count').textContent = `${entries.length} ${entries.length === 1 ? 'mark' : 'marks'}`;
    ui('copy-marks').disabled = entries.length === 0;
  }

  function marksText() {
    const header = `${globalValues.groupId || ''} interview marks (video time counted from the start sync beep)`;
    return [header, ...marks().map((mark) => [`M${mark.n}`, phaseLabel(mark), videoTime(mark), phaseTime(mark), mark.note || ''].filter(Boolean).join('\t'))].join('\n');
  }

  // Marks bypass the busy lock: a click must never be dropped because another command is in flight.
  async function markNow() {
    if (!globalValues.recording || disposed) {
      return;
    }
    const time = now();
    const button = ui('mark');
    button.classList.add('is-flash');
    later(() => button.classList.remove('is-flash'), 350);
    try {
      await sendCommand('mark', { time });
      if (!disposed) {
        commandError = '';
        commandMessage = 'Moment marked. You can add a note under “Interview marks”.';
        updateFeedback();
      }
    } catch (error) {
      if (!disposed) {
        commandError = error?.message || 'The mark was not saved. Please try again.';
        updateFeedback();
      }
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
        field('status').innerHTML = '<i></i>Not connected';
        histories[index] = [];
        lastPeaks[index] = null;
        return;
      }
      const stale = Number.isFinite(player.lastSeen) && player.lastSeen > 0 && time - player.lastSeen > 5;
      const ready = player.ready && !stale;
      field('status').className = `status-pill ${ready ? 'is-ready' : 'is-waiting'}`;
      field('status').innerHTML = `<i></i>${stale ? 'Updates stalled' : ready ? 'Ready' : 'Waiting to start'}`;
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
      field('peak-label').textContent = lastPeaks[index] === null ? 'None detected yet' : flashing ? 'Peak detected' : `${Math.max(0, time - lastPeaks[index]).toFixed(1)} s ago`;
      field('sensor').textContent = player.sensorAvailable ? 'Available' : 'Not ready';
      field('audio').textContent = ({ running: 'Running', suspended: 'Suspended', closed: 'Closed', interrupted: 'Interrupted' })[player.audioState] || 'Not started';
      field('wake').textContent = player.wakeLock ? 'On' : 'Off';
      field('visibility').textContent = player.visibility === 'visible' ? 'Foreground' : player.visibility === 'hidden' ? 'Background' : 'Unknown';
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
      commandError = 'Enter a group ID before you start recording.';
      updateFeedback();
      ui('group-id').focus();
      return;
    }
    await command('record-start', { groupId, order: ['familiarization', ...ORDERS[Number(ui('order').value) || 0]] });
  });
  ui('start-beep').addEventListener('click', () => command('sync-beep', {}, 'Start sync beep scheduled. Check that the video caught it.'));
  ui('end-beep').addEventListener('click', async () => {
    if (await command('sync-beep', {}, 'End sync beep scheduled.')) {
      endSyncReady = true;
      updateControls();
    }
  });
  ui('record-stop').addEventListener('click', async () => {
    await command('record-stop');
  });
  ui('mark').addEventListener('click', () => markNow());
  ui('reset').addEventListener('click', () => {
    if (window.confirm('Reset the system? Both phones will disconnect and must scan the QR code again to rejoin.')) {
      command('reset', {}, 'System reset. Scan the QR code again on each phone to rejoin.');
    }
  });
  const onKeydown = (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    if (!typing && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      markNow();
    }
  };
  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));
  ui('mark-list').addEventListener('change', async (event) => {
    const row = event.target.closest('[data-mark]');
    if (!row || !(event.target instanceof HTMLInputElement)) {
      return;
    }
    try {
      await sendCommand('mark-note', { n: Number(row.dataset.mark), note: event.target.value });
    } catch (error) {
      if (!disposed) {
        commandError = error?.message || 'The note was not saved. Please try again.';
        updateFeedback();
      }
    }
  });
  ui('mark-list').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.target.blur();
    }
  });
  ui('copy-marks').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(marksText());
      if (disposed) {
        return;
      }
      ui('copy-marks').textContent = 'Mark list copied ✓';
      later(() => {
        ui('copy-marks').innerHTML = 'Copy mark list <span aria-hidden="true">⧉</span>';
      }, 2000);
    } catch {
      if (!disposed) {
        commandError = 'The browser blocked copying. Please copy the marks from the list by hand.';
        updateFeedback();
      }
    }
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
      ui('copy-url').textContent = 'URL copied ✓';
      later(() => {
        ui('copy-url').innerHTML = 'Copy participant URL <span aria-hidden="true">⧉</span>';
      }, 2000);
    } catch {
      if (disposed) {
        return;
      }
      commandError = 'The browser blocked copying. Select the participant URL above and copy it manually.';
      updateFeedback();
    }
  });

  ui('duration-note').textContent = params.phaseDuration == null ? 'Phase duration is not set yet ([X] in Appendix B). Fill in the parameter after piloting.' : `Phase duration: ${params.phaseDuration} min. The timer is for observation only; phases never switch automatically.`;

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
