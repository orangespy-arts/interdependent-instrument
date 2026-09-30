import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig } from '@soundworks/helpers/browser.js';
import ClientPluginSync from '@soundworks/plugin-sync/client.js';
import params from '../shared/params.js';
import { mountController } from './controller/dashboard.js';

document.documentElement.lang = 'en';
document.body.className = 'controller';
document.title = 'Interdependent Instrument · Research Console';
const container = document.createElement('main');
container.textContent = 'Connecting to the research server…';
document.body.append(container);
const client = new Client(loadConfig());
client.pluginManager.register('sync', ClientPluginSync);
let sequence = 0;
let dashboard;
const pending = new Map();

client.socket.addListener('research:result', result => {
  const request = pending.get(result.id);
  if (!request) {
    return;
  }
  clearTimeout(request.timer);
  pending.delete(result.id);
  if (result.ok) {
    request.resolve();
  } else {
    request.reject(new Error(result.error));
  }
});
client.socket.addListener('close', () => {
  dashboard?.destroy();
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Lost connection to the server.'));
  }
  pending.clear();
  container.replaceChildren();
  const notice = document.createElement('p');
  notice.textContent = 'Lost connection to the server. Restart the server, then reload this page.';
  container.append(notice);
});

function sendCommand(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The command was not confirmed in time. Check the console state before trying again.'));
    }, params.commandTimeout * 1000);
    pending.set(id, { resolve, reject, timer });
    client.socket.send('research:command', { id, action, payload });
  });
}

async function main() {
  await client.start();
  const global = await client.stateManager.attach('global');
  const players = await client.stateManager.getCollection('player');
  const sync = await client.pluginManager.get('sync');
  dashboard = mountController({ container, global, players, sync, sendCommand, params });
}

main().catch(error => {
  container.textContent = `The console failed to start: ${error.message}`; 
});
