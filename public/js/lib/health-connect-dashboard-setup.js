// SPDX-License-Identifier: AGPL-3.0-only

export const DASHBOARD_METRICS = Object.freeze({
  WeightRecord: Object.freeze({ label: 'Weight', metric: 'body_mass', templateId: 'body-mass-hae' }),
  StepsRecord: Object.freeze({ label: 'Steps', metric: 'step_count', templateId: 'steps' }),
});

const SOURCE_FIELDS = ['tenantId', 'sourceStoreId', 'recordType', 'dataOrigin'];
const DISPLAY_FIELDS = [...SOURCE_FIELDS, 'switchDate', 'timeZone', 'mappingVersion'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const scalar = (value, max = 256) => typeof value === 'string' && value.length > 0
  && [...value].length <= max && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const supported = type => Object.hasOwn(DASHBOARD_METRICS, type);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function validSource(source) {
  return exact(source, SOURCE_FIELDS) && typeof source.tenantId === 'string' && UUID.test(source.tenantId)
    && typeof source.sourceStoreId === 'string' && UUID.test(source.sourceStoreId)
    && supported(source.recordType) && scalar(source.dataOrigin);
}

export function dashboardSources(payload, recordType) {
  if (!supported(recordType) || !Array.isArray(payload?.sources)
      || payload.sources.some(source => !validSource(source))) {
    throw new Error('Could not confirm the saved sources. Refresh to try again.');
  }
  const seen = new Set();
  return payload.sources.filter(source => {
    const key = JSON.stringify(SOURCE_FIELDS.map(field => source[field]));
    if (source.recordType !== recordType || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(source => ({ ...source }));
}

export function dashboardCards(entries, recordType) {
  if (!supported(recordType) || !Array.isArray(entries)) return [];
  return entries.filter(entry => typeof entry?.id === 'string' && entry.id
    && entry.meta?.ingest?.source === 'hae'
    && entry.meta.ingest.metric === DASHBOARD_METRICS[recordType].metric);
}

export function makeDisplaySelection(source, switchDate, timeZone) {
  if (!validSource(source) || !validDate(switchDate) || !scalar(timeZone, 80)) {
    throw new Error('Choose a saved source, the phone display date and a valid timezone.');
  }
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(0); }
  catch { throw new Error('Choose a valid display timezone, for example UTC.'); }
  return { ...source, switchDate, timeZone, mappingVersion: 1 };
}

function refusal(status) {
  if (status === 401) return 'Sign in to set up the dashboard.';
  if (status === 403) return 'You cannot select that saved source.';
  if (status === 409) return 'The saved history cannot provide this display choice.';
  if (status === 422) return 'Check the source, display date and timezone.';
  return 'Could not confirm the dashboard choice. Refresh or retry.';
}

async function requestJson(fetchImpl, url, options, signal) {
  if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
  const response = await fetchImpl(url, {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal,
  });
  if (!response.ok) throw new Error(refusal(response.status));
  return response.json();
}

// The ordinary owner APIs validate authority. This helper only saves a view choice.
export async function saveDashboardSelection({
  fetchImpl = fetch, cardId, recordType, selection, signal, onCreated,
}) {
  if (!supported(recordType) || !exact(selection, DISPLAY_FIELDS)
      || selection.recordType !== recordType || selection.mappingVersion !== 1) {
    throw new Error('Choose a valid Weight or Steps display.');
  }
  makeDisplaySelection(Object.fromEntries(SOURCE_FIELDS.map(key => [key, selection[key]])),
    selection.switchDate, selection.timeZone);
  let id = cardId;
  if (!id) {
    const created = await requestJson(fetchImpl, '/api/settings/cards/from-template', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: DASHBOARD_METRICS[recordType].templateId }),
    }, signal);
    if (created.ok !== true || typeof created.id !== 'string' || !created.id) {
      throw new Error('Could not confirm the new card. Refresh the card list before retrying.');
    }
    id = created.id;
    // Retain this ID even if the following PATCH or readback fails.
    if (onCreated) onCreated(id);
  }
  const url = `/api/manifests/${encodeURIComponent(id)}`;
  await requestJson(fetchImpl, url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta: { healthConnectDisplay: selection } }),
  }, signal);
  const entry = await requestJson(fetchImpl, url, { method: 'GET' }, signal);
  const effective = entry?.meta?.healthConnectDisplay;
  const card = { ...entry, id: entry?.meta?.id };
  if (card.id !== id || dashboardCards([card], recordType).length !== 1
      || !exact(effective, DISPLAY_FIELDS)
      || DISPLAY_FIELDS.some(key => effective[key] !== selection[key])) {
    throw new Error('The effective choice differs from the request. Refresh before retrying.');
  }
  return card;
}
