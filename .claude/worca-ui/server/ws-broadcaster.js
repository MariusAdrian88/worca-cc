/**
 * WebSocket broadcast utilities.
 * Stateless — uses wss.clients and the subs WeakMap from client-manager.
 */

/**
 * @param {{ wss: import('ws').WebSocketServer, getSubs: Function }} deps
 */
export function createBroadcaster({ wss, getSubs }) {
  function broadcast(type, payload) {
    const msg = JSON.stringify({
      id: `evt-${Date.now()}`,
      ok: true,
      type,
      payload,
    });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  function broadcastToSubscribers(runId, type, payload) {
    const msg = JSON.stringify({
      id: `evt-${Date.now()}`,
      ok: true,
      type,
      payload,
    });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const s = getSubs(ws);
      if (s && s.runId === runId) {
        ws.send(msg);
      }
    }
  }

  function broadcastToLogSubscribers(stage, type, payload, runId) {
    const msg = JSON.stringify({
      id: `evt-${Date.now()}`,
      ok: true,
      type,
      payload,
    });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const s = getSubs(ws);
      if (s && (s.logStage === stage || s.logStage === '*')) {
        if (runId && s.logRunId && s.logRunId !== runId) continue;
        ws.send(msg);
      }
    }
  }

  function broadcastPipelineEvent(runId, event) {
    const msg = JSON.stringify({
      id: `evt-${Date.now()}`,
      ok: true,
      type: 'pipeline-event',
      payload: event,
    });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const s = getSubs(ws);
      if (s && s.eventsRunId === runId) {
        ws.send(msg);
      }
    }
  }

  return {
    broadcast,
    broadcastToSubscribers,
    broadcastToLogSubscribers,
    broadcastPipelineEvent,
  };
}
