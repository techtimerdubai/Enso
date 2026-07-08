/* Ensō 円相 — a free, kid-friendly infinite-canvas drawing app (Android-first).
   Strokes are vectors in WORLD space, so zoom stays razor-sharp at any scale.
   Rendering uses cached layers (paper / committed ink / live overlay) so drawing
   stays smooth even with lots of strokes. */
(() => {
  'use strict';

  const canvas = document.getElementById('paper');
  // desynchronized: low-latency path — the browser paints ink to a fast, un-synced
  // buffer, cutting pen-to-screen lag (biggest perceived-smoothness win on Android).
  const ctx = canvas.getContext('2d', { alpha:false, desynchronized:true });
  if(!ctx){ document.body.innerHTML = '<p style="color:#eee;font:16px system-ui;padding:24px">Sorry — your browser can’t run Ensō (no canvas support). Try a recent Chrome, Safari, Firefox or Edge.</p>'; return; }
  // two offscreen layers: committed ink (cached) + a live-draw overlay. Paper+grid are drawn
  // straight onto the visible canvas each frame (cheap) — one fewer full-screen buffer to hold.
  const inkCv  = document.createElement('canvas'), kctx = inkCv.getContext('2d');
  const overCv = document.createElement('canvas'), octx = overCv.getContext('2d');

  /* ---------------- camera & document ---------------- */
  const cam = { x: 0, y: 0, scale: 1 };
  const MIN_SCALE = 0.004, MAX_SCALE = 1000;   // 0.4% … 100000% — deep "worlds within worlds" zoom, precision-safe
  let dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  let cacheValid = false;                 // is inkCv up to date for the current camera?
  const invalidate = () => { cacheValid = false; requestRender(); };

  let strokes = [];          // committed items (strokes + stamps), in z / draw order
  let undoStack = [];        // operation log: {type:'add'|'delete'|'move', items, dx?, dy?}
  let redoStack = [];        // undone operations
  let live = null;           // stroke being drawn
  let selection = new Set(); // currently selected items (select tool)
  let layers = [{ id:1, name:'Layer 1', visible:true, opacity:1 }];   // bottom → top
  let activeLayer = 1, nextLayerId = 2;
  const layerById = id => layers.find(l => l.id===id) || layers[0];

  const state = {
    tool: 'brush',
    color: '#2b2b31',
    size: 8,
    theme: 'light',
    grid: true,
    sym: false,
    axes: 6,
    rainbow: false,
    shapeSnap: false,        // auto-clean hand-drawn shapes
    pendingStamp: null,      // {dataURL, img, size} awaiting placement
  };
  let rainbowHue = 0;
  let lastBrushStyle = 'brush';

  // Brush engine — each style defines how stroke width & compositing behave.
  //  wp = pressure floor (width = wp + (1-wp)*pressure) · ws = speed thinning
  //  const = constant width · calli = angle-driven (calligraphy nib) · neon = glow
  const STYLES = {
    brush:       { label:'Ink brush',   emoji:'🖌️', wp:0.25, ws:0.18, taper:6 },
    pen:         { label:'Pen',          emoji:'🖊️', wp:0.55, ws:0,    taper:3 },
    fineliner:   { label:'Fineliner',    emoji:'✒️', const:true, mult:0.4, taper:2 },
    pencil:      { label:'Pencil',       emoji:'✏️', wp:0.72, ws:0.05, taper:3, alpha:0.9, jitter:0.1 },
    marker:      { label:'Highlighter',  emoji:'🖍️', const:true, mult:2.2, taper:0, alpha:0.38, blend:'multiply' },
    crayon:      { label:'Crayon',       emoji:'🖍', wp:0.45, ws:0.05, taper:2, alpha:0.9, jitter:0.5, blend:'multiply' },
    calligraphy: { label:'Calligraphy',  emoji:'🪶', calli:true, taper:3 },
    neon:        { label:'Neon glow',    emoji:'💡', wp:0.4,  ws:0.1,  taper:4, neon:true },
  };
  const isDrawStyle = t => STYLES[t] != null;

  // bright, friendly palette (kid-first) — sumi black kept for natural ink
  const PALETTE = [
    { c:'#2b2b31', n:'Black' },  { c:'#ff4d4f', n:'Red' },    { c:'#ff8c1a', n:'Orange' },
    { c:'#ffd21a', n:'Yellow' }, { c:'#37c86b', n:'Green' },  { c:'#20b8e6', n:'Sky' },
    { c:'#2f6bff', n:'Blue' },   { c:'#9a5bff', n:'Purple' }, { c:'#ff5fa2', n:'Pink' },
    { c:'#a2673f', n:'Brown' },  { c:'#ffffff', n:'White' },
  ];
  const STICKERS = ['⭐','🌈','❤️','🌸','🦋','🐱','🐶','🌟','🍭','🎈','🌞','🍡','🐢','🌷','⚡','🍎'];

  /* 💛 CRYPTO DONATIONS — replace the YOUR_… placeholders with your own wallet
     addresses. Delete a row you don't want. 100% free: no processor, no backend. */
  const DONATE = [
    { sym:'BTC',  name:'Bitcoin',                addr:'YOUR_BTC_ADDRESS',  scheme:'bitcoin' },
    { sym:'ETH',  name:'Ethereum · USDT/USDC (ERC-20)', addr:'YOUR_ETH_ADDRESS', scheme:'ethereum' },
    { sym:'SOL',  name:'Solana',                 addr:'YOUR_SOL_ADDRESS',  scheme:'solana' },
    { sym:'TON',  name:'Toncoin',                addr:'YOUR_TON_ADDRESS',  scheme:'ton' },
  ];
  const paperColor = () => state.theme === 'dark' ? '#17181c' : '#f7f4ee';

  /* ---------------- persistence ---------------- */
  const KEY = 'enso.doc.v2';
  let quotaWarned = false;
  const save = () => { try {
    localStorage.setItem(KEY, JSON.stringify({ strokes: serialize(strokes), cam, layers, activeLayer, nextLayerId,
      state:{ theme:state.theme, grid:state.grid, axes:state.axes, shape:state.shapeSnap } }));
  } catch(e){ if(!quotaWarned){ quotaWarned = true; toast('Storage full — older work may not auto-save. Export to keep it.'); } } };
  const saveSoon = debounce(save, 400);
  function serialize(list){ return list.map(s => s.tool==='stamp'
    ? { tool:'stamp', dataURL:s.dataURL, x:r2(s.x), y:r2(s.y), size:r2(s.size), layer:s.layer }
    : { tool:s.tool, color:s.color, size:s.size, layer:s.layer, snapped:s.snapped?1:undefined, pts:s.pts.map(p=>[r2(p.x),r2(p.y),r2(p.w)]) }); }
  function applyDoc(d){
    if(!d) return;
    strokes=[]; undoStack=[]; redoStack=[]; selection.clear();
    layers=[{id:1,name:'Layer 1',visible:true,opacity:1}]; activeLayer=1; nextLayerId=2;
    if(d.cam) Object.assign(cam, d.cam);
    if(d.state){ state.theme=d.state.theme||state.theme; state.grid=d.state.grid!==false; state.axes=d.state.axes||6; state.shapeSnap=!!d.state.shape; }
    if(Array.isArray(d.layers) && d.layers.length){ layers=d.layers; activeLayer=d.activeLayer||layers[0].id; nextLayerId=d.nextLayerId||(Math.max(...layers.map(l=>l.id))+1); }
    if(Array.isArray(d.strokes)) for(const s of d.strokes){
      if(s.tool==='stamp'){ const st=makeStamp(s.dataURL, s.x, s.y, s.size); st.layer=s.layer||layers[0].id; strokes.push(st); }
      else { const st={ tool:s.tool, color:s.color, size:s.size, layer:s.layer||layers[0].id, snapped:!!s.snapped, pts:s.pts.map(p=>({x:p[0],y:p[1],w:p[2]})) };
        finalizeBB(st); strokes.push(st); }
    }
    gridRebuild();
  }
  function load(){ try { applyDoc(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch(e){} }

  /* ---------------- sizing (crisp on every device) ---------------- */
  function resize(){
    dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const w = Math.max(1, Math.round(innerWidth * dpr)), h = Math.max(1, Math.round(innerHeight * dpr));
    for(const c of [canvas, inkCv, overCv]){ if(c.width!==w) c.width = w; if(c.height!==h) c.height = h; }
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

  // Re-rasterise all committed strokes from VECTORS at the current camera scale, into inkCv.
  // Because this runs on every camera change, strokes stay pixel-sharp at any zoom level.
  function rebuildInk(){
    kctx.setTransform(1,0,0,1,0,0); kctx.clearRect(0,0,inkCv.width,inkCv.height);
    const vis = visibleStrokes();                  // z-sorted, viewport-culled
    if(layers.length===1){                         // fast path: single layer
      const L=layers[0];
      if(L.visible){ worldTransform(kctx); drawScene(kctx, vis, Infinity); }
      cacheValid = true; return;
    }
    // group visible items by layer, then composite each layer with its opacity so
    // an eraser only affects its own layer (isolated via the overCv temp)
    const byLayer = new Map();
    for(const s of vis){ const id=s.layer||layers[0].id; (byLayer.get(id) || byLayer.set(id,[]).get(id)).push(s); }
    for(const L of layers){
      if(!L.visible) continue;
      const items = byLayer.get(L.id); if(!items || !items.length) continue;
      octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
      worldTransform(octx); drawScene(octx, items, Infinity);
      kctx.setTransform(1,0,0,1,0,0); kctx.globalAlpha = L.opacity; kctx.drawImage(overCv,0,0); kctx.globalAlpha = 1;
    }
    cacheValid = true;
  }

  function paintPaper(){
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = paperColor(); ctx.fillRect(0,0,innerWidth,innerHeight);
    if(state.grid) drawGrid(ctx);
  }

  function render(){
    needsRender = false;
    try { renderInner(); }
    catch(err){ /* never let one bad frame kill the app */ }
  }
  function renderInner(){
    paintPaper();
    if(replay.active){
      octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
      worldTransform(octx);
      drawScene(octx, strokes, replay.revealed);
      ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(overCv, 0, 0);
      return;
    }
    if(!cacheValid) rebuildInk();
    if(live){
      // committed ink + the live stroke, composited so a live eraser reveals paper only
      octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
      octx.drawImage(inkCv, 0, 0);
      worldTransform(octx);
      const clip = clipRect();
      // splice the predicted tail on for rendering only (constant leading-edge width)
      let ls = live;
      if(live._pred && live._pred.length){
        const lp = live.pts[live.pts.length-1];
        if(lp){ ls = { tool:live.tool, color:live.color, pts: live.pts.concat(live._pred.map(p=>({x:p.x,y:p.y,w:lp.w,_t:lp._t}))) }; }
      }
      drawStroke(octx, ls, 0, clip);
      if(state.sym) for(const c of symCopies(live)) drawStroke(octx, c, 0, clip);
      ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(overCv, 0, 0);
    } else {
      ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(inkCv, 0, 0);
    }
    if(state.sym) drawSymGuide();
    if(state.tool==='select') drawSelectionOverlay();
  }

  function viewRect(){ const a=toWorld(0,0), b=toWorld(innerWidth,innerHeight);
    return { minX:a.x, minY:a.y, maxX:b.x, maxY:b.y }; }

  // expand the world view rect by ~half a screen so stroke caps at run boundaries stay off-screen
  function clipRect(){
    const vr = viewRect();
    const mx = (vr.maxX-vr.minX)*0.4 + 8/cam.scale, my = (vr.maxY-vr.minY)*0.4 + 8/cam.scale;
    return { minX:vr.minX-mx, minY:vr.minY-my, maxX:vr.maxX+mx, maxY:vr.maxY+my };
  }
  function drawScene(target, list, upTo){
    const vr = viewRect(); const pad = 40/cam.scale; const clip = clipRect();
    let count = 0;
    for(const s of list){
      const len = s.tool==='stamp' ? 1 : Math.max(1, s.pts.length);
      const revealHere = upTo === Infinity ? len : Math.min(len, Math.max(0, upTo - count));
      count += len;
      if(revealHere <= 0){ if(upTo!==Infinity && count > upTo) break; else continue; }
      if(s.bb && (s.bb.maxX < vr.minX-pad || s.bb.minX > vr.maxX+pad || s.bb.maxY < vr.minY-pad || s.bb.minY > vr.maxY+pad)) continue;
      // LOD: skip items too small to see at the current zoom (huge win on big, zoomed-out docs)
      if(s.bb && (s.bb.maxX-s.bb.minX)*cam.scale < 0.6 && (s.bb.maxY-s.bb.minY)*cam.scale < 0.6) continue;
      if(s.tool==='stamp') drawStampItem(target, s);
      else drawStroke(target, s, revealHere < len ? Math.ceil(revealHere) : 0, clip);
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

  /* ---- draw one vector stroke as a smooth variable-width ribbon ----
     `clip` (world rect) limits geometry to the visible area so device coordinates
     stay small — this keeps rendering sharp AND correct at extreme zoom, where an
     un-clipped off-screen vertex would exceed the canvas coordinate limit. */
  // Level-of-detail: drop points closer than ~0.7 screen px so a stroke drawn at
  // full detail uses far fewer vertices when the view is zoomed out (keeps first/last).
  function decimate(pts, minD){
    if(pts.length<=2 || minD<=0.02) return pts;
    const out=[pts[0]]; let last=pts[0];
    for(let i=1;i<pts.length-1;i++){ if(Math.hypot(pts[i].x-last.x,pts[i].y-last.y)>=minD){ out.push(pts[i]); last=pts[i]; } }
    out.push(pts[pts.length-1]); return out;
  }
  // Catmull-Rom centreline smoothing: resample the polyline through its points with a
  // spline so fast/sparse strokes render as glassy curves instead of faceted segments.
  // Subdivision scales with each segment's ON-SCREEN length, so dense strokes (and
  // zoomed-out views) add ~no extra points — the cost only shows up where it's visible.
  function smooth(pts){
    if(pts.length < 3) return pts;
    const out = [pts[0]];
    for(let i=0; i<pts.length-1; i++){
      const p0=pts[i-1]||pts[i], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||p2;
      const segPx = Math.hypot(p2.x-p1.x, p2.y-p1.y) * cam.scale;
      const steps = segPx <= 6 ? 1 : Math.min(24, Math.round(segPx/6));   // 1 = no subdivision (identity)
      if(steps === 1){ out.push(p2); continue; }
      for(let s=1; s<=steps; s++){
        const t=s/steps, t2=t*t, t3=t2*t;
        const x = 0.5*(2*p1.x + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3);
        const y = 0.5*(2*p1.y + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3);
        out.push({ x, y, w: p1.w + (p2.w-p1.w)*t });
      }
    }
    return out;
  }
  function drawStroke(target, s, partial, clip){
    let src = partial ? s.pts.slice(0, partial) : s.pts;
    if(!src.length) return;
    src = decimate(src, 0.7/cam.scale);
    if(!s.snapped) src = smooth(src);   // snapped shapes keep their crisp corners
    const st = STYLES[s.tool];
    const runs = clip ? clipRuns(src, clip) : [src];
    if(st && st.neon){ drawNeon(target, s, runs); return; }
    setComposite(target, s.tool);
    target.fillStyle = s.color;
    for(const run of runs){
      if(run.length === 1){ target.beginPath(); target.arc(run[0].x, run[0].y, Math.max(.4,run[0].w/2), 0, 7); target.fill(); }
      else fillRibbon(target, run, 1);
    }
    resetComposite(target);
  }

  // Neon: soft wide glow + brighter core, layered.
  function drawNeon(target, s, runs){
    target.globalCompositeOperation = state.theme==='dark' ? 'lighter' : 'source-over';
    const passes = [ [2.8, 0.18, s.color], [1.7, 0.35, s.color], [0.75, 1, lighten(s.color)] ];
    for(const [wm, a, col] of passes){
      target.globalAlpha = a; target.fillStyle = col;
      for(const run of runs){
        if(run.length === 1){ target.beginPath(); target.arc(run[0].x, run[0].y, Math.max(.4,run[0].w/2*wm), 0, 7); target.fill(); }
        else fillRibbon(target, run, wm);
      }
    }
    resetComposite(target);
  }

  function fillRibbon(target, pts, wmul){
    const edges = ribbon(pts, wmul);
    const path = new Path2D();
    path.moveTo(edges.left[0].x, edges.left[0].y);
    for(let i=1;i<edges.left.length;i++) path.lineTo(edges.left[i].x, edges.left[i].y);
    for(let i=edges.right.length-1;i>=0;i--) path.lineTo(edges.right[i].x, edges.right[i].y);
    path.closePath();
    target.fill(path);
    target.beginPath(); target.arc(pts[0].x, pts[0].y, Math.max(.3,pts[0].w/2*wmul), 0, 7); target.fill();
    const e = pts[pts.length-1]; target.beginPath(); target.arc(e.x, e.y, Math.max(.3,e.w/2*wmul), 0, 7); target.fill();
  }

  const pointInRect = (p,r) => p.x>=r.minX && p.x<=r.maxX && p.y>=r.minY && p.y<=r.maxY;
  // Liang–Barsky: does segment a→b touch rect r?
  function segHitsRect(ax,ay,bx,by,r){
    let t0=0,t1=1; const dx=bx-ax, dy=by-ay;
    const p=[-dx,dx,-dy,dy], q=[ax-r.minX, r.maxX-ax, ay-r.minY, r.maxY-ay];
    for(let i=0;i<4;i++){
      if(p[i]===0){ if(q[i]<0) return false; }
      else { const t=q[i]/p[i]; if(p[i]<0){ if(t>t1) return false; if(t>t0) t0=t; } else { if(t<t0) return false; if(t<t1) t1=t; } }
    }
    return t0<=t1;
  }
  // split a polyline into contiguous runs of points whose segments touch the clip rect
  function clipRuns(pts, r){
    const runs=[]; let run=null; const n=pts.length;
    for(let i=0;i<n;i++){
      const a=pts[i];
      const keep = (i>0 && segHitsRect(pts[i-1].x,pts[i-1].y,a.x,a.y,r))
                || (i<n-1 && segHitsRect(a.x,a.y,pts[i+1].x,pts[i+1].y,r))
                || pointInRect(a,r);
      if(keep){ if(!run){ run=[]; runs.push(run); } run.push(a); }
      else run=null;
    }
    return runs;
  }

  function ribbon(pts, wmul){
    const m = wmul || 1; const left=[], right=[];
    for(let i=0;i<pts.length;i++){
      const p=pts[i]; let dx,dy;
      if(i===0){ dx=pts[1].x-p.x; dy=pts[1].y-p.y; }
      else if(i===pts.length-1){ dx=p.x-pts[i-1].x; dy=p.y-pts[i-1].y; }
      else { dx=pts[i+1].x-pts[i-1].x; dy=pts[i+1].y-pts[i-1].y; }
      const len=Math.hypot(dx,dy)||1, nx=-dy/len, ny=dx/len, hw=Math.max(.15,p.w/2*m);
      left.push({x:p.x+nx*hw, y:p.y+ny*hw});
      right.push({x:p.x-nx*hw, y:p.y-ny*hw});
    }
    return {left,right};
  }

  function setComposite(t, tool){
    if(tool==='eraser'){ t.globalCompositeOperation='destination-out'; t.globalAlpha=1; return; }
    const st = STYLES[tool] || {};
    let blend = st.blend || 'source-over';
    if(blend==='multiply' && state.theme==='dark') blend='screen';
    t.globalCompositeOperation = blend; t.globalAlpha = st.alpha || 1;
  }
  const resetComposite = t => { t.globalCompositeOperation='source-over'; t.globalAlpha=1; };
  // mix a colour toward white (for neon cores)
  function lighten(c){ const h=cssColorToHex(c); const v=i=>parseInt(h.slice(i,i+2),16);
    const m=x=>Math.round(x+(255-x)*0.6); return `rgb(${m(v(1))},${m(v(3))},${m(v(5))})`; }

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
    stopInertia(); stopCamAnim();
    if(document.body.classList.contains('bloom-open')) setBloom(false);
    if(e.pointerType==='pen') penDownCount++;
    // palm rejection — ignore fingers while a stylus is drawing
    if(e.pointerType==='touch' && penDownCount>0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch(_){}
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if(isEyedrop() && e.isPrimary){ doSample(e.clientX, e.clientY); return; }
    if(state.pendingStamp && e.isPrimary && pointers.size===1){ placeStamp(e.clientX, e.clientY); return; }

    if(pointers.size >= 2){
      multi.n = Math.max(multi.n, pointers.size);
      if(pointers.size===2){ multi.t = performance.now(); multi.moved = false; }
      startPinch();
      if(live){ live=null; drawingId=null; requestRender(); }
      return;
    }
    if(isPan()){ panLast={x:e.clientX,y:e.clientY}; panVel.x=panVel.y=0; panT=performance.now(); document.body.classList.add('panning'); return; }
    if(state.tool==='select'){ startSelect(e.clientX, e.clientY); return; }

    drawingId = e.pointerId; redoStack.length = 0;
    const w = toWorld(e.clientX, e.clientY);
    const col = state.rainbow ? nextRainbow() : state.color;
    // width is stored in WORLD units, so divide the screen-px slider size by the zoom:
    // brushes then paint the SAME on-screen thickness at any zoom (WYSIWYG), and zooming
    // in yields finer world strokes → effectively unlimited detail on the endless canvas.
    live = { tool:state.tool, color:col, size:state.size/cam.scale, layer:activeLayer, pts:[], _t:performance.now() };
    live._fx = makeOneEuro(1.7, 0.02); live._fy = makeOneEuro(1.7, 0.02);
    const t0 = e.timeStamp || performance.now();
    const fw = toWorld(live._fx(e.clientX, t0), live._fy(e.clientY, t0));
    addPoint(live, fw.x, fw.y, pressure(e), 0);
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
    if(sel){ moveSelect(e.clientX, e.clientY); return; }
    if(drawingId===e.pointerId && live){
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const now = performance.now();
      for(const ev of (evs.length?evs:[e])){
        const t = ev.timeStamp || now;
        const w = toWorld(live._fx(ev.clientX, t), live._fy(ev.clientY, t));   // smoothed, screen-space
        const last = live.pts[live.pts.length-1];
        if(last && Math.hypot(w.x-last.x, w.y-last.y)*cam.scale < 0.6) continue;
        addPoint(live, w.x, w.y, pressure(ev), now-live._t);
      }
      // Predicted events: a short provisional tail ahead of the real pen position.
      // Rendered but NOT committed — makes ink feel glued to the pen, no overshoot on lift.
      live._pred = e.getPredictedEvents ? e.getPredictedEvents().map(ev=>toWorld(ev.clientX, ev.clientY)) : null;
      requestRender();
    }
  });

  function endPointer(e){
    if(e.pointerType==='pen' && penDownCount>0) penDownCount--;
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if(pointers.size<2){ pinch=null; pinch0=null; }

    if(sel){ endSelect(); }
    if(drawingId===e.pointerId){
      if(live && live.pts.length){
        finalizeStroke(live);
        if(state.shapeSnap && isDrawStyle(live.tool) && live.tool!=='marker'){
          const shaped=recognizeShape(live);
          if(shaped){ live.pts=shaped.pts; live.snapped=true; finalizeBB(live); buzz(10); toast('✦ Snapped to '+shaped.kind); }
        }
        commit(state.sym ? [live, ...symCopies(live)] : [live]);
      }
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

  // One-Euro filter (Casiez et al.) — adaptive low-pass: heavy smoothing when the
  // pointer moves slowly (kills jitter), light when fast (no lag). Run in SCREEN space.
  function makeOneEuro(minCutoff, beta){
    let xp=null, dxp=0, tp=null;
    const alpha=(cut,dt)=>{ const tau=1/(2*Math.PI*cut); return 1/(1+tau/dt); };
    return (x, t)=>{
      if(xp===null){ xp=x; tp=t; return x; }
      let dt=(t-tp)/1000; if(dt<=0) dt=1/120; tp=t;
      const dx=(x-xp)/dt, aD=alpha(1.0,dt), dxh=aD*dx+(1-aD)*dxp; dxp=dxh;
      const cut=minCutoff+beta*Math.abs(dxh), a=alpha(cut,dt); xp=a*x+(1-a)*xp; return xp;
    };
  }

  function addPoint(s, x, y, p, t){
    const pts=s.pts, base=s.size, st=STYLES[s.tool]; let w;
    const last = pts[pts.length-1];
    if(s.tool==='eraser'){ w = base*2.4; }
    else if(st.const){ w = base*(st.mult||1); }
    else if(st.calli){
      let ang = last ? Math.atan2(y-last.y, x-last.x) : 0;
      w = base * (0.2 + 0.95*Math.abs(Math.sin(ang - Math.PI/4)));   // thick across the 45° nib
    } else {
      let speedF = 1;
      // velocity in SCREEN space (world distance × zoom) so brush dynamics feel
      // identical at every zoom level — the fix for "brush wrong at max zoom".
      if(last && st.ws){ const dt=Math.max(1,t-(last._t||0)); const v=Math.hypot(x-last.x,y-last.y)*cam.scale/dt; speedF=clamp(1-v*st.ws,0.35,1); }
      w = base * (st.wp + (1-st.wp)*p) * speedF;
    }
    if(st && st.jitter) w *= (1 - st.jitter*0.5 + st.jitter*Math.random());
    const k = (st && st.taper) ? st.taper : 3;
    if(!(st && st.const) && pts.length < k) w *= (0.4 + 0.6*pts.length/k);
    pts.push({ x, y, w, _t:t });
  }

  function finalizeStroke(s){
    const st=STYLES[s.tool];
    if(st && st.taper && !st.const){
      const k=st.taper, n=s.pts.length;
      for(let i=0;i<k && i<n;i++){ const f=0.35+0.65*(i/k); s.pts[n-1-i].w *= f; }
    }
    for(const p of s.pts) delete p._t;
    delete s._fx; delete s._fy;
    finalizeBB(s);
  }
  function finalizeBB(s){
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity,mw=0;
    for(const p of s.pts){ a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y);mw=Math.max(mw,p.w); }
    s.bb={minX:a-mw,minY:b-mw,maxX:c+mw,maxY:d+mw};
  }

  /* ---------------- shape recognition (snap hand-drawn shapes) ---------------- */
  const perpDist=(p,a,b)=>{ const L=Math.hypot(b.x-a.x,b.y-a.y)||1; return Math.abs((b.y-a.y)*p.x-(b.x-a.x)*p.y+b.x*a.y-b.y*a.x)/L; };
  function rdp(pts, eps){ if(pts.length<3) return pts.slice(); let dmax=0, idx=0; const a=pts[0], b=pts[pts.length-1];
    for(let i=1;i<pts.length-1;i++){ const dd=perpDist(pts[i],a,b); if(dd>dmax){ dmax=dd; idx=i; } }
    if(dmax>eps){ const l=rdp(pts.slice(0,idx+1),eps), r=rdp(pts.slice(idx),eps); return l.slice(0,-1).concat(r); }
    return [a,b]; }
  function recognizeShape(s){
    const P=s.pts; if(!P || P.length<8) return null;
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const p of P){ a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y); }
    const W=c-a, H=d-b, size=Math.hypot(W,H); if(size<14) return null;
    const w=P.reduce((t,p)=>t+p.w,0)/P.length, mk=(x,y)=>({x,y,w});
    let plen=0; for(let i=1;i<P.length;i++) plen+=Math.hypot(P[i].x-P[i-1].x,P[i].y-P[i-1].y);
    const closed=Math.hypot(P[0].x-P[P.length-1].x,P[0].y-P[P.length-1].y) < 0.22*plen;
    if(!closed){
      const A=P[0], B=P[P.length-1], L=Math.hypot(B.x-A.x,B.y-A.y)||1; let dev=0;
      for(const p of P) dev=Math.max(dev, perpDist(p,A,B));
      if(dev < 0.06*L && L>15) return { kind:'line', pts:[mk(A.x,A.y),mk((A.x+B.x)/2,(A.y+B.y)/2),mk(B.x,B.y)] };
      return null;
    }
    const cx=P.reduce((t,p)=>t+p.x,0)/P.length, cy=P.reduce((t,p)=>t+p.y,0)/P.length;
    const rs=P.map(p=>Math.hypot(p.x-cx,p.y-cy)); const mr=rs.reduce((t,r)=>t+r,0)/rs.length;
    let vr=0; for(const r of rs) vr+=(r-mr)*(r-mr); vr=Math.sqrt(vr/rs.length);
    if(mr>7 && vr/mr < 0.17){
      const rx=W/2, ry=H/2, ex=(a+c)/2, ey=(b+d)/2, N=64, out=[];
      for(let i=0;i<=N;i++){ const t=i/N*2*Math.PI; out.push(mk(ex+rx*Math.cos(t), ey+ry*Math.sin(t))); }
      return { kind: Math.abs(rx-ry)<0.18*Math.max(rx,ry) ? 'circle':'ellipse', pts:out };
    }
    let cor=rdp(P.map(p=>({x:p.x,y:p.y})), 0.05*size);
    if(cor.length>1 && Math.hypot(cor[0].x-cor[cor.length-1].x, cor[0].y-cor[cor.length-1].y) < 0.06*size) cor=cor.slice(0,-1);
    const nc=cor.length;
    // fill ratio (shoelace area / bbox area): rectangles ≈1, triangles ≈0.5
    let area=0; for(let i=0,j=P.length-1;i<P.length;j=i++) area += (P[j].x+P[i].x)*(P[j].y-P[i].y);
    const fill=Math.abs(area/2)/((W*H)||1);
    if(fill>0.72 && nc>=4 && nc<=8) return { kind:'rectangle', pts:[mk(a,b),mk(c,b),mk(c,d),mk(a,d),mk(a,b)] };
    if(fill>=0.33 && fill<=0.68 && nc>=3){          // triangle — pick the 3 corners forming the largest triangle
      let best=null, bestA=0;
      for(let i=0;i<nc;i++) for(let j=i+1;j<nc;j++) for(let k=j+1;k<nc;k++){
        const A=Math.abs((cor[j].x-cor[i].x)*(cor[k].y-cor[i].y)-(cor[k].x-cor[i].x)*(cor[j].y-cor[i].y))/2;
        if(A>bestA){ bestA=A; best=[cor[i],cor[j],cor[k]]; } }
      if(best) return { kind:'triangle', pts:[...best.map(p=>mk(p.x,p.y)), mk(best[0].x,best[0].y)] };
    }
    return null;
  }

  function nextRainbow(){ rainbowHue = (rainbowHue + 47) % 360; return `hsl(${rainbowHue} 85% 55%)`; }

  /* ---------------- symmetry (mandala) ---------------- */
  function symCopies(stroke){
    const out=[]; const N=state.axes;
    for(let k=0;k<N;k++) for(const mir of [1,-1]){
      if(k===0 && mir===1) continue;
      const a=k*2*Math.PI/N, cos=Math.cos(a), sin=Math.sin(a);
      const pts=stroke.pts.map(p=>{ const y=mir*p.y; return { x:p.x*cos - y*sin, y:p.x*sin + y*cos, w:p.w }; });
      const c={ tool:stroke.tool, color:stroke.color, size:stroke.size, layer:stroke.layer, pts };
      if(stroke.bb) finalizeBB(c);
      out.push(c);
    }
    return out;
  }

  /* ---------------- spatial index (uniform hash grid) ----------------
     Buckets items by their bounding box so a frame only touches items near the
     viewport instead of scanning the whole document — O(visible), not O(n). */
  const CELL = 256;                     // world units per cell
  const grid = new Map();               // "cx,cy" -> Set(item)
  const bigItems = new Set();           // items spanning too many cells (always considered)
  let zCounter = 0;
  const cellsOf = bb => [Math.floor(bb.minX/CELL), Math.floor(bb.minY/CELL), Math.floor(bb.maxX/CELL), Math.floor(bb.maxY/CELL)];
  function gridAdd(s){
    if(!s.bb) finalizeBB(s);
    if(s.z==null) s.z = zCounter++;
    s._big = false;
    const [x0,y0,x1,y1]=cellsOf(s.bb);
    if((x1-x0+1)*(y1-y0+1) > 64){ s._big=true; bigItems.add(s); return; }
    for(let cx=x0;cx<=x1;cx++) for(let cy=y0;cy<=y1;cy++){
      const k=cx+','+cy; let set=grid.get(k); if(!set){ set=new Set(); grid.set(k,set); } set.add(s);
    }
  }
  function gridRemove(s){
    if(s._big){ bigItems.delete(s); return; }
    if(!s.bb) return;
    const [x0,y0,x1,y1]=cellsOf(s.bb);
    for(let cx=x0;cx<=x1;cx++) for(let cy=y0;cy<=y1;cy++){
      const k=cx+','+cy; const set=grid.get(k); if(set){ set.delete(s); if(!set.size) grid.delete(k); }
    }
  }
  function gridRebuild(){ grid.clear(); bigItems.clear(); zCounter=0; for(const s of strokes){ s.z=null; gridAdd(s); } }
  function visibleStrokes(){
    const vr=viewRect(), pad=40/cam.scale;
    const [x0,y0,x1,y1]=cellsOf({minX:vr.minX-pad,minY:vr.minY-pad,maxX:vr.maxX+pad,maxY:vr.maxY+pad});
    if((x1-x0+1)*(y1-y0+1) > 6000) return strokes;   // zoomed way out: everything's on screen anyway
    const out=new Set();
    for(let cx=x0;cx<=x1;cx++) for(let cy=y0;cy<=y1;cy++){ const set=grid.get(cx+','+cy); if(set) for(const s of set) out.add(s); }
    for(const s of bigItems) out.add(s);
    return [...out].sort((a,b)=>a.z-b.z);
  }

  /* ---------------- operation-based undo / redo ---------------- */
  function pushOp(op){ undoStack.push(op); redoStack.length = 0; }
  function addItems(items){ for(const it of items){ if(!it.bb) finalizeBB(it); strokes.push(it); gridAdd(it); } strokes.sort((a,b)=>a.z-b.z); }
  function removeItems(items){ const set=new Set(items); strokes=strokes.filter(s=>!set.has(s)); for(const it of items){ gridRemove(it); selection.delete(it); } }
  function translateItems(items, dx, dy){
    for(const s of items){
      gridRemove(s);
      if(s.tool==='stamp'){ s.x+=dx; s.y+=dy; s.bb={minX:s.x-s.size/2,minY:s.y-s.size/2,maxX:s.x+s.size/2,maxY:s.y+s.size/2}; }
      else { for(const p of s.pts){ p.x+=dx; p.y+=dy; } finalizeBB(s); }
      gridAdd(s);
    }
  }
  function commit(items){ addItems(items); pushOp({type:'add', items}); invalidate(); saveSoon(); }
  function applyOp(op, forward){
    if(op.type==='add')    forward ? addItems(op.items)    : removeItems(op.items);
    else if(op.type==='delete') forward ? removeItems(op.items) : addItems(op.items);
    else if(op.type==='move')   translateItems(op.items, forward?op.dx:-op.dx, forward?op.dy:-op.dy);
    else if(op.type==='transform') applyMatrixToItems(op.items, forward?op.m:matInv(op.m));
  }
  function undo(){ if(!undoStack.length) return; const op=undoStack.pop(); applyOp(op,false); redoStack.push(op); updateSelBar(); invalidate(); saveSoon(); }
  function redo(){ if(!redoStack.length) return; const op=redoStack.pop(); applyOp(op,true); undoStack.push(op); updateSelBar(); invalidate(); saveSoon(); }

  /* ---------------- selection (select / move tool) ---------------- */
  let sel = null;   // active gesture {mode:'marquee'|'move', ...}
  const worldToScreen = (wx,wy) => ({ x:(wx+cam.x)*cam.scale, y:(wy+cam.y)*cam.scale });
  function selectionBBox(){ if(!selection.size) return null; let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;
    for(const s of selection){ if(!s.bb) continue; a=Math.min(a,s.bb.minX);b=Math.min(b,s.bb.minY);c=Math.max(c,s.bb.maxX);d=Math.max(d,s.bb.maxY); }
    return a===Infinity?null:{minX:a,minY:b,maxX:c,maxY:d}; }
  function selectInRect(r){
    const out=new Set(); const [x0,y0,x1,y1]=cellsOf(r); let cand;
    if((x1-x0+1)*(y1-y0+1) > 6000) cand=strokes;
    else { cand=new Set(); for(let cx=x0;cx<=x1;cx++)for(let cy=y0;cy<=y1;cy++){ const st=grid.get(cx+','+cy); if(st) for(const it of st) cand.add(it); } for(const it of bigItems) cand.add(it); }
    for(const s of cand){ if(s.bb && !(s.bb.maxX<r.minX||s.bb.minX>r.maxX||s.bb.maxY<r.minY||s.bb.minY>r.maxY)) out.add(s); }
    return out;
  }
  /* affine matrices {a,b,c,d,e,f}: x'=a·x+c·y+e, y'=b·x+d·y+f */
  const matMul=(A,B)=>({ a:A.a*B.a+A.c*B.b, b:A.b*B.a+A.d*B.b, c:A.a*B.c+A.c*B.d, d:A.b*B.c+A.d*B.d, e:A.a*B.e+A.c*B.f+A.e, f:A.b*B.e+A.d*B.f+A.f });
  const matTrans=(x,y)=>({a:1,b:0,c:0,d:1,e:x,f:y});
  const matScl=k=>({a:k,b:0,c:0,d:k,e:0,f:0});
  const matRot=r=>({a:Math.cos(r),b:Math.sin(r),c:-Math.sin(r),d:Math.cos(r),e:0,f:0});
  const matInv=m=>{ const det=m.a*m.d-m.b*m.c, id=1/det; return { a:m.d*id, b:-m.b*id, c:-m.c*id, d:m.a*id, e:(m.c*m.f-m.d*m.e)*id, f:(m.b*m.e-m.a*m.f)*id }; };
  const scaleAround=(px,py,k)=>matMul(matTrans(px,py), matMul(matScl(k), matTrans(-px,-py)));
  const rotAround=(px,py,r)=>matMul(matTrans(px,py), matMul(matRot(r), matTrans(-px,-py)));
  const matScaleOf=m=>Math.sqrt(Math.abs(m.a*m.d-m.b*m.c));
  function xformOne(s, apply){
    gridRemove(s);
    if(s.tool==='stamp'){ const r=apply(s.x,s.y); s.x=r.x; s.y=r.y; s.size=Math.max(2, s.size*r.sc);
      s.bb={minX:s.x-s.size/2,minY:s.y-s.size/2,maxX:s.x+s.size/2,maxY:s.y+s.size/2}; }
    else { for(const p of s.pts){ const r=apply(p.x,p.y); p.x=r.x; p.y=r.y; p.w*=r.sc; } finalizeBB(s); }
    gridAdd(s);
  }
  function applyMatrixToItems(items, m){ const sc=matScaleOf(m);
    for(const s of items) xformOne(s, (x,y)=>({ x:m.a*x+m.c*y+m.e, y:m.b*x+m.d*y+m.f, sc })); }
  function snapshotSelection(){ return [...selection].map(s=>({ item:s, x:s.x, y:s.y, size:s.size, pts: s.pts?s.pts.map(p=>({x:p.x,y:p.y,w:p.w})):null })); }
  function applySnapshot(list, m){ const sc=matScaleOf(m);
    for(const snap of list){ const s=snap.item; gridRemove(s);
      if(s.tool==='stamp'){ s.x=m.a*snap.x+m.c*snap.y+m.e; s.y=m.b*snap.x+m.d*snap.y+m.f; s.size=Math.max(2, snap.size*sc);
        s.bb={minX:s.x-s.size/2,minY:s.y-s.size/2,maxX:s.x+s.size/2,maxY:s.y+s.size/2}; }
      else { for(let i=0;i<snap.pts.length;i++){ const o=snap.pts[i], p=s.pts[i]; p.x=m.a*o.x+m.c*o.y+m.e; p.y=m.b*o.x+m.d*o.y+m.f; p.w=o.w*sc; } finalizeBB(s); }
      gridAdd(s); }
  }
  // screen-space handle positions for the current selection
  function selHandles(){
    const bb=selectionBBox(); if(!bb) return null;
    const p0=worldToScreen(bb.minX,bb.minY), p1=worldToScreen(bb.maxX,bb.maxY), pad=4;
    const L=p0.x-pad, T=p0.y-pad, Rr=p1.x+pad, B=p1.y+pad;
    return { bb, L, T, R:Rr, B, corners:[[L,T],[Rr,T],[L,B],[Rr,B]], rot:[(L+Rr)/2, T-28], cx:(bb.minX+bb.maxX)/2, cy:(bb.minY+bb.maxY)/2 };
  }
  function startSelect(sx,sy){
    if(selection.size){
      const h=selHandles(); const near=(hx,hy)=>Math.hypot(sx-hx,sy-hy)<18;
      if(h){
        if(near(h.rot[0],h.rot[1])){ const w=toWorld(sx,sy); sel={mode:'rotate', px:h.cx, py:h.cy, startAng:Math.atan2(w.y-h.cy,w.x-h.cx), orig:snapshotSelection(), m:null}; return; }
        for(let i=0;i<4;i++){ if(near(h.corners[i][0],h.corners[i][1])){
          const opp=h.corners[3-i]; const piv=toWorld(opp[0],opp[1]), st=toWorld(sx,sy);
          sel={mode:'scale', px:piv.x, py:piv.y, startDist:Math.max(1e-4,Math.hypot(st.x-piv.x,st.y-piv.y)), orig:snapshotSelection(), m:null}; return; }}
        const w=toWorld(sx,sy);
        if(w.x>=h.bb.minX && w.x<=h.bb.maxX && w.y>=h.bb.minY && w.y<=h.bb.maxY){ sel={mode:'move', lastX:sx, lastY:sy, dx:0, dy:0}; return; }
      }
    }
    sel={ mode:'lasso', pts:[{x:sx,y:sy}] };
  }
  const pointInPoly=(x,y,poly)=>{ let inside=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi)) inside=!inside; } return inside; };
  function selectInLasso(poly){
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const p of poly){ a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y); }
    const cand=selectInRect({minX:a,minY:b,maxX:c,maxY:d}), out=new Set();
    for(const s of cand){
      if(s.tool==='stamp'){ if(pointInPoly(s.x,s.y,poly)) out.add(s); continue; }
      const pts=s.pts, step=Math.max(1,Math.floor(pts.length/24)); let hit=false, cx=0, cy=0, n=0;
      for(let i=0;i<pts.length;i+=step){ cx+=pts[i].x; cy+=pts[i].y; n++; if(pointInPoly(pts[i].x,pts[i].y,poly)){ hit=true; break; } }
      if(!hit && n){ if(pointInPoly(cx/n,cy/n,poly)) hit=true; }
      if(hit) out.add(s);
    }
    return out;
  }
  function moveSelect(sx,sy){
    if(!sel) return;
    if(sel.mode==='lasso'){ const l=sel.pts[sel.pts.length-1]; if(!l||Math.hypot(sx-l.x,sy-l.y)>2){ sel.pts.push({x:sx,y:sy}); requestRender(); } return; }
    if(sel.mode==='move'){ const dxw=(sx-sel.lastX)/cam.scale, dyw=(sy-sel.lastY)/cam.scale;
      translateItems([...selection], dxw, dyw); sel.dx+=dxw; sel.dy+=dyw; sel.lastX=sx; sel.lastY=sy; invalidate(); return; }
    const w=toWorld(sx,sy);
    if(sel.mode==='scale'){ let k=Math.hypot(w.x-sel.px,w.y-sel.py)/sel.startDist; k=clamp(k,0.05,40);
      sel.m=scaleAround(sel.px,sel.py,k); applySnapshot(sel.orig, sel.m); invalidate(); }
    else if(sel.mode==='rotate'){ const d=Math.atan2(w.y-sel.py,w.x-sel.px)-sel.startAng;
      sel.m=rotAround(sel.px,sel.py,d); applySnapshot(sel.orig, sel.m); invalidate(); }
  }
  function endSelect(){
    if(!sel) return;
    if(sel.mode==='lasso'){
      const path=sel.pts; let len=0; for(let i=1;i<path.length;i++) len+=Math.hypot(path[i].x-path[i-1].x, path[i].y-path[i-1].y);
      if(path.length<3 || len<14) selection.clear();
      else selection = selectInLasso(path.map(p=>toWorld(p.x,p.y)));
      updateSelBar(); requestRender();
    } else if(sel.mode==='move'){ if(Math.hypot(sel.dx*cam.scale, sel.dy*cam.scale) > 1){ pushOp({type:'move', items:[...selection], dx:sel.dx, dy:sel.dy}); saveSoon(); } }
    else if(sel.m){ pushOp({type:'transform', items:sel.orig.map(o=>o.item), m:sel.m}); saveSoon(); }
    sel=null;
  }
  function clearSelection(){ if(selection.size){ selection.clear(); updateSelBar(); requestRender(); } }
  function deleteSelection(){ if(!selection.size) return; const items=[...selection]; removeItems(items); pushOp({type:'delete', items}); selection.clear(); updateSelBar(); invalidate(); saveSoon(); buzz(12); }
  function cloneItem(s){ return s.tool==='stamp' ? {tool:'stamp',dataURL:s.dataURL,x:s.x,y:s.y,size:s.size,layer:s.layer,_img:s._img}
    : {tool:s.tool,color:s.color,size:s.size,layer:s.layer,pts:s.pts.map(p=>({x:p.x,y:p.y,w:p.w}))}; }
  function duplicateSelection(){ if(!selection.size) return; const off=14/cam.scale;
    const clones=[...selection].map(s=>{ const c=cloneItem(s);
      if(c.tool==='stamp'){ c.x+=off; c.y+=off; c.bb={minX:c.x-c.size/2,minY:c.y-c.size/2,maxX:c.x+c.size/2,maxY:c.y+c.size/2}; }
      else { for(const p of c.pts){ p.x+=off; p.y+=off; } finalizeBB(c); } return c; });
    addItems(clones); pushOp({type:'add', items:clones}); selection=new Set(clones); updateSelBar(); invalidate(); saveSoon(); buzz(10); }
  const selBar=document.getElementById('selBar'), selCount=document.getElementById('selCount');
  function updateSelBar(){ const n=selection.size; if(selBar) selBar.classList.toggle('hidden', n===0 || state.tool!=='select'); if(selCount) selCount.textContent = n+(n===1?' selected':' selected'); }
  document.getElementById('selDup').addEventListener('click', ()=>{ duplicateSelection(); });
  document.getElementById('selDel').addEventListener('click', ()=>{ deleteSelection(); });
  document.getElementById('selNone').addEventListener('click', ()=>{ clearSelection(); });
  function drawSelectionOverlay(){
    ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0);
    if(sel && sel.mode==='lasso' && sel.pts.length>1){
      const p=sel.pts;
      ctx.beginPath(); ctx.moveTo(p[0].x,p[0].y); for(let i=1;i<p.length;i++) ctx.lineTo(p[i].x,p[i].y); ctx.closePath();
      ctx.fillStyle='rgba(143,178,255,.12)'; ctx.fill();
      ctx.strokeStyle='rgba(143,178,255,.95)'; ctx.lineWidth=1.5; ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
    }
    const h=selHandles();
    if(h){
      ctx.strokeStyle='#e0503a'; ctx.lineWidth=2; ctx.setLineDash([7,5]);
      ctx.strokeRect(h.L,h.T,h.R-h.L,h.B-h.T); ctx.setLineDash([]);
      // rotate handle stem + knob
      ctx.beginPath(); ctx.moveTo((h.L+h.R)/2,h.T); ctx.lineTo(h.rot[0],h.rot[1]); ctx.stroke();
      ctx.fillStyle='#e0503a'; ctx.strokeStyle='#fff'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(h.rot[0],h.rot[1],7,0,7); ctx.fill(); ctx.stroke();
      // scale corners (white-filled squares)
      ctx.fillStyle='#fff'; ctx.strokeStyle='#e0503a'; ctx.lineWidth=2;
      for(const [hx,hy] of h.corners){ ctx.beginPath(); ctx.rect(hx-5,hy-5,10,10); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }

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
    cam.scale = clamp(cam.scale*f, MIN_SCALE, MAX_SCALE);
    const after=toWorld(sx,sy);
    cam.x += after.x-before.x; cam.y += after.y-before.y;
    updateHud();
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); stopInertia(); stopCamAnim();
    if(e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)){
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY*0.0016));
    } else { cam.x -= e.deltaX/cam.scale; cam.y -= e.deltaY/cam.scale; }
    invalidate(); saveSoon();
  }, { passive:false });

  ['gesturestart','gesturechange','gestureend'].forEach(t => document.addEventListener(t, e=>e.preventDefault(), {passive:false}));
  document.addEventListener('dblclick', e=>e.preventDefault());
  document.addEventListener('touchmove', e=>{ if(e.touches.length>1) e.preventDefault(); }, {passive:false});

  // smooth animated camera move (log-interpolated scale for a natural zoom feel)
  let camAnim = 0;
  function stopCamAnim(){ if(camAnim){ cancelAnimationFrame(camAnim); camAnim=0; } }
  function animateCam(tx, ty, ts, dur){
    stopCamAnim(); dur = dur || 340;
    const sx=cam.x, sy=cam.y, ss=cam.scale, t0=performance.now(), ease=t=>1-Math.pow(1-t,3);
    const step=()=>{ const t=Math.min(1,(performance.now()-t0)/dur), k=ease(t);
      cam.scale = ss*Math.pow(ts/ss, k); cam.x = sx+(tx-sx)*k; cam.y = sy+(ty-sy)*k;
      updateHud(); invalidate();
      if(t<1) camAnim=requestAnimationFrame(step); else { camAnim=0; saveSoon(); } };
    camAnim=requestAnimationFrame(step);
  }
  function zoomToFit(){
    const bb = bounds();
    if(!bb || !strokes.length){ animateCam(0,0,1); return; }   // empty canvas → reset to 100%, not a sentinel-bbox fit
    const w=bb.maxX-bb.minX, h=bb.maxY-bb.minY;
    const s = clamp(Math.min(innerWidth/w, innerHeight/h)*0.9, MIN_SCALE, 8);
    animateCam(innerWidth/(2*s)-(bb.minX+w/2), innerHeight/(2*s)-(bb.minY+h/2), s);
  }

  /* ---------------- UI: swatches / tools / size ---------------- */
  const sw = document.getElementById('swatches');
  const swatchEls = [];
  function setColor(c, el){ state.color=c; state.rainbow=false;
    if(!isDrawStyle(state.tool)) selectTool(lastBrushStyle);
    swatchEls.forEach(n=>n.classList.remove('active')); if(el) el.classList.add('active'); updateBrushDot(); }
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
    if(!isDrawStyle(state.tool)) selectTool(lastBrushStyle);
    swatchEls.forEach(n=>n.classList.remove('active')); rainbowEl.classList.add('active'); updateBrushDot(); buzz(6); toast('🌈 Rainbow! Every line a new colour'); });
  sw.appendChild(rainbowEl); swatchEls.push(rainbowEl);
  // custom colour swatch
  const customEl=document.createElement('label'); customEl.className='swatch custom'; customEl.title='Custom colour'; customEl.setAttribute('aria-label','Pick a custom colour');
  customEl.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><input type="color" value="#2f6bff" aria-label="Custom colour picker">';
  const customInput=customEl.querySelector('input');
  customInput.addEventListener('input',()=>{ if(validHex(customInput.value)){ customEl.style.background=customInput.value; setColor(customInput.value, customEl); addRecent(customInput.value); } });
  sw.appendChild(customEl); swatchEls.push(customEl);
  // eyedropper — grab a colour from the drawing
  const eyeEl=document.createElement('button'); eyeEl.type='button'; eyeEl.className='swatch eyedrop'; eyeEl.title='Eyedropper — grab a colour'; eyeEl.setAttribute('aria-label','Eyedropper');
  eyeEl.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l4 4M17.5 2.5a2.1 2.1 0 0 1 3 3l-9 9-4 1 1-4 9-9z"/></svg>';
  eyeEl.addEventListener('click', pickEyedropper);
  sw.appendChild(eyeEl);
  // recent colours (appear as you use custom colours / the eyedropper)
  const recentWrap=document.createElement('span'); recentWrap.style.display='contents'; sw.appendChild(recentWrap);
  let recent = (()=>{ try{ return JSON.parse(localStorage.getItem('enso.recent')||'[]'); }catch(e){ return []; } })();
  function addRecent(c){ if(!validHex(c)) return; c=c.toLowerCase();
    if(PALETTE.some(p=>p.c.toLowerCase()===c)) return;
    recent = [c, ...recent.filter(x=>x!==c)].slice(0,4);
    try{ localStorage.setItem('enso.recent', JSON.stringify(recent)); }catch(e){}
    renderRecent(); }
  function renderRecent(){ recentWrap.innerHTML='';
    for(const c of recent){ const el=document.createElement('button'); el.type='button'; el.className='swatch recent'; el.style.background=c; el.title=c; el.setAttribute('aria-label','Recent colour '+c);
      el.addEventListener('click',()=>{ setColor(c, null); buzz(6); }); recentWrap.appendChild(el); } }
  renderRecent();
  let eyedropMode=false;
  async function pickEyedropper(){
    buzz(6);
    if(window.EyeDropper){ try{ const r=await new EyeDropper().open(); const hex=r.sRGBHex.toLowerCase(); setColor(hex); addRecent(hex); customInput.value=hex; customEl.style.background=hex; }catch(e){} }
    else { eyedropMode=true; document.body.classList.add('eyedrop'); toast('Tap the drawing to grab its colour'); }
  }
  function sampleColorAt(sx,sy){ try{ const d=ctx.getImageData(Math.round(sx*dpr),Math.round(sy*dpr),1,1).data;
    const hex='#'+[d[0],d[1],d[2]].map(v=>('0'+v.toString(16)).slice(-2)).join(''); setColor(hex); addRecent(hex); }catch(e){} }
  const isEyedrop = () => eyedropMode;
  const doSample = (x,y)=>{ sampleColorAt(x,y); eyedropMode=false; document.body.classList.remove('eyedrop'); };

  // collapsible right-side palette
  const paletteTab=document.getElementById('paletteTab'), paletteDot=paletteTab.querySelector('.pt-dot');
  let palOpen = localStorage.getItem('enso.palOpen')!=='0';
  function setPalette(open){ palOpen=open; document.body.classList.toggle('pal-open', open); paletteTab.setAttribute('aria-expanded', open?'true':'false'); try{ localStorage.setItem('enso.palOpen', open?'1':'0'); }catch(e){} }
  paletteTab.addEventListener('click', ()=>{ setPalette(!palOpen); buzz(6); });
  setPalette(palOpen);

  const brushBtn = document.getElementById('brushBtn'), brushDot = brushBtn.querySelector('.brush-dot');

  // radial bloom dock
  const bloom=document.getElementById('bloom'), bloomOrb=document.getElementById('bloomOrb'),
        orbIco=bloomOrb.querySelector('.orb-ico'), orbDot=bloomOrb.querySelector('.orb-dot');
  document.querySelectorAll('.petal').forEach(p=>{ if(p.dataset.c) p.style.background=p.dataset.c;
    if(p.dataset.r) p.style.right=p.dataset.r+'px'; if(p.dataset.b) p.style.bottom=p.dataset.b+'px'; });
  function setBloom(open){ document.body.classList.toggle('bloom-open', open); bloomOrb.setAttribute('aria-expanded', open?'true':'false'); }
  bloomOrb.addEventListener('click', e=>{ e.stopPropagation(); setBloom(!document.body.classList.contains('bloom-open')); buzz(6); });
  document.addEventListener('click', e=>{ if(document.body.classList.contains('bloom-open') && !bloom.contains(e.target)) setBloom(false); });
  function updateOrb(){
    const el = isDrawStyle(state.tool) ? brushBtn : document.querySelector('.petal[data-tool="'+state.tool+'"]');
    if(el){ const svg=el.querySelector('svg'); if(svg) orbIco.innerHTML = svg.outerHTML; }
    orbDot.style.background = state.rainbow ? '#e0503a' : state.color;
  }
  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.addEventListener('click',()=>{ selectTool(b.dataset.tool); buzz(6); }));
  function selectTool(tool){ state.tool=tool; clearPendingStamp();
    if(isDrawStyle(tool)) lastBrushStyle = tool;
    const draw = isDrawStyle(tool);
    brushBtn.classList.toggle('active', draw); brushBtn.setAttribute('aria-pressed', draw?'true':'false');
    document.querySelectorAll('.tool[data-tool]').forEach(b=>{ const on=b.dataset.tool===tool; b.classList.toggle('active',on); b.setAttribute('aria-pressed', on?'true':'false'); });
    document.body.classList.toggle('pan', tool==='pan');
    document.body.classList.toggle('erase', tool==='eraser');
    document.body.classList.toggle('select', tool==='select');
    if(tool!=='select'){ selection.clear(); sel=null; }
    updateSelBar(); updateBrushDot(); updateOrb(); requestRender();
  }
  function updateBrushDot(){ const bg = state.rainbow
    ? 'conic-gradient(from 0deg,#ff4d4f,#ffd21a,#37c86b,#20b8e6,#9a5bff,#ff4d4f)' : state.color;
    brushDot.style.background = bg; if(paletteDot) paletteDot.style.background = bg; if(orbDot) orbDot.style.background = bg; }

  // brush style picker
  const brushModal=document.getElementById('brushModal'), brushGrid=document.getElementById('brushGrid');
  Object.entries(STYLES).forEach(([key,st])=>{
    const b=document.createElement('button'); b.type='button'; b.className='brush'; b.dataset.style=key;
    b.innerHTML=`<span class="em" aria-hidden="true">${st.emoji}</span><span>${st.label}</span>`; b.setAttribute('aria-label', st.label);
    b.addEventListener('click',()=>{ selectTool(key); highlightBrush(); brushModal.classList.add('hidden'); buzz(8); toast(st.emoji+' '+st.label); });
    brushGrid.appendChild(b);
  });
  function highlightBrush(){ brushGrid.querySelectorAll('.brush').forEach(b=>b.classList.toggle('on', b.dataset.style===state.tool)); }
  function openBrushPicker(){ highlightBrush(); brushModal.classList.remove('hidden'); pushGuard(); }
  brushBtn.addEventListener('click',()=>{ if(isDrawStyle(state.tool)) openBrushPicker(); else selectTool(lastBrushStyle); buzz(6); });
  document.getElementById('brushClose').addEventListener('click',()=>brushModal.classList.add('hidden'));
  const sizeRange=document.getElementById('sizeRange');
  sizeRange.addEventListener('input',()=>{ state.size=+sizeRange.value; });
  document.getElementById('undo').addEventListener('click', ()=>{ undo(); buzz(6); });
  document.getElementById('redo').addEventListener('click', ()=>{ redo(); buzz(6); });

  const symBtn=document.getElementById('symBtn');
  symBtn.addEventListener('click',()=>{ state.sym=!state.sym; symBtn.classList.toggle('on',state.sym); symBtn.setAttribute('aria-pressed',state.sym?'true':'false');
    toast(state.sym?`✨ Mandala on · ${state.axes} axes`:'Mandala off'); buzz(6); requestRender(); });

  const zenBtn=document.getElementById('zenBtn'); if(zenBtn) zenBtn.addEventListener('click', ()=>toggleZen());
  function toggleZen(force){ const on = force!==undefined ? force : !document.body.classList.contains('zen');
    document.body.classList.toggle('zen', on); if(on) pushGuard(); }

  { const h=document.getElementById('hud'); if(h) h.addEventListener('click', ()=>{ zoomToFit(); }); }
  function clearAll(){ if(confirm('Clear the whole canvas? This cannot be undone.')){
    strokes=[]; undoStack=[]; redoStack=[]; selection.clear(); updateSelBar();
    layers=[{id:1,name:'Layer 1',visible:true,opacity:1}]; activeLayer=1; nextLayerId=2;
    gridRebuild(); invalidate(); save(); buzz(12); toast('Fresh paper ✨'); } }
  document.getElementById('clearBtn').addEventListener('click', clearAll);

  /* ---------------- sheet menu ---------------- */
  const sheet=document.getElementById('sheet'), menuBtn=document.getElementById('menuBtn');
  function toggleSheet(open){ const show = open!==undefined ? open : sheet.classList.contains('hidden');
    sheet.classList.toggle('hidden', !show); menuBtn.setAttribute('aria-expanded', show?'true':'false'); if(show) pushGuard(); }
  menuBtn.addEventListener('click', e=>{ e.stopPropagation(); toggleSheet(); });
  document.addEventListener('click', e=>{ if(!sheet.classList.contains('hidden') && !sheet.contains(e.target) && e.target!==menuBtn && !menuBtn.contains(e.target)) toggleSheet(false); });
  sheet.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',()=>{
    const a=b.dataset.act; toggleSheet(false); buzz(6);
    if(a==='home'){ animateCam(0,0,1); }
    else if(a==='fit') zoomToFit();
    else if(a==='theme'){ state.theme=state.theme==='dark'?'light':'dark'; invalidate(); saveSoon(); }
    else if(a==='grid'){ state.grid=!state.grid; invalidate(); saveSoon(); }
    else if(a==='shapesnap'){ state.shapeSnap=!state.shapeSnap; toast(state.shapeSnap?'✦ Shape snap ON — draw a circle, box, line…':'Shape snap off'); saveSoon(); }
    else if(a==='symaxes') cycleAxes();
    else if(a==='png') exportPNG();
    else if(a==='svg') exportSVG();
    else if(a==='savefile') exportDoc();
    else if(a==='openfile') importDoc();
    else if(a==='share') shareImage();
    else if(a==='replay') startReplay();
    else if(a==='seal') openSeal();
    else if(a==='sticker') openStickers();
    else if(a==='install') doInstall();
    else if(a==='layers') openLayers();
    else if(a==='donate') openDonate();
    else if(a==='clear') clearAll();
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
    const st={ tool:'stamp', dataURL, x, y, size, layer:activeLayer };
    st.bb={minX:x-size/2,minY:y-size/2,maxX:x+size/2,maxY:y+size/2};
    st._img = img || (()=>{ const im=new Image(); im.onload=()=>{ invalidate(); }; im.src=dataURL; return im; })();
    return st;
  }
  function emojiDataURL(em){
    // render large so stickers stay sharp when the canvas is zoomed in
    const S=256, c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d');
    x.textAlign='center'; x.textBaseline='middle'; x.font='200px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif';
    x.fillText(em, S/2, S/2+10); return c.toDataURL('image/png');
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
      const stream=canvas.captureStream(30); replay.chunks=[]; replay.stream=stream;
      replay.rec=new MediaRecorder(stream,{ mimeType:type, videoBitsPerSecond:8_000_000 });
      replay.rec.ondataavailable=e=>{ if(e.data.size) replay.chunks.push(e.data); };
      replay.rec.onstop=()=>{ const blob=new Blob(replay.chunks,{type:'video/webm'}); downloadBlob(blob,'enso-'+stamp()+'.webm');
        try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){} replay.rec=null; replay.stream=null;
        rRec.classList.remove('recording'); rRec.textContent='● REC'; toast('Video saved 🎬'); };
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
  // save / open an editable Ensō document file (real backup + sharing)
  function exportDoc(){
    const data=JSON.stringify({ v:2, strokes:serialize(strokes), cam, layers, activeLayer, nextLayerId, state:{theme:state.theme,grid:state.grid,axes:state.axes} });
    downloadBlob(new Blob([data],{type:'application/json'}), 'enso-'+stamp()+'.enso.json'); toast('Saved file ✓');
  }
  function importDoc(){
    const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
    inp.onchange=()=>{ const f=inp.files&&inp.files[0]; if(!f) return; const r=new FileReader();
      r.onload=()=>{ try{ applyDoc(JSON.parse(r.result)); updateSelBar(); updateHud(); invalidate(); save(); toast('Opened ✓'); }catch(e){ toast('Could not open that file'); } };
      r.readAsText(f); };
    inp.click();
  }
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
      || !stickerModal.classList.contains('hidden') || !brushModal.classList.contains('hidden') || !layerModal.classList.contains('hidden')
      || !donateModal.classList.contains('hidden')
      || replay.active || document.body.classList.contains('zen') || !!state.pendingStamp; }
  function pushGuard(){ if(!guardActive){ guardActive=true; try{ history.pushState({enso:1},''); }catch(e){} } }
  function closeAllOverlays(){ toggleSheet(false); sealModal.classList.add('hidden'); stickerModal.classList.add('hidden'); brushModal.classList.add('hidden'); layerModal.classList.add('hidden'); donateModal.classList.add('hidden');
    if(replay.active) exitReplay(); document.body.classList.remove('zen'); clearPendingStamp(); }
  window.addEventListener('popstate', ()=>{ guardActive=false; if(anyOverlay()) closeAllOverlays(); });

  // click on modal backdrop closes it
  [sealModal, stickerModal, brushModal].forEach(m=>m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); }));

  /* ---------------- keyboard ---------------- */
  addEventListener('keydown', e=>{
    if(e.target && /input|textarea/i.test(e.target.tagName)) return;
    if(e.code==='Space' && !spaceDown){ spaceDown=true; document.body.classList.add('pan'); return; }
    if(e.ctrlKey||e.metaKey){ const k=e.key.toLowerCase();
      if(k==='z'&&!e.shiftKey){ e.preventDefault(); undo(); } else if((k==='z'&&e.shiftKey)||k==='y'){ e.preventDefault(); redo(); }
      else if(k==='d'){ e.preventDefault(); duplicateSelection(); } return; }
    if((e.key==='Delete'||e.key==='Backspace') && selection.size){ e.preventDefault(); deleteSelection(); return; }
    const k=e.key.toLowerCase();
    if(k==='b') selectTool('brush'); else if(k==='p') selectTool('pen');
    else if(k==='m') selectTool('marker'); else if(k==='e') selectTool('eraser');
    else if(k==='v') selectTool('select');
    else if(k==='h') selectTool('pan'); else if(k==='z') toggleZen();
    else if(k==='s') symBtn.click();
    else if(k==='+'||k==='=') zoomAt(innerWidth/2,innerHeight/2,1.2), invalidate();
    else if(k==='-'||k==='_') zoomAt(innerWidth/2,innerHeight/2,1/1.2), invalidate();
    else if(k==='0') zoomToFit();
    else if(k==='escape'){ if(anyOverlay()) closeAllOverlays(); else clearSelection(); }
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
  function updateHud(){ if(hud) hud.textContent = cam.scale>=1 ? Math.round(cam.scale*100)+'%' : (cam.scale*100).toFixed(cam.scale<0.1?1:0)+'%'; }
  let toastT; function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); t.style.opacity='1';
    clearTimeout(toastT); toastT=setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.classList.add('hidden'),300); }, 1900); }
  let hintT=setTimeout(hideHint,6500); function hideHint(){ const h=document.getElementById('hint'); if(h) h.style.opacity='0'; clearTimeout(hintT); }

  /* ---------------- layers panel ---------------- */
  const layerModal=document.getElementById('layerModal'), layerList=document.getElementById('layerList');
  function openLayers(){ renderLayers(); layerModal.classList.remove('hidden'); pushGuard(); }
  document.getElementById('layerClose').addEventListener('click',()=>layerModal.classList.add('hidden'));
  document.getElementById('layerAdd').addEventListener('click', addLayer);
  layerModal.addEventListener('click', e=>{ if(e.target===layerModal) layerModal.classList.add('hidden'); });
  function addLayer(){ const L={ id:nextLayerId++, name:'Layer '+(layers.length+1), visible:true, opacity:1 };
    layers.push(L); activeLayer=L.id; renderLayers(); saveSoon(); buzz(6); }
  function moveLayer(idx, dir){ const t=idx+dir; if(t<0||t>=layers.length) return;
    const tmp=layers[idx]; layers[idx]=layers[t]; layers[t]=tmp; renderLayers(); invalidate(); saveSoon(); }
  function deleteLayer(L){
    if(layers.length<=1){ toast('Keep at least one layer'); return; }
    const items=strokes.filter(s=>(s.layer||layers[0].id)===L.id);
    if(items.length && !confirm(`Delete “${L.name}” and its ${items.length} drawing${items.length>1?'s':''}?`)) return;
    if(items.length) removeItems(items);
    layers=layers.filter(x=>x!==L);
    if(activeLayer===L.id) activeLayer=layers[layers.length-1].id;
    undoStack=[]; redoStack=[];             // avoid undo referencing a removed layer
    renderLayers(); updateSelBar(); invalidate(); saveSoon();
  }
  function renderLayers(){
    layerList.innerHTML='';
    for(let i=layers.length-1;i>=0;i--){                 // top layer first
      const L=layers[i];
      const row=document.createElement('div'); row.className='layer-row'+(L.id===activeLayer?' active':'');
      const eye=document.createElement('button'); eye.className='lyr-eye'; eye.title='Show / hide'; eye.textContent=L.visible?'👁':'🙈';
      eye.onclick=()=>{ L.visible=!L.visible; renderLayers(); invalidate(); saveSoon(); };
      const name=document.createElement('button'); name.className='lyr-name'; name.textContent=L.name; name.title='Tap to draw on this layer';
      name.onclick=()=>{ activeLayer=L.id; renderLayers(); saveSoon(); };
      const op=document.createElement('input'); op.className='lyr-op'; op.type='range'; op.min=0; op.max=100; op.value=Math.round(L.opacity*100); op.title='Opacity'; op.setAttribute('aria-label','Layer opacity');
      op.oninput=()=>{ L.opacity=+op.value/100; invalidate(); saveSoon(); };
      const up=document.createElement('button'); up.className='lyr-up'; up.title='Move up'; up.textContent='▲'; up.onclick=()=>moveLayer(i,1);
      const dn=document.createElement('button'); dn.className='lyr-down'; dn.title='Move down'; dn.textContent='▼'; dn.onclick=()=>moveLayer(i,-1);
      const del=document.createElement('button'); del.className='lyr-del'; del.title='Delete layer'; del.textContent='🗑'; del.onclick=()=>deleteLayer(L);
      row.append(eye,name,op,up,dn,del); layerList.appendChild(row);
    }
  }

  /* ---------------- install (Add to Home screen / desktop shortcut) ---------------- */
  let deferredPrompt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });
  addEventListener('appinstalled', () => { deferredPrompt = null; hideAppPrompt(true); toast('Installed! Find Ensō on your home screen 🎉'); });
  async function doInstall(){
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if(standalone){ toast('Ensō is already installed ✓'); return; }
    if(deferredPrompt){
      deferredPrompt.prompt();
      try{ await deferredPrompt.userChoice; }catch(e){}
      deferredPrompt = null; return;
    }
    if(/iphone|ipad|ipod/i.test(navigator.userAgent)) toast('On iPhone/iPad: tap Share ⬆ then “Add to Home Screen”');
    else toast('Open your browser menu → “Install app” / “Add to Home screen”');
  }

  // Mobile "get the app" prompt — shown when opened in a phone/tablet browser
  const appPrompt=document.getElementById('appPrompt');
  function hideAppPrompt(remember){ if(appPrompt) appPrompt.classList.add('hidden'); document.body.classList.remove('apshow'); if(remember){ try{ localStorage.setItem('enso.getapp', String(Date.now())); }catch(e){} } }
  const apGet=document.getElementById('apGet'); if(apGet) apGet.addEventListener('click', ()=>{ doInstall(); if(deferredPrompt) hideAppPrompt(true); });
  const apClose=document.getElementById('apClose'); if(apClose) apClose.addEventListener('click', ()=>hideAppPrompt(true));
  function maybeShowAppPrompt(){
    if(!appPrompt) return;
    if(matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;   // already installed
    const ua = navigator.userAgent || '';
    const isIpadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints||0) > 1;
    if(!(/android|iphone|ipad|ipod/i.test(ua) || isIpadOS)) return;                          // mobile/tablet browsers only
    const dis = +(localStorage.getItem('enso.getapp')||0);
    if(Date.now() - dis < 7*24*3600*1000) return;                                            // snoozed for 7 days
    if(/iphone|ipad|ipod/i.test(ua) || isIpadOS){                                            // iOS has no install prompt
      const m=document.getElementById('apMsg'); if(m) m.textContent='Tap Share ⬆ then “Add to Home Screen” for the best experience';
      if(apGet) apGet.style.display='none';
    }
    setTimeout(()=>{ appPrompt.classList.remove('hidden'); document.body.classList.add('apshow'); }, 1500);
  }

  /* ---------------- support / crypto donate ---------------- */
  const donateModal=document.getElementById('donateModal'), donateList=document.getElementById('donateList');
  function openDonate(){ renderDonate(); donateModal.classList.remove('hidden'); pushGuard(); }
  document.getElementById('donateClose').addEventListener('click',()=>donateModal.classList.add('hidden'));
  donateModal.addEventListener('click', e=>{ if(e.target===donateModal) donateModal.classList.add('hidden'); });
  function renderDonate(){
    donateList.innerHTML='';
    for(const d of DONATE){
      const set = d.addr && !/^YOUR_/.test(d.addr);
      const row=document.createElement('div'); row.className='donate-row';
      const head=document.createElement('div'); head.className='dr-head';
      const nm=document.createElement('span'); nm.className='dr-name'; nm.textContent=d.name;
      const sy=document.createElement('span'); sy.className='dr-sym'; sy.textContent=d.sym;
      head.append(nm,sy); row.appendChild(head);
      if(set){
        const ad=document.createElement('div'); ad.className='dr-addr'; ad.textContent=d.addr; row.appendChild(ad);
        const act=document.createElement('div'); act.className='dr-actions';
        const cp=document.createElement('button'); cp.className='dr-copy'; cp.textContent='Copy address';
        cp.onclick=()=>{ const done=()=>{ toast('Copied '+d.sym+' address 📋'); buzz(6); };
          if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(d.addr).then(done).catch(()=>toast(d.addr)); else toast(d.addr); };
        act.appendChild(cp);
        if(d.scheme){ const lk=document.createElement('a'); lk.className='dr-open'; lk.href=d.scheme+':'+d.addr; lk.rel='noopener'; lk.textContent='Open wallet'; act.appendChild(lk); }
        row.appendChild(act);
      } else { const td=document.createElement('div'); td.className='dr-todo'; td.textContent='Add your '+d.sym+' address in app.js → DONATE'; row.appendChild(td); }
      donateList.appendChild(row);
    }
  }

  /* ---------------- boot ---------------- */
  load(); gridRebuild(); selectTool(state.tool); updateHud(); maybeShowAppPrompt();
  addEventListener('resize', resize);
  if(window.visualViewport) visualViewport.addEventListener('resize', resize);
  resize();
  addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) save(); });
  if('serviceWorker' in navigator){
    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(refreshing) return; refreshing=true; location.reload(); });
    addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').then(reg=>{
      reg.addEventListener('updatefound',()=>{ const nw=reg.installing; if(nw) nw.addEventListener('statechange',()=>{ if(nw.state==='installed' && navigator.serviceWorker.controller) nw.postMessage&&reg.waiting&&reg.waiting.postMessage('skipWaiting'); }); });
    }).catch(()=>{}); });
  }
})();
