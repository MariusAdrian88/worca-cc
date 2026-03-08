export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const [path, query] = clean.split('?');
  const section = path || 'active';
  const params = new URLSearchParams(query || '');
  return { section, runId: params.get('run') || null };
}

export function buildHash(section, runId) {
  const base = `#/${section}`;
  return runId ? `${base}?run=${runId}` : base;
}

export function onHashChange(callback) {
  const handler = () => callback(parseHash(location.hash));
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

export function navigate(section, runId) {
  location.hash = buildHash(section, runId);
}
