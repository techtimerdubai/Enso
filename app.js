/* Ensō 円相 — a free, kid-friendly infinite-canvas drawing app (Android-first).
   Strokes are vectors in WORLD space, so zoom stays razor-sharp at any scale.
   Rendering uses cached layers (paper / committed ink / live overlay) so drawing
   stays smooth even with lots of strokes. */
(() => {
  'use strict';

  const canvas = document.getElementById('paper');
  const ctx = canvas.getContext('2d');
  // offscreen layers: paper+grid, committed ink, and a live-draw overlay
  const paperCv = document.createElement('canvas'), pctx = paperCv.getContext('2d');
  const inkCv   = document.createElement('canvas'), kctx = inkCv.getContext('2d');
  const overCv  = document.createElement('canvas'), octx = overCv.getContext('2d');

  /* ---------------- camera & document ---------------- */
  const cam = { x: 0, y: 0, scale: 1 };
  let dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  let cacheValid = false;                 // are paperCv / inkCv up to date for current cam?
  const invalidate = () => { cacheValid = false; requestRender(); };

  let strokes = [];          // committed items (strokes + stamps), in draw order
  let opSizes = [];          // undo groups: how many items each committed action added
  let redoStack = [];        // arrays of items
  let live = null;           // stroke being drawn

  const state = {
    tool: 'brush',
    color: '#2b2b31',
    size: 8,
    theme: 'light',
    grid: true,
    sym: false,
    axes: 6,
    rainbow: false,
    pendingStamp: null,      // {dataURL, img, size} awaiting placement
  };
  let rainbowHue = 0;

  // bright, friendly palette (kid-first) — sumi black kept for natural ink
  const PALETTE = [
    { c:'#2b2b31', n:'Black' },  { c:'#ff4d4f', n:'Red' },    { c:'#ff8c1a', n:'Orange' },
    { c:'#ffd21a', n:'Yellow' }, { c:'#37c86b', n:'Green' },  { c:'#20b8e6', n:'Sky' },
    { c:'#2f6bff', n:'Blue' },   { c:'#9a5bff', n:'Purple' }, { c:'#ff5fa2', n:'Pink' },
    { c:'#a2673f', n:'Brown' },  { c:'#ffffff', n:'White' },
  ];
  const STICKERS = ['⭐','🌈','❤️','🌸','🦋','🐱','🐶','🌟','🍭','🎈','🌞','🍡','🐢','🌷','⚡','🍎'];
  const paperColor = () => state.theme === 'dark' ? '#17181c' : '#f7f4ee';

  /* ---------------- persistence ---------------- */
  const KEY = 'enso.doc.v2';
  let quotaWarned = false;
  const save = () => { try {
    localStorage.setItem(KEY, JSON.stringify({ strokes: serialize(strokes), cam,
      state:{ theme:state.theme, grid:state.grid, axes:state.axes } }));
  } catch(e){ if(!quotaWarned){ quotaWarned = true; toast('Storage full — older work may not auto-save. Export to keep it.'); } } };
  const saveSoon = debounce(save, 400);
  function serialize(list){ return list.map(s => s.tool==='stamp'
    ? { tool:'stamp', dataURL:s.dataURL, x:r2(s.x), y:r2(s.y), size:r2(s.size) }
    : { tool:s.tool, color:s.color, size:s.size, pts:s.pts.map(p=>[r2(p.x),r2(p.y),r2(p.w)]) }); }
  function load(){ try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if(!d) return;
    if(d.cam) Object.assign(cam, d.cam);
    if(d.state){ state.theme=d.state.theme||state.theme; state.grid=d.state.grid!==false; state.axes=d.state.axes||6; }
    if(Array.isArray(d.strokes)) for(const s of d.strokes){
      if(s.tool==='stamp'){ strokes.push(makeStamp(s.dataURL, s.x, s.y, s.size)); }
      else { const st={ tool:s.tool, color:s.color, size:s.size, pts:s.pts.map(p=>({x:p[0],y:p[1],w:p[2]})) };
        finalizeBB(st); strokes.push(st); }
      opSizes.push(1);
    }
  } catch(e){} }

  /* ---------------- sizing (crisp on every device) ---------------- */
  function resize(){
    dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    for(const c of [canvas, paperCv, inkCv, overCv]){ c.width = w; c.height = h; }
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    invalidate();
  }

  /* ---------------- transforms ---------------- */
  const toWorld = (sx, sy) => ({ x: sx / cam.scale - cam.x, y: sy / cam.scale - cam.y });
  const worldTransform = g => g.setTransform(cam.scale*dpr, 0, 0, cam.scale*dpr, cam.x*cam.scale*dpr, cam.y*cam.scale*dpr);

  /* ---------------- rendering ---------------- */
  let needsRender = false;
  const requestRender = () => { if(!needsRender){ needsRender = true; requestAnimationFrame(render); } };

  function rebuildCache(){
    // paper + grid
    pctx.setTransform(dpr,0,0,dpr,0,0);
    pctx.fillStyle = paperColor(); pctx.fillRect(0,0,innerWidth,innerHeight);
    if(state.grid) drawGrid(pctx);
    // committed ink (transparent; eraser erases ink only)
    kctx.setTransform(1,0,0,1,0,0); kctx.clearRect(0,0,inkCv.width,inkCv.height);
    worldTransform(kctx);
    drawScene(kctx, strokes, Infinity);
    cacheValid = true;
  }

  function render(){
    needsRender = false;
    if(replay.active){ renderReplay(); return; }
    if(!cacheValid) rebuildCache();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(paperCv, 0, 0);
    if(live){
      // committed ink + the live stroke, composited so a live eraser reveals paper
      octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
      octx.drawImage(inkCv, 0, 0);
      worldTransform(octx);
      drawStroke(octx, live);
      if(state.sym) for(const c of symCopies(live)) drawStroke(octx, c);
      ctx.drawImage(overCv, 0, 0);
    } else {
      ctx.drawImage(inkCv, 0, 0);
    }
    if(state.sym) drawSymGuide();
  }

  function renderReplay(){
    if(!cacheValid) rebuildCache();               // paperCv valid for current (fixed) cam
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(paperCv, 0, 0);
    octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
    worldTransform(octx);
    drawScene(octx, strokes, replay.revealed);
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(overCv, 0, 0);
  }

  function viewRect(){ const a=toWorld(0,0), b=toWorld(innerWidth,innerHeight);
    return { minX:a.x, minY:a.y, maxX:b.x, maxY:b.y }; }

  function drawScene(target, list, upTo){
    const vr = viewRect(); const pad = 40/cam.scale;
    let count = 0;
    for(const s of list){
      const len = s.tool==='stamp' ? 1 : Math.max(1, s.pts.length);
      const revealHere = upTo === Infinity ? len : Math.min(len, Math.max(0, upTo - count));
      count += len;
      if(revealHere <= 0){ if(upTo!==Infinity && count > upTo) break; else continue; }
      if(s.bb && (s.bb.maxX < vr.minX-pad || s.bb.minX > vr.maxX+pad || s.bb.maxY < vr.minY-pad || s.bb.minY > vr.maxY+pad)) continue;
      if(s.tool==='stamp') drawStampItem(target, s);
      else drawStroke(target, s, revealHere < len ? Math.ceil(revealHere) : 0);
    }
  }

  function drawGrid(g){
    let step = 34 * cam.scale;
    while(step < 16) step *= 4;
    while(step > 150) step /= 4;
    const ox = ((cam.x*cam.scale)%step+step)%step, oy = ((cam.y*cam.scale)%step+step)%step;
    g.fillStyle = state.theme==='dark' ? 'rgba(255,255,255,.06)' : 'rgba(60,50,40,.07)';
    const r = clamp(cam.scale, .6, 1.4);
    for(let x=ox; x<innerWidth; x+=step) for(let y=oy; y<innerHeight; y+=step) g.fillRect(x-r/2, y-r/2, r, r);
  }

  function drawSymGuide(){
    ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0);
    const cx = cam.x*cam.scale, cy = cam.y*cam.scale;
    ctx.strokeStyle = 'rgba(224,80,58,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx-9,cy); ctx.lineTo(cx+9,cy); ctx.moveTo(cx,cy-9); ctx.lineTo(cx,cy+9); ctx.stroke();
    ctx.restore();
  }

  /* ---- draw one vector stroke as a smooth variable-width ribbon ---- */
  function drawStroke(target, s, partial){
    const pts = partial ? s.pts.slice(0, partial) : s.pts;
    if(!pts.length) return;
    setComposite(target, s.tool);
    target.fillStyle = s.color;
    if(pts.length === 1){
      target.beginPath(); target.arc(pts[0].x, pts[0].y, Math.max(.4, pts[0].w/2), 0, 7); target.fill();
      resetComposite(target); return;
    }
    const edges = ribbon(pts);
    const path = new Path2D();
    path.moveTo(edges.left[0].x, edges.left[0].y);
    for(let i=1;i<edges.left.length;i++) path.lineTo(edges.left[i].x, edges.left[i].y);
    for(let i=edges.right.length-1;i>=0;i--) path.lineTo(edges.right[i].x, edges.right[i].y);
    path.closePath();
    target.fill(path);
    target.beginPath(); target.arc(pts[0].x, pts[0].y, Math.max(.3,pts[0].w/2), 0, 7); target.fill();
    const e = pts[pts.length-1]; target.beginPath(); target.arc(e.x, e.y, Math.max(.3,e.w/2), 0, 7); target.fill();
    resetComposite(target);
  }

  function ribbon(pts){
    const left=[], right=[];
    for(let i=0;i<pts.length;i++){
      const p=pts[i]; let dx,dy;
      if(i===0){ dx=pts[1].x-p.x; dy=pts[1].y-p.y; }
      else if(i===pts.length-1){ dx=p.x-pts[i-1].x; dy=p.y-pts[i-1].y; }
      else { dx=pts[i+1].x-pts[i-1].x; dy=pts[i+1].y-pts[i-1].y; }
      const len=Math.hypot(dx,dy)||1, nx=-dy/len, ny=dx/len, hw=Math.max(.15,p.w/2);
      left.push({x:p.x+nx*hw, y:p.y+ny*hw});
      right.push({x:p.x-nx*hw, y:p.y-ny*hw});
    }
    return {left,right};
  }

  function setComposite(t, tool){
    if(tool==='eraser'){ t.globalCompositeOperation='destination-out'; t.globalAlpha=1; }
    else if(tool==='marker'){ t.globalCompositeOperation = state.theme==='dark'?'screen':'multiply'; t.globalAlpha=.38; }
    else { t.globalCompositeOperation='source-over'; t.globalAlpha=1; }
  }
  const resetComposite = t => { t.globalCompositeOperation='source-over'; t.globalAlpha=1; };

  function drawStampItem(target, s){
    if(!s._img || !s._img.complete || !s._img.naturalWidth) return;   // wait until decoded
    const half = s.size/2;
    target.globalAlpha = 1; target.globalCompositeOperation='source-over';
    try { target.drawImage(s._img, s.x-half, s.y-half, s.size, s.size); } catch(e){}
  }

  /* ---------------- input / drawing ---------------- */
  const pointers = new Map();
  let drawingId = null, panLast = null, pinch = null, pinch0 = null, spaceDown = false;
  let penDownCount = 0;                          // palm rejection: ignore touch while a pen is down
  const multi = { n:0, t:0, moved:false };       // multi-finger tap (undo/redo)
  const isPan = () => state.tool==='pan' || spaceDown;

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    stopInertia();
    if(e.pointerType==='pen') penDownCount++;
    // palm rejection — ignore fingers while a stylus is drawing
    if(e.pointerType==='touch' && penDownCount>0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch(_){}
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if(state.pendingStamp && e.isPrimary && pointers.size===1){ placeStamp(e.clientX, e.clientY); return; }

    if(pointers.size >= 2){
      multi.n = Math.max(multi.n, pointers.size);
      if(pointers.size===2){ multi.t = performance.now(); multi.moved = false; }
      startPinch();
      if(live){ live=null; drawingId=null; requestRender(); }
      return;
    }
    if(isPan()){ panLast={x:e.clientX,y:e.clientY}; panVel.x=panVel.y=0; panT=performance.now(); document.body.classList.add('panning'); return; }

    drawingId = e.pointerId; redoStack.length = 0;
    const w = toWorld(e.clientX, e.clientY);
    const col = state.rainbow ? nextRainbow() : state.color;
    live = { tool:state.tool, color:col, size:state.size, pts:[], _t:performance.now() };
    addPoint(live, w.x, w.y, pressure(e), 0);
    hideHint(); requestRender();
  });

  canvas.addEventListener('pointermove', e => {
    if(pointers.has(e.pointerId)) pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(pinch && pointers.size>=2){ updatePinch(); return; }
    if(panLast && isPan()){
      const now=performance.now(), dt=Math.max(1, now-panT); panT=now;
      const dx=(e.clientX-panLast.x)/cam.scale, dy=(e.clientY-panLast.y)/cam.scale;
      cam.x+=dx; cam.y+=dy;
      panVel.x = 0.75*panVel.x + 0.25*(dx/dt); panVel.y = 0.75*panVel.y + 0.25*(dy/dt);
      panLast={x:e.clientX,y:e.clientY}; invalidate(); saveSoon(); return;
    }
    if(drawingId===e.pointerId && live){
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const now = performance.now();
      for(const ev of (evs.length?evs:[e])){
        const w = toWorld(ev.clientX, ev.clientY);
        const last = live.pts[live.pts.length-1];
        if(last && Math.hypot(w.x-last.x, w.y-last.y)*cam.scale < 0.7) continue;
        addPoint(live, w.x, w.y, pressure(ev), now-live._t);
      }
      requestRender();
    }
  });

  function endPointer(e){
    if(e.pointerType==='pen' && penDownCount>0) penDownCount--;
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if(pointers.size<2){ pinch=null; pinch0=null; }

    if(drawingId===e.pointerId){
      if(live && live.pts.length){ finalizeStroke(live); commit(state.sym ? [live, ...symCopies(live)] : [live]); }
      live=null; drawingId=null; requestRender();
    }
    if(panLast){ panLast=null; document.body.classList.remove('panning'); startInertia(); saveSoon(); }

    // multi-finger tap → undo / redo (only when no drag/pinch happened)
    if(had && pointers.size===0 && multi.n>=2){
      if(!multi.moved && performance.now()-multi.t < 320){
        if(multi.n===2){ undo(); buzz(12); } else if(multi.n>=3){ redo(); buzz(12); }
      }
      multi.n = 0;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', e=>{ if(e.pointerType==='pen'&&penDownCount>0)penDownCount--; pointers.delete(e.pointerId); if(pointers.size<2){pinch=null;pinch0=null;} if(drawingId===e.pointerId){ live=null; drawingId=null; requestRender(); } if(panLast){ panLast=null; document.body.classList.remove('panning'); } });

  function pressure(e){
    if(e.pointerType==='pen' && e.pressure>0) return e.pressure;
    if(e.pointerType==='touch' && e.pressure>0 && e.pressure!==0.5) return e.pressure;
    return 0.5;
  }

  function addPoint(s, x, y, p, t){
    const pts=s.pts; const base=s.size; let w;
    if(s.tool==='marker'){ w = base*2.2; }
    else if(s.tool==='eraser'){ w = base*2.4; }
    else {
      let speedF = 1;
      const last = pts[pts.length-1];
      if(last && s.tool==='brush'){
        const dt = Math.max(1, t-(last._t||0));
        const v = Math.hypot(x-last.x, y-last.y)/dt;
        speedF = clamp(1 - v*0.18, 0.35, 1);
      }
      const pf = s.tool==='brush' ? (0.25+0.75*p) : (0.55+0.45*p);
      w = base * pf * speedF;
      const k = s.tool==='brush' ? 5 : 3;
      if(pts.length < k) w *= (0.4 + 0.6*pts.length/k);
    }
    pts.push({ x, y, w, _t:t });
  }

  function finalizeStroke(s){
    if(s.tool==='pen'||s.tool==='brush'){
      const k = s.tool==='brush'?6:3, n=s.pts.length;
      for(let i=0;i<k && i<n;i++){ const f=0.35+0.65*(i/k); s.pts[n-1-i].w *= f; }
    }
    for(const p of s.pts) delete p._t;
    finalizeBB(s);
  }
  function finalizeBB(s){
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity,mw=0;
    for(const p of s.pts){ a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y);mw=Math.max(mw,p.w); }
    s.bb={minX:a-mw,minY:b-mw,maxX:c+mw,maxY:d+mw};
  }

  function nextRainbow(){ rainbowHue = (rainbowHue + 47) % 360; return `hsl(${rainbowHue} 85% 55%)`; }

  /* ---------------- symmetry (mandala) ---------------- */
  function symCopies(stroke){
    const out=[]; const N=state.axes;
    for(let k=0;k<N;k++) for(const mir of [1,-1]){
      if(k===0 && mir===1) continue;
      const a=k*2*Math.PI/N, cos=Math.cos(a), sin=Math.sin(a);
      const pts=stroke.pts.map(p=>{ const y=mir*p.y; return { x:p.x*cos - y*sin, y:p.x*sin + y*cos, w:p.w }; });
      const c={ tool:stroke.tool, color:stroke.color, size:stroke.size, pts };
      if(stroke.bb) finalizeBB(c);
      out.push(c);
    }
    return out;
  }

  /* ---------------- undo / redo ---------------- */
  function commit(items){
    for(const it of items) if(!it.bb) finalizeBB(it);
    strokes.push(...items); opSizes.push(items.length); invalidate(); saveSoon();
  }
  function undo(){ if(!opSizes.length){ return; } const n=opSizes.pop(); redoStack.push(strokes.splice(-n)); invalidate(); saveSoon(); }
  function redo(){ if(!redoStack.length) return; const items=redoStack.pop(); strokes.push(...items); opSizes.push(items.length); invalidate(); saveSoon(); }

  /* ---------------- pinch / wheel zoom + inertia ---------------- */
  const panVel = { x:0, y:0 }; let panT = 0, inertiaRAF = 0;
  function startInertia(){
    stopInertia();
    let last = performance.now();
    const step = () => {
      const now=performance.now(), dt=Math.min(40, now-last); last=now;
      if(Math.hypot(panVel.x,panVel.y) < 0.0006 || drawingId!=null || pinch){ inertiaRAF=0; return; }
      cam.x += panVel.x*dt; cam.y += panVel.y*dt;
      const fr = Math.pow(0.94, dt/16); panVel.x*=fr; panVel.y*=fr;
      invalidate(); saveSoon();
      inertiaRAF = requestAnimationFrame(step);
    };
    inertiaRAF = requestAnimationFrame(step);
  }
  function stopInertia(){ if(inertiaRAF){ cancelAnimationFrame(inertiaRAF); inertiaRAF=0; } }

  const twoPts = () => [...pointers.values()];
  function startPinch(){ const [a,b]=twoPts(); const d=Math.hypot(a.x-b.x,a.y-b.y), cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    pinch={d,cx,cy}; pinch0={d,cx,cy}; panLast=null; }
  function updatePinch(){
    const [a,b]=twoPts(); const d=Math.hypot(a.x-b.x,a.y-b.y)||1, cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    if(pinch0 && (Math.abs(d-pinch0.d)>8 || Math.hypot(cx-pinch0.cx,cy-pinch0.cy)>8)) multi.moved=true;
    zoomAt(cx, cy, d/pinch.d);
    cam.x += (cx-pinch.cx)/cam.scale; cam.y += (cy-pinch.cy)/cam.scale;
    pinch={d,cx,cy}; invalidate(); saveSoon();
  }
  function zoomAt(sx, sy, f){
    const before=toWorld(sx,sy);
    cam.scale = clamp(cam.scale*f, 0.02, 64);
    const after=toWorld(sx,sy);
    cam.x += after.x-before.x; cam.y += after.y-before.y;
    updateHud();
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); stopInertia();
    if(e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)){
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY*0.0016));
    } else { cam.x -= e.deltaX/cam.scale; cam.y -= e.deltaY/cam.scale; }
    invalidate(); saveSoon();
  }, { passive:false });

  ['gesturestart','gesturechange','gestureend'].forEach(t => document.addEventListener(t, e=>e.preventDefault(), {passive:false}));
  document.addEventListener('dblclick', e=>e.preventDefault());
  document.addEventListener('touchmove', e=>{ if(e.touches.length>1) e.preventDefault(); }, {passive:false});

  function zoomToFit(){
    const bb = bounds();
    if(!bb){ cam.x=0; cam.y=0; cam.scale=1; updateHud(); invalidate(); saveSoon(); return; }
    const w=bb.maxX-bb.minX, h=bb.maxY-bb.minY;
    const s = clamp(Math.min(innerWidth/w, innerHeight/h)*0.9, 0.02, 8);
    cam.scale = s;
    cam.x = innerWidth/(2*s) - (bb.minX+w/2);
    cam.y = innerHeight/(2*s) - (bb.minY+h/2);
    updateHud(); invalidate(); saveSoon();
  }

  /* ---------------- UI: swatches / tools / size ---------------- */
  const sw = document.getElementById('swatches');
  const swatchEls = [];
  function setColor(c, el){ state.color=c; state.rainbow=false;
    if(state.tool==='eraser'||state.tool==='pan') selectTool('brush');
    swatchEls.forEach(n=>n.classList.remove('active')); if(el) el.classList.add('active'); }
  PALETTE.forEach((s,i)=>{
    const el=document.createElement('button'); el.className='swatch'+(i===0?' active':''); el.type='button';
    el.style.background=s.c; el.title=s.n; el.setAttribute('aria-label', s.n);
    if(s.c.toLowerCase()==='#ffffff') el.style.boxShadow='inset 0 0 0 1px rgba(0,0,0,.25)';
    el.addEventListener('click',()=>{ setColor(s.c, el); buzz(6); });
    sw.appendChild(el); swatchEls.push(el);
  });
  // rainbow / magic swatch
  const rainbowEl=document.createElement('button'); rainbowEl.type='button'; rainbowEl.className='swatch rainbow'; rainbowEl.title='Rainbow (magic)'; rainbowEl.setAttribute('aria-label','Rainbow magic colour');
  rainbowEl.addEventListener('click',()=>{ state.rainbow=true;
    if(state.tool==='eraser'||state.tool==='pan') selectTool('brush');
    swatchEls.forEach(n=>n.classList.remove('active')); rainbowEl.classList.add('active'); buzz(6); toast('🌈 Rainbow! Every line a new colour'); });
  sw.appendChild(rainbowEl); swatchEls.push(rainbowEl);
  // custom colour swatch
  const customEl=document.createElement('label'); customEl.className='swatch custom'; customEl.title='Custom colour'; customEl.setAttribute('aria-label','Pick a custom colour');
  customEl.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><input type="color" value="#2f6bff" aria-label="Custom colour picker">';
  const customInput=customEl.querySelector('input');
  customInput.addEventListener('input',()=>{ if(validHex(customInput.value)){ customEl.style.background=customInput.value; setColor(customInput.value, customEl); } });
  sw.appendChild(customEl); swatchEls.push(customEl);

  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.addEventListener('click',()=>{ selectTool(b.dataset.tool); buzz(6); }));
  function selectTool(tool){ state.tool=tool; clearPendingStamp();
    document.querySelectorAll('.tool[data-tool]').forEach(b=>{ const on=b.dataset.tool===tool; b.classList.toggle('active',on); b.setAttribute('aria-pressed', on?'true':'false'); });
    document.body.classList.toggle('pan', tool==='pan');
    document.body.classList.toggle('erase', tool==='eraser');
  }
  const sizeRange=document.getElementById('sizeRange');
  sizeRange.addEventListener('input',()=>{ state.size=+sizeRange.value; });
  document.getElementById('undo').addEventListener('click', ()=>{ undo(); buzz(6); });
  document.getElementById('redo').addEventListener('click', ()=>{ redo(); buzz(6); });

  const symBtn=document.getElementById('symBtn');
  symBtn.addEventListener('click',()=>{ state.sym=!state.sym; symBtn.classList.toggle('on',state.sym); symBtn.setAttribute('aria-pressed',state.sym?'true':'false');
    toast(state.sym?`✨ Mandala on · ${state.axes} axes`:'Mandala off'); buzz(6); requestRender(); });

  document.getElementById('zenBtn').addEventListener('click', ()=>toggleZen());
  function toggleZen(force){ const on = force!==undefined ? force : !document.body.classList.contains('zen');
    document.body.classList.toggle('zen', on); if(on) pushGuard(); }

  document.getElementById('hud').addEventListener('click', ()=>{ zoomToFit(); });

  /* ---------------- sheet menu ---------------- */
  const sheet=document.getElementById('sheet'), menuBtn=document.getElementById('menuBtn');
  function toggleSheet(open){ const show = open!==undefined ? open : sheet.classList.contains('hidden');
    sheet.classList.toggle('hidden', !show); menuBtn.setAttribute('aria-expanded', show?'true':'false'); if(show) pushGuard(); }
  menuBtn.addEventListener('click', e=>{ e.stopPropagation(); toggleSheet(); });
  document.addEventListener('click', e=>{ if(!sheet.classList.contains('hidden') && !sheet.contains(e.target) && e.target!==menuBtn && !menuBtn.contains(e.target)) toggleSheet(false); });
  sheet.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',()=>{
    const a=b.dataset.act; toggleSheet(false); buzz(6);
    if(a==='home'){ cam.x=0;cam.y=0;cam.scale=1;updateHud();invalidate();saveSoon(); }
    else if(a==='fit') zoomToFit();
    else if(a==='theme'){ state.theme=state.theme==='dark'?'light':'dark'; invalidate(); saveSoon(); }
    else if(a==='grid'){ state.grid=!state.grid; invalidate(); saveSoon(); }
    else if(a==='symaxes') cycleAxes();
    else if(a==='png') exportPNG();
    else if(a==='svg') exportSVG();
    else if(a==='share') shareImage();
    else if(a==='replay') startReplay();
    else if(a==='seal') openSeal();
    else if(a==='sticker') openStickers();
    else if(a==='clear'){ if(confirm('Clear the whole canvas? This cannot be undone.')){ strokes=[];opSizes=[];redoStack=[];invalidate();save(); toast('Fresh paper ✨'); } }
  }));
  const axesLabel=document.getElementById('axesLabel');
  function cycleAxes(){ const opts=[2,3,4,6,8,12]; state.axes=opts[(opts.indexOf(state.axes)+1)%opts.length];
    axesLabel.textContent=state.axes; if(!state.sym){ state.sym=true; symBtn.classList.add('on'); symBtn.setAttribute('aria-pressed','true'); }
    toast(`✨ Mandala · ${state.axes} axes`); requestRender(); saveSoon(); }
  axesLabel.textContent=state.axes;

  /* ---------------- stamps: ink seal + emoji stickers ---------------- */
  const sealModal=document.getElementById('sealModal'), sealInput=document.getElementById('sealInput'), sealCanvas=document.getElementById('sealCanvas');
  const stickerModal=document.getElementById('stickerModal'), stickerGrid=document.getElementById('stickerGrid');

  function openSeal(){ sealModal.classList.remove('hidden'); if(!sealInput.value) sealInput.value='円相'; renderSeal(sealInput.value); pushGuard(); setTimeout(()=>{ sealInput.focus(); sealInput.select(); },50); }
  sealInput.addEventListener('input',()=>renderSeal(sealInput.value));
  sealInput.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('sealStamp').click(); } });
  document.getElementById('sealClose').addEventListener('click',()=>sealModal.classList.add('hidden'));
  document.getElementById('sealDownload').addEventListener('click',()=>{ renderSeal(sealInput.value); sealCanvas.toBlob(b=>downloadBlob(b,'enso-seal.png')); });
  document.getElementById('sealStamp').addEventListener('click',()=>{ renderSeal(sealInput.value);
    beginStampFromDataURL(sealCanvas.toDataURL('image/png'), 90); sealModal.classList.add('hidden'); });

  // sticker grid
  STICKERS.forEach(em=>{ const b=document.createElement('button'); b.type='button'; b.className='sticker'; b.textContent=em; b.setAttribute('aria-label','Sticker '+em);
    b.addEventListener('click',()=>{ beginStampFromDataURL(emojiDataURL(em), 80); stickerModal.classList.add('hidden'); buzz(8); }); stickerGrid.appendChild(b); });
  function openStickers(){ stickerModal.classList.remove('hidden'); pushGuard(); }
  document.getElementById('stickerClose').addEventListener('click',()=>stickerModal.classList.add('hidden'));
  document.getElementById('stickerBtn').addEventListener('click',()=>{ openStickers(); buzz(6); });

  function beginStampFromDataURL(dataURL, size){
    const img=new Image(); img.onload=()=>requestRender(); img.src=dataURL;
    state.pendingStamp={ dataURL, img, size };
    document.body.classList.add('stamping'); toast('👇 Tap on the paper to place it');
  }
  function clearPendingStamp(){ state.pendingStamp=null; document.body.classList.remove('stamping'); }
  function placeStamp(sx, sy){
    const p=state.pendingStamp; const w=toWorld(sx,sy); const size=(p.size||80)/cam.scale;
    const st=makeStamp(p.dataURL, w.x, w.y, size, p.img);
    redoStack.length=0; commit([st]); clearPendingStamp(); buzz(14); requestRender();
  }
  function makeStamp(dataURL, x, y, size, img){
    const st={ tool:'stamp', dataURL, x, y, size };
    st.bb={minX:x-size/2,minY:y-size/2,maxX:x+size/2,maxY:y+size/2};
    st._img = img || (()=>{ const im=new Image(); im.onload=()=>{ invalidate(); }; im.src=dataURL; return im; })();
    return st;
  }
  function emojiDataURL(em){
    const S=128, c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d');
    x.textAlign='center'; x.textBaseline='middle'; x.font='96px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif';
    x.fillText(em, S/2, S/2+6); return c.toDataURL('image/png');
  }

  function renderSeal(text){
    const c=sealCanvas, x=c.getContext('2d'), S=c.width; x.clearRect(0,0,S,S);
    const name=(text||'円相').trim()||'円相'; const rnd=mulberry32(hashStr(name));
    const ink=['#c8202a','#b81f28','#d1382f','#a51c25','#cf3b2e'][Math.floor(rnd()*5)];
    const round=rnd()>0.45, pad=22, box=S-pad*2, bw=Math.round(10+rnd()*4);
    x.save(); x.translate(S/2,S/2); x.rotate((rnd()-0.5)*0.05); x.translate(-S/2,-S/2);
    x.strokeStyle=ink; x.fillStyle=ink; x.lineJoin='round'; x.lineWidth=bw;
    if(round){ x.beginPath(); x.arc(S/2,S/2,box/2,0,7); x.stroke(); } else { roundRect(x,pad,pad,box,box,14); x.stroke(); }
    const chars=[...name].slice(0,4);
    const cells = chars.length<=1?[[0,0]]:chars.length===2?[[0,-1],[0,1]]:[[-1,-1],[1,-1],[-1,1],[1,1]].slice(0,chars.length);
    const inner=box-bw*2-14, unit=inner/2, cx=S/2, cy=S/2;
    x.textAlign='center'; x.textBaseline='middle';
    chars.forEach((ch,i)=>{ const [gx,gy]=cells[i]; const single=chars.length<=1;
      const fs=single?Math.round(inner*0.72):Math.round(unit*0.92);
      x.font=`700 ${fs}px "Yu Mincho","Hiragino Mincho ProN","MS Mincho",serif`;
      const px=cx+(single?0:gx*unit/2), py=cy+(single?0:gy*unit/2);
      x.save(); x.translate(px,py); x.rotate((rnd()-0.5)*0.04); x.fillText(ch,0,0); x.restore(); });
    x.restore();
    x.globalCompositeOperation='destination-out';
    for(let i=0;i<220;i++){ const rx=rnd()*S, ry=rnd()*S, rr=rnd()*1.6; x.beginPath(); x.arc(rx,ry,rr,0,7); x.fill(); }
    x.globalCompositeOperation='source-over';
  }

  /* ---------------- replay + record ---------------- */
  const replay={ active:false, revealed:0, total:0, playing:false, last:0, raf:0, dur:6, rec:null, chunks:[] };
  const replayBar=document.getElementById('replayBar');
  const rSeek=document.getElementById('replaySeek'), rToggle=document.getElementById('replayToggle'), rRec=document.getElementById('replayRec');
  function totalUnits(){ let n=0; for(const s of strokes) n += s.tool==='stamp'?1:Math.max(1,s.pts.length); return n; }
  function startReplay(){
    if(!strokes.length){ toast('Draw something first ✍️'); return; }
    replay.total=totalUnits(); replay.revealed=0; replay.active=true; replay.playing=true; replay.last=performance.now();
    replay.dur=clamp(replay.total/140, 2.5, 12);
    replayBar.classList.remove('hidden'); rToggle.textContent='⏸'; toggleZen(true); pushGuard();
    cancelAnimationFrame(replay.raf); loopReplay();
  }
  function loopReplay(){
    const now=performance.now();
    if(replay.playing){
      const rate=replay.total/(replay.dur*1000);
      replay.revealed=Math.min(replay.total, replay.revealed + (now-replay.last)*rate);
      if(replay.revealed>=replay.total){ replay.revealed=replay.total; replay.playing=false; rToggle.textContent='↺'; if(replay.rec) stopRecording(); }
    }
    replay.last=now; rSeek.value=Math.round(replay.revealed/replay.total*1000)||0;
    render();
    if(replay.active) replay.raf=requestAnimationFrame(loopReplay);
  }
  rToggle.addEventListener('click',()=>{ if(replay.revealed>=replay.total) replay.revealed=0;
    replay.playing=!replay.playing; replay.last=performance.now(); rToggle.textContent=replay.playing?'⏸':'▶'; });
  rSeek.addEventListener('input',()=>{ replay.playing=false; rToggle.textContent='▶'; replay.revealed=(+rSeek.value/1000)*replay.total; });
  document.getElementById('replayExit').addEventListener('click', exitReplay);
  function exitReplay(){ replay.active=false; replay.playing=false; cancelAnimationFrame(replay.raf);
    if(replay.rec) stopRecording(); replayBar.classList.add('hidden'); document.body.classList.remove('zen'); invalidate(); }

  rRec.addEventListener('click',()=>{ replay.rec ? stopRecording() : startRecording(); });
  function startRecording(){
    if(!canvas.captureStream || typeof MediaRecorder==='undefined'){ toast('Recording not supported on this browser'); return; }
    try{
      const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const stream=canvas.captureStream(30); replay.chunks=[];
      replay.rec=new MediaRecorder(stream,{ mimeType:type, videoBitsPerSecond:8_000_000 });
      replay.rec.ondataavailable=e=>{ if(e.data.size) replay.chunks.push(e.data); };
      replay.rec.onstop=()=>{ const blob=new Blob(replay.chunks,{type:'video/webm'}); downloadBlob(blob,'enso-'+stamp()+'.webm'); replay.rec=null; rRec.classList.remove('recording'); rRec.textContent='● REC'; toast('Video saved 🎬'); };
      replay.rec.start(); rRec.classList.add('recording'); rRec.textContent='◼ STOP';
      replay.revealed=0; replay.playing=true; replay.last=performance.now(); rToggle.textContent='⏸';
      toast('Recording the replay…');
    }catch(err){ toast('Could not start recording'); }
  }
  function stopRecording(){ try{ if(replay.rec && replay.rec.state!=='inactive') replay.rec.stop(); }catch(e){} }

  /* ---------------- export / share ---------------- */
  function bounds(){
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;
    for(const s of strokes){ if(!s.bb) continue; a=Math.min(a,s.bb.minX);b=Math.min(b,s.bb.minY);c=Math.max(c,s.bb.maxX);d=Math.max(d,s.bb.maxY); }
    if(a===Infinity) return null;
    const pad=32; return { minX:a-pad, minY:b-pad, maxX:c+pad, maxY:d+pad };
  }
  function renderToCanvas(){
    const bb=bounds(); if(!bb) return null;
    const w=Math.max(1,bb.maxX-bb.minX), h=Math.max(1,bb.maxY-bb.minY);
    const scale=Math.min(3, 2600/Math.max(w,h));
    const out=document.createElement('canvas'); out.width=Math.round(w*scale); out.height=Math.round(h*scale);
    const o=out.getContext('2d');
    o.fillStyle=paperColor(); o.fillRect(0,0,out.width,out.height);
    const ink=document.createElement('canvas'); ink.width=out.width; ink.height=out.height;
    const i=ink.getContext('2d'); i.setTransform(scale,0,0,scale,-bb.minX*scale,-bb.minY*scale);
    for(const s of strokes){ if(s.tool==='stamp') drawStampItem(i,s); else drawStroke(i,s,0); }
    o.drawImage(ink,0,0); return out;
  }
  function exportPNG(){ const out=renderToCanvas(); if(!out){ toast('Nothing to export yet'); return; } out.toBlob(b=>downloadBlob(b,'enso-'+stamp()+'.png'),'image/png'); }
  async function shareImage(){
    const out=renderToCanvas(); if(!out){ toast('Draw something first ✍️'); return; }
    out.toBlob(async blob=>{
      const file=new File([blob],'enso-'+stamp()+'.png',{type:'image/png'});
      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{ await navigator.share({ files:[file], title:'Ensō 円相', text:'Made with Ensō 円相' }); }catch(e){}
      } else if(navigator.clipboard && window.ClipboardItem){
        try{ await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]); toast('Copied to clipboard 📋'); }
        catch(e){ downloadBlob(blob,'enso-'+stamp()+'.png'); toast('Saved image (sharing not supported)'); }
      } else { downloadBlob(blob,'enso-'+stamp()+'.png'); toast('Saved image (sharing not supported)'); }
    },'image/png');
  }
  function exportSVG(){
    const bb=bounds(); if(!bb){ toast('Nothing to export yet'); return; }
    const w=bb.maxX-bb.minX, h=bb.maxY-bb.minY;
    let body=`<rect width="${r2(w)}" height="${r2(h)}" fill="${paperColor()}"/>`;
    for(const s of strokes){
      if(s.tool==='stamp'){ body+=`<image x="${r2(s.x-s.size/2-bb.minX)}" y="${r2(s.y-s.size/2-bb.minY)}" width="${r2(s.size)}" height="${r2(s.size)}" href="${s.dataURL}"/>`; continue; }
      const fill = s.tool==='eraser' ? paperColor() : cssColorToHex(s.color);
      const op = s.tool==='marker' ? ' fill-opacity="0.38"' : '';
      body += `<path d="${ribbonPath(s.pts, bb)}" fill="${fill}"${op}/>`;
    }
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(w)} ${r2(h)}" width="${r2(w)}" height="${r2(h)}">${body}</svg>`;
    downloadBlob(new Blob([svg],{type:'image/svg+xml'}),'enso-'+stamp()+'.svg');
  }
  function ribbonPath(pts, bb){
    if(pts.length===1){ const p=pts[0]; return circlePath(p.x-bb.minX,p.y-bb.minY,Math.max(.3,p.w/2)); }
    const e=ribbon(pts); let d='M';
    d+=e.left.map(p=>`${r2(p.x-bb.minX)},${r2(p.y-bb.minY)}`).join(' L');
    d+=' L'+e.right.slice().reverse().map(p=>`${r2(p.x-bb.minX)},${r2(p.y-bb.minY)}`).join(' L')+' Z';
    return d;
  }
  const circlePath=(cx,cy,r)=>`M${r2(cx-r)},${r2(cy)} a${r2(r)},${r2(r)} 0 1,0 ${r2(r*2)},0 a${r2(r)},${r2(r)} 0 1,0 ${r2(-r*2)},0 Z`;

  /* ---------------- Android back button closes overlays ---------------- */
  let guardActive=false;
  function anyOverlay(){ return !sheet.classList.contains('hidden') || !sealModal.classList.contains('hidden')
      || !stickerModal.classList.contains('hidden') || replay.active || document.body.classList.contains('zen') || !!state.pendingStamp; }
  function pushGuard(){ if(!guardActive){ guardActive=true; try{ history.pushState({enso:1},''); }catch(e){} } }
  function closeAllOverlays(){ toggleSheet(false); sealModal.classList.add('hidden'); stickerModal.classList.add('hidden');
    if(replay.active) exitReplay(); document.body.classList.remove('zen'); clearPendingStamp(); }
  window.addEventListener('popstate', ()=>{ guardActive=false; if(anyOverlay()) closeAllOverlays(); });

  // click on modal backdrop closes it
  [sealModal, stickerModal].forEach(m=>m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); }));

  /* ---------------- keyboard ---------------- */
  addEventListener('keydown', e=>{
    if(e.target && /input|textarea/i.test(e.target.tagName)) return;
    if(e.code==='Space' && !spaceDown){ spaceDown=true; document.body.classList.add('pan'); return; }
    if(e.ctrlKey||e.metaKey){ const k=e.key.toLowerCase();
      if(k==='z'&&!e.shiftKey){ e.preventDefault(); undo(); } else if((k==='z'&&e.shiftKey)||k==='y'){ e.preventDefault(); redo(); } return; }
    const k=e.key.toLowerCase();
    if(k==='b') selectTool('brush'); else if(k==='p') selectTool('pen');
    else if(k==='m') selectTool('marker'); else if(k==='e') selectTool('eraser');
    else if(k==='h') selectTool('pan'); else if(k==='z') toggleZen();
    else if(k==='s') symBtn.click();
    else if(k==='+'||k==='=') zoomAt(innerWidth/2,innerHeight/2,1.2), invalidate();
    else if(k==='-'||k==='_') zoomAt(innerWidth/2,innerHeight/2,1/1.2), invalidate();
    else if(k==='0') zoomToFit();
    else if(k==='escape'){ if(anyOverlay()) closeAllOverlays(); }
  });
  addEventListener('keyup', e=>{ if(e.code==='Space'){ spaceDown=false; if(state.tool!=='pan') document.body.classList.remove('pan'); } });

  /* ---------------- helpers ---------------- */
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function r2(n){ return Math.round(n*100)/100; }
  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
  function validHex(s){ return /^#[0-9a-fA-F]{6}$/.test(s); }
  function cssColorToHex(c){ if(validHex(c)) return c; // convert hsl(...) etc via a canvas
    const cv=cssColorToHex._c || (cssColorToHex._c=document.createElement('canvas')); cv.width=cv.height=1;
    const x=cv.getContext('2d'); x.fillStyle='#000'; x.fillStyle=c; x.fillRect(0,0,1,1);
    const d=x.getImageData(0,0,1,1).data; return '#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join(''); }
  function buzz(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms); }catch(e){} }
  function hashStr(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
  function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function downloadBlob(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }
  function stamp(){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  const hud=document.getElementById('hud');
  function updateHud(){ hud.textContent = cam.scale>=1 ? Math.round(cam.scale*100)+'%' : (cam.scale*100).toFixed(cam.scale<0.1?1:0)+'%'; }
  let toastT; function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); t.style.opacity='1';
    clearTimeout(toastT); toastT=setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.classList.add('hidden'),300); }, 1900); }
  let hintT=setTimeout(hideHint,6500); function hideHint(){ const h=document.getElementById('hint'); if(h) h.style.opacity='0'; clearTimeout(hintT); }

  /* ---------------- boot ---------------- */
  load(); selectTool(state.tool); updateHud();
  addEventListener('resize', resize);
  if(window.visualViewport) visualViewport.addEventListener('resize', resize);
  resize();
  addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) save(); });
  if('serviceWorker' in navigator) addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
})();
