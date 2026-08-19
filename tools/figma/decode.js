const fs=require('fs'),zlib=require('zlib'),cp=require('child_process'),kiwi=require('kiwi-schema');
const buf=fs.readFileSync('canvas.fig');let off=12;const chunks=[];
while(off<buf.length){const len=buf.readUInt32LE(off);off+=4;const raw=buf.slice(off,off+len);off+=len;chunks.push(raw)}
const schemaBuf=zlib.inflateRawSync(chunks[0]);
fs.writeFileSync('/tmp/c1.zst',chunks[1]);
cp.execSync('zstd -d -f -q /tmp/c1.zst -o /tmp/c1.bin --long=31');
const dataBuf=fs.readFileSync('/tmp/c1.bin');
console.error('data',dataBuf.length);
const schema=kiwi.decodeBinarySchema(schemaBuf);
const defs={}; for(const d of schema.definitions) defs[d.name]=d;
const bb=new kiwi.ByteBuffer(dataBuf);
const BUILTIN=new Set(['bool','byte','int','uint','float','string','int64','uint64']);
function readBuiltin(t){switch(t){case 'bool':return !!bb.readByte();case 'byte':return bb.readByte();case 'int':return bb.readVarInt();case 'uint':return bb.readVarUint();case 'float':return bb.readVarFloat();case 'string':return bb.readString();case 'int64':return bb.readVarInt64();case 'uint64':return bb.readVarUint64();}}
function readOne(type){
  if(BUILTIN.has(type))return readBuiltin(type);
  const d=defs[type]; if(!d)throw new Error('unknown type '+type);
  if(d.kind==='ENUM'){const v=bb.readVarUint();const f=d.fields.find(f=>f.value===v);return f?f.name:v;}
  if(d.kind==='STRUCT'){const o={};for(const f of d.fields)o[f.name]=f.isArray?readArray(f.type):readOne(f.type);return o;}
  const o={};for(;;){const id=bb.readVarUint();if(id===0)break;const f=d.fields.find(f=>f.value===id);
    if(!f)throw new Error('unknown field '+id+' in '+type);o[f.name]=f.isArray?readArray(f.type):readOne(f.type);}
  return o;
}
function readArray(type){const n=bb.readVarUint();const a=new Array(n);for(let i=0;i<n;i++)a[i]=readOne(type);return a;}
const msgDef=defs['Message'];const out={};let err=null;
try{for(;;){const id=bb.readVarUint();if(id===0)break;const f=msgDef.fields.find(f=>f.value===id);
  if(!f){err='unknown top field '+id;break;}out[f.name]=f.isArray?readArray(f.type):readOne(f.type);}}catch(e){err=e.message}
console.error('stopped:',err||'clean');console.error('keys',Object.keys(out));
console.error('nodeChanges',out.nodeChanges?out.nodeChanges.length:0);
fs.writeFileSync('nodes.json',JSON.stringify(out.nodeChanges||[]));
