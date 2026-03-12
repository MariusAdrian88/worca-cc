import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dbExists, listIssues, listUnlinkedIssues, listDistinctExternalRefs, getIssue } from './beads-reader.js';

let tmpDir, dbPath;

function setupDb(rows = [], deps = []) {
  tmpDir = mkdtempSync(join(tmpdir(), 'beads-test-'));
  dbPath = join(tmpDir, 'beads.db');
  const db = new Database(dbPath);
  db.prepare(`CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT, description TEXT,
      status TEXT, priority INTEGER, created_at TEXT, external_ref TEXT)`).run();
  db.prepare(`CREATE TABLE dependencies (issue_id INTEGER, depends_on_id INTEGER)`).run();
  const insertIssue = db.prepare(
    'INSERT INTO issues (id, title, description, status, priority, created_at, external_ref) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertDep = db.prepare(
    'INSERT INTO dependencies VALUES (?, ?)'
  );
  for (const r of rows) insertIssue.run(r.id, r.title, r.body || '', r.status, r.priority, r.created_at || '', r.external_ref || null);
  for (const d of deps) insertDep.run(d.issue_id, d.depends_on_id);
  db.close();
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('dbExists', () => {
  it('returns false for non-existent path', () => {
    expect(dbExists('/tmp/nonexistent-beads-db-12345/beads.db')).toBe(false);
  });

  it('returns true when the db file exists', () => {
    setupDb();
    expect(dbExists(dbPath)).toBe(true);
  });
});

describe('listIssues', () => {
  it('returns [] for non-existent path', () => {
    expect(listIssues('/tmp/nonexistent-beads-db-12345/beads.db')).toEqual([]);
  });

  it('excludes closed and tombstone issues', () => {
    setupDb([
      { id: 1, title: 'Open', body: '', status: 'open', priority: 2 },
      { id: 2, title: 'Closed', body: '', status: 'closed', priority: 2 },
      { id: 3, title: 'Tombstone', body: '', status: 'tombstone', priority: 3 },
    ]);
    const issues = listIssues(dbPath);
    expect(issues.length).toBe(1);
    expect(issues[0].title).toBe('Open');
  });

  it('returns correct depends_on array', () => {
    setupDb(
      [
        { id: 1, title: 'A', body: '', status: 'open', priority: 2 },
        { id: 2, title: 'B', body: '', status: 'open', priority: 2 },
      ],
      [{ issue_id: 2, depends_on_id: 1 }]
    );
    const issues = listIssues(dbPath);
    const issueB = issues.find(i => i.id === 2);
    expect(issueB.depends_on).toEqual([1]);
  });

  it('issue with closed dependency has blocked_by = []', () => {
    setupDb(
      [
        { id: 1, title: 'Closed dep', body: '', status: 'closed', priority: 2 },
        { id: 2, title: 'B', body: '', status: 'open', priority: 2 },
      ],
      [{ issue_id: 2, depends_on_id: 1 }]
    );
    const issues = listIssues(dbPath);
    const issueB = issues.find(i => i.id === 2);
    expect(issueB.blocked_by).toEqual([]);
  });

  it('issue with open dependency has blocked_by = [depId]', () => {
    setupDb(
      [
        { id: 1, title: 'Open dep', body: '', status: 'open', priority: 2 },
        { id: 2, title: 'B', body: '', status: 'open', priority: 2 },
      ],
      [{ issue_id: 2, depends_on_id: 1 }]
    );
    const issues = listIssues(dbPath);
    const issueB = issues.find(i => i.id === 2);
    expect(issueB.blocked_by).toEqual([1]);
  });

  it('issue with no dependencies has depends_on = [] and blocked_by = []', () => {
    setupDb([
      { id: 1, title: 'Standalone', body: '', status: 'open', priority: 2 },
    ]);
    const issues = listIssues(dbPath);
    expect(issues[0].depends_on).toEqual([]);
    expect(issues[0].blocked_by).toEqual([]);
  });

  it('returns [] on corrupt DB without throwing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'beads-test-'));
    dbPath = join(tmpDir, 'beads.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE wrong_table (x TEXT)');
    db.close();
    expect(listIssues(dbPath)).toEqual([]);
  });
});

