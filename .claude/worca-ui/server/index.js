// server/index.js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './app.js';
import { attachWsServer } from './ws.js';

// Parse argv
let port = 3400;
let host = '127.0.0.1';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) port = parseInt(process.argv[++i], 10);
  if (process.argv[i] === '--host' && process.argv[i + 1]) host = process.argv[++i];
}

const cwd = process.cwd();
const app = createApp({ settingsPath: join(cwd, '.claude', 'settings.json') });
const server = createServer(app);

attachWsServer(server, {
  worcaDir: join(cwd, '.worca'),
  settingsPath: join(cwd, '.claude', 'settings.json'),
  prefsPath: join(homedir(), '.worca', 'preferences.json')
});

server.listen(port, host, () => {
  console.log(`worca-ui running at http://${host}:${port}`);
});
