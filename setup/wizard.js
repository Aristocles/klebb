// setup/wizard.js
// Handles the first-run setup wizard:
//   * Detects whether $HEALTH_HOME/data/ is empty (new install)
//   * Serves a JSON list of available optional cards (from data.example/)
//   * Accepts a POST with the user's choices; materialises the chosen
//     JSON files into $HEALTH_HOME/data/
//
// This is intentionally light — UI wizard lives client-side and just calls
// GET /api/setup/options and POST /api/setup/install.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const EXAMPLE_DIR = path.join(__dirname, '..', 'data.example');
const GREETING_MESSAGES = path.join(EXAMPLE_DIR, 'greeting-messages.json');

// Human-facing catalogue: maps example filename -> { id, label, blurb, defaultChecked }
const CATALOGUE = [
  { file: 'greeting.example.json',            id: 'greeting',            label: 'Daily greeting',      blurb: 'A rotating short message at the top of Today',                 defaultChecked: true  },
  { file: 'weight.example.json',              id: 'weight',              label: 'Weight',              blurb: 'Log weight entries and chart trends',                          defaultChecked: true  },
  { file: 'bp.example.json',                  id: 'bp',                  label: 'Blood pressure',      blurb: 'Log BP readings with colour-coded thresholds',                 defaultChecked: false },
  { file: 'mood.example.json',                id: 'mood',                label: 'Mood check-ins',      blurb: 'Log how you feel each day',                                     defaultChecked: false },
  { file: 'notes.example.json',               id: 'notes',               label: 'Daily notes',         blurb: 'Freeform journaling, writeable for past/today/future',         defaultChecked: false },
  { file: 'medication-schedule.example.json', id: 'medication-schedule', label: 'Medication schedule', blurb: 'Tracked meds/drops/supplements with schedule + adherence',     defaultChecked: false },
];

function isFirstRun() {
  try {
    const files = fs.readdirSync(PATHS.DATA_DIR).filter(f => f.endsWith('.json'));
    return files.length === 0;
  } catch {
    return true;
  }
}

function listOptions() {
  const out = [];
  for (const item of CATALOGUE) {
    try {
      const src = path.join(EXAMPLE_DIR, item.file);
      if (!fs.existsSync(src)) continue;
      out.push({
        id: item.id,
        label: item.label,
        blurb: item.blurb,
        defaultChecked: item.defaultChecked,
      });
    } catch {}
  }
  return out;
}

function installSelected(ids) {
  // Ensure data dir exists
  try { fs.mkdirSync(PATHS.DATA_DIR, { recursive: true }); } catch {}

  const created = [];
  const skipped = [];
  const errors = [];

  for (const item of CATALOGUE) {
    if (!ids.includes(item.id)) continue;
    const src = path.join(EXAMPLE_DIR, item.file);
    const dst = path.join(PATHS.DATA_DIR, `${item.id}.json`);
    try {
      if (fs.existsSync(dst)) { skipped.push(item.id); continue; }
      const raw = fs.readFileSync(src, 'utf8');
      const json = JSON.parse(raw);

      // Special-case: greeting gets seeded with the 100+ messages
      if (item.id === 'greeting') {
        try {
          const msgs = JSON.parse(fs.readFileSync(GREETING_MESSAGES, 'utf8'));
          if (Array.isArray(msgs)) json.data = msgs;
        } catch {}
      }

      fs.writeFileSync(dst, JSON.stringify(json, null, 2));
      created.push(item.id);
    } catch (e) {
      errors.push({ id: item.id, error: e.message });
    }
  }
  return { created, skipped, errors };
}

module.exports = { isFirstRun, listOptions, installSelected, CATALOGUE };
