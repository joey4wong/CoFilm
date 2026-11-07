// No install/build dependency: validate the same native modules shipped to Pages.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const sources = ['app.js', 'theme.js', ...['lib','scripts'].flatMap(dir => fs.readdirSync(dir).filter(f => /\.m?js$/.test(f)).map(f => dir+'/'+f))];
function run(args) { const r=spawnSync(process.execPath,args,{stdio:'inherit'}); if(r.status!==0)process.exit(r.status||1); }
for (const file of sources) run(['--check', file]);
const html=fs.readFileSync('index.html','utf8');
for (const [,ref] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (/^(https?:|data:)/.test(ref)) continue;
  const file=ref.split('?')[0];
  if (!fs.existsSync(file)) throw Error('Missing HTML asset: '+file);
}
console.log('Syntax and local HTML assets verified.');
run(['--test', ...fs.readdirSync('scripts').filter(f=>f.endsWith('.test.mjs')).map(f=>'scripts/'+f)]);
