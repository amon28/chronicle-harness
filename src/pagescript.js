// The half of the browser tool that runs INSIDE the page (injected through eval). Plain JavaScript in a string.
export const PAGE_SCRIPT = `(function(){
if(window.__ocmB)return;
(function(){if(window.__ocmClip)return;var C=window.__ocmClip={text:'',n:0,how:''};
 var act=function(){return !navigator.userActivation||navigator.userActivation.isActive};
 var deny=function(){return Promise.reject(new DOMException('Write permission denied.','NotAllowedError'))};
 var put=function(t,how){C.text=String(t==null?'':t);C.n++;C.how=how};
 var cb=navigator.clipboard;
 if(cb){try{
  cb.writeText=function(t){if(!act())return deny();put(t,'navigator.clipboard.writeText');return Promise.resolve()};
  cb.write=function(items){if(!act())return deny();var it=items&&items[0];if(!it||!it.types||it.types.indexOf('text/plain')<0){put('','navigator.clipboard.write (no text)');return Promise.resolve()}
   return it.getType('text/plain').then(function(b){return b.text()}).then(function(t){put(t,'navigator.clipboard.write')})};
  cb.readText=function(){return Promise.resolve(C.text)};
  cb.read=function(){return Promise.resolve(typeof ClipboardItem==='function'?[new ClipboardItem({'text/plain':new Blob([C.text],{type:'text/plain'})})]:[])};
 }catch(e){}}
 var ex=document.execCommand;
 document.execCommand=function(c){var k=String(c).toLowerCase();if(k!=='copy'&&k!=='cut')return ex.apply(document,arguments);
  var a=document.activeElement,dt=null;try{dt=new DataTransfer()}catch(e){}
  var ev;try{ev=new ClipboardEvent(k,{clipboardData:dt,bubbles:true,cancelable:true})}catch(e){ev=new Event(k,{bubbles:true,cancelable:true})}
  (a||document).dispatchEvent(ev);var t;
  if(ev.defaultPrevented&&dt)t=dt.getData('text/plain');
  else if(a&&(a.tagName==='TEXTAREA'||a.tagName==='INPUT')&&a.selectionStart!=null){t=a.value.slice(a.selectionStart,a.selectionEnd);if(k==='cut'&&!a.readOnly)a.setRangeText('')}
  else t=String(getSelection()||'');
  put(t,'document.execCommand('+k+')');return true};
})();
var D=document;
/** Same-origin frames on the page (their documents can be read and their elements tapped). */
function frameDocs(){var o=[];[].forEach.call(document.querySelectorAll('iframe,frame'),function(f){try{var d=f.contentDocument;if(d&&d.body&&f.getBoundingClientRect().width>2)o.push(d)}catch(e){}});return o;}
/** Open shadow roots under a document or root (web components), nested ones too. */
function shadowRoots(root){var o=[],all=root.querySelectorAll('*'),n=Math.min(all.length,8000);for(var i=0;i<n;i++){var sr=all[i].shadowRoot;if(sr){o.push(sr);o=o.concat(shadowRoots(sr));}}return o;}
/** Where an element is in the main view (a frame's element is offset by the frame's position). */
function rectOf(e){var r=e.getBoundingClientRect(),d=e.ownerDocument,x=0,y=0;if(d!==document){var f=d.defaultView&&d.defaultView.frameElement;if(f){var fr=f.getBoundingClientRect();x=fr.left+f.clientLeft;y=fr.top+f.clientTop;}}
 return {left:r.left+x,top:r.top+y,right:r.right+x,bottom:r.bottom+y,width:r.width,height:r.height};}
var SEL='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=radio],[role=combobox],[role=slider],[role=treeitem],[role=searchbox],[role=textbox],[role=switch],[tabindex="0"],[onclick],[contenteditable=true]';
function vis(e){var r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;var s=(e.ownerDocument.defaultView||window).getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';}
function clean(t){return String(t||'').replace(/\\s+/g,' ').trim();}
function label(e){var t=e.tagName.toLowerCase();var v=clean(e.getAttribute('aria-label')||e.innerText||e.value||e.getAttribute('title')||e.getAttribute('alt')||'');
 if(t==='input'||t==='textarea'||t==='select'){var l=e.id&&e.ownerDocument.querySelector('label[for="'+e.id+'"]');v=clean((l&&l.innerText)||e.getAttribute('aria-label')||e.placeholder||e.name||'');}
 if(!v){var img=e.querySelector&&e.querySelector('img[alt]');if(img)v=clean(img.alt);}
 return v.slice(0,70);}
function kind(e){var t=e.tagName.toLowerCase();if(t==='a')return 'link';if(t==='select')return 'select';if(t==='textarea')return 'textbox';
 if(t==='input'){var ty=(e.type||'text').toLowerCase();if(ty==='checkbox'||ty==='radio')return ty;if(ty==='submit'||ty==='button')return 'button';return 'input('+ty+')';}
 if(t==='button'||e.getAttribute('role')==='button')return 'button';return e.getAttribute('role')||t;}
function byId(id){var e=document.querySelector('[data-ocm="'+id+'"]');if(!e)frameDocs().concat(shadowRoots(document)).some(function(d){e=d.querySelector('[data-ocm="'+id+'"]');return !!e;});if(!e)throw new Error('No element ['+id+'] – read the page again to get fresh numbers');return e;}
/** A short name for an element the assistant can recognise: tag#id.class "what it says". */
function nameOf(e){var c=typeof e.className==='string'?e.className.trim().split(/ +/)[0]:'',t=clean(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').slice(0,60);
 return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(c?'.'+c:'')+(t?' "'+t+'"':'');}
/** The popup an element is part of: the nearest box that floats over the page (fixed, an open dialog, a popover). */
function popupOf(e){for(var n=e;n&&n.nodeType===1&&n!==document.body&&n!==document.documentElement;n=n.parentElement){var po=false;try{po=n.matches(':popover-open')}catch(x){}
  if(po||(n.tagName==='DIALOG'&&n.open)||n.getAttribute('aria-modal')==='true'||getComputedStyle(n).position==='fixed')return n;}return null;}
/** What lies over the middle of the screen, when it is not the page itself: a cookie wall, a dialog, a consent frame.
 *  An app that lives in one fixed box is the page (it holds most of the text), not a popup. */
function overlay(bodyText){var W=innerWidth,H=innerHeight,P=[[.5,.5],[.5,.3],[.5,.7],[.3,.5],[.7,.5]],tops=[],hits=[],i,best=-1;
 for(i=0;i<P.length;i++){var t=popupOf(document.elementFromPoint(W*P[i][0],H*P[i][1]));if(!t)continue;var k=tops.indexOf(t);if(k<0){tops.push(t);hits.push(1);}else hits[k]++;}
 for(i=0;i<tops.length;i++)if(best<0||hits[i]>hits[best])best=i;if(best<0)return null;
 var e=tops[best],frame=false,modal=e.getAttribute('aria-modal')==='true';if(e.tagName==='DIALOG'){try{modal=e.matches(':modal')}catch(x){}}
 if(e.tagName==='IFRAME'){try{frame=!e.contentDocument}catch(x){frame=true}}
 if(hits[best]<2&&!modal)return null;
 if(!modal&&!frame&&clean(e.innerText).length*2>=bodyText.length)return null;
 var r=e.getBoundingClientRect(),w=Math.max(0,Math.min(r.right,W)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,H)-Math.max(r.top,0)),src='';
 if(frame){try{src=new URL(e.src,location.href).host}catch(x){}}
 return {e:e,what:nameOf(e)+(src?' from '+src:''),pct:Math.round(100*w*h/(W*H)),frame:frame};}
/** Is this element inside a box pinned to the screen (a bar, a banner)? Those are in view wherever the page is scrolled. */
function pinned(e){if(e.ownerDocument!==document)return false;var n=e;while(n.offsetParent)n=n.offsetParent;return n!==document.body&&n!==document.documentElement&&n.nodeType===1&&getComputedStyle(n).position==='fixed';}
function scroller(){var best=null,area=0,all=document.querySelectorAll('*'),n=Math.min(all.length,6000);
 for(var i=0;i<n;i++){var e=all[i];if(e.clientHeight<80||e.scrollHeight<=e.clientHeight+20)continue;var s=getComputedStyle(e).overflowY;if(s!=='auto'&&s!=='scroll'&&s!=='overlay')continue;var a=e.clientWidth*e.clientHeight;if(a>area){area=a;best=e;}}
 var d=document.scrollingElement||document.documentElement;
 return best&&(d.scrollHeight<=d.clientHeight+20||area>innerWidth*innerHeight*0.25)?best:d;}

var IMPLICIT={button:'button,input[type=button],input[type=submit],input[type=reset],summary',link:'a[href]',textbox:'input:not([type]),input[type=text],input[type=email],input[type=search],input[type=url],input[type=tel],input[type=password],input[type=number],textarea,[contenteditable=true]',checkbox:'input[type=checkbox]',radio:'input[type=radio]',combobox:'select',heading:'h1,h2,h3,h4,h5,h6',img:'img',listitem:'li',list:'ul,ol',table:'table',row:'tr',cell:'td',navigation:'nav',main:'main',searchbox:'input[type=search]'};
/** A text test: /re/flags, an exact text (it was in quotes), or a part of it – any case. */
function txtM(v,exact){var rx=/^\\/([\\s\\S]+)\\/([gimsuy]*)$/.exec(v);if(rx){var R=new RegExp(rx[1],rx[2].replace('g',''));return function(t){return R.test(t);};}
 var q=String(v).toLowerCase();return exact?function(t){return t.toLowerCase()===q;}:function(t){return t.toLowerCase().indexOf(q)>=0;};}
function textOf(e){return clean(e.innerText||e.textContent||'');}
/** The accessible name: aria-labelledby, aria-label, the field's <label>, a button's value, alt, the text, title. */
function accName(e){var d=e.ownerDocument,by=e.getAttribute('aria-labelledby');if(by){var t=by.split(/ +/).map(function(i){var x=d.getElementById(i);return x?textOf(x):'';}).join(' ').trim();if(t)return t;}
 var a=e.getAttribute('aria-label');if(a&&a.trim())return clean(a);var tg=e.tagName;
 if(/^(INPUT|TEXTAREA|SELECT)$/.test(tg)){var l=e.labels&&e.labels[0];if(l)return textOf(l);if(tg==='INPUT'&&/^(submit|button|reset)$/i.test(e.type))return clean(e.value);return clean(e.getAttribute('placeholder')||e.getAttribute('title')||'');}
 if(tg==='IMG')return clean(e.getAttribute('alt')||e.getAttribute('title')||'');
 var tx=textOf(e);if(!tx){var im=e.querySelector&&e.querySelector('img[alt]');if(im)tx=clean(im.alt);}return tx||clean(e.getAttribute('title')||'');}
function ariaState(e,key){if(key==='checked'){if(e.type==='checkbox'||e.type==='radio')return e.indeterminate?'mixed':String(!!e.checked);return e.getAttribute('aria-checked')||'false';}
 if(key==='selected'){if(e.tagName==='OPTION')return String(!!e.selected);return e.getAttribute('aria-selected')||'false';}
 if(key==='disabled')return String(!!e.disabled||e.getAttribute('aria-disabled')==='true');
 if(key==='level'){var m=/^H([1-6])$/.exec(e.tagName);return m?m[1]:(e.getAttribute('aria-level')||'');}
 return e.getAttribute('aria-'+key)||'false';}
function deepest(match){var root=D.body||D,out=[],all=root.querySelectorAll?root.querySelectorAll('*'):[],n=Math.min(all.length,8000);
 function hit(e){return match(textOf(e));}
 for(var i=0;i<n;i++){var e=all[i];if(/^(script|style|noscript)$/i.test(e.tagName))continue;if(!hit(e))continue;var kid=false;for(var c=e.firstElementChild;c;c=c.nextElementSibling){if(hit(c)){kid=true;break;}}if(!kid)out.push(e);}
 return out;}
function find(sel){sel=String(sel).trim();var m=/^(text|role|label|placeholder|testid|xpath|css|alt|title)=([\\s\\S]*)$/.exec(sel),k='css',v=sel,res=[];
 if(m){k=m[1];v=m[2];}else if(sel.slice(0,2)==='//'||sel.slice(0,2)==='./'||sel.slice(0,3)==='(//')k='xpath';
 var q=/^"([\\s\\S]*)"$/.exec(v)||/^'([\\s\\S]*)'$/.exec(v),exact=!!q;if(q)v=q[1];
 if(k==='css'){var ht=/:(has-text|text-is|text)\\((["'])([\\s\\S]*?)\\2\\)/.exec(v),base=ht?(v.replace(ht[0],'').trim()||'*'):v;res=[].slice.call(D.querySelectorAll(base));
  if(ht){var hm=txtM(ht[3],ht[1]==='text-is');res=res.filter(function(e){return hm(textOf(e));});
   if(ht[1]!=='has-text')res=res.filter(function(e){for(var c=e.firstElementChild;c;c=c.nextElementSibling)if(hm(textOf(c)))return false;return true;});}}
 else if(k==='xpath'){var XD=D.evaluate?D:(D.ownerDocument||document);var r=XD.evaluate(v,D,null,7,null);for(var i=0;i<r.snapshotLength;i++)res.push(r.snapshotItem(i));}
 else if(k==='text')res=deepest(txtM(v,exact));
 else if(k==='placeholder')res=[].slice.call(D.querySelectorAll('[placeholder]')).filter(function(e){var p=e.getAttribute('placeholder').toLowerCase();return exact?p===v.toLowerCase():p.indexOf(v.toLowerCase())>=0;});
 else if(k==='alt')res=[].slice.call(D.querySelectorAll('[alt]')).filter(function(e){return e.getAttribute('alt').toLowerCase().indexOf(v.toLowerCase())>=0;});
 else if(k==='title')res=[].slice.call(D.querySelectorAll('[title]')).filter(function(e){return e.getAttribute('title').toLowerCase().indexOf(v.toLowerCase())>=0;});
 else if(k==='testid')res=[].slice.call(D.querySelectorAll('[data-testid="'+v.replace(/"/g,'')+'"],[data-test-id="'+v.replace(/"/g,'')+'"]'));
 else if(k==='label'){var lb=[].slice.call(D.querySelectorAll('label')).filter(function(l){var t=clean(l.innerText).toLowerCase();return exact?t===v.toLowerCase():t.indexOf(v.toLowerCase())>=0;});
  lb.forEach(function(l){var c=l.control||(l.htmlFor&&(D.getElementById?D:(D.ownerDocument||document)).getElementById(l.htmlFor));if(c)res.push(c);});
  [].slice.call(D.querySelectorAll('[aria-label]')).forEach(function(e){if(e.getAttribute('aria-label').toLowerCase().indexOf(v.toLowerCase())>=0&&res.indexOf(e)<0)res.push(e);});}
 else if(k==='role'){var rm=/^([a-z]+)((?:\\[[^\\]]*\\])*)$/.exec(v.trim());if(!rm)throw new Error('Bad role selector: '+v);var role=rm[1],opts=[],am,are=/\\[\\s*([a-z-]+)\\s*(?:=\\s*(?:"([^"]*)"\\s*([is]?)|'([^']*)'\\s*([is]?)|\\/([^\\]]+)\\/([a-z]*)|([^\\]]*)))?\\]/g;
  while((am=are.exec(rm[2]))){var key=am[1],val=am[2]!=null?am[2]:am[4];if(val!=null)opts.push({k:key,s:val,f:am[3]||am[5]||''});else if(am[6]!=null)opts.push({k:key,re:new RegExp(am[6],am[7])});else opts.push({k:key,s:am[8]==null?'true':am[8].trim(),raw:1});}
  var exactName=opts.some(function(o){return o.k==='exact';});
  var css='[role="'+role+'"]'+(IMPLICIT[role]?','+IMPLICIT[role]:'');res=[].slice.call(D.querySelectorAll(css)).filter(function(e){
   if(IMPLICIT[role]&&e.getAttribute('role')&&e.getAttribute('role')!==role&&!e.matches('[role="'+role+'"]'))return false;
   return opts.every(function(o){if(o.k==='exact'||o.k==='include-hidden')return true;
    if(o.k==='name'){var n=accName(e);if(o.re)return o.re.test(n);if(o.f==='s')return n===o.s;if(o.f==='i'||exactName)return n.toLowerCase()===o.s.toLowerCase();return n.toLowerCase().indexOf(o.s.toLowerCase())>=0;}
    var st=ariaState(e,o.k);if(o.re)return o.re.test(st);return String(st).toLowerCase()===String(o.s).toLowerCase();});});}
 return res;}
function findOne(sel){var a=find(sel);if(a.length)return a;var ds=frameDocs();ds=ds.concat(shadowRoots(document));for(var i=0;i<ds.length&&!a.length;i++){D=ds[i];try{a=find(sel)}finally{D=document}}return a;}
/** a >> b: b inside each match of a (Playwright chains); nth=, visible=, has-text= / has-not-text= filter the matches so far. */
function chainParts(sel){var out=[],cur='',q=null;for(var i=0;i<sel.length;i++){var c=sel[i];if(q){cur+=c;if(c===q)q=null;continue;}
  if((c==='"'||c==="'")&&(i===0||/[=( ]/.test(sel[i-1]))){q=c;cur+=c;continue;}if(c==='>'&&sel[i+1]==='>'){out.push(cur.trim());cur='';i++;continue;}cur+=c;}
 out.push(cur.trim());return out.filter(Boolean);}
function unq(v){var m=/^"([\\s\\S]*)"$/.exec(v)||/^'([\\s\\S]*)'$/.exec(v);return m?m[1]:v;}
function findAll(sel){var parts=chainParts(String(sel).trim());if(parts.length<2)return findOne(sel);var cur=findOne(parts[0]);
 for(var i=1;i<parts.length;i++){var p=parts[i],m;
  if((m=/^nth=(-?\\d+)$/.exec(p))){var n=+m[1];if(n<0)n=cur.length+n;cur=cur[n]?[cur[n]]:[];continue;}
  if((m=/^visible=(true|false)$/.exec(p))){var want=m[1]==='true';cur=cur.filter(function(e){return vis(e)===want;});continue;}
  if((m=/^has-(not-)?text=([\\s\\S]*)$/.exec(p))){var tm=txtM(unq(m[2]),false),neg=!!m[1];cur=cur.filter(function(e){return tm(textOf(e))!==neg;});continue;}
  var next=[];cur.forEach(function(e){D=e;try{find(p).forEach(function(x){if(next.indexOf(x)<0)next.push(x);});if(e.shadowRoot){D=e.shadowRoot;find(p).forEach(function(x){if(next.indexOf(x)<0)next.push(x);});}}finally{D=document}});cur=next;}
 return cur;}
function pick(t){t=t||{};if(t.selector){var a=findAll(t.selector);if(t.has_text){var ft=txtM(unq(String(t.has_text)),false);a=a.filter(function(e){return ft(textOf(e));});}if(!a.length)throw new Error('No element matches "'+t.selector+'"'+(t.has_text?' with text '+JSON.stringify(t.has_text):''));var vv=a.filter(vis),use=vv.length?vv:a,n=t.nth|0;if(n<0)n=use.length+n;if(n>=use.length||n<0)throw new Error('Only '+use.length+' match(es) for "'+t.selector+'"');return use[n];}
 if(t.id==null)throw new Error('Give an element number (id) or a selector');return byId(t.id|0);}
function fire(e,types,init){types.forEach(function(ty){var C=/^pointer/.test(ty)&&window.PointerEvent?PointerEvent:MouseEvent;e.dispatchEvent(new C(ty,Object.assign({bubbles:true,cancelable:true,view:window},init||{})));});}
function tabbables(){var all=[].slice.call(document.querySelectorAll('a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable=true],[contenteditable=""]')).filter(function(x){var ti=x.getAttribute('tabindex');if(ti!=null&&ti!==''&&+ti<0)return false;if(x.disabled||(x.tagName==='INPUT'&&x.type==='hidden'))return false;return vis(x);});
 var pos=all.filter(function(x){return +x.getAttribute('tabindex')>0;}).sort(function(a,b){return a.getAttribute('tabindex')-b.getAttribute('tabindex');});return pos.concat(all.filter(function(x){return !(+x.getAttribute('tabindex')>0);}));}
/** The browser's own default for a key, done by hand (a script-made key event changes nothing by itself). → what was done, or ''. */
function emuKey(e,k,m){var plain=!m.ctrl&&!m.alt&&!m.meta;
 if(k==='Tab'&&plain){var L=tabbables();if(!L.length)return '';var i=L.indexOf(document.activeElement),n=m.shift?(i<=0?L.length-1:i-1):(i<0||i>=L.length-1?0:i+1);L[n].focus();return 'the focus moved to '+nameOf(L[n]);}
 var tg=e.tagName,len;
 if(/^(INPUT|TEXTAREA)$/.test(tg)&&e.selectionStart!=null&&plain){var v=String(e.value),a=e.selectionStart,b=e.selectionEnd;len=v.length;
  if(k==='Backspace'||k==='Delete'){if(a===b){if(k==='Backspace'&&a>0)a--;else if(k==='Delete'&&b<len)b++;else return '';}setVal(e,v.slice(0,a)+v.slice(b));e.setSelectionRange(a,a);return 'deleted';}
  var ls=function(x){return tg==='TEXTAREA'?v.lastIndexOf('\\n',x-1)+1:0;},le=function(x){var j=tg==='TEXTAREA'?v.indexOf('\\n',x):-1;return j<0?len:j;};
  var r=null;if(k==='ArrowLeft')r=m.shift?[Math.max(0,a-1),b,'backward']:[a!==b?a:Math.max(0,a-1)];else if(k==='ArrowRight')r=m.shift?[a,Math.min(len,b+1),'forward']:[a!==b?b:Math.min(len,b+1)];
  else if(k==='Home')r=m.shift?[ls(a),b,'backward']:[ls(a)];else if(k==='End')r=m.shift?[a,le(b),'forward']:[le(b)];
  else if(tg==='INPUT'&&k==='ArrowUp')r=[0];else if(tg==='INPUT'&&k==='ArrowDown')r=[len];
  if(r){e.setSelectionRange(r[0],r.length>1?r[1]:r[0],r[2]||'none');return 'the caret is at '+e.selectionStart+(e.selectionEnd!==e.selectionStart?'–'+e.selectionEnd+' (selected)':'');}}
 if(e.isContentEditable&&plain){if(k==='Backspace'){document.execCommand('delete');return 'deleted';}if(k==='Delete'){document.execCommand('forwardDelete');return 'deleted';}
  var g=window.getSelection(),dir={ArrowLeft:['backward','character'],ArrowRight:['forward','character'],ArrowUp:['backward','line'],ArrowDown:['forward','line'],Home:['backward','lineboundary'],End:['forward','lineboundary']}[k];
  if(g&&g.modify&&dir){g.modify(m.shift?'extend':'move',dir[0],dir[1]);return 'the caret moved';}}
 if(tg==='SELECT'&&plain&&(k==='ArrowDown'||k==='ArrowUp')){var si=e.selectedIndex+(k==='ArrowDown'?1:-1);if(si<0||si>=e.options.length)return '';e.selectedIndex=si;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'picked "'+clean(e.options[si].text)+'"';}
 if(tg==='INPUT'&&e.type==='radio'&&plain&&/^Arrow/.test(k)&&e.name){var g2=[].slice.call(e.ownerDocument.querySelectorAll('input[type=radio]')).filter(function(x){return x.name===e.name&&x.form===e.form&&!x.disabled;}),gi=g2.indexOf(e)+(k==='ArrowDown'||k==='ArrowRight'?1:-1);gi=(gi+g2.length)%g2.length;g2[gi].focus();g2[gi].click();return 'picked '+nameOf(g2[gi]);}
 var btn=tg==='BUTTON'||e.getAttribute('role')==='button'||(tg==='INPUT'&&/^(checkbox|radio|button|submit|reset)$/i.test(e.type))||tg==='SUMMARY';
 if(plain&&(k===' '||k==='Space')&&btn){e.click();return 'clicked '+nameOf(e);}
 if(plain&&k==='Enter'&&(btn&&tg!=='INPUT'||(tg==='A'&&e.href))){e.click();return 'clicked '+nameOf(e);}
 return '';}
function keyEv(el,k,mods){var o={key:k,code:/^[a-z]$/i.test(k)?'Key'+k.toUpperCase():k,bubbles:true,cancelable:true,ctrlKey:!!mods.ctrl,shiftKey:!!mods.shift,altKey:!!mods.alt,metaKey:!!mods.meta};
 var went=true;['keydown','keypress','keyup'].forEach(function(ty){if(ty==='keypress'&&k.length>1&&k!=='Enter')return;if(!el.dispatchEvent(new KeyboardEvent(ty,o))&&ty==='keydown')went=false;});return went;}
/** What a real Escape does in the browser itself and a key event made by script does not: the popover on top, or else
 *  the modal <dialog> on top, is closed (the dialog may refuse through its cancel event). → what was closed, or ''. */
function escapeTop(){var nm=function(e){var l=e.getAttribute('aria-label');return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(l?' "'+l.slice(0,60)+'"':'');},ps=[];try{ps=[].slice.call(document.querySelectorAll(':popover-open')).filter(function(p){var a=p.getAttribute('popover');return a===''||a==='auto';});}catch(x){}
 if(ps.length){var p=ps[ps.length-1];p.hidePopover();return 'the popover '+nm(p);}
 var ds=[].slice.call(document.querySelectorAll('dialog[open]')).filter(function(d){try{return d.matches(':modal')}catch(x){return false}}),d=ds[ds.length-1];
 if(d&&d.dispatchEvent(new Event('cancel',{cancelable:true}))){d.close();return 'the dialog '+nm(d);}
 return '';}
function setVal(e,text){if(e.isContentEditable){e.textContent=text;}else{var proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,text);}
 e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
/* capture console, errors, dialogs, requests; a window the page opens is a tab of its own (decision 211) */
if(!window.__ocmHooks){window.__ocmHooks=1;window.__ocmLog=window.__ocmLog||[];window.__ocmNet=[];window.__ocmDialogs=[];window.__ocmBlock=[];window.__ocmHdr=window.__ocmHdr||{};
 window.__ocmKeySeen=0;window.addEventListener('keydown',function(e){if(e.isTrusted)window.__ocmKeySeen++;},true);
 /* is the page quiet? requests in flight (fetch/XHR, by start time) and when the document last changed */
 window.__ocmIn={};window.__ocmInN=0;window.__ocmMutT=Date.now();
 var inS=function(){var k=++window.__ocmInN;window.__ocmIn[k]=Date.now();return k;},inE=function(k){delete window.__ocmIn[k];};
 try{new MutationObserver(function(l){for(var i=0;i<l.length;i++){var a=l[i].attributeName;if(!a||a.indexOf('data-ocm')!==0){window.__ocmMutT=Date.now();return;}}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});}catch(e){}
 var pre=!!window.__ocmErr;/* the workspace server's catcher already logs errors and console.error */
 (pre?['log','info','warn','debug']:['log','info','warn','error','debug']).forEach(function(l){var o=console[l];console[l]=function(){try{window.__ocmLog.push({t:l,m:[].slice.call(arguments).map(function(a){try{return typeof a==='string'?a:JSON.stringify(a);}catch(e){return String(a);}}).join(' ').slice(0,400)});if(window.__ocmLog.length>200)window.__ocmLog.shift();}catch(e){}return o.apply(console,arguments);};});
 if(!pre)window.addEventListener('error',function(e){window.__ocmLog.push({t:'pageerror',m:String(e.message||e).slice(0,400)});});
 if(!pre)window.addEventListener('unhandledrejection',function(e){window.__ocmLog.push({t:'pageerror',m:'Unhandled rejection: '+String(e.reason&&e.reason.message||e.reason).slice(0,400)});});
 var dlg=function(type,def){return function(m,d){var no=window.__ocmDialogMode==='dismiss',v=type==='confirm'?!no:type==='prompt'?(no?null:(window.__ocmPromptText!=null?window.__ocmPromptText:(d!=null?String(d):''))):undefined;window.__ocmDialogs.push({type:type,message:String(m).slice(0,300),answer:type==='alert'?'OK':type==='confirm'?(v?'OK':'Cancel'):(v==null?'Cancel':JSON.stringify(v))});return v;};};
 window.alert=dlg('alert');window.confirm=dlg('confirm');window.prompt=dlg('prompt');
 /* a navigation to another document this one started (a link, a submit, location=…): this document stays 'complete' until the next one commits, so it is marked here */
 var navOn=function(u){var n={u:String(u||'').slice(0,200),t:Date.now()};window.__ocmNav=n;return n;};
 if(window.navigation&&navigation.addEventListener){navigation.addEventListener('navigate',function(e){if(!e.destination||e.destination.sameDocument||e.hashChange||e.downloadRequest!=null)return;var n=navOn(e.destination.url);setTimeout(function(){if(e.defaultPrevented&&window.__ocmNav===n)window.__ocmNav=null;},0);});
  navigation.addEventListener('navigatesuccess',function(){window.__ocmNav=null;});navigation.addEventListener('navigateerror',function(){window.__ocmNav=null;});}
 window.addEventListener('beforeunload',function(){if(!window.__ocmNav)navOn('');});
 window.__ocmDownloads=[];
 var grab=function(a){var h=a.href||'',nm=a.getAttribute('download');if(!h||(nm==null&&!/^(blob|data):/.test(h)))return false;
  var d={name:nm||decodeURIComponent((h.split(/[?#]/)[0].split('/').pop())||'download'),href:h.slice(0,200),state:'fetching'};window.__ocmDownloads.push(d);
  fetch(h).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(function(b){var u=new Uint8Array(b),s='',i;if(u.length>15e6)throw new Error('over 15 MB');for(i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));d.b64=btoa(s);d.size=u.length;d.state='done'}).catch(function(e){d.state='failed';d.error=String(e&&e.message||e)});return true;};
 document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&!e.defaultPrevented&&grab(a))e.preventDefault();},false);
 var ac=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(!this.isConnected&&grab(this))return;return ac.apply(this,arguments)};
 var hdr=function(){var h=window.__ocmHdr||{},k,n=0;for(k in h)n++;return n?h:null;};
 var F=window.fetch;if(F)window.fetch=function(i,o){var u=String(i&&i.url||i);
  if(window.__ocmOff){window.__ocmNet.push({t:Date.now(),m:(o&&o.method)||'GET',u:u.slice(0,200),s:'offline'});return Promise.reject(new TypeError('Failed to fetch'));}
  var xh=hdr();if(xh){o=Object.assign({},o||{});var H=new Headers(o.headers||(i&&i.headers)||{});for(var hk in xh)H.set(hk,xh[hk]);o.headers=H;}for(var b=0;b<window.__ocmBlock.length;b++)if(u.indexOf(window.__ocmBlock[b])>=0){window.__ocmNet.push({t:Date.now(),m:(o&&o.method)||'GET',u:u.slice(0,200),s:'blocked'});return Promise.reject(new TypeError('Blocked by assistant'));}
  var r=F.apply(this,[i,o]),k=inS();r.then(function(){inE(k)},function(){inE(k)});r.then(function(x){window.__ocmNet.push({t:Date.now(),m:(o&&o.method)||'GET',u:u.slice(0,200),s:x.status});if(window.__ocmNet.length>300)window.__ocmNet.shift();},function(){window.__ocmNet.push({t:Date.now(),m:'GET',u:u.slice(0,200),s:'failed'});});return r;};
 var XS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){var xh=hdr();if(xh)for(var hk in xh){try{this.setRequestHeader(hk,xh[hk]);}catch(e){}}return XS.apply(this,arguments);};
 var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var uu=String(u),self=this;for(var b=0;b<window.__ocmBlock.length;b++)if(uu.indexOf(window.__ocmBlock[b])>=0){window.__ocmNet.push({t:Date.now(),m:m,u:uu.slice(0,200),s:'blocked'});uu='data:,blocked';}
  var k;this.addEventListener('loadstart',function(){k=inS()});this.addEventListener('loadend',function(){inE(k);window.__ocmNet.push({t:Date.now(),m:m,u:uu.slice(0,200),s:self.status});if(window.__ocmNet.length>300)window.__ocmNet.shift();});return X.apply(this,[m,uu].concat([].slice.call(arguments,2)));};}
/* where an element is for a real tap, and what would make the tap miss it: off screen, hidden, no size, or another
    element on top (named tag#id.class "text"); l/t/w/h is its box, so two looks a moment apart tell if it still moves */
function whereOf(e){var W=e.ownerDocument.defaultView||window,fe=W!==window&&W.frameElement;
  var r=rectOf(e),x=r.left+r.width/2,y=r.top+r.height/2,off=x<0||y<0||x>innerWidth||y>innerHeight,h=off?null:document.elementFromPoint(x,y);if(fe&&h===fe){var ir=e.getBoundingClientRect();h=e.ownerDocument.elementFromPoint(ir.left+ir.width/2,ir.top+ir.height/2);}
  var rn=e.getRootNode&&e.getRootNode();if(!off&&rn&&rn.host&&rn.elementFromPoint){var sr2=e.getBoundingClientRect();h=rn.elementFromPoint(sr2.left+sr2.width/2,sr2.top+sr2.height/2)||h;}
  var cs=W.getComputedStyle(e),hid=cs.display==='none'?'display:none':cs.visibility==='hidden'?'visibility:hidden':cs.opacity==='0'?'opacity:0':'';
  var cov=h&&h!==e&&!e.contains(h)&&!h.contains(e)?nameOf(popupOf(h)||h):'';
  return {x:x,y:y,vw:innerWidth,vh:innerHeight,l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),zero:r.width<1||r.height<1,off:off,hidden:hid,covered:cov,self:nameOf(e)};}
window.__ocmB={
 snapshot:function(off,max){
  var fds=frameDocs();[document].concat(fds).forEach(function(d){d.querySelectorAll('[data-ocm]').forEach(function(e){e.removeAttribute('data-ocm');});});
  var out=[],n=0,more=0,above=0,below=0,all=[].slice.call(document.querySelectorAll(SEL));
  var srs=shadowRoots(document);
  fds.concat(srs).forEach(function(d){all=all.concat([].slice.call(d.querySelectorAll(SEL)));});
  srs.forEach(function(r){r.querySelectorAll('[data-ocm]').forEach(function(e){e.removeAttribute('data-ocm');});});
  /* what is on top of the page comes first: a cookie wall's buttons are the last in the document, and with more than
     80 things on the page they used to fall off the list – the one button that mattered was not in it */
  var bodyT=clean(document.body&&document.body.innerText),ov=overlay(bodyT),inOv=function(e){return !!ov&&(ov.e.contains(e)||(e.ownerDocument!==document&&e.ownerDocument.defaultView.frameElement===ov.e));},ovN=0;
  if(ov||all.length>80){var many=all.length>80,first=[],rest=[];all.forEach(function(e){(inOv(e)||(many&&pinned(e))?first:rest).push(e);});all=first.concat(rest);}
  for(var i=0;i<all.length;i++){var e=all[i];if(!vis(e)||e.disabled)continue;
   var r=rectOf(e);if(r.bottom<0){above++;continue;}if(r.top>innerHeight*3){below++;continue;}
   if(n>=80){more++;continue;}
   n++;e.setAttribute('data-ocm',n);
   var line='['+n+'] '+kind(e)+' "'+label(e)+'"';
   if(e.tagName==='A'&&e.href)line+=' → '+e.href.slice(0,100);
   if(e.value&&/input|textarea|select/i.test(e.tagName)&&e.type!=='password')line+=' = "'+String(e.value).slice(0,40)+'"';
   if(e.checked)line+=' (checked)';
   if(e.ownerDocument!==document)line+=' (in a frame)';
   if(inOv(e)){line+=' (in the popup)';ovN++;}
   if(r.top>innerHeight||r.bottom<0)line+=' (off-screen, scroll to reach)';
   out.push(line);}
  var xf=0;[].forEach.call(document.querySelectorAll('iframe,frame'),function(f){if(xf>=5)return;var cd=null;try{cd=f.contentDocument}catch(x){}if(cd)return;var r=f.getBoundingClientRect();if(r.width<50||r.height<30||r.bottom<0||r.top>innerHeight*3||!vis(f))return;var h='';try{h=new URL(f.src,location.href).host}catch(x){}xf++;
   out.push('[frame] from '+(h||'another site')+(f.title?' "'+clean(f.title).slice(0,50)+'"':'')+' at x '+Math.round(r.left)+'–'+Math.round(r.right)+', y '+Math.round(r.top)+'–'+Math.round(r.bottom)+' – another site, so what is inside is not in this list: take a screenshot, then mouse kind click at a point inside it');});
  var full=bodyT;fds.forEach(function(d){var f=d.defaultView.frameElement,t=clean(d.body.innerText);if(t)full+=' [frame '+((f&&(f.getAttribute('src')||f.id))||'')+': '+t+']';});
  srs.forEach(function(r){var t=clean([].map.call(r.children,function(c){return c.innerText||''}).join(' '));if(t&&full.indexOf(t)<0)full+=' ['+r.host.tagName.toLowerCase()+': '+t+']';});
  var o=Math.max(0,off|0),m=Math.max(50,Math.min(20000,max|0||6000)),text=full.slice(o,o+m),sc=scroller();
  var dl=window.__ocmDialogs||[],ds=window.__ocmDlgSeen||0;window.__ocmDlgSeen=dl.length;
  return JSON.stringify({overlay:ov?{what:ov.what,pct:ov.pct,frame:ov.frame,n:ovN}:null,downloads:(window.__ocmDownloads||[]).length,dialogs:dl.slice(ds).slice(-5),url:location.href,title:document.title,scrollY:Math.round(sc.scrollTop),pageHeight:sc.scrollHeight,viewHeight:sc.clientHeight,elements:out,moreElements:more+above+below,moreAbove:above,moreBelow:below,text:text,textFrom:o,textLen:full.length});},
 where:function(t){return JSON.stringify(whereOf(pick(t)));},
 /* scroll it into view at once (a smooth-scrolling page moved it while it was tapped), arm the check that the next click
    reaches it, and say where it is (where) */
 aim:function(t,o){o=o||{};var e=pick(t),W=e.ownerDocument.defaultView||window;var fe=W!==window&&W.frameElement;
  if(o.scroll!==false){var ins={block:'center',inline:'center',behavior:'instant'};if(fe)fe.scrollIntoView(ins);e.scrollIntoView(ins);}
  var A0=window.__ocmAim;if(A0&&A0.f)A0.W.removeEventListener('click',A0.f,true);
  var A={e:e,clicked:false,trusted:false,active:false,n0:(window.__ocmClip||{}).n||0,W:W};var f=function(ev){var pth=ev.composedPath?ev.composedPath():[ev.target];if(pth.indexOf(e)<0&&!(ev.target===e||e.contains(ev.target)))return;W.removeEventListener('click',f,true);var a=window.__ocmAim;a.clicked=true;a.trusted=ev.isTrusted;a.active=!!(W.navigator.userActivation&&W.navigator.userActivation.isActive);};A.f=f;window.__ocmAim=A;W.addEventListener('click',f,true);
  return JSON.stringify(whereOf(e));},
 /* pdf: scroll one screen further (lazy pages load what comes into view) → where it is */
 stepDown:function(){var d=document.scrollingElement||document.documentElement,list=[scroller()],r=null;if(list[0]!==d)list.push(d);
  for(var k=0;k<list.length;k++){var sc=list[k],y0=sc.scrollTop;sc.style.setProperty('scroll-behavior','auto','important');d.style.setProperty('scroll-behavior','auto','important');
   var to=y0+Math.max(200,sc.clientHeight*0.9);if(sc===d)window.scrollTo({top:to,behavior:'instant'});else sc.scrollTop=to;
   r={y:Math.round(sc.scrollTop),max:sc.scrollHeight-sc.clientHeight,moved:sc.scrollTop>y0+1};if(r.moved)break;}
  return JSON.stringify(r);},
 toTop:function(){var d=document.scrollingElement||document.documentElement,sc=scroller();[sc,d].forEach(function(e){e.style.setProperty('scroll-behavior','auto','important');e.scrollTop=0;});window.scrollTo({top:0,behavior:'instant'});[sc,d].forEach(function(e){e.style.removeProperty('scroll-behavior');});return 'ok';},
 /* pdf: an app that scrolls inside a box (Notion, Gmail…) prints one screen only: let the box and its parents grow */
 unclip:function(){var sc=scroller(),d=document.scrollingElement||document.documentElement,saved=[];window.__ocmUnclip=saved;
  if(sc===d||sc===document.body)return JSON.stringify({inner:false});
  for(var e=sc;e&&e!==document.documentElement;e=e.parentElement){saved.push([e,e.getAttribute('style')]);e.style.setProperty('height','auto','important');e.style.setProperty('max-height','none','important');e.style.setProperty('overflow','visible','important');e.style.setProperty('position',getComputedStyle(e).position==='fixed'?'static':getComputedStyle(e).position,'important');}
  [document.documentElement,document.body].forEach(function(e){saved.push([e,e.getAttribute('style')]);e.style.setProperty('height','auto','important');e.style.setProperty('overflow','visible','important');});
  var st=document.createElement('style');st.id='__ocmPrint';st.textContent='@media print{html,body{height:auto!important;overflow:visible!important}}';document.head.appendChild(st);
  return JSON.stringify({inner:true,box:sc.tagName.toLowerCase()+(sc.id?'#'+sc.id:'')+(sc.className&&typeof sc.className==='string'?'.'+sc.className.trim().split(/ +/)[0]:''),height:sc.scrollHeight});},
 reclip:function(){(window.__ocmUnclip||[]).forEach(function(p){if(p[1]==null)p[0].removeAttribute('style');else p[0].setAttribute('style',p[1]);});window.__ocmUnclip=[];var st=document.getElementById('__ocmPrint');if(st)st.remove();return 'ok';},
 aimed:function(){var a=window.__ocmAim||{},C=window.__ocmClip||{};return JSON.stringify({hit:!!a.clicked,trusted:!!a.trusted,active:!!a.active,copied:(C.n||0)>(a.n0||0)?String(C.text).slice(0,300):null});},
 click:function(t,o){o=o||{};var e=pick(t);if(!o.right&&e.matches&&e.matches(':disabled'))throw new Error('That element is disabled (greyed out): a click does nothing until the page enables it – something it waits for is missing (a required field, a checkbox, a choice). Read the page for what.');e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect(),pt={clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:o.right?2:0};
  if(o.right){fire(e,['pointerdown','mousedown','pointerup','mouseup','contextmenu'],pt);return 'right-clicked';}
  e.focus&&e.focus();if(o.dbl){e.click();e.click();fire(e,['dblclick'],pt);return 'double-clicked';}e.click();return 'clicked';},
 hover:function(t){var e=pick(t);e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect(),pt={clientX:r.left+r.width/2,clientY:r.top+r.height/2};fire(e,['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove'],pt);return 'hovered';},
 upload:function(t,files){var e=t&&(t.id!=null||t.selector)?pick(t):null;
  if(!e||!(e.tagName==='INPUT'&&e.type==='file')){var inner=e&&(e.querySelector&&e.querySelector('input[type=file]')||e.control||(e.htmlFor&&D.getElementById(e.htmlFor)));
   if(inner&&inner.type==='file')e=inner;else if(!e){var all=findAll('css=input[type=file]');if(!all.length)throw new Error('This page has no file field');e=all[0];}}
  var dt=new DataTransfer();for(var i=0;i<files.length;i++){var f=files[i],bin=atob(f.b64),u=new Uint8Array(bin.length);for(var j=0;j<bin.length;j++)u[j]=bin.charCodeAt(j);dt.items.add(new File([u],f.name,f.mtime?{type:f.type||'',lastModified:f.mtime}:{type:f.type||''}));}
  if(e.tagName==='INPUT'&&e.type==='file'){if(!e.multiple&&files.length>1)throw new Error('That field takes one file');e.files=dt.files;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'attached '+files.length+' file(s) to the file field';}
  ['dragenter','dragover','drop'].forEach(function(n){e.dispatchEvent(new DragEvent(n,{bubbles:true,cancelable:true,dataTransfer:dt}))});return 'dropped '+files.length+' file(s) on the element';},
 focus:function(t){var e=pick(t);e.scrollIntoView({block:'center'});e.focus();return 'focused';},
 check:function(t,val){var e=pick(t);e.scrollIntoView({block:'center'});var on=e.type==='checkbox'||e.type==='radio'?e.checked:e.getAttribute('aria-checked')==='true';if(on!==val)e.click();return val?'checked':'unchecked';},
 type:function(t,text,submit,force){var e=pick(t);if(e.isContentEditable&&!force)throw new Error('That is an editable block of the page itself, not a form field – typing would change the document. Pass force:true only if the user asked you to edit it.');e.scrollIntoView({block:'center'});e.focus();
  if(e.tagName==='SELECT'){var ok=false;for(var i=0;i<e.options.length;i++){if(clean(e.options[i].text).toLowerCase()===clean(text).toLowerCase()||e.options[i].value===text){e.selectedIndex=i;ok=true;}}
   if(!ok)throw new Error('No option "'+text+'"');e.dispatchEvent(new Event('change',{bubbles:true}));return 'selected';}
  setVal(e,text);
  if(submit){keyEv(e,'Enter',{});if(e.form){if(e.form.requestSubmit)e.form.requestSubmit();else e.form.submit();}}
  return 'typed';},
 press:function(k,t,mods){var e=(t&&(t.selector||t.id!=null))?pick(t):(document.activeElement||document.body);mods=mods||{};if(t&&(t.selector||t.id!=null))e.focus&&e.focus();var went=keyEv(e,k,mods);
  if(k==='Escape'&&went&&!mods.ctrl&&!mods.alt&&!mods.meta&&!mods.shift){var gone=escapeTop();if(gone)return 'Escape closed '+gone+'.';}
  if(k==='Enter'&&e.form&&e.tagName==='INPUT'){if(e.form.requestSubmit)e.form.requestSubmit();}
  if(mods.ctrl&&/^a$/i.test(k)&&e.select)e.select();var em=went&&!(k==='Enter'&&e.form&&e.tagName==='INPUT')?emuKey(e,k,mods):'';return em?'pressed – done by hand, as the browser would: '+em:'pressed';},
 /** an event sent to an element (Playwright dispatchEvent): click, input, change, focus, a custom one… */
 dispatch:function(t,type,init){var e=pick(t),ty=String(type||'click'),C=/^(click|dblclick|mouse|contextmenu)/.test(ty)?MouseEvent:/^key/.test(ty)?KeyboardEvent:/^pointer/.test(ty)&&window.PointerEvent?PointerEvent:/^(focus|blur)/.test(ty)?FocusEvent:/^(input|beforeinput)$/.test(ty)?InputEvent:/^drag|^drop/.test(ty)?DragEvent:Event;
  var o=Object.assign({bubbles:true,cancelable:true,composed:true},init||{});if(C===Event&&o.detail!==undefined)C=CustomEvent;var ok=e.dispatchEvent(new C(ty,o));return 'sent '+ty+' to '+nameOf(e)+(ok?'':' (the page cancelled it: preventDefault)');},
 keyboardType:function(text){var e=document.activeElement||document.body;if(e.isContentEditable){document.execCommand('insertText',false,text);return 'typed';}
  if('value' in e){var v=String(e.value||''),a=e.selectionStart==null?v.length:e.selectionStart,b=e.selectionEnd==null?a:e.selectionEnd;setVal(e,v.slice(0,a)+text+v.slice(b));try{e.setSelectionRange(a+text.length,a+text.length);}catch(x){}return 'typed';}
  for(var i=0;i<text.length;i++)keyEv(e,text[i],{});return 'typed';},
 mouse:function(x,y,kind){var e=document.elementFromPoint(x,y);if(!e)throw new Error('Nothing at that point');var pt={clientX:x,clientY:y};
  if(kind==='move')fire(e,['pointerover','mouseover','pointermove','mousemove'],pt);else if(kind==='down')fire(e,['pointerdown','mousedown'],pt);else if(kind==='up')fire(e,['pointerup','mouseup'],pt);else{fire(e,['pointerdown','mousedown','pointerup','mouseup'],pt);e.click();}return 'mouse '+kind;},
 drag:function(t,to){var a=pick(t),b=pick(to),ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect(),dt=new DataTransfer(),pa={clientX:ra.left+ra.width/2,clientY:ra.top+ra.height/2},pb={clientX:rb.left+rb.width/2,clientY:rb.top+rb.height/2};
  fire(a,['pointerdown','mousedown'],pa);var d=function(el,ty,pt){el.dispatchEvent(new DragEvent(ty,Object.assign({bubbles:true,cancelable:true,dataTransfer:dt},pt)));};
  d(a,'dragstart',pa);d(b,'dragenter',pb);d(b,'dragover',pb);d(b,'drop',pb);d(a,'dragend',pb);fire(b,['pointermove','mousemove','pointerup','mouseup'],pb);return 'dragged';},
 reveal:function(t){var e=pick(t);e.scrollIntoView({block:'center'});return 'revealed';},
 check_:function(kind,arg,state){
  if(kind==='selector'){var a=findAll(arg),v=a.filter(vis);if(state==='hidden')return v.length===0;if(state==='detached')return a.length===0;if(state==='attached')return a.length>0;return v.length>0;}
  if(kind==='text')return clean(document.body&&document.body.innerText).toLowerCase().indexOf(String(arg).toLowerCase())>=0;
  if(kind==='url')return location.href.indexOf(arg)>=0;
  if(kind==='load')return document.readyState==='complete'&&!window.__ocmNav;return true;},
 quiet:function(){var n=0,now=Date.now(),m=window.__ocmIn||{};for(var k in m)if(now-m[k]<5000)n++;var an=0;try{(document.getAnimations?document.getAnimations():[]).forEach(function(x){if(x.playState!=='running')return;var t=x.effect&&x.effect.getComputedTiming&&x.effect.getComputedTiming();if(t&&isFinite(t.endTime)&&t.endTime-(Number(t.localTime)||0)<3000)an++;});}catch(e){}return JSON.stringify({rs:document.readyState,inflight:n,sinceMut:now-(window.__ocmMutT||0),nav:!!window.__ocmNav,anim:an});},
 navState:function(){var n=window.__ocmNav;return JSON.stringify({pending:n?(n.u||'another page'):null,ms:n?Date.now()-n.t:0,rs:document.readyState,url:location.href});},
 get:function(prop,t,attr){var e=pick(t);
  if(prop==='text')return clean(e.innerText||e.textContent);if(prop==='inner_html')return e.innerHTML.slice(0,20000);if(prop==='outer_html')return e.outerHTML.slice(0,20000);
  if(prop==='value')return e.value;if(prop==='attribute')return e.getAttribute(attr);if(prop==='visible')return vis(e);if(prop==='enabled')return !e.disabled;
  if(prop==='checked')return !!e.checked;if(prop==='box'){var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};}
  if(prop==='count')return findAll(t.selector).length;throw new Error('Unknown property '+prop);},
 queryAll:function(sel,limit){var a=findAll(sel),out=[];for(var i=0;i<a.length&&i<limit;i++){var e=a[i],o={i:i,tag:e.tagName.toLowerCase(),text:clean(e.innerText||e.textContent).slice(0,120),visible:vis(e)};if(e.href)o.href=e.href.slice(0,160);if(e.value&&e.tagName!=='LI')o.value=String(e.value).slice(0,60);if(e.id)o.id=e.id;if(e.getAttribute('class'))o.class=e.getAttribute('class').slice(0,60);out.push(o);}return JSON.stringify({total:a.length,items:out});},
 storage:function(kind,op,key,val){var st=kind==='session'?sessionStorage:localStorage;if(op==='set'){st.setItem(key,val);return 'set';}if(op==='remove'){st.removeItem(key);return 'removed';}if(op==='clear'){st.clear();return 'cleared';}
  if(key!=null&&key!=='')return st.getItem(key);var o={};for(var i=0;i<st.length;i++){var k=st.key(i);o[k]=String(st.getItem(k)).slice(0,200);}return o;},
 cookies:function(op,name,val){if(op==='set'){document.cookie=name+'='+encodeURIComponent(val)+'; path=/';return 'set';}
  if(op==='clear'){document.cookie.split(';').forEach(function(c){var n=c.split('=')[0].trim();if(n)document.cookie=n+'=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';});return 'cleared';}
  return document.cookie.split(';').map(function(c){var i=c.indexOf('=');return {name:c.slice(0,i).trim(),value:decodeURIComponent(c.slice(i+1).trim()).slice(0,200)};}).filter(function(c){return c.name;});},
 scroll:function(dir,y,amt){var sc=scroller(),h=sc.clientHeight*0.8;if(typeof y==='number'&&y>=0)sc.scrollTop=y;else if(typeof amt==='number'&&amt)sc.scrollTop+=amt;else if(dir==='top')sc.scrollTop=0;else if(dir==='bottom')sc.scrollTop=sc.scrollHeight;else sc.scrollTop+=dir==='up'?-h:h;return 'scrolled';},
 key:function(k){var sc=scroller(),h=sc.clientHeight*0.9;
  if(k==='PageDown')sc.scrollTop+=h;else if(k==='PageUp')sc.scrollTop-=h;else if(k==='End')sc.scrollTop=sc.scrollHeight;else if(k==='Home')sc.scrollTop=0;
  else{var t=document.activeElement||document.body;['keydown','keypress','keyup'].forEach(function(ty){t.dispatchEvent(new KeyboardEvent(ty,{key:k,code:k,bubbles:true}));});}
  return 'key';},
 chunk:function(){var sc=scroller(),items=[],b=document.querySelectorAll('[data-block-id]');
  function own(el){var out=[];(function w(n){for(var c=n.firstChild;c;c=c.nextSibling){if(c.nodeType===3)out.push(c.nodeValue);else if(c.nodeType===1){if(c.hasAttribute('data-block-id')||/^(SCRIPT|STYLE|NOSCRIPT)$/.test(c.tagName))continue;w(c);if(/^(DIV|P|LI|BR|H[1-6]|TR|TD)$/.test(c.tagName))out.push(' ');}}})(el);return clean(out.join(''));}
  var raw='';
  if(b.length){for(var i=0;i<b.length;i++){var t=own(b[i]);if(t)items.push([b[i].getAttribute('data-block-id'),t]);}}
  else{raw=String((sc===document.scrollingElement||sc===document.documentElement?document.body:sc).innerText||'').split('\\n').map(function(l){return l.replace(/\\s+$/,'');}).filter(function(l){return l.trim();}).join('\\n');}
  return JSON.stringify({items:items,hasBlocks:b.length>0,raw:raw,n:b.length||raw.length,y:Math.round(sc.scrollTop),h:sc.scrollHeight,view:sc.clientHeight,atBottom:sc.scrollTop+sc.clientHeight>=sc.scrollHeight-4});},
 back:function(){history.back();return 'back';},
 forward:function(){history.forward();return 'forward';},
 reload:function(){location.reload();return 'reload';}
};})()`;

