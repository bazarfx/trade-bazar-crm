const fs=require('fs');
const nodes=JSON.parse(fs.readFileSync('nodes.json'));
const key=g=>g?g.sessionID+':'+g.localID:null;
const hex=c=>{const h=x=>Math.round(x*255).toString(16).padStart(2,'0');
  return c.a!==undefined&&c.a<1?`rgba(${Math.round(c.r*255)}, ${Math.round(c.g*255)}, ${Math.round(c.b*255)}, ${+c.a.toFixed(2)})`:'#'+h(c.r)+h(c.g)+h(c.b);};
const sets={};for(const n of nodes) if(n.type==='VARIABLE_SET') sets[key(n.guid)]=n.name;
const vars=new Map();
for(const v of nodes.filter(n=>n.type==='VARIABLE')) vars.set(key(v.guid),v);
function resolve(v,depth=0){
  if(depth>6) return null;
  const e=v.variableDataValues&&v.variableDataValues.entries&&v.variableDataValues.entries[0];
  if(!e||!e.variableData) return null;
  const d=e.variableData.value;
  if(!d) return null;
  if(d.colorValue) return {kind:'color',val:hex(d.colorValue)};
  if(d.floatValue!==undefined) return {kind:'number',val:d.floatValue};
  if(d.textValue!==undefined) return {kind:'string',val:d.textValue};
  if(d.alias){const t=vars.get(key(d.alias.guid)); if(t) {const r=resolve(t,depth+1); return r?{...r,aliasOf:t.name}:null;} }
  return null;
}
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const out={};
for(const v of vars.values()){
  const r=resolve(v); if(!r) continue;
  const set=sets[v.variableSetID?key(v.variableSetID):'']||'misc';
  (out[set]=out[set]||[]).push({name:v.name,...r});
}
let css=':root {\n';
const seen=new Set();
for(const [set,list] of Object.entries(out)){
  css+=`\n  /* ${set} */\n`;
  for(const t of list.sort((a,b)=>a.name.localeCompare(b.name))){
    let n='--'+slug(t.name); let i=2; while(seen.has(n)){n='--'+slug(t.name)+'-'+i++;} seen.add(n);
    const val=t.kind==='number'?(/radius|px/i.test(t.name)?t.val+'px':t.val):t.val;
    css+=`  ${n}: ${val};${t.aliasOf?`  /* → ${t.aliasOf} */`:''}\n`;
  }
}
css+='}\n';
fs.writeFileSync('tokens.css',css);
console.log('sets:',Object.keys(out).join(' | '));
console.log('tokens:',[...seen].length);
