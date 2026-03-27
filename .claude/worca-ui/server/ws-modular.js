/**
 * Modular WebSocket server — facade wiring 7 extracted modules.
 * Drop-in replacement for ws-legacy.js with identical behavior.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createClientManager } from './ws-client-manager.js';
import { createBroadcaster } from './ws-broadcaster.js';
import { createStatusWatcher, resolveActiveRunDir } from './ws-status-watcher.js';
import { createLogWatcher } from './ws-log-watcher.js';
import { createBeadsWatcher } from './ws-beads-watcher.js';
import { createEventWatcher } from './ws-event-watcher.js';
import { createMessageRouter } from './ws-message-router.js';

export { resolveActiveRunDir };

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ worcaDir: string, settingsPath: string, prefsPath: string }} config
 */
export function attachWsServer(httpServer, config) {
  const { worcaDir, settingsPath, prefsPath, webhookInbox, projectRoot } =
    config;
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // 1. Client manager — owns subs WeakMap and heartbeat
  const clientManager = createClientManager({ wss });

  // 2. Broadcaster — stateless, uses wss.clients + subs
  const broadcaster = createBroadcaster({
    wss,
    getSubs: clientManager.getSubs,
  });

  // Shared helper: resolve filesystem dir for a run ID
  function resolveRunDirById(runId) {
    const candidates = [
      join(worcaDir, 'runs', runId),
      join(worcaDir, 'results', runId),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return join(worcaDir, 'runs', runId);
  }

  // 3. Log watcher (created before status watcher so onActiveRunChange can reference it)
  // We'll set up the dependency via a late-bound reference
  let logWatcher;

  // 4. Status watcher — owns refresh, activeRun tracking
  const statusWatcher = createStatusWatcher({
    worcaDir,
    settingsPath,
    broadcaster,
    getSubs: clientManager.getSubs,
    wss,
    onActiveRunChange: () => {
      if (logWatcher) logWatcher.clearLogWatchers();
    },
  });

  // Now create log watcher with status watcher's resolveActiveRunDir
  logWatcher = createLogWatcher({
    broadcaster,
    resolveActiveRunDir: statusWatcher.resolveActiveRunDir,
    worcaDir,
    currentActiveRunId: statusWatcher.currentActiveRunId,
  });

  // 5. Beads watcher
  const beadsWatcher = createBeadsWatcher({ worcaDir, broadcaster });

  // 6. Event watcher
  const eventWatcher = createEventWatcher({
    broadcaster,
    getSubs: clientManager.getSubs,
    wss,
    resolveRunDirById,
  });

  // 7. Message router — delegates to all other modules
  const messageRouter = createMessageRouter({
    worcaDir,
    settingsPath,
    prefsPath,
    projectRoot,
    webhookInbox,
    clientManager,
    broadcaster,
    statusWatcher,
    logWatcher,
    beadsWatcher,
    eventWatcher,
  });

  // Connection lifecycle
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    clientManager.ensureSubs(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      messageRouter.handleMessage(ws, data);
    });

    ws.on('close', () => {
      const s = clientManager.getSubs(ws);
      const eventsRunId = s?.eventsRunId;
      clientManager.deleteSubs(ws);
      if (eventsRunId) eventWatcher.maybeCloseEventWatcher(eventsRunId);
    });
  });

  wss.on('close', () => {
    clientManager.destroy();
    statusWatcher.destroy();
    logWatcher.destroy();
    beadsWatcher.destroy();
    eventWatcher.destroy();
  });

  return { wss, broadcast: broadcaster.broadcast, scheduleRefresh: statusWatcher.scheduleRefresh };
}
