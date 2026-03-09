import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function createRunId(status) {
  // Prefer run_id from status (new per-run format)
  if (status.run_id) return status.run_id;
  // Legacy: hash-based ID
  const key = `${status.started_at}:${status.work_request?.title || ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function isTerminal(status) {
  if (status.completed_at) return true;
  if (!status.stages) return false;
  const values = Object.values(status.stages);
  return values.length > 0 && values.every(s =>
    s.status === 'completed' || s.status === 'error' || s.status === 'interrupted'
  );
}

function isPipelineRunning(worcaDir) {
  const pidPath = join(worcaDir, 'pipeline.pid');
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    return false; // stale PID or unreadable
  }
}

export function discoverRuns(worcaDir) {
  const runs = [];
  const seenIds = new Set();
  const pipelineRunning = isPipelineRunning(worcaDir);

  // 1. Check active_run pointer for the current run
  const activeRunPath = join(worcaDir, 'active_run');
  if (existsSync(activeRunPath)) {
    try {
      const activeId = readFileSync(activeRunPath, 'utf8').trim();
      const candidate = join(worcaDir, 'runs', activeId, 'status.json');
      if (existsSync(candidate)) {
        const status = JSON.parse(readFileSync(candidate, 'utf8'));
        const active = !isTerminal(status) && pipelineRunning;
        const id = createRunId(status);
        runs.push({ id, active, ...status });
        seenIds.add(id);
      }
    } catch { /* ignore */ }
  }

  // 2. Scan .worca/runs/ for non-active runs
  const runsDir = join(worcaDir, 'runs');
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const statusPath = join(runsDir, entry, 'status.json');
      if (!existsSync(statusPath)) continue;
      try {
        const status = JSON.parse(readFileSync(statusPath, 'utf8'));
        const id = createRunId(status);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        runs.push({ id, active: false, ...status });
      } catch { /* ignore */ }
    }
  }

  // 3. Legacy: flat .worca/status.json
  const statusPath = join(worcaDir, 'status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      const id = createRunId(status);
      if (!seenIds.has(id)) {
        const active = !isTerminal(status) && pipelineRunning;
        runs.push({ id, active, ...status });
        seenIds.add(id);
      }
    } catch { /* ignore malformed */ }
  }

  // 4. Results: handle both dir format (results/{id}/status.json) and file format (results/{id}.json)
  const resultsDir = join(worcaDir, 'results');
  if (existsSync(resultsDir)) {
    for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
      try {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          // Legacy file format
          const data = JSON.parse(readFileSync(join(resultsDir, entry.name), 'utf8'));
          if (data.started_at) {
            const id = createRunId(data);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              runs.push({ id, active: false, ...data });
            }
          }
        } else if (entry.isDirectory()) {
          // New dir format
          const sp = join(resultsDir, entry.name, 'status.json');
          if (existsSync(sp)) {
            const data = JSON.parse(readFileSync(sp, 'utf8'));
            const id = createRunId(data);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              runs.push({ id, active: false, ...data });
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return runs;
}
