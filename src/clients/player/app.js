import { Client } from '@soundworks/core/client.js';
import { loadConfig } from '@soundworks/helpers/browser.js';
import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginSync from '@soundworks/plugin-sync/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import devicemotion from '@ircam/devicemotion';
import params from '../../shared/params.js';
import { introduction } from '../../shared/instructions.js';
import { playerRules } from '../../shared/rules.js';
import { createFeatureExtractor } from '../../shared/features.js';
import AudioEngine from './AudioEngine.js';

document.documentElement.lang = 'en';
document.body.className = 'player';
document.title = 'Welcome';
const guide = document.createElement('main');
guide.className = 'introduction';
introduction.forEach((text, index) => {
  const element = document.createElement(index === 0 ? 'h1' : 'p');
  element.textContent = text;
  guide.append(element);
});
const button = document.createElement('button');
button.textContent = 'Start';
button.disabled = true;
guide.append(button);
document.body.append(guide);

// Line icons for what a gesture changes; stroke follows the dim guide color.
const EFFECT_ICONS = {
  pitch: '<path d="M8 38h32M8 28h32M8 18h32"/><circle cx="13" cy="38" r="3.5"/><circle cx="24" cy="28" r="3.5"/><circle cx="35" cy="18" r="3.5"/><path d="M16.5 38V24M27.5 28V14M38.5 18V4"/>',
  rhythm: '<path d="M4 16v16M13 16v16M20 16v16M26 16v16M31 16v16M35 16v16M39 16v16M42 16v16M45 16v16"/>',
  brightness: '<circle cx="24" cy="24" r="8"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6M10 10l4 4M34 34l4 4M38 10l-4 4M14 34l-4 4"/>',
  joint: '<path d="M14 34c0-12 2-22 10-22s10 10 10 22zM10 34h28M21 38a3 3 0 0 0 6 0M24 8v4"/><path d="M4 18c2 4 2 8 0 12M44 18c-2 4-2 8 0 12"/>',
};
const ACTOR_LABELS = { you: 'You', partner: 'Partner', both: 'Together' };

// Performing-screen guide: the current phase's rule for this player, redrawn
// on each phase change (see shared/rules.js).
function createRuleGuide(index) {
  const element = document.createElement('div');
  element.className = 'rule-guide';
  const update = (phase, divisionSwap) => {
    const rules = playerRules(phase, index, divisionSwap);
    element.dataset.phase = phase;
    if (!rules) {
      element.innerHTML = '<p class="rule-wait">Please wait for the next part.</p>';
      return;
    }
    const rows = rules.rows.map(({ actor, gesture, effect, text }) => {
      const phones = actor === 'both' ? 2 : 1;
      return `<li class="rule rule-${gesture} rule-actor-${actor}">
        <div class="rule-figure">
          <div class="gesture-stage">${'<span class="gesture-phone"></span>'.repeat(phones)}</div>
          <span class="rule-actor">${ACTOR_LABELS[actor]} · ${gesture}</span>
        </div>
        <span class="rule-arrow" aria-hidden="true"></span>
        <svg class="rule-effect rule-effect-${effect}" viewBox="0 0 48 48" aria-hidden="true">${EFFECT_ICONS[effect]}</svg>
        <p class="rule-text">${text}</p>
      </li>`;
    }).join('');
    element.innerHTML = `<header><h2>${rules.title}</h2><p>${rules.summary}</p></header><ul class="rules">${rows}</ul>`;
  };
  return { element, update };
}

const client = new Client(loadConfig());
// iOS Safari silences Web Audio in silent mode unless the session is 'playback'.
if (navigator.audioSession) {
  navigator.audioSession.type = 'playback';
}
const audioContext = new AudioContext({ latencyHint: 'interactive' });
client.pluginManager.register('platform-init', ClientPluginPlatformInit, { audioContext, devicemotion });
client.pluginManager.register('sync', ClientPluginSync, {
  getTimeFunction: () => audioContext.currentTime,
}, ['platform-init']);
client.pluginManager.register('checkin', ClientPluginCheckin);

let platform;
let clicked = false;
let connected = true;
let engine;
let player;
let sync;
let wakeLock;
let latestSensorAt = -Infinity;
let heartbeat;
let removeMotion;
let sensorRunning = false;
const featureExtractor = createFeatureExtractor();

// Custom initialization UI: no default soundworks stage/status screens reach participants.
client.pluginManager.onStateChange(plugins => {
  platform = plugins['platform-init'];
  if (!clicked && platform?.state.check && plugins.checkin?.status === 'started') {
    button.disabled = false;
  }
});

button.addEventListener('click', event => {
  if (!platform || clicked) {
    return;
  }
  clicked = true;
  button.disabled = true;
  // Must remain directly within this click: Safari disallows an earlier await.
  platform.onUserGesture(event).catch(console.error);
});

function setPlayer(values) {
  if (connected && player) {
    player.set(values).catch(console.error);
  }
}

async function keepAwake() {
  if (document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    setPlayer({ wakeLock: true });
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      setPlayer({ wakeLock: false });
    });
  } catch (error) {
    console.warn('Wake lock unavailable', error);
    setPlayer({ wakeLock: false });
  }
}

function reportHealth() {
  const sensorAvailable = performance.now() - latestSensorAt < params.sensorTimeout * 1000;
  if (!sensorAvailable && sensorRunning) {
    engine?.stop();
    engine?.setOwn({ tilt: 0.5, intensity: 0 });
    featureExtractor.reset();
    sensorRunning = false;
  }
  setPlayer({
    sensorAvailable,
    ready: sensorAvailable && audioContext.state === 'running' && document.visibilityState === 'visible',
    audioState: audioContext.state,
    visibility: document.visibilityState,
    lastSeen: sync.getSyncTime(),
  });
}

