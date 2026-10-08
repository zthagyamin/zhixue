import {readFile,copyFile,mkdir} from 'node:fs/promises';
const root=new URL('../',import.meta.url),pdf=new URL('node_modules/pdfjs-dist/',root);
const {version}=JSON.parse(await readFile(new URL('package.json',pdf),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Unexpected PDF.js version');
await mkdir(new URL('public/vendor/',root),{recursive:true});
await copyFile(new URL('build/pdf.worker.min.mjs',pdf),new URL(`public/vendor/pdf.worker-${version}.mjs`,root));
await copyFile(new URL('LICENSE',pdf),new URL('public/vendor/pdfjs-LICENSE.txt',root));
