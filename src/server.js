import '@soundworks/helpers/polyfills.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';
import ServerPluginPlatformInit from '@soundworks/plugin-platform-init/server.js';
import ServerPluginSync from '@soundworks/plugin-sync/server.js';
import ServerPluginCheckin from '@soundworks/plugin-checkin/server.js';
import ServerPluginLogger from '@soundworks/plugin-logger/server.js';
import { globalDescription, playerDescription } from './shared/state-descriptions.js';
import { Session } from './server/Session.js';
import { participantLinks, readCertificate } from './server/participant-links.js';

const config = loadConfig(process.env.ENV, import.meta.url);
const server = new Server(config);
configureHttpRouter(server);
server.pluginManager.register('platform-init', ServerPluginPlatformInit);
server.pluginManager.register('sync', ServerPluginSync);
server.pluginManager.register('checkin', ServerPluginCheckin, { capacity: 2 });
server.pluginManager.register('logger', ServerPluginLogger, { dirname: 'logs' });
server.stateManager.defineClass('global', globalDescription);
server.stateManager.defineClass('player', playerDescription);

let session;
let commands = Promise.resolve();
const playerClients = new Set();
server.onClientConnect(client => {
  // Participant sockets never receive a researcher command handler.
  if (client.role !== 'controller') {
    if (client.role === 'player') {
      playerClients.add(client);
    }
    return;
  }
  client.socket.addListener('research:command', message => {
    const { id, action, payload } = message ?? {};
    commands = commands.then(async () => {
      try {
        if (!session) {
          throw new Error('The server is still starting up. Try again in a moment.');
        }
        await session.command(action, payload);
        client.socket.send('research:result', { id, ok: true });
      } catch (error) {
        console.error(error);
        client.socket.send('research:result', { id, ok: false, error: error.message });
      }
    });
  });
});

server.onClientDisconnect(client => playerClients.delete(client));

await server.start();
const global = await server.stateManager.create('global');
const players = await server.stateManager.getCollection('player');
const sync = await server.pluginManager.get('sync');
const logger = await server.pluginManager.get('logger');
// Each phone leaves for its reset view and disconnects, freeing both checkin slots.
const resetPlayers = () => playerClients.forEach(client => client.socket.send('research:reset'));
session = new Session({ global, players, sync, logger, resetPlayers });

// Poll so the controller's QR code follows Wi-Fi joins and DHCP changes.
const certificate = readCertificate(config.env);
async function refreshParticipantLinks() {
  const links = participantLinks(config.env, undefined, certificate);
  if (JSON.stringify(links) !== JSON.stringify(global.get('participantLinks'))) {
    await global.set({ participantLinks: links });
  }
  return links;
}
const links = await refreshParticipantLinks();
const linkTimer = setInterval(() => refreshParticipantLinks().catch(console.error), 5000);
const protocol = config.env.useHttps ? 'https' : 'http';
console.log(`\nPhones: ${links[0]?.url ?? '(no local network address found; connect to Wi-Fi)'}\nResearcher controller: ${protocol}://localhost:${config.env.port}/controller (shows a QR code for the phones)\n`);

let stopping = false;
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(linkTimer);
  await commands;
  await session.close();
  await server.stop();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
