// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// Test-process preload: engage the real structural dispatch gate in a child
// server. It adds no product route, header, clock or environment bypass.
'use strict';

require('../../lib/import/freeze').engage('synthetic-authority-test');
