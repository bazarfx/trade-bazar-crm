const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const clean=src.split('\n').map(l=>l.replace(/\/\/.*$/,'')).join('\n');
const errs=[], warns=[];

// balanced braces
let d=0; for(const c of clean){ if(c==='{')d++; if(c==='}')d--; if(d<0){errs.push('unbalanced }');break;} }
if(d!==0) errs.push(`unbalanced braces (depth ${d})`);

// collect blocks
const blocks=[...clean.matchAll(/^(model|enum|generator|datasource)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
  .map(m=>({kind:m[1],name:m[2],body:m[3]}));
const models=new Map(blocks.filter(b=>b.kind==='model').map(b=>[b.name,b]));
const enums=new Set(blocks.filter(b=>b.kind==='enum').map(b=>b.name));
const scalars=new Set(['String','Int','BigInt','Float','Decimal','Boolean','DateTime','Json','Bytes']);

console.log(`models: ${models.size}  enums: ${enums.size}`);

for(const [name,b] of models){
  const fields=new Map();
  for(const line of b.body.split('\n')){
    const t=line.trim();
    if(!t||t.startsWith('@@')||t.startsWith('//')) continue;
    const m=t.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if(!m) continue;
    fields.set(m[1],{type:m[2],list:!!m[3],opt:!!m[4],line:t});
  }
  // type resolution
  for(const [f,info] of fields){
    if(!scalars.has(info.type)&&!enums.has(info.type)&&!models.has(info.type))
      errs.push(`${name}.${f}: unknown type "${info.type}"`);
  }
  // @relation fields/references must exist
  for(const [f,info] of fields){
    const rel=info.line.match(/@relation\((?:"[^"]*",\s*)?fields:\s*\[([^\]]+)\],\s*references:\s*\[([^\]]+)\]/);
    if(rel){
      for(const fk of rel[1].split(',').map(s=>s.trim()))
        if(!fields.has(fk)) errs.push(`${name}.${f}: @relation fields references missing field "${fk}"`);
      const target=models.get(info.type);
      if(target){
        const tf=new Set([...target.body.matchAll(/^\s*(\w+)\s+\w+/gm)].map(m=>m[1]));
        for(const rf of rel[2].split(',').map(s=>s.trim()))
          if(!tf.has(rf)) errs.push(`${name}.${f}: references missing "${info.type}.${rf}"`);
      }
    }
  }
  // @@unique / @@index field existence
  for(const m of b.body.matchAll(/@@(unique|index)\(\[([^\]]+)\]/g)){
    for(const f of m[2].split(',').map(s=>s.trim()))
      if(!fields.has(f)) errs.push(`${name}: @@${m[1]} references missing field "${f}"`);
  }
  // every model needs @id
  if(!b.body.includes('@id')) errs.push(`${name}: no @id`);
  // relation back-reference check
  for(const [f,info] of fields){
    if(models.has(info.type)){
      const other=models.get(info.type);
      if(!new RegExp(`\\s${name}(\\[\\])?[\\s?]`).test(other.body)&&other.name!==name)
        warns.push(`${name}.${f} → ${info.type}: no obvious back-reference in ${info.type}`);
    }
  }
}
console.log('\nERRORS:', errs.length); errs.forEach(e=>console.log('  ✗',e));
console.log('WARNINGS:', warns.length); warns.forEach(w=>console.log('  ⚠',w));
process.exit(errs.length?1:0);
