// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// Pure relation for already resolved, validated common UTC nanoseconds.
// null footprint means genuinely missing common time, never malformed data.
// NO_MATCH does not grant admission or clear an existing suppression reason.
function classifyKnownPeriod(footprint, requestedPeriod, cutoffNs) {
  if (typeof cutoffNs !== 'bigint' || (requestedPeriod !== null &&
      (typeof requestedPeriod !== 'object' ||
       typeof requestedPeriod.startNs !== 'bigint' ||
       typeof requestedPeriod.endNs !== 'bigint' ||
       requestedPeriod.startNs >= requestedPeriod.endNs))) {
    throw new TypeError('Invalid parsed temporal-policy input');
  }
  if (footprint === null) return 'UNKNOWN';
  if (typeof footprint !== 'object' ||
      (footprint.kind === 'instant' ? typeof footprint.timeNs !== 'bigint' :
       footprint.kind !== 'interval' || typeof footprint.startNs !== 'bigint' ||
       typeof footprint.endNs !== 'bigint' || footprint.startNs >= footprint.endNs)) {
    throw new TypeError('Invalid parsed common period');
  }
  const start = requestedPeriod === null ? null : requestedPeriod.startNs;
  const end = requestedPeriod === null || cutoffNs < requestedPeriod.endNs ?
    cutoffNs : requestedPeriod.endNs;
  if (start !== null && start >= end) return 'NO_MATCH';
  const overlaps = footprint.kind === 'instant' ?
    (start === null || start <= footprint.timeNs) && footprint.timeNs < end :
    (start === null || start < footprint.endNs) && footprint.startNs < end;
  return overlaps ? 'MATCH' : 'NO_MATCH';
}

module.exports = { classifyKnownPeriod };
