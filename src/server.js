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
server.onClientConnect(client => {
  // Participant sockets never receive a researcher command handler.
  if (client.role !== 'controller') {
    return;
  }
  client.socket.addListener('research:command', message => {
    const { id, action, payload } = message ?? {};
    commands = commands.then(async () => {
      try {
        if (!session) {
          throw new Error('服务器正在初始化，请稍后重试。');
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

await server.start();
const global = await server.stateManager.create('global');
const players = await server.stateManager.getCollection('player');
const sync = await server.pluginManager.get('sync');
const logger = await server.pluginManager.get('logger');
session = new Session({ global, players, sync, logger });

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
console.log(`\n手机端: ${links[0]?.url ?? '（未检测到局域网地址，请连接 Wi-Fi）'}\n研究者控制端: ${protocol}://localhost:${config.env.port}/controller（页面内有手机二维码）\n`);

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
