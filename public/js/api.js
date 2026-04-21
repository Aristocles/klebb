// API client helper
const api = {
  async get(path) {
    const res = await fetch(`/api/${path}`);
    if (!res.ok) return null;
    return res.json();
  },

  config: () => api.get('config'),
  supplements: () => api.get('supplements'),
  weight: () => api.get('weight'),
  bloods: () => api.get('bloods'),
  appointments: () => api.get('appointments'),
  goals: () => api.get('goals'),
  peptides: () => api.get('peptides'),
  reports: () => api.get('reports'),
  mood: (date) => api.get(`mood/${date}`),
  async saveMood(date, mood, notes, wakeUps) {
    const res = await fetch(`/api/mood/${date}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mood, notes, wakeUps }),
    });
    return res.json();
  },
  moodRange: (start, end) => api.get(`mood/range/${start}/${end}`),
  notes: (date) => api.get(`notes/${date}`),
  async saveNotes(date, text) {
    const res = await fetch(`/api/notes/${date}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.json();
  },
  injectionLog: (date) => api.get(`injection-log/${date}`),
  injectionLogRange: (start, end) => api.get(`injection-log/range/${start}/${end}`),
  injectionLogAll: () => api.get('injection-log'),
  async toggleInjection(date, peptide, taken) {
    const res = await fetch(`/api/injection-log/${date}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peptide, taken }),
    });
    return res.json();
  },
  infoDates: () => api.get('info'),
  info: (date) => api.get(`info/${date}`),
  sleep: (date) => api.get(`sleep/${date}`).then(mergeSleepEntries),
  workouts: (date) => api.get(`workouts/${date}`),
  vitals: (date) => api.get(`vitals/${date}`),
  activity: (date) => api.get(`activity/${date}`),
  sleepRange: (start, end) => api.get(`sleep/range/${start}/${end}`).then(data => {
    if (!data || typeof data !== 'object') return data;
    const merged = {};
    for (const [date, entries] of Object.entries(data)) {
      merged[date] = Array.isArray(entries) ? (mergeSleepEntries(entries) ? [mergeSleepEntries(entries)] : entries) : entries;
    }
    return merged;
  }),
  workoutsRange: (start, end) => api.get(`workouts/range/${start}/${end}`),
  vitalsRange: (start, end) => api.get(`vitals/range/${start}/${end}`),
  activityRange: (start, end) => api.get(`activity/range/${start}/${end}`),
  weightRange: (start, end) => api.get(`weight/range/${start}/${end}`),
};

// Date helpers
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function getMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toLocaleDateString('en-CA');
}

function getSunday(mondayStr) {
  const d = new Date(mondayStr + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return d.toLocaleDateString('en-CA');
}

function calculateIntensity(workouts, config) {
  if (!workouts || workouts.length === 0) return null;
  const totalMinutes = workouts.reduce((s, w) => s + (w.durationMin || 0), 0);
  const maxHR = Math.max(...workouts.map(w => w.avgHeartRate || 0));
  if (totalMinutes >= config.workout_intensity.beast_above_minutes || maxHR > 140) return '🌋';
  if (totalMinutes >= config.workout_intensity.moderate_max_minutes || maxHR > 110) return '🔥';
  if (totalMinutes > 0) return '🧊';
  return null;
}

function classifyWorkout(name, config) {
  if (config.workout_categories.cardio.includes(name)) return 'cardio';
  if (config.workout_categories.strength.includes(name)) return 'strength';
  return 'strength'; // default to strength
}

function formatHours(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${mins}m`;
}

export { api, today, formatDate, daysAgo, getMonday, getSunday, calculateIntensity, classifyWorkout, formatHours };

/**
 * Merge multiple sleep entries for the same day.
 * AutoSleep provides accurate total/inBed/times but no stages.
 * Apple Watch provides stage breakdown (core/rem/deep) but less accurate totals.
 * Strategy: use AutoSleep as base for times/totals, overlay Apple Watch stages.
 * Returns a single merged object (not an array).
 */
function mergeSleepEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  // Find the entry with stage data (Apple Watch) and the one without (AutoSleep)
  const withStages = entries.find(e => (e.core > 0 || e.rem > 0 || e.deep > 0));
  const autoSleep = entries.find(e => e.source === 'AutoSleep') || entries.find(e => e.core === 0 && e.rem === 0 && e.deep === 0);

  if (!withStages && autoSleep) return autoSleep;
  if (withStages && !autoSleep) return withStages;
  if (!withStages && !autoSleep) return entries[0];

  // Merge: AutoSleep times/totals + Apple Watch stages
  return {
    ...autoSleep,
    core: withStages.core || 0,
    rem: withStages.rem || 0,
    deep: withStages.deep || 0,
    awake: withStages.awake || autoSleep.awake || 0,
  };
}
