import { readFileSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const files=JSON.parse(readFileSync('release-files.json','utf8'));
if(!Array.isArray(files)||!files.length||new Set(files).size!==files.length)throw new Error('Release manifest must contain unique paths.');
const prohibited=[
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /GOCSPX-[A-Za-z0-9_-]{20,}/,
  /1\/\/[A-Za-z0-9_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /\b\d{10,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com\b/,
  /\bappg(?:prj|dep|ver)_[a-z0-9]+\b/,
];
for(const file of files){
 if(typeof file!=='string'||file.includes('..')||file.startsWith('/')||relative(root,resolve(file))!==file)throw new Error('Invalid release path.');
 if(file!=='.env.example'&&/(?:^|\/)(?:\.env(?:\.|$)|\.git\/|data\/|\.openai\/|\.wrangler\/|node_modules\/)|\.(?:sqlite|db)(?:[.-]|$)|\.(?:zip|tar|gz)$/.test(file))throw new Error(`Private/runtime file in manifest: ${file}`);
 if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw new Error(`Not a regular source file: ${file}`);
 const content=readFileSync(file,'utf8');if(prohibited.some(pattern=>pattern.test(content)))throw new Error(`Credential/hosted-identity pattern in ${file}`);
}
const tracked=spawnSync('git',['ls-files','-z'],{encoding:'utf8'});
if(tracked.status===0){const paths=tracked.stdout.split('\0').filter(Boolean);if(paths.length!==files.length||paths.some(path=>!files.includes(path)))throw new Error('Tracked files must exactly match the release manifest.');}
const example=readFileSync('.env.example','utf8');
for(const key of ['ADMIN_PASSWORD','TOKEN_ENCRYPTION_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'])if(!new RegExp(`^${key}=$`,'m').test(example))throw new Error(`${key} example must be blank.`);
console.log(`Release manifest verified: ${files.length} source files, no runtime files or recognized credential patterns. Review changes manually too; this is not a complete secret scanner.`);
