const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { execSync } = require('child_process');
const { isAuthenticated, isPublicPath, handleAuthRoutes, isSetup } = require('./auth/webauthn');

// chat-gateway gateway config
const CHAT_GATEWAY_HOST = 'localhost';
const CHAT_GATEWAY_PORT = 18789;
const CHAT_GATEWAY_TOKEN = '***REMOVED-TOKEN***';
const CHAT_GATEWAY_MODEL = 'your-model-id-here';

const HEALTH_SYSTEM_PROMPT = `You are Axis, a health assistant embedded in Eddy's vorHealth dashboard.
You have access to Eddy's health data files at ~/axis/workspace/.private/health/data/.
Key files: supplements.json, peptides.json, weight.json, config.json, injection-log.json, bloods.json, appointments.json.
Auto-export data (from Apple Health): auto-export/sleep/, auto-export/workouts/, auto-export/vitals/, auto-export/activity/.

You can help Eddy with:
- Adding/updating supplements, weight entries, appointments
- Answering questions about his health data, peptide cycles, supplement schedule
- Looking up blood work results and trends
- Checking injection schedules and logs

Keep responses concise. You're in a small chat widget, not a full conversation.
Use simple formatting: bullet lists with - dashes, **bold** for emphasis. No headers (#). No tables.
Use Australian English. Be direct and helpful.`;


const PORT = 10002;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(process.env.HOME, 'axis/workspace/.private/health/data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = path.join(DATA_DIR, '..');

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
  return weights.filter(w => w.date >= start && w.date <= end);
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
      if (data) return sendJSON(res, data);
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
    if (parts[0] === 'injection-log' && parts.length === 1 && req.method === 'GET') {
      const data = readJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      return sendJSON(res, data || {});
    }

    // GET /api/injection-log/range/:start/:end — get injection log for date range
    if (parts[0] === 'injection-log' && parts[1] === 'range' && parts.length === 4 && req.method === 'GET') {
      const data = readJSONFile(path.join(DATA_DIR, 'injection-log.json')) || {};
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
          const data = readJSONFile(filePath) || {};
          const date = parts[1];
          if (!data[date]) data[date] = {};
          if (taken) {
            data[date][peptide] = { taken: true, time: new Date().toISOString() };
          } else {
            delete data[date][peptide];
            if (Object.keys(data[date]).length === 0) delete data[date];
          }
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
      const data = readJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      const dateLog = (data || {})[parts[1]] || {};
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
      const data = readJSONFile(path.join(DATA_DIR, 'mood.json')) || {};
      const [, , start, end] = parts;
      const result = {};
      for (const [date, entry] of Object.entries(data)) {
        if (date >= start && date <= end) result[date] = entry;
      }
      return sendJSON(res, result);
    }

    // GET /api/mood/:date — get mood check-in for a date
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'GET') {
      const data = readJSONFile(path.join(DATA_DIR, 'mood.json'));
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
          try { data = readJSONFile(filePath) || {}; } catch {}
          const entry = { mood, notes: notes || '', time: new Date().toISOString() };
          if (wakeUps !== null && wakeUps !== undefined) entry.wakeUps = wakeUps;
          data[parts[1]] = entry;
          try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          } catch (writeErr) {
            // If file doesn't exist or isn't writable, try creating it fresh
            console.error('Mood write error, attempting create:', writeErr.message);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o666 });
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
        try { data = readJSONFile(filePath) || {}; } catch {}
        delete data[parts[1]];
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return sendJSON(res, { ok: true });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 400);
      }
    }

    // GET /api/notes/:date
    if (parts[0] === 'notes' && parts.length === 2 && req.method === 'GET') {
      const filePath = path.join(DATA_DIR, 'daily-notes.json');
      const data = readJSONFile(filePath) || {};
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
          try { data = readJSONFile(filePath) || {}; } catch {}
          if (text && text.trim()) {
            data[parts[1]] = { text: text.trim(), updated: new Date().toISOString() };
          } else {
            delete data[parts[1]];
          }
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          return sendJSON(res, { ok: true });
        } catch (e) {
          return sendJSON(res, { error: e.message }, 400);
        }
      });
      return;
    }

    // POST /api/chat — proxy to chat-gateway gateway chat completions
    if (parts[0] === 'chat' && parts.length === 1 && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { messages } = JSON.parse(body);
          if (!Array.isArray(messages) || messages.length === 0) {
            return sendJSON(res, { error: 'messages required' }, 400);
          }

          // Prepend system prompt
          const fullMessages = [
            { role: 'system', content: HEALTH_SYSTEM_PROMPT },
            ...messages,
          ];

          const payload = JSON.stringify({
            model: CHAT_GATEWAY_MODEL,
            messages: fullMessages,
          });

          const options = {
            hostname: CHAT_GATEWAY_HOST,
            port: CHAT_GATEWAY_PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${CHAT_GATEWAY_TOKEN}`,
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
                const reply = result.choices?.[0]?.message?.content || 'No response';
                sendJSON(res, { reply });
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
