import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./run-python-suite.py',import.meta.url));
const result=spawnSync(process.env.PYTHON||'python',['-X','utf8',script,...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
