#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.claude', 'settings.json'))) return dir;
    dir = dirname(dir);
  }
  return startDir;
}

const PROJECT_ROOT = findProjectRoot(process.cwd());
const PID_DIR = join(PROJECT_ROOT, '.worca');
const PID_FILE = join(PID_DIR, 'worca-ui.pid');
const SERVER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'index.js',
);

function parseArgs(argv) {
  const args = { command: 'start', port: 3400, host: '127.0.0.1', open: false };
  for (let i = 2; i < argv.length; i++) {
    if (
      argv[i] === 'start' ||
      argv[i] === 'stop' ||
      argv[i] === 'restart' ||
      argv[i] === 'status'
    ) {
      args.command = argv[i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[++i];
    } else if (argv[i] === '--open') {
      args.open = true;
    }
  }
  return args;
}

function readPid() {
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writePid(info) {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(PID_FILE, `${JSON.stringify(info, null, 2)}\n`);
}

function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, host, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const p = startPort + i;
    if (await isPortAvailable(p, host)) return p;
  }
  return null;
}

async function start({ port, host, open }) {
  const existing = readPid();
  if (existing && isRunning(existing.pid)) {
    console.log(
      `worca-ui already running (PID ${existing.pid}) at http://${existing.host}:${existing.port}`,
    );
    return;
  }

  const availablePort = await findAvailablePort(port, host);
  if (availablePort === null) {
    console.error(`No available port found (tried ${port}-${port + 9})`);
    process.exit(1);
  }
  if (availablePort !== port) {
    console.log(`Port ${port} in use, using ${availablePort}`);
  }

  const child = spawn(
    process.execPath,
    [SERVER_SCRIPT, '--port', String(availablePort), '--host', host],
    {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    },
  );
  child.unref();

  const info = {
    pid: child.pid,
    port: availablePort,
    host,
    started_at: new Date().toISOString(),
  };
  writePid(info);
  const url = `http://${host}:${availablePort}`;
  console.log(`worca-ui started (PID ${child.pid}) at ${url}`);

  if (open) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function stop() {
  const info = readPid();
  if (!info) {
    console.log('worca-ui is not running');
    return;
  }
  if (isRunning(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
      console.log(`worca-ui stopped (PID ${info.pid})`);
    } catch (e) {
      console.error(`Failed to stop PID ${info.pid}: ${e.message}`);
    }
  } else {
    console.log('worca-ui was not running (stale PID file)');
  }
  removePid();
}

async function restart(opts) {
  stop();
  await new Promise((r) => setTimeout(r, 500));
  await start(opts);
}

function status() {
  const info = readPid();
  if (!info) {
    console.log('worca-ui is not running');
    return;
  }
  if (isRunning(info.pid)) {
    console.log(
      `worca-ui is running (PID ${info.pid}) at http://${info.host}:${info.port}`,
    );
    console.log(`Started: ${info.started_at}`);
  } else {
    console.log('worca-ui is not running (stale PID file)');
    removePid();
  }
}

const args = parseArgs(process.argv);
switch (args.command) {
  case 'start':
    start(args);
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    restart(args);
    break;
  case 'status':
    status();
    break;
  default:
    console.log(
      'Usage: worca-ui [start|stop|restart|status] [--port N] [--host H] [--open]',
    );
}