describe('getIssue', () => {
  it('returns null for non-existent ID', () => {
    setupDb([
      { id: 1, title: 'A', body: '', status: 'open', priority: 2 },
    ]);
    expect(getIssue(dbPath, 999)).toBeNull();
  });

  it('returns correct issue with depends_on and blocked_by', () => {
    setupDb(
      [
        { id: 1, title: 'Dep', body: 'dep body', status: 'open', priority: 2 },
        { id: 2, title: 'Main', body: 'main body', status: 'open', priority: 2 },
      ],
      [{ issue_id: 2, depends_on_id: 1 }]
    );
    const issue = getIssue(dbPath, 2);
    expect(issue.title).toBe('Main');
    expect(issue.depends_on).toEqual([1]);
    expect(issue.blocked_by).toEqual([1]);
  });

  it('with a closed dependency: blocked_by is empty', () => {
    setupDb(
      [
        { id: 1, title: 'Closed', body: '', status: 'closed', priority: 2 },
        { id: 2, title: 'Main', body: '', status: 'open', priority: 2 },
      ],
      [{ issue_id: 2, depends_on_id: 1 }]
    );
    const issue = getIssue(dbPath, 2);
    expect(issue.depends_on).toEqual([1]);
    expect(issue.blocked_by).toEqual([]);
  });

  it('returns null on corrupt DB without throwing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'beads-test-'));
    dbPath = join(tmpDir, 'beads.db');
    const db = new Database(dbPath);
    db.prepare('CREATE TABLE wrong_table (x TEXT)').run();
    db.close();
    expect(getIssue(dbPath, 1)).toBeNull();
  });
});

describe('listUnlinkedIssues', () => {
  it('returns only issues without external_ref', () => {
    setupDb([
      { id: 1, title: 'Linked', body: '', status: 'open', priority: 2, external_ref: 'worca:run-1' },
      { id: 2, title: 'Unlinked', body: '', status: 'open', priority: 2 },
      { id: 3, title: 'Empty ref', body: '', status: 'open', priority: 2, external_ref: '' },
    ]);
    const issues = listUnlinkedIssues(dbPath);
    expect(issues.length).toBe(2);
    expect(issues.map(i => i.title)).toEqual(['Unlinked', 'Empty ref']);
  });

  it('excludes closed issues', () => {
    setupDb([
      { id: 1, title: 'Closed unlinked', body: '', status: 'closed', priority: 2 },
      { id: 2, title: 'Open unlinked', body: '', status: 'open', priority: 2 },
    ]);
    const issues = listUnlinkedIssues(dbPath);
    expect(issues.length).toBe(1);
    expect(issues[0].title).toBe('Open unlinked');
  });
});

describe('listDistinctExternalRefs', () => {
  it('returns distinct worca: refs', () => {
    setupDb([
      { id: 1, title: 'A', body: '', status: 'open', priority: 2, external_ref: 'worca:run-1' },
      { id: 2, title: 'B', body: '', status: 'open', priority: 2, external_ref: 'worca:run-1' },
      { id: 3, title: 'C', body: '', status: 'open', priority: 2, external_ref: 'worca:run-2' },
      { id: 4, title: 'D', body: '', status: 'open', priority: 2 },
    ]);
    const refs = listDistinctExternalRefs(dbPath);
    expect(refs.sort()).toEqual(['worca:run-1', 'worca:run-2']);
  });

  it('returns [] when no worca refs exist', () => {
    setupDb([
      { id: 1, title: 'A', body: '', status: 'open', priority: 2 },
    ]);
    expect(listDistinctExternalRefs(dbPath)).toEqual([]);
  });
});
