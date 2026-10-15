import {spawnPythonSync} from './python-runtime.mjs';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./run-python-suite.py',import.meta.url));
const result=spawnPythonSync(['-X','utf8',script,...process.argv.slice(2)],{stdio:'inherit'});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
