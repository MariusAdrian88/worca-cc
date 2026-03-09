import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function createRunId(status) {
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
  const pipelineRunning = isPipelineRunning(worcaDir);

  const statusPath = join(worcaDir, 'status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      const active = !isTerminal(status) && pipelineRunning;
      runs.push({ id: createRunId(status), active, ...status });
    } catch { /* ignore malformed */ }
  }

  const resultsDir = join(worcaDir, 'results');
  if (existsSync(resultsDir)) {
    for (const file of readdirSync(resultsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
        if (data.started_at) {
          runs.push({ id: createRunId(data), active: false, ...data });
        }
      } catch { /* ignore */ }
    }
  }

  return runs;
}
