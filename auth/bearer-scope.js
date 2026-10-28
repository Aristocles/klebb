// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// Reserve this family in bootstrap mode and if the same string is accidentally
// configured as a broader API token.
function isHealthConnectorBearer(req) {
  return /^Bearer\s+klebb_hc1_/i.test(req.headers.authorization || '');
}
module.exports = { isHealthConnectorBearer };
