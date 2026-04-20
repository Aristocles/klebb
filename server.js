const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { execSync, spawn } = require('child_process');
const { isAuthenticated, isPublicPath, handleAuthRoutes, isSetup } = require('./auth/webauthn');
const PATHS = require('./config/paths');
const ENV = require('./config/env');
const registry = require('./manifests/registry');
const wizard = require('./setup/wizard');
const voice = require('./voice/fish');
const voiceCache = require('./voice/cache');

// OpenClaw gateway config (now env-driven; defaults preserve existing Axis behaviour)
const OPENCLAW_HOST = ENV.OPENCLAW_HOST;
const OPENCLAW_PORT = ENV.OPENCLAW_PORT;
const OPENCLAW_TOKEN = ENV.OPENCLAW_TOKEN;
const OPENCLAW_MODEL = ENV.OPENCLAW_MODEL;

const HEALTH_SYSTEM_PROMPT = ENV.HEALTH_SYSTEM_PROMPT;


const PORT = ENV.PORT;
const HOST = ENV.HOST;
const DATA_DIR = PATHS.DATA_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = PATHS.REPORTS_DIR;

// Ensure writable dirs exist
PATHS.ensureWritableDirs();

// Configure marked for GFM (tables, etc.)
marked.setOptions({ gfm: true, breaks: true });

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function send404(res, msg = 'Not found') {
  sendJSON(res, { error: msg }, 404);
}

function readJSONFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Legacy-aware helper: returns the data block if the file is a v2 manifest,
// otherwise the raw parsed content. Lets legacy endpoints keep working
// after migration without rewriting each handler.
function readLegacyJSONFile(filePath) {
  const data = readJSONFile(filePath);
  if (data && typeof data === 'object' && data.$schema === 'eddzhealth.datafile.v1') {
    return data.data;
  }
  return data;
}

// Legacy-aware write: preserves meta/description/schema when writing back
// to a v2 manifest file; otherwise writes the raw value.
function writeLegacyJSONFile(filePath, newData) {
  const existing = readJSONFile(filePath);
  if (existing && typeof existing === 'object' && existing.$schema === 'eddzhealth.datafile.v1') {
    const merged = { ...existing, data: newData };
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, filePath);
    return;
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(newData, null, 2));
  fs.renameSync(tmp, filePath);
}

function listDatesInDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

function getDateRange(dir, start, end) {
  const result = {};
  const dates = listDatesInDir(dir);
  for (const date of dates) {
    if (date >= start && date <= end) {
      const data = readJSONFile(path.join(dir, `${date}.json`));
      if (data) result[date] = data;
    }
  }
  return result;
}

function getWeightRange(start, end) {
  const weights = readJSONFile(path.join(DATA_DIR, 'weight.json'));
  if (!weights) return [];
  // Unwrap v2 manifest
  const arr = (weights && weights.$schema === 'eddzhealth.datafile.v1') ? weights.data : weights;
  if (!Array.isArray(arr)) return [];
  return arr.filter(w => w.date >= start && w.date <= end);
}

// Pipe a buffer of any audio into ffmpeg and get 16kHz mono 16-bit WAV back
// on stdout. This is the format Fish ASR accepts most reliably (advertised
// opus/mp4 support both reject in practice).
function transcodeToWav(inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',                        // no video
      '-ac', '1',                   // mono
      '-ar', '16000',               // 16 kHz
      '-sample_fmt', 's16',         // 16-bit
      '-f', 'wav',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const outChunks = [];
    let stderr = '';
    ff.stdout.on('data', c => outChunks.push(c));
    ff.stderr.on('data', c => stderr += c.toString());
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(Buffer.concat(outChunks));
    });
    ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg dies early
    ff.stdin.end(inputBuf);
  });
}

// Extract a { speak, display } JSON object from a model's raw reply.
// The model is instructed to emit pure JSON, but handle stray text/fences +
// tool-use intermixing by grabbing the LAST JSON object in the response
// (that one is always the final answer).
function extractJsonReply(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip common markdown fences
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Try direct parse first (common case: clean JSON reply)
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') return obj;
  } catch {}
  // Find all {...} blocks and try each from last to first.
  // Walk the string and track brace depth to extract balanced objects.
  const candidates = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try from last to first (the final answer is usually last)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && typeof obj === 'object' && (typeof obj.speak === 'string' || typeof obj.display === 'string')) {
        return obj;
      }
    } catch {}
  }
  return null;
}

