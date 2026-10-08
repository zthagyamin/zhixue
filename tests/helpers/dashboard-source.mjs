import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const DASHBOARD = join(appDir, 'study-dashboard.tsx');
const EXTRACTED = join(appDir, 'study-dashboard');

/**
 * 仪表盘源码闭包：主文件 + 已抽出的模块（若存在）。
 * 拆解重构期间，源码文本断言必须覆盖这两部分，否则断言会因为代码搬家而误报失败。
 */
export function dashboardSourceFiles() {
  const files = [DASHBOARD];
  if (existsSync(EXTRACTED)) {
    for (const name of readdirSync(EXTRACTED).sort()) {
      if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(join(EXTRACTED, name));
    }
  }
  // Migrated behavior is now owned by these public source/sync modules.
  for(const relative of ['domain/sync','application/sync','features/sync','domain/sources','application/sources','features/sources','infrastructure/sources']){
    const directory=join(appDir,'..','src',relative);
    if(existsSync(directory))for(const name of readdirSync(directory).sort())if(name.endsWith('.ts')||name.endsWith('.tsx'))files.push(join(directory,name));
  }
  return files;
}

export function readDashboardSourceSync() {
  return dashboardSourceFiles().map((file) => readFileSync(file, 'utf8')).join('\n');
}

export async function readDashboardSource() {
  return readDashboardSourceSync();
}
