// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const approvals = new WeakMap();
class OwnerApprovalError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const refuse = (status, code) => { throw new OwnerApprovalError(status, code); };
function assertImportActor(actor) {
  if (!actor || typeof actor.ownerId !== 'string' || !actor.ownerId.length ||
      typeof actor.check !== 'function') refuse(401, 'IMPORT_OWNER_REQUIRED');
  let current;
  try { current = actor.check(); }
  catch (error) {
    if (error instanceof OwnerApprovalError) throw error;
    refuse(401, 'IMPORT_OWNER_REQUIRED');
  }
  if (typeof current !== 'string' || !current.length) refuse(401, 'IMPORT_OWNER_REQUIRED');
  if (current !== actor.ownerId) refuse(403, 'IMPORT_OWNER_MISMATCH');
  return current;
}
function issueOwnerApproval(importActor, binding) {
  const ownerId = assertImportActor(importActor);
  if (!binding || typeof binding.jobId !== 'string' || !binding.jobId.length ||
      typeof binding.treePath !== 'string' || !binding.treePath.length ||
      typeof binding.targetHome !== 'string' || !binding.targetHome.length ||
      typeof binding.selectedDbFile !== 'string' || !binding.selectedDbFile.length) {
    refuse(409, 'IMPORT_APPROVAL_REQUIRED');
  }
  const actor = Object.freeze({ ownerId, check: importActor.check });
  const approved = Object.freeze({ ownerId, jobId: binding.jobId,
    treePath: binding.treePath, targetHome: binding.targetHome,
    selectedDbFile: binding.selectedDbFile });
  const approval = Object.freeze({ check: () => assertOwnerApproval(approval) });
  approvals.set(approval, { actor, approved });
  return approval;
}
function assertOwnerApproval(approval, importActor) {
  const stored = approval && approvals.get(approval);
  if (!stored) refuse(409, 'IMPORT_APPROVAL_REQUIRED');
  if (importActor !== undefined && assertImportActor(importActor) !== stored.approved.ownerId) {
    refuse(403, 'IMPORT_OWNER_MISMATCH');
  }
  if (assertImportActor(stored.actor) !== stored.approved.ownerId) {
    refuse(403, 'IMPORT_OWNER_MISMATCH');
  }
  return stored.approved;
}
module.exports = { OwnerApprovalError, assertImportActor, issueOwnerApproval, assertOwnerApproval };
