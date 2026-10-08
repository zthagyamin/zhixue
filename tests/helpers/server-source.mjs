import { readFile } from 'node:fs/promises';

// Follow managed implementations without maintaining a second program inventory.
const manifest = JSON.parse(await readFile(new URL('../../companion/program-files.json', import.meta.url), 'utf8'));
const modules = ['server.py', 'study_event_schema.py', 'http_routes.py', 'route_services.py',
  'routes_account.py', 'routes_study.py', 'routes_planning.py', 'routes_sources.py', 'routes_ai.py',
  ...manifest.files.filter(name => /^(application|infrastructure)\/.*\.py$/.test(name))];

export async function readServerSource() {
  return (await Promise.all(modules.map(name => readFile(new URL(`../../companion/${name}`, import.meta.url), 'utf8')))).join('\n');
}
