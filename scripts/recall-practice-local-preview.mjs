import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

// Synthetic recall fixture only: no production identity, records or paid model.
const root=resolve('scratch/recall-practice');
await mkdir(root,{recursive:true});
await writeFile(resolve(root,'entry.jsx'),await readFile(new URL('../.github/recall-flow-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回忆交互隔离验收</title><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
const server=await createServer({
  configFile:false,root,plugins:[react()],
  server:{host:'127.0.0.1',port:4183,strictPort:true,fs:{allow:[process.cwd()]},
    headers:{'Content-Security-Policy':"connect-src 'self' ws://127.0.0.1:4183; object-src 'none'; frame-src 'none'"}},
});
await server.listen();
console.log('Recall practice preview: http://127.0.0.1:4183/?mode=paper-wrong&theme=light');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0);});