// Synthesise the legacy injection-log.json shape { 'YYYY-MM-DD': { 'PeptideName': { taken: true, time: ISO } } }
// from the v2 peptides.json data.items[].doses[]. Called by the legacy
// injection-log endpoints after migration has archived the original file.
function synthesiseLegacyInjectionLog() {
  const raw = readJSONFile(path.join(DATA_DIR, 'peptides.json'));
  if (!raw) return {};
  const items = (raw && raw.$schema === 'eddzhealth.datafile.v1')
    ? ((raw.data && raw.data.items) || [])
    : (raw.peptides || []);
  const result = {};
  for (const item of items) {
    if (!Array.isArray(item.doses)) continue;
    for (const d of item.doses) {
      if (!d.takenAt || !d.scheduledDate) continue;
      if (!result[d.scheduledDate]) result[d.scheduledDate] = {};
      result[d.scheduledDate][item.name] = { taken: true, time: d.takenAt };
    }
  }
  return result;
}

function renderReportPage(title, htmlContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Health Dashboard</title>
<style>
:root {
  --bg: #f5f7fa;
  --text: #1e293b;
  --text-muted: #64748b;
  --heading: #0ea5e9;
  --border: #e2e8f0;
  --code-bg: #e2e8f0;
  --strong: #b45309;
  --em: #475569;
  --link: #0ea5e9;
  --row-even: rgba(226, 232, 240, 0.5);
  --row-hover: rgba(14, 165, 233, 0.08);
  --quote: #64748b;
}
html[data-theme="dark"] {
  --bg: #0f0f1a;
  --text: #e0e0e0;
  --text-muted: #8888aa;
  --heading: #00d4aa;
  --border: #2a2a4a;
  --code-bg: #1a1a2e;
  --strong: #ffaa00;
  --em: #ccccdd;
  --link: #00d4aa;
  --row-even: rgba(26, 26, 46, 0.5);
  --row-hover: rgba(0, 212, 170, 0.08);
  --quote: #8888aa;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --bg: #0f0f1a;
    --text: #e0e0e0;
    --text-muted: #8888aa;
    --heading: #00d4aa;
    --border: #2a2a4a;
    --code-bg: #1a1a2e;
    --strong: #ffaa00;
    --em: #ccccdd;
    --link: #00d4aa;
    --row-even: rgba(26, 26, 46, 0.5);
    --row-hover: rgba(0, 212, 170, 0.08);
    --quote: #8888aa;
  }
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); max-width: 900px; margin: 0 auto; padding: 20px; line-height: 1.7; }
h1, h2, h3, h4 { color: var(--heading); margin-top: 1.5em; }
h1 { border-bottom: 2px solid var(--border); padding-bottom: 10px; }
h2 { border-bottom: 1px solid var(--border); padding-bottom: 6px; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: var(--text); }
pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
ul, ol { padding-left: 24px; }
li { margin: 4px 0; }
hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
strong { color: var(--strong); }
em { color: var(--em); }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th { background: var(--code-bg); color: var(--heading); text-align: left; padding: 10px 12px; border: 1px solid var(--border); font-weight: 600; }
td { padding: 8px 12px; border: 1px solid var(--border); color: var(--text); }
tr:nth-child(even) { background: var(--row-even); }
tr:hover { background: var(--row-hover); }
blockquote { border-left: 3px solid var(--heading); padding-left: 16px; margin: 16px 0; color: var(--quote); }
.back-link { display: inline-block; margin-bottom: 20px; color: var(--text-muted); font-size: 0.9em; }
.back-link:hover { color: var(--heading); }
</style>
<script>
// Respect app theme preference (from localStorage key 'eddzhealth-theme')
(function() {
  try {
    var t = localStorage.getItem('eddzhealth-theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
</script>
</head>
<body>
<a href="/" class="back-link">← Back to Dashboard</a>
${htmlContent}
</body></html>`;
}

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    // For SPA routing, serve index.html for non-API, non-file paths
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Handle auth routes first
  if (pathname.startsWith('/auth/')) {
    const result = await handleAuthRoutes(req, res, pathname);
    if (result !== null) return;
  }

  // Redirect to setup or login if not authenticated
  if (!isAuthenticated(req) && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    // Redirect to login page (or setup if no credentials yet)
    const redirect = isSetup() ? '/login.html' : '/setup.html';
    res.writeHead(302, { 'Location': redirect });
    res.end();
    return;
  }

  // If setup is not done, redirect non-setup pages to setup
  if (!isSetup() && pathname !== '/setup.html' && !isPublicPath(pathname) && !pathname.startsWith('/api/')) {
    res.writeHead(302, { 'Location': '/setup.html' });
    res.end();
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    const parts = pathname.slice(5).split('/'); // strip /api/

    // === Manifest endpoints (v2) ===
    // These take precedence over legacy flat endpoints when a manifest file exists.

    // GET /api/manifests — list of all registered manifests
    if (parts[0] === 'manifests' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, { entries: registry.list(), errors: registry.errors() });
    }

    // GET /api/views/:viewName — cards that opt into a named view
    if (parts[0] === 'views' && parts.length === 2 && req.method === 'GET') {
      const viewName = parts[1];
      const valid = ['view', 'trends', 'calendar', 'reports', 'dayDetail'];
      if (!valid.includes(viewName)) return send404(res, 'unknown view');
      return sendJSON(res, { cards: registry.listForView(viewName) });
    }

    // GET /api/manifests/:id — full manifest
    if (parts[0] === 'manifests' && parts.length === 2 && req.method === 'GET') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      return sendJSON(res, entry);
    }

    // GET /api/manifests/:id/data — data block only
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'data' && req.method === 'GET') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      return sendJSON(res, { data: entry.data });
    }

    // POST /api/manifests/:id/data — full rewrite (honours meta.writeable.fromWebapp)
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'data' && req.method === 'POST') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      const w = entry.meta.writeable;
      if (!w || !w.fromWebapp) return sendJSON(res, { error: 'not writeable from webapp' }, 403);
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!('data' in parsed)) return sendJSON(res, { error: 'missing data field in body' }, 400);
          registry.writeData(parts[1], parsed.data);
          return sendJSON(res, { ok: true, id: parts[1] });
        } catch (e) {
          return sendJSON(res, { error: e.message || 'invalid request' }, 400);
        }
      });
      return;
    }

    // === End manifest endpoints ===

    // === Setup wizard + Settings endpoints ===

    // GET /api/setup — is this a first-run, and what options are available?
    if (parts[0] === 'setup' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, {
        firstRun: wizard.isFirstRun(),
        options: wizard.listOptions(),
      });
    }

    // POST /api/setup/install — body: { ids: [...] } — materialise chosen files
    if (parts[0] === 'setup' && parts[1] === 'install' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { ids } = JSON.parse(body || '{}');
          if (!Array.isArray(ids)) return sendJSON(res, { error: 'ids[] required' }, 400);
          const result = wizard.installSelected(ids);
          try { registry.reload(); } catch {}
          return sendJSON(res, result);
        } catch (e) {
          return sendJSON(res, { error: e.message }, 400);
        }
      });
      return;
    }

    // GET /api/settings/cards — list cards with enabled state + archive status
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 2 && req.method === 'GET') {
      const cards = registry.list().map(c => ({ id: c.id, label: c.meta.label, emoji: c.meta.emoji || null, hasData: c.hasData }));
      // Also include archived cards
      let archived = [];
      try {
        const archiveDir = PATHS.ARCHIVE_DIR;
        if (fs.existsSync(archiveDir)) {
          const items = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
          archived = items.map(f => ({ file: f }));
        }
      } catch {}
      return sendJSON(res, { active: cards, archived });
    }

    // POST /api/settings/cards/:id/archive — archive the card (moves to _archive/)
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 4 && parts[3] === 'archive' && req.method === 'POST') {
      try {
        const entry = registry.get(parts[2]);
        if (!entry) return send404(res, 'card not found');
        const src = path.join(DATA_DIR, `${parts[2]}.json`);
        const archiveDir = PATHS.ARCHIVE_DIR;
        fs.mkdirSync(archiveDir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const dst = path.join(archiveDir, `${parts[2]}.${stamp}.json`);
        fs.renameSync(src, dst);
        registry.reload();
        return sendJSON(res, { ok: true, archivedTo: path.basename(dst) });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // POST /api/settings/cards/:id/restore?file=archived-filename — pull from archive
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 4 && parts[3] === 'restore' && req.method === 'POST') {
      try {
        const fileParam = url.searchParams.get('file');
        if (!fileParam) return sendJSON(res, { error: 'file query param required' }, 400);
        const src = path.join(PATHS.ARCHIVE_DIR, fileParam);
        if (!src.startsWith(PATHS.ARCHIVE_DIR)) return sendJSON(res, { error: 'invalid file' }, 400);
        if (!fs.existsSync(src)) return send404(res, 'archived file not found');
        const dst = path.join(DATA_DIR, `${parts[2]}.json`);
        if (fs.existsSync(dst)) return sendJSON(res, { error: 'card already active' }, 409);
        fs.renameSync(src, dst);
        registry.reload();
        return sendJSON(res, { ok: true });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // === End setup + settings endpoints ===

    // Simple JSON file endpoints
    const simpleFiles = {
      'config': 'config.json',
      'supplements': 'supplements.json',
      'weight': 'weight.json',
      'bloods': 'bloods.json',
      'appointments': 'appointments.json',
      'goals': 'goals.json',
      'peptides': 'peptides.json',
    };

    if (parts.length === 1 && simpleFiles[parts[0]]) {
      const data = readJSONFile(path.join(DATA_DIR, simpleFiles[parts[0]]));
      if (data) {
        // Transparent v2 unwrap: if the file is a v2 manifest, return only
        // the data block to keep legacy clients (and the current UI) happy.
        if (data && typeof data === 'object' && data.$schema === 'eddzhealth.datafile.v1') {
          let payload = data.data;
          // Special-case: the legacy frontend expects peptides.json to have
          // 'peptides' and 'injection_groups' keys. The v2 manifest uses
          // 'items' and 'groups'. Alias them back here for the legacy UI.
          if (parts[0] === 'peptides' && payload && typeof payload === 'object') {
            const aliased = {
              ...payload,
              peptides: Array.isArray(payload.items) ? payload.items : (payload.peptides || []),
              injection_groups: Array.isArray(payload.groups)
                ? payload.groups.map(g => ({
                    name: g.label || g.name || g.id,
                    peptides: g.items || g.peptides || [],
                    timing: g.timing,
                    draw_order: g.draw_order,
                    max_units: g.max_units,
                    notes: g.notes,
                  }))
                : (payload.injection_groups || []),
            };
            return sendJSON(res, aliased);
          }
          return sendJSON(res, payload);
        }
        return sendJSON(res, data);
      }
      return send404(res);
    }

    // GET /api/info — list all info dates
    if (parts[0] === 'info' && parts.length === 1) {
      const dates = listDatesInDir(path.join(DATA_DIR, 'info'));
      return sendJSON(res, dates);
    }

    // GET /api/info/:date
    if (parts[0] === 'info' && parts.length === 2) {
      const data = readJSONFile(path.join(DATA_DIR, 'info', `${parts[1]}.json`));
      if (data) return sendJSON(res, data);
      return send404(res);
    }

    // Auto-export endpoints: sleep, workouts, vitals, activity
    const autoExportTypes = ['sleep', 'workouts', 'vitals', 'activity'];
    if (autoExportTypes.includes(parts[0])) {
      const dir = path.join(DATA_DIR, 'auto-export', parts[0]);

      // GET /api/{type}/range/:start/:end
      if (parts[1] === 'range' && parts.length === 4) {
        return sendJSON(res, getDateRange(dir, parts[2], parts[3]));
      }

      // GET /api/{type}/:date
      if (parts.length === 2) {
        const data = readJSONFile(path.join(dir, `${parts[1]}.json`));
        if (data) return sendJSON(res, data);
        return send404(res);
      }
    }

    // GET /api/weight/range/:start/:end
    if (parts[0] === 'weight' && parts[1] === 'range' && parts.length === 4) {
      return sendJSON(res, getWeightRange(parts[2], parts[3]));
    }

    // GET /api/injection-log — get all injection check-offs
    // Prefers legacy injection-log.json if present; otherwise synthesises the
    // legacy shape from peptides.items[].doses[] (after migration).
    if (parts[0] === 'injection-log' && parts.length === 1 && req.method === 'GET') {
      const legacy = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      if (legacy && Object.keys(legacy).length > 0) {
        return sendJSON(res, legacy);
      }
      return sendJSON(res, synthesiseLegacyInjectionLog());
    }

    // GET /api/injection-log/range/:start/:end — get injection log for date range
    if (parts[0] === 'injection-log' && parts[1] === 'range' && parts.length === 4 && req.method === 'GET') {
      let data = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json')) || {};
      if (Object.keys(data).length === 0) {
        data = synthesiseLegacyInjectionLog();
      }
      const [, , start, end] = parts;
      const result = {};
      for (const [date, entries] of Object.entries(data)) {
        if (date >= start && date <= end) result[date] = entries;
      }
      return sendJSON(res, result);
    }

    // POST /api/injection-log/:date — toggle an injection check-off
    // Body: { "peptide": "BPC-157", "taken": true }
    if (parts[0] === 'injection-log' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { peptide, taken } = JSON.parse(body);
          if (!peptide) return sendJSON(res, { error: 'peptide required' }, 400);
          const filePath = path.join(DATA_DIR, 'injection-log.json');
          const data = readLegacyJSONFile(filePath) || {};
          const date = parts[1];
          if (!data[date]) data[date] = {};
          if (taken) {
            data[date][peptide] = { taken: true, time: new Date().toISOString() };
          } else {
            delete data[date][peptide];
            if (Object.keys(data[date]).length === 0) delete data[date];
          }
          writeLegacyJSONFile(filePath, data);

          // Write-through to v2 peptides manifest (if present) so the new
          // schedule-timeline/adherence-report see the same check-offs.
          try {
            const peptidesPath = path.join(DATA_DIR, 'peptides.json');
            const raw = readJSONFile(peptidesPath);
            if (raw && raw.$schema === 'eddzhealth.datafile.v1') {
              const items = Array.isArray(raw.data?.items) ? raw.data.items : [];
              const item = items.find(i => i.name === peptide);
              if (item) {
                item.doses = Array.isArray(item.doses) ? item.doses : [];
                const idx = item.doses.findIndex(d => d.scheduledDate === date);
                if (taken) {
                  const now = new Date().toISOString();
                  if (idx >= 0) item.doses[idx] = { ...item.doses[idx], takenAt: now };
                  else item.doses.push({ scheduledDate: date, takenAt: now });
                } else if (idx >= 0) {
                  item.doses.splice(idx, 1);
                }
                const tmp = peptidesPath + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
                fs.renameSync(tmp, peptidesPath);
              }
            }
          } catch (syncErr) {
            console.warn('[sync] peptides manifest update failed:', syncErr.message);
          }

          return sendJSON(res, { ok: true, date, peptide, taken: !!taken });
        } catch (e) {
          console.error('injection-log POST error:', e.message);
          return sendJSON(res, { error: e.message || 'Invalid request' }, 400);
        }
      });
      return;
    }

    // GET /api/injection-log/:date — get injection check-offs for a specific date
    if (parts[0] === 'injection-log' && parts.length === 2 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      let dateLog = (data || {})[parts[1]] || null;
      if (!dateLog) {
        // Fallback to synthesised view
        const synth = synthesiseLegacyInjectionLog();
        dateLog = synth[parts[1]] || {};
      }
      return sendJSON(res, dateLog);
    }

    // GET /api/calendar/health — fetch health-related events from Google Calendar
    if (parts[0] === 'calendar' && parts[1] === 'health' && parts.length === 2) {
      try {
        const script = `
import sys, json
sys.path.insert(0, '/home/minecraft/axis/skills/google-core/scripts')
from gmail_utils import list_events
from datetime import datetime, timezone, timedelta

tz = timezone(timedelta(hours=11))
now = datetime.now(tz)
end = now + timedelta(days=30)

events = list_events(account_name='edward', time_min=now.isoformat(), time_max=end.isoformat())

health_keywords = ['doctor', 'gp', 'dentist', 'physio', 'chiro', 'osteo', 'blood', 'bloods',
  'pathology', 'specialist', 'dermatologist', 'appointment', 'health', 'medical', 'hospital',
  'surgery', 'checkup', 'check-up', 'therapy', 'psych', 'counsell', 'optom', 'eye test',
  'vaccination', 'vaccine', 'injection', 'scan', 'x-ray', 'xray', 'mri', 'ct scan',
  'ultrasound', 'endoscop', 'colonoscop', 'pharmacy', 'prescription', 'sleep study',
  'dietitian', 'nutritionist', 'podiatrist', 'massage', 'acupuncture', 'gym', 'personal train']

results = []
for e in events:
    summary = (e.get('summary') or '').lower()
    desc = (e.get('description') or '').lower()
    loc = (e.get('location') or '').lower()
    combined = summary + ' ' + desc + ' ' + loc
    if any(kw in combined for kw in health_keywords):
        results.append({
            'summary': e.get('summary'),
            'start': e.get('start', {}).get('dateTime', e.get('start', {}).get('date')),
            'end': e.get('end', {}).get('dateTime', e.get('end', {}).get('date')),
            'location': e.get('location'),
            'description': e.get('description'),
            'id': e.get('id'),
        })

print(json.dumps(results))
`;
        const result = execSync(`python3 -c ${JSON.stringify(script)}`, {
          timeout: 15000,
          encoding: 'utf8',
        });
        return sendJSON(res, JSON.parse(result.trim()));
      } catch (e) {
        console.error('Calendar fetch error:', e.message);
        return sendJSON(res, []);
      }
    }

    // GET /api/mood/range/:start/:end — get mood for date range
    if (parts[0] === 'mood' && parts[1] === 'range' && parts.length === 4 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'mood.json')) || {};
      const [, , start, end] = parts;
      const result = {};
      for (const [date, entry] of Object.entries(data)) {
        if (date >= start && date <= end) result[date] = entry;
      }
      return sendJSON(res, result);
    }

    // GET /api/mood/:date — get mood check-in for a date
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'mood.json'));
      const entry = (data || {})[parts[1]] || null;
      return sendJSON(res, entry);
    }

    // POST /api/mood/:date — save mood check-in
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { mood, notes, wakeUps } = JSON.parse(body);
          if (!mood) return sendJSON(res, { error: 'mood required' }, 400);
          const filePath = path.join(DATA_DIR, 'mood.json');
          let data = {};
          try { data = readLegacyJSONFile(filePath) || {}; } catch {}
          const entry = { mood, notes: notes || '', time: new Date().toISOString() };
          if (wakeUps !== null && wakeUps !== undefined) entry.wakeUps = wakeUps;
          data[parts[1]] = entry;
          try {
            writeLegacyJSONFile(filePath, data);
          } catch (writeErr) {
            // If file doesn't exist or isn't writable, try creating it fresh
            console.error('Mood write error, attempting create:', writeErr.message);
            writeLegacyJSONFile(filePath, data);
          }
          return sendJSON(res, { ok: true });
        } catch (e) {
          console.error('Mood POST error:', e.message);
          return sendJSON(res, { error: e.message || 'Invalid request' }, 400);
        }
      });
      return;
    }

    // DELETE /api/mood/:date
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'DELETE') {
      try {
        const filePath = path.join(DATA_DIR, 'mood.json');
        let data = {};
        try { data = readLegacyJSONFile(filePath) || {}; } catch {}
        delete data[parts[1]];
        writeLegacyJSONFile(filePath, data);
        return sendJSON(res, { ok: true });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 400);
      }
    }

    // GET /api/notes/:date
    if (parts[0] === 'notes' && parts.length === 2 && req.method === 'GET') {
      const filePath = path.join(DATA_DIR, 'daily-notes.json');
      const data = readLegacyJSONFile(filePath) || {};
      return sendJSON(res, data[parts[1]] || { text: '' });
    }

    // POST /api/notes/:date
    if (parts[0] === 'notes' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          const filePath = path.join(DATA_DIR, 'daily-notes.json');
          let data = {};
          try { data = readLegacyJSONFile(filePath) || {}; } catch {}
          if (text && text.trim()) {
            data[parts[1]] = { text: text.trim(), updated: new Date().toISOString() };
          } else {
            delete data[parts[1]];
          }
          writeLegacyJSONFile(filePath, data);
          return sendJSON(res, { ok: true });
        } catch (e) {
          return sendJSON(res, { error: e.message }, 400);
        }
      });
      return;
    }

    // POST /api/chat — proxy to OpenClaw gateway chat completions
    // Body: { messages: [...], voiceMode?: boolean }
    //   voiceMode=true → append "keep replies short/conversational" to system prompt
    if (parts[0] === 'chat' && parts.length === 1 && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { messages, voiceMode } = parsed;
          if (!Array.isArray(messages) || messages.length === 0) {
            return sendJSON(res, { error: 'messages required' }, 400);
          }

          let systemPrompt = HEALTH_SYSTEM_PROMPT;
          if (voiceMode) {
            systemPrompt = `You are ${process.env.CHAT_AGENT_NAME || 'Axis'}, a health assistant.
Voice mode is active: the user is speaking to you and will hear your reply aloud.

OUTPUT FORMAT — MANDATORY:
Reply with a single JSON object and nothing else. Schema:
{
  "speak":   "what should be spoken aloud (plain prose, no markdown, no emoji, no code, no URLs)",
  "display": "what should appear in the chat bubble (same answer, may include emoji / light markdown / short URLs)"
}

Voice-reply rules:
- speak is 1-3 short conversational sentences, 40 words MAX.
- No bullet points, no markdown, no code blocks, no headings in speak.
- Spell out abbreviations in speak (BP -> "blood pressure", HRV -> "heart rate variability", kg, lbs).
- No emoji, no URLs, no file paths in speak.
- If the answer is long, give the headline in speak + "ask me for details" — never cram.

Conversational allow-list (reply naturally, no disclaimer footer, no "let me check my data"):
- Thanks / cheers / awesome / nice / good one / ok -> a short friendly ack like "no worries" or "any time".
- Hi / hey / hello / morning / night -> a matching greeting.
- Emoji-only or one-word reactions -> a matching short reaction.

NEVER INVENT any of these phrases in either field:
- "No response from ${process.env.CHAT_AGENT_NAME || 'Axis'}" / "No response from OpenClaw" / similar
- "Gateway unavailable" / "Loading…" / "Please wait" / anything that reads like a UI state
- Error-looking lines or apologies for non-errors

Return STRICTLY the JSON object. No leading/trailing text. No markdown fences.

Original system prompt follows:

` + HEALTH_SYSTEM_PROMPT;
          }

          // Prepend system prompt
          const fullMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
          ];

          const payload = JSON.stringify({
            model: OPENCLAW_MODEL,
            messages: fullMessages,
          });

          const options = {
            hostname: OPENCLAW_HOST,
            port: OPENCLAW_PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
              'Content-Length': Buffer.byteLength(payload),
              'Connection': 'close',
            },
            rejectUnauthorized: false, // self-signed TLS
            agent: false, // disable keep-alive — stale pooled connections hang on self-signed gateways
          };

          const proxyReq = https.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', c => data += c);
            proxyRes.on('end', () => {
              try {
                const result = JSON.parse(data);
                const rawReply = result.choices?.[0]?.message?.content || '';
                if (voiceMode) {
                  // Parse { speak, display } JSON. The model is instructed to
                  // output nothing but the JSON object; handle stray text + code
                  // fences defensively.
                  const parsed = extractJsonReply(rawReply);
                  if (parsed && (parsed.speak || parsed.display)) {
                    const speak = (parsed.speak || parsed.display || '').trim();
                    const display = (parsed.display || parsed.speak || '').trim();
                    return sendJSON(res, { reply: display, speak });
                  }
                  // Fallback if the model didn't produce JSON: use the raw text
                  // for both (with light emoji stripping for speak)
                  const speak = rawReply.replace(/\p{Extended_Pictographic}/gu, '').trim();
                  return sendJSON(res, { reply: rawReply || 'No response', speak });
                }
                sendJSON(res, { reply: rawReply || 'No response' });
              } catch (e) {
                console.error('Chat parse error:', e.message);
                sendJSON(res, { error: 'Failed to parse response' }, 500);
              }
            });
          });

          proxyReq.on('error', (e) => {
            console.error('Chat proxy error:', e.message);
            sendJSON(res, { error: 'Gateway unavailable' }, 502);
          });

          proxyReq.setTimeout(120000, () => {
            proxyReq.destroy();
            sendJSON(res, { error: 'Request timed out' }, 504);
          });

          proxyReq.write(payload);
          proxyReq.end();
        } catch (e) {
          sendJSON(res, { error: 'Invalid request' }, 400);
        }
      });
      return;
    }

    // === Voice endpoints ===

    // GET /api/voice/config — current Fish Audio status (backend tier, credit, voiceId)
    if (parts[0] === 'voice' && parts[1] === 'config' && parts.length === 2 && req.method === 'GET') {
      voice.getStatus().then(s => sendJSON(res, s)).catch(e => sendJSON(res, { error: e.message }, 500));
      return;
    }

    // POST /api/voice/tts — body { text } -> JSON { key, url, contentType, byteLength }
    // Generates TTS, caches the buffer, returns a GET URL the client can set
    // as an <audio> src. The GET endpoint below serves with Content-Length +
    // Range support (critical for iOS auto-play).
    if (parts[0] === 'voice' && parts[1] === 'tts' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { text, format } = JSON.parse(body);
          if (!text || typeof text !== 'string' || !text.trim()) {
            return sendJSON(res, { error: 'text required' }, 400);
          }
          const capped = text.slice(0, 4000);
          const fmt = format === 'wav' ? 'wav' : 'mp3';
          const voiceId = require('./voice/fish').getCurrentBackend ? undefined : undefined;
          const key = voiceCache.hashKey(capped, 'default', fmt);
          let entry = voiceCache.get(key);
          if (!entry) {
            const { buffer, contentType } = await voice.ttsBuffer({ text: capped, format: fmt });
            voiceCache.set(key, buffer, contentType || `audio/${fmt === 'wav' ? 'wav' : 'mpeg'}`);
            entry = voiceCache.get(key);
          }
          return sendJSON(res, {
            key,
            url: `/api/voice/tts/${key}`,
            contentType: entry.contentType,
            byteLength: entry.buffer.length,
          });
        } catch (e) {
          console.error('[voice] tts error:', e.message);
          return sendJSON(res, { error: e.message || 'tts failed' }, 500);
        }
      });
      return;
    }

    // GET /api/voice/tts/:key — serves cached TTS bytes with full Content-Length
    // and Range support. iOS's media pipeline probes with Range: bytes=0-1
    // before issuing the full fetch; we must honour it with 206 Partial Content
    // or auto-play silently fails.
    if (parts[0] === 'voice' && parts[1] === 'tts' && parts.length === 3 && req.method === 'GET') {
      const entry = voiceCache.get(parts[2]);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      const total = entry.buffer.length;
      const rangeHeader = req.headers['range'];

      // Handle Range: bytes=start-end (end optional)
      if (rangeHeader) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
          if (start >= total || start > end) {
            res.writeHead(416, {
              'Content-Range': `bytes */${total}`,
              'Content-Type': entry.contentType,
            });
            return res.end();
          }
          const chunk = entry.buffer.slice(start, end + 1);
          res.writeHead(206, {
            'Content-Type': entry.contentType,
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          });
          return res.end(chunk);
        }
      }

      // Full response
      res.writeHead(200, {
        'Content-Type': entry.contentType,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      });
      return res.end(entry.buffer);
    }

    // POST /api/voice/asr — body: raw audio bytes -> { text }
    if (parts[0] === 'voice' && parts[1] === 'asr' && parts.length === 2 && req.method === 'POST') {
      const chunks = [];
      let total = 0;
      const MAX = 20 * 1024 * 1024;
      req.on('data', c => {
        total += c.length;
        if (total > MAX) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        try {
          let audio = Buffer.concat(chunks);
          if (audio.length === 0) return sendJSON(res, { error: 'empty audio' }, 400);

          // Fish ASR is fussy about input codec. Transcode everything to
          // 16kHz mono 16-bit WAV (the only format Fish ASR reliably accepts)
          // unless the body is already WAV.
          const incomingType = (req.headers['content-type'] || '').toLowerCase();
          const isWav =
            incomingType.includes('wav') ||
            incomingType.includes('x-wav') ||
            (audio.length >= 12 && audio.slice(0, 4).toString() === 'RIFF' && audio.slice(8, 12).toString() === 'WAVE');

          if (!isWav) {
            try {
              audio = await transcodeToWav(audio);
            } catch (tErr) {
              console.error('[voice] ffmpeg transcode failed:', tErr.message);
              return sendJSON(res, { error: 'audio transcode failed: ' + tErr.message }, 500);
            }
          }

          const { text, duration } = await voice.asr({ audio, language: 'en' });
          return sendJSON(res, { text, duration });
        } catch (e) {
          console.error('[voice] asr error:', e.message);
          return sendJSON(res, { error: e.message || 'asr failed' }, 500);
        }
      });
      return;
    }

    // === End voice endpoints ===

    // GET /api/reports — list available report files
    if (parts[0] === 'reports' && parts.length === 1) {
      try {
        // Exclude system prompt / internal files
        const EXCLUDED = new Set(['PEPI_SYSTEM_PROMPT_FOR_ONYX.md', 'PROFILE.md']);
        const files = fs.readdirSync(REPORTS_DIR)
          .filter(f => f.endsWith('.md') && !f.startsWith('.') && !EXCLUDED.has(f));
        const reports = files.map(f => {
          const name = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1] : name;
          // Extract date from filename if present
          const dateMatch = name.match(/\d{4}-\d{2}-\d{2}/);
          return {
            name,
            title,
            date: dateMatch ? dateMatch[0] : null,
            url: `/report/${name}`,
          };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return sendJSON(res, reports);
      } catch {
        return sendJSON(res, []);
      }
    }

    return send404(res);
  }

  // /register -> serve setup.html (keeps the URL clean for invite links)
  if (pathname === '/register') {
    const fp = path.join(PUBLIC_DIR, 'setup.html');
    return serveStaticFile(res, fp) || send404(res);
  }

  // Report routes: /report/<name> serves REPORTS_DIR/<name>.md as styled HTML
  if (pathname.startsWith('/report/')) {
    const reportName = pathname.replace('/report/', '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!reportName) return send404(res, 'Report not found');

    // Try multiple naming patterns
    const candidates = [
      path.join(REPORTS_DIR, `${reportName}.md`),
      path.join(REPORTS_DIR, `${reportName.toUpperCase()}.md`),
      path.join(REPORTS_DIR, reportName.replace(/^debrief-/, 'DEBRIEF-') + '.md'),
    ];

    let md = null;
    for (const candidate of candidates) {
      try {
        if (candidate.startsWith(REPORTS_DIR)) {
          md = fs.readFileSync(candidate, 'utf8');
          break;
        }
      } catch {}
    }

    if (!md) return send404(res, 'Report not found');

    const content = marked.parse(md);
    const html = renderReportPage(reportName, content);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Static file serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send404(res);
  }

  if (serveStaticFile(res, filePath)) return;

  // SPA fallback: serve index.html for client-side routes
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  serveStaticFile(res, indexPath);
});

server.listen(PORT, HOST, () => {
  console.log(`Health dashboard running at http://${HOST}:${PORT}`);
  // Initialise manifest registry (discovers + watches data files)
  try {
    const stats = registry.init();
    console.log(`[manifest] loaded ${stats.count} card(s); ${stats.errors} error(s)`);
  } catch (e) {
    console.error('[manifest] init failed:', e.message);
  }
  // Ensure mood.json exists and is writable
  const moodPath = path.join(DATA_DIR, 'mood.json');
  try {
    if (!fs.existsSync(moodPath)) {
      fs.writeFileSync(moodPath, '{}', { mode: 0o644 });
      console.log('Created mood.json');
    } else {
      // Test write access
      const data = JSON.parse(fs.readFileSync(moodPath, 'utf8'));
      fs.writeFileSync(moodPath, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.error('mood.json access issue:', e.message, '- recreating');
    try { fs.unlinkSync(moodPath); } catch {}
    fs.writeFileSync(moodPath, '{}', { mode: 0o644 });
  }
});