// A researcher reset leaves this page for the disconnected reset view, which
// frees its checkin slot until the QR code is scanned again (see ../player.js).
client.socket.addListener('research:reset', () => {
  window.location.replace(`${window.location.pathname}?reset=1`);
});

client.socket.addListener('close', () => {
  connected = false;
  engine?.stop();
  clearInterval(heartbeat);
  // A researcher reloads the phone to recover; its screen stays black during a session.
});

async function main() {
  await client.start();
  sync = await client.pluginManager.get('sync');
  const index = (await client.pluginManager.get('checkin')).getIndex();
  const global = await client.stateManager.attach('global');
  player = await client.stateManager.create('player', {
    index,
    audioState: audioContext.state,
    baseLatency: Number.isFinite(audioContext.baseLatency) ? audioContext.baseLatency : -1,
    outputLatency: Number.isFinite(audioContext.outputLatency) ? audioContext.outputLatency : -1,
    lastSeen: sync.getSyncTime(),
  });
  const players = await client.stateManager.getCollection('player');
  engine = new AudioEngine(audioContext, sync, index);
  engine.setGlobal(global.getValues());
  const updatePartner = () => {
    const partner = players.find(state => state.get('index') === 1 - index);
    engine.setPartner(partner?.get('ready') ? partner.getValues() : { tilt: 0.5, intensity: 0 });
  };
  players.onAttach(updatePartner, true);
  players.onDetach(updatePartner);
  players.onUpdate((state, updates) => {
    if (state.get('index') !== 1 - index) {
      return;
    }
    updatePartner();
    if ('peak' in updates && global.get('phase') === 'latency-test') {
      engine.click();
    }
  });
  const ruleGuide = params.ruleGuide ? createRuleGuide(index) : null;
  global.onUpdate(updates => {
    engine.setGlobal(updates);
    if (ruleGuide && ('phase' in updates || 'divisionSwap' in updates)) {
      ruleGuide.update(global.get('phase'), global.get('divisionSwap'));
    }
    if ('cue' in updates) {
      engine.cue(updates.cue);
    }
    if ('syncBeep' in updates) {
      engine.syncBeep(updates.syncBeep);
    }
  });

  let lastSent = -Infinity;
  const onMotion = event => {
    if (!connected || document.visibilityState !== 'visible') {
      return;
    }
    const rotation = event.rotationRate;
    const gravity = event.accelerationIncludingGravity;
    if (!rotation || !gravity || ![rotation.alpha, rotation.beta, rotation.gamma, gravity.x, gravity.y, gravity.z].every(Number.isFinite)) {
      return;
    }
    latestSensorAt = performance.now();
    const time = sync.getSyncTime();
    const features = featureExtractor.process(event, time);
    engine.setOwn(features); // Local input reaches Web Audio before any network send.
    if (!sensorRunning) {
      sensorRunning = true;
      engine.start();
      reportHealth();
    }
    if (time - lastSent >= 1 / params.featuresHz) {
      lastSent = time;
      setPlayer({ tilt: features.tilt, intensity: features.intensity, sampleTime: time });
    }
    if (features.peak !== null) {
      if (global.get('phase') === 'latency-test') {
        engine.click();
      }
      setPlayer({ peak: features.peak });
    }
  };
  devicemotion.addEventListener(onMotion);
  removeMotion = () => devicemotion.removeEventListener(onMotion);
  guide.remove();
  document.body.classList.add('performing');
  if (ruleGuide) {
    ruleGuide.update(global.get('phase'), global.get('divisionSwap'));
    document.body.append(ruleGuide.element);
  }
  document.title = '';
  for (const type of ['touchstart', 'touchmove', 'touchend', 'contextmenu', 'dblclick']) {
    document.addEventListener(type, event => event.preventDefault(), { passive: false });
  }
  await keepAwake();
  reportHealth();
  heartbeat = setInterval(reportHealth, params.heartbeatInterval * 1000);
  audioContext.addEventListener('statechange', reportHealth);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') {
      engine.stop();
      sensorRunning = false;
      latestSensorAt = -Infinity;
      reportHealth();
      return;
    }
    featureExtractor.reset();
    engine.setOwn({ tilt: 0.5, intensity: 0 });
    if (connected) {
      try {
        await audioContext.resume(); 
      } catch (error) {
        console.warn(error); 
      }
      engine.setGlobal(global.getValues());
      await keepAwake();
      reportHealth();
    }
  });
}

main().catch(error => {
  console.error('Player startup failed; check permissions and reload before the session.', error);
  button.disabled = true;
  button.title = 'Ask the researcher to check the connection and browser permissions, then reload.';
  // Researcher-facing: every open participant page holds one of the two
  // checkin slots, even before "Start", so a forgotten tab blocks a phone.
  const notice = document.createElement('p');
  notice.className = 'startup-error';
  notice.textContent = error?.name === 'IndexSizeError'
    ? 'Two participant pages are already connected. Close this page on any other phone or browser tab, then reload.'
    : 'Could not start. The researcher should check the network and browser permissions, then reload the page.';
  guide.append(notice);
  engine?.stop();
});
window.addEventListener('pagehide', () => {
  clearInterval(heartbeat);
  removeMotion?.();
  engine?.destroy();
  wakeLock?.release().catch(console.error);
});
