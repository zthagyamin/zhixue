import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {readDashboardSource} from './helpers/dashboard-source.mjs';
test('global header actions retain 44px two-axis targets and can wrap on a narrow viewport',async()=>{
  const [css,dashboard]=await Promise.all([readFile(new URL('../app/globals.css',import.meta.url),'utf8'),readDashboardSource()]);
  assert.match(dashboard,/className="study-header-actions flex flex-wrap items-center/);
  assert.match(css,/\.study-header-actions\s+:is\(button,\s*a\)\s*\{[^}]*min-inline-size:\s*44px;[^}]*min-block-size:\s*44px;/);
});
