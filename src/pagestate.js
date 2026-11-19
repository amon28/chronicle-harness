// Scripts run in a page (as the body of an async function) by the browser tool's state action (decision 211).
/** A site's sign-in as the page keeps it (Playwright storageState): local/sessionStorage and IndexedDB (JSON values). */
export const STATE_DUMP = `var o={origin:location.origin,url:location.href,local:{},session:{},idb:[],skipped:0},i,k;
for(i=0;i<localStorage.length;i++){k=localStorage.key(i);o.local[k]=localStorage.getItem(k);}
for(i=0;i<sessionStorage.length;i++){k=sessionStorage.key(i);o.session[k]=sessionStorage.getItem(k);}
var req=function(r){return new Promise(function(ok,no){r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)};});};
var dbs=indexedDB.databases?await indexedDB.databases():[];
for(var d of dbs){if(!d.name)continue;var db=await req(indexedDB.open(d.name)),e={name:d.name,version:db.version,stores:[]};
 for(var sn of [].slice.call(db.objectStoreNames)){var st=db.transaction(sn,'readonly').objectStore(sn);
  var x={name:sn,keyPath:st.keyPath,autoIncrement:st.autoIncrement,indexes:[].slice.call(st.indexNames).map(function(n){var ix=st.index(n);return {name:n,keyPath:ix.keyPath,unique:ix.unique,multiEntry:ix.multiEntry};}),records:[]};
  var kr=st.getAllKeys(),vr=st.getAll(),keys=await req(kr),vals=await req(vr);
  for(i=0;i<vals.length;i++){try{JSON.stringify(vals[i]);x.records.push([x.keyPath==null?keys[i]:null,vals[i]]);}catch(err){o.skipped++;}}
  e.stores.push(x);}
 db.close();o.idb.push(e);}
return o;`;
/** Put a saved state back: storage keys are set; IndexedDB stores are emptied and filled (a database the page lacks is made). */
export const STATE_LOAD = (st) => `var s=${JSON.stringify({ local: st.local || {}, session: st.session || {}, idb: st.idb || [] })},k;
for(k in s.local)localStorage.setItem(k,s.local[k]);for(k in s.session)sessionStorage.setItem(k,s.session[k]);
var req=function(r){return new Promise(function(ok,no){r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)};});};
var have=indexedDB.databases?(await indexedDB.databases()).map(function(d){return d.name}):[],missed=0;
for(var e of s.idb){var op=indexedDB.open(e.name,have.indexOf(e.name)<0?(e.version||1):undefined);
 op.onupgradeneeded=function(){var db=op.result;e.stores.forEach(function(x){if(db.objectStoreNames.contains(x.name))return;var os=db.createObjectStore(x.name,x.keyPath==null?{autoIncrement:!!x.autoIncrement}:{keyPath:x.keyPath,autoIncrement:!!x.autoIncrement});(x.indexes||[]).forEach(function(ix){os.createIndex(ix.name,ix.keyPath,{unique:!!ix.unique,multiEntry:!!ix.multiEntry});});});};
 var db=await req(op);
 for(var x of e.stores){if(!db.objectStoreNames.contains(x.name)){missed++;continue;}var tx=db.transaction(x.name,'readwrite'),os=tx.objectStore(x.name);os.clear();x.records.forEach(function(r){if(x.keyPath==null)os.put(r[1],r[0]);else os.put(r[1]);});
  await new Promise(function(ok,no){tx.oncomplete=ok;tx.onerror=function(){no(tx.error)};});}
 db.close();}
return missed;`;
