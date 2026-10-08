import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('the homepage executes on the server without reading client plugin objects',()=>{
  const result=spawnSync(process.execPath,['--conditions=react-server',fileURLToPath(new URL('./fixtures/rsc-homepage.mjs',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
});
