import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(path) {return readdirSync(path,{withFileTypes:true}).flatMap(f=>f.isDirectory()?walk(join(path,f.name)):[join(path,f.name)]);}
for (const file of ['src','public','scripts','test'].flatMap(walk).filter(f=>/\.(mjs|js)$/.test(f))) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'}); if(result.status)process.exit(result.status);
}
console.log('All JavaScript syntax checks passed.');
