import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as runtime from '../app/plan-runtime.ts';
import {readDashboardSource} from './helpers/dashboard-source.mjs';

// C1 客户端契约：练习事件必须携带可解析的 stateRef。结果卡的 stateRef 是
// 不带 .md 的 wikilink 目标，直接过 markdownNotePath 会被丢弃 → v3 事件
// unmapped → 卡片练习写不回 Vault 队列。resolvableNotePath 补全 .md，
// 与 server 端 item.key 路由形成双保险。
test("dashboard practice events send a resolvable stateRef for card items", async () => {
  const source = await readDashboardSource();
  assert.match(source, /function resolvableNotePath/);
  assert.match(source, /stateRef:\s*resolvableNotePath\(item\.stateRef\)/);
  assert.match(source, /\.endsWith\("\.md"\) \? path : `\$\{path\}\.md`/);
});

test("practice session renders plugins with an authenticated gradeCalculation context", async () => {
  const session = await readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8");
  assert.match(session, /gradeCalculation/);
  assert.match(session, /companionClient\.gradePractice/);
});

test("dashboard caches the last practice list and reuses it when Companion is offline", async () => {
  let cached=[];
  const items=[{itemId:'q1',abilityId:'a1'},{itemId:'q2',abilityId:'a2'}];
  const deps={loadRemote:async()=>items,readCache:async()=>cached,writeCache:async value=>{cached=value;}};
  const first=await runtime.loadPlannedPractice?.(null,[],deps);
  assert.equal(first?.items.length,2);
  const plan={items:[{kind:'review',itemKey:'practice:q1',domain:'paper',estimatedMinutes:2,reasons:[]}],day:'2026-08-31',planHash:'test',totalMinutes:2,skipped:[],overloaded:false};
  const second=await runtime.loadPlannedPractice(plan,[],{...deps,loadRemote:async()=>{throw new Error('offline');}});
  assert.equal(second.offline,true);
  assert.deepEqual(second.items.map(item=>item.itemId),['q1']);
});
