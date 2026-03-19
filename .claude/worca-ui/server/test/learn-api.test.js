import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockGetRunningPid = vi.fn().mockReturnValue(null);

vi.mock('../process-manager.js', () => ({
  startPipeline: vi.fn().mockResolvedValue({ pid: 12345 }),
  stopPipeline: vi.fn(),
  restartStage: vi.fn(),
  getRunningPid: (...args) => mockGetRunningPid(...args),
}));

const { createApp } = await import('../app.js');

function startServer(worcaDir, opts = {}) {
  const app = createApp({ worcaDir, ...opts });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ server, base, app });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postLearn(base, runId) {
  return fetch(`${base}/api/runs/${runId}/learn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/runs/:id/learn', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'learn-api-test-'));
    mockGetRunningPid.mockReturnValue(null);
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 501 when worcaDir not configured', async () => {
    ({ server, base } = await startServer(undefined));
    const res = await postLearn(base, 'run-123');
    expect(res.status).toBe(501);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/worcaDir/i);
  });

  it('returns 404 when run status.json does not exist', async () => {
    ({ server, base } = await startServer(tmpDir));
    const res = await postLearn(base, 'nonexistent-run');
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/not found/i);
  });

  it('returns 409 when pipeline is currently running', async () => {
    // Create run directory with status.json
    const runDir = join(tmpDir, 'runs', 'run-123');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'status.json'), JSON.stringify({
      run_id: 'run-123',
      result: 'success',
    }));

    mockGetRunningPid.mockReturnValue({ pid: 99999 });

    ({ server, base } = await startServer(tmpDir));
    const res = await postLearn(base, 'run-123');
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/running/i);
  });

  it('returns 200 and spawns learn script for valid run', async () => {
    const runDir = join(tmpDir, 'runs', 'my-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'status.json'), JSON.stringify({
      run_id: 'my-run',
      result: 'success',
    }));

    ({ server, base } = await startServer(tmpDir, { projectRoot: tmpDir }));
    const res = await postLearn(base, 'my-run');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('returns 200 for a failed run too', async () => {
    const runDir = join(tmpDir, 'runs', 'failed-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'status.json'), JSON.stringify({
      run_id: 'failed-run',
      result: 'failure',
      error: 'Tests failed',
    }));

    ({ server, base } = await startServer(tmpDir, { projectRoot: tmpDir }));
    const res = await postLearn(base, 'failed-run');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});
