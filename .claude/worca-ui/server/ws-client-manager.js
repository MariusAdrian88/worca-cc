/**
 * WebSocket client subscription and heartbeat management.
 * Owns the subs WeakMap that tracks per-client subscriptions.
 */

/**
 * @param {{ wss: import('ws').WebSocketServer }} deps
 */
export function createClientManager({ wss }) {
  /** @type {WeakMap<import('ws').WebSocket, { runId: string | null, logStage: string | null, logRunId: string | null, eventsRunId: string | null, protocolVersion: number, projectId: string | null }>} */
  const subs = new WeakMap();

  function ensureSubs(ws) {
    let s = subs.get(ws);
    if (!s) {
      s = { runId: null, logStage: null, logRunId: null, eventsRunId: null, protocolVersion: 1, projectId: null };
      subs.set(ws, s);
    }
    return s;
  }

  function getSubs(ws) {
    return subs.get(ws);
  }

  function deleteSubs(ws) {
    subs.delete(ws);
  }

  function setProtocol(ws, version, projectId) {
    const s = ensureSubs(ws);
    s.protocolVersion = version;
    s.projectId = projectId ?? null;
  }

  // Heartbeat — ping all clients every 30s, terminate unresponsive ones
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  function destroy() {
    clearInterval(heartbeat);
  }

  return { ensureSubs, getSubs, deleteSubs, setProtocol, destroy };
}
