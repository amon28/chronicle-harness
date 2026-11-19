// A full-page capture makes the hidden window as tall as the page. Anything sized from the window (100vh, min-height:
// 100vh, 50dvh…) then grows with it, the page gets taller than the capture, and its bottom is cut – while the picture
// looks complete. Android's WebView cannot capture beyond its window (desktop Chrome's captureBeyondViewport), so
// those elements are held at the size they had on the normal screen for the capture, and put back afterwards.
// Found from the page's own stylesheets (cross-origin ones cannot be read) and inline styles.

/** In the page: pin the window-sized elements. → how many were pinned */
export const PIN_VH = `(function(){
var rx=/(^|[^a-z])[\\d.]+(d|s|l)?(vh|vmin|vmax|vb)\\b/i,P=['height','min-height','max-height','box-sizing'];
var sels=[];
function scan(rules){for(var i=0;i<rules.length;i++){var r=rules[i];if(r.cssRules&&!r.selectorText){try{scan(r.cssRules)}catch(e){}continue}
if(!r.selectorText||!r.style)continue;for(var k=0;k<3;k++){var v=r.style.getPropertyValue(P[k]);if(v&&rx.test(v)){sels.push(r.selectorText);break}}}}
for(var s=0;s<document.styleSheets.length;s++){try{scan(document.styleSheets[s].cssRules)}catch(e){}}
var els=[];function add(e){if(els.indexOf(e)<0)els.push(e)}
sels.forEach(function(sel){try{document.querySelectorAll(sel).forEach(add)}catch(e){}});
document.querySelectorAll('[style]').forEach(function(e){for(var k=0;k<3;k++){if(rx.test(e.style.getPropertyValue(P[k]))){add(e);break}}});
var kept=window.__ocmPinned=[];
var hs=els.map(function(e){return e.getBoundingClientRect().height});
els.forEach(function(e,i){var o={e:e};P.forEach(function(p){o[p]=[e.style.getPropertyValue(p),e.style.getPropertyPriority(p)]});kept.push(o);
e.style.setProperty('box-sizing','border-box','important');e.style.setProperty('height',hs[i]+'px','important');
e.style.setProperty('min-height','0px','important');e.style.setProperty('max-height','none','important')});
return kept.length})()`;

/** In the page: put them back as they were. */
export const UNPIN_VH = `(function(){var k=window.__ocmPinned||[];k.forEach(function(o){['height','min-height','max-height','box-sizing'].forEach(function(p){
if(o[p][0])o.e.style.setProperty(p,o[p][0],o[p][1]);else o.e.style.removeProperty(p)})});window.__ocmPinned=[];return k.length})()`;

/**
 * In the page, for a capture that has to stretch the window: what scripts read about the window keeps the normal
 * screen's values (innerHeight/innerWidth, outerHeight, the root's clientHeight/Width, visualViewport) and resize
 * events do not reach the page's handlers – a hero sized from innerHeight in a resize handler would otherwise grow with
 * the window and push the footer out of the picture. Together with PIN_VH (CSS vh).
 */
export const FREEZE_WINDOW = `(function(){if(window.__ocmFrozen)return 0;var W=innerWidth,H=innerHeight,OH=outerHeight,CW=document.documentElement.clientWidth,CH=document.documentElement.clientHeight;
var saved=[];function hold(o,k,v){if(!o)return;var own=Object.getOwnPropertyDescriptor(o,k);saved.push([o,k,own]);try{Object.defineProperty(o,k,{get:function(){return v},configurable:true})}catch(e){}}
hold(window,'innerHeight',H);hold(window,'innerWidth',W);hold(window,'outerHeight',OH);hold(document.documentElement,'clientHeight',CH);hold(document.documentElement,'clientWidth',CW);
if(window.visualViewport){hold(window.visualViewport,'height',window.visualViewport.height);hold(window.visualViewport,'width',window.visualViewport.width)}
var stop=function(e){e.stopImmediatePropagation()};window.addEventListener('resize',stop,true);if(window.visualViewport)window.visualViewport.addEventListener('resize',stop,true);
window.__ocmFrozen={saved:saved,stop:stop};return 1})()`;

/** In the page: the window is the window again. */
export const THAW_WINDOW = `(function(){var f=window.__ocmFrozen;if(!f)return 0;f.saved.reverse().forEach(function(x){try{if(x[2])Object.defineProperty(x[0],x[1],x[2]);else delete x[0][x[1]]}catch(e){}});
window.removeEventListener('resize',f.stop,true);if(window.visualViewport)window.visualViewport.removeEventListener('resize',f.stop,true);window.__ocmFrozen=null;return 1})()`;
