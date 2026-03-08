# worca-ui End-to-End Server Tests

> **For pipeline agents:** Follow your agent role instructions. Do not invoke skills.

**Goal:** Add integration tests that boot the full server stack (Express app + WebSocket) via `createApp()` so that startup crashes like the Express 5 `'*'` route bug are caught.

**Architecture:** A new test file creates the full server (Express + WS) using `createApp()` and `attachWsServer()`, then validates HTTP responses, static file serving, WebSocket connectivity, and live update flow — all through the real server entry path.

**Tech Stack:** Vitest, ws, node:http, existing test fixtures

**Design doc:** `docs/plans/2026-03-08-worca-ui-design.md`

---

### Task 1: Full Server Boot Test

**Files:**
- Create: `.claude/worca-ui/test/server-e2e.test.js`

**Step 1: Write the tests**

Create a test file that boots the complete server stack and validates end-to-end behavior. The key difference from the existing `ws-integration.test.js` is that these tests use `createApp()` from `server/app.js` (which creates the Express app with static file serving and the catch-all route) combined with `attachWsServer()` — the same code path as `server/index.js`.

The test setup (`beforeEach`) must:
1. Create a temp directory structure with `.worca/` and `.worca/results/` subdirectories
2. Create a preferences file path in the temp dir
3. Call `createApp()` to create the Express application
4. Call `createServer(app)` from `node:http` to create the HTTP server
5. Call `attachWsServer(server, config)` with the temp directories
6. Listen on port 0 (auto-assign) on `127.0.0.1`
7. Store the assigned port for use in tests

The test teardown (`afterEach`) must:
1. Close the HTTP server
2. Remove the temp directory recursively

Test cases to implement:

**Test 1: "server boots without crashing"**
- Just verify the server starts and `server.address()` returns a valid port
- This catches startup crashes like the Express 5 `'*'` route bug

**Test 2: "serves index.html on GET /"**
- Use `http.get` (from `node:http`) to fetch `http://127.0.0.1:${port}/`
- Verify response status is 200
- Verify response body contains `<title>worca-ui</title>`

**Test 3: "serves styles.css on GET /styles.css"**
- Fetch `http://127.0.0.1:${port}/styles.css`
- Verify status 200
- Verify content-type contains `text/css`

**Test 4: "serves index.html for unknown routes (SPA fallback)"**
- Fetch `http://127.0.0.1:${port}/some/unknown/path`
- Verify status 200
- Verify body contains `<title>worca-ui</title>`
- This validates the catch-all route works

**Test 5: "WebSocket connects through full server stack"**
- Create a WebSocket client connecting to `ws://127.0.0.1:${port}/ws`
- Send a `list-runs` request
- Verify the response has `ok: true`

**Test 6: "HTTP and WebSocket work together on same server"**
- Write `status-running.json` fixture content to `${tmpDir}/worca/status.json`
- Fetch `http://127.0.0.1:${port}/` and verify 200
- Connect WebSocket, send `list-runs`, verify it finds the active run
- This proves both layers coexist correctly

**Test 7: "preferences round-trip through full stack"**
- Connect WebSocket
- Send `get-preferences`, verify default theme is `'light'`
- Send `set-preferences` with `{ theme: 'dark' }`
- Send `get-preferences` again, verify theme is now `'dark'`

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { get as httpGet } from 'node:http';
import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { attachWsServer } from '../server/ws.js';

function fetch(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function sendAndReceive(ws, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

describe('server e2e', () => {
  let server, port, dir, prefsPath;

  beforeEach(async () => {
    dir = join(tmpdir(), `worca-e2e-${Date.now()}`);
    mkdirSync(join(dir, 'worca', 'results'), { recursive: true });
    prefsPath = join(dir, 'preferences.json');

    const app = createApp();
    server = createServer(app);
    attachWsServer(server, {
      worcaDir: join(dir, 'worca'),
      settingsPath: join(dir, 'settings.json'),
      prefsPath
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('server boots without crashing', () => {
    expect(server.address().port).toBeGreaterThan(0);
  });

  it('serves index.html on GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>worca-ui</title>');
  });

  it('serves styles.css on GET /styles.css', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('serves index.html for unknown routes (SPA fallback)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>worca-ui</title>');
  });

  it('WebSocket connects through full server stack', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '1', type: 'list-runs' });
    expect(reply.ok).toBe(true);
    ws.close();
  });

  it('HTTP and WebSocket work together on same server', async () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      work_request: { title: 'test run' },
      stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } }
    };
    writeFileSync(join(dir, 'worca', 'status.json'), JSON.stringify(status));

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '2', type: 'list-runs' });
    expect(reply.payload.runs.length).toBe(1);
    expect(reply.payload.runs[0].active).toBe(true);
    ws.close();
  });

  it('preferences round-trip through full stack', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    const getReply = await sendAndReceive(ws, { id: '3', type: 'get-preferences' });
    expect(getReply.payload.theme).toBe('light');

    const setReply = await sendAndReceive(ws, { id: '4', type: 'set-preferences', payload: { theme: 'dark' } });
    expect(setReply.payload.theme).toBe('dark');

    const getReply2 = await sendAndReceive(ws, { id: '5', type: 'get-preferences' });
    expect(getReply2.payload.theme).toBe('dark');

    ws.close();
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run test/server-e2e.test.js`
Expected: All 7 tests PASS

**Step 3: Run the full test suite to verify no regressions**

Run: `cd .claude/worca-ui && npx vitest run`
Expected: All test suites PASS (the existing 10 + this new one = 11 total)

**Step 4: Commit**

```bash
git add .claude/worca-ui/test/server-e2e.test.js
git commit -m "test: add e2e server tests that boot full Express+WS stack"
```
