// Runs playground code in a sandboxed page with an opaque origin and no extension APIs.
const pre = `<script>(function(){var P=function(t,a){try{parent.postMessage({df:'console',level:t,args:Array.prototype.map.call(a,function(x){try{return typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)}})},'*')}catch(e){}};['log','info','warn','error'].forEach(function(l){var o=console[l];console[l]=function(){P(l,arguments);o.apply(console,arguments)}});window.addEventListener('error',function(e){P('error',[e.message+' ('+(e.lineno||'?')+':'+(e.colno||'?')+')'])});window.addEventListener('unhandledrejection',function(e){P('error',['Unhandled rejection: '+(e.reason&&e.reason.message||e.reason)])})})();</script>`;
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.df !== 'run') return;
  const doc = `<!doctype html><html><head><meta charset="utf-8">${pre}<style>${m.css || ''}</style></head><body>${m.html || ''}<script>${(m.js || '').replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  document.open();
  document.write(doc);
  document.close();
});
