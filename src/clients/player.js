import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig } from '@soundworks/helpers/browser.js';
import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginSync from '@soundworks/plugin-sync/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import devicemotion from '@ircam/devicemotion';
import params from '../shared/params.js';
import { introduction } from '../shared/instructions.js';
import { createFeatureExtractor } from '../shared/features.js';
import AudioEngine from './player/AudioEngine.js';

document.documentElement.lang = 'zh-CN';
document.body.className = 'player';
document.title = '欢迎';
const guide = document.createElement('main');
guide.className = 'introduction';
introduction.forEach((text, index) => {
  const element = document.createElement(index === 0 ? 'h1' : 'p');
  element.textContent = text;
  guide.append(element);
});
const button = document.createElement('button');
button.textContent = '开始';
button.disabled = true;
guide.append(button);
document.body.append(guide);

const client = new Client(loadConfig());
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
  global.onUpdate(updates => {
    engine.setGlobal(updates);
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
  button.title = '请由研究者检查连接和浏览器权限后重新载入。';
  engine?.stop();
});
window.addEventListener('pagehide', () => {
  clearInterval(heartbeat);
  removeMotion?.();
  engine?.destroy();
  wakeLock?.release().catch(console.error);
});
