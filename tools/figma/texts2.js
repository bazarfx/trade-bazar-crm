const fs=require('fs');
const nodes=JSON.parse(fs.readFileSync('nodes.json'));
const key=g=>g?`${g.sessionID}:${g.localID}`:null;
const kids=new Map();
for(const n of nodes){const p=n.parentIndex&&n.parentIndex.guid?key(n.parentIndex.guid):null;
 if(!kids.has(p))kids.set(p,[]);kids.get(p).push(n);}
for(const [k,arr] of kids) arr.sort((a,b)=>String(a.parentIndex&&a.parentIndex.position||'').localeCompare(String(b.parentIndex&&b.parentIndex.position||'')));
function texts(k,acc){
  for(const n of (kids.get(k)||[])){
    if(n.type==='TEXT'&&n.textData&&n.textData.characters) acc.push(n.textData.characters.replace(/\s+/g,' ').trim());
    texts(key(n.guid),acc);
  }
  return acc;
}
const FAKE=/^(Robert Fox|Cody Fisher|Floyd Miles|Arlene McCoy|Jenny Wilson|Wade Warren|Devon Lane|Kristin Watson|Albert Flores|Jerome Bell|Marvin McKinney|Darrell Steward|Courtney Henry|Theresa Webb|Ronald Richards|Jacob Jones|Kathryn Murphy|Leslie Alexander|Guy Hawkins|Brooklyn Simmons|Dianne Russell|Esther Howard|Savannah Nguyen|Bessie Cooper|Annette Black|Eleanor Pena|Cameron Williamson|Darlene Robertson)$|@example\.com|^\(\d{3}\) 555|^-$/;
for(const id of process.argv.slice(2)){
  const node=nodes.find(n=>key(n.guid)===id);
  console.log('\n########## '+id+' :: '+(node?node.name:'?'));
  const a=texts(id,[]).filter(t=>t&&!FAKE.test(t));
  const seen=new Set(); const outp=[];
  for(const t of a){ if(seen.has(t))continue; seen.add(t); outp.push(t); }
  console.log(outp.join(' ┃ '));
}
