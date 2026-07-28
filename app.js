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
  const MIN_SCALE = 0.0002, MAX_SCALE = 1e8;   // 0.02% … 10,000,000,000% (10 billion %) — verified-crisp ceiling; the canvas rasterizer's float32 transform limits deeper
  const REBASE_BUDGET = 1e6;   // when cam.scale*|cam| exceeds this, re-base the world origin to the camera so far-from-origin stays as crisp as near-origin (float32 rasterizer starts losing sub-pixels ~8e6)
  let dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  let cacheValid = false;                 // is inkCv up to date for the current camera?
  const invalidate = () => { cacheValid = false; recordCam(); requestRender(); };

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
    paper: 'dots',           // paper theme (cream · sky · kraft · dots · grid)
    palette: 'Classic',      // active colour palette
    accent: 'verm',          // UI accent theme — recolours the whole app + icon
    glow: false,             // Glow room: lights-off, every stroke glows
    music: null,             // soundtrack id ('calm'|'chimes'|'rain'|'lofi'|'custom'|null)
    watermark: true,         // subtle "Made with Ensō" mark on shared images
  };
  let gardenRAF = 0;         // magic-garden sprout animation
  // Session timeline — records the REAL camera path + per-stroke timing so Replay can
  // reproduce the actual drawing session (every zoom, pan and stroke), not a fly-through.
  const session = { t0:null, cam:[], _lm:0, ok:true };
  function recordCam(force){
    if(replay.active || !session.ok) return;
    const now=performance.now();
    if(session.t0==null) session.t0=now;
    if(!force && now - session._lm < 55) return;
    session._lm=now;
    session.cam.push({ t: now-session.t0, x:cam.x, y:cam.y, s:cam.scale });
    if(session.cam.length>6000) session.cam.splice(0, session.cam.length-6000);
  }
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
    water:       { label:'Watercolour',  emoji:'💧', wp:0.6,  ws:0.04, taper:2, alpha:0.5, blend:'multiply', water:true },
    garden:      { label:'Magic garden', emoji:'🌱', wp:0.5,  ws:0.08, taper:3, garden:true },
  };
  const isDrawStyle = t => STYLES[t] != null;

  // bright, friendly palette (kid-first) — sumi black kept for natural ink
  const PALETTE = [
    { c:'#2b2b31', n:'Black' },  { c:'#ff4d4f', n:'Red' },    { c:'#ff8c1a', n:'Orange' },
    { c:'#ffd21a', n:'Yellow' }, { c:'#37c86b', n:'Green' },  { c:'#20b8e6', n:'Sky' },
    { c:'#2f6bff', n:'Blue' },   { c:'#9a5bff', n:'Purple' }, { c:'#ff5fa2', n:'Pink' },
    { c:'#a2673f', n:'Brown' },  { c:'#ffffff', n:'White' },
  ];
  // Paper themes — background colour + optional pattern (dark flag for light strokes)
  const PAPERS = [
    { id:'dots',  label:'Dots',  bg:'#f7f4ee', pat:'dots' },
    { id:'grid',  label:'Grid',  bg:'#f7f4ee', pat:'grid' },
    { id:'cream', label:'Cream', bg:'#f7f4ee', pat:null },
    { id:'sky',   label:'Sky',   bg:'#e9f1f8', pat:null },
    { id:'kraft', label:'Kraft', bg:'#e8dcc4', pat:null },
    { id:'sakura',label:'Sakura',bg:'#fbeef0', pat:null },
    { id:'midnight', label:'Midnight',   bg:'#141726', pat:null, dark:true },
    { id:'blackboard', label:'Blackboard', bg:'#1f2a24', pat:null, dark:true },
  ];
  // UI accent themes — recolour the whole app (buttons, brand, links) + the tab icon
  const ACCENTS = [
    { id:'verm',   name:'Vermillion', c:'#e0503a', c2:'#c0433a' },
    { id:'purple', name:'Magic purple', c:'#9a5bff', c2:'#7d43e0' },
    { id:'ocean',  name:'Ocean', c:'#1aa5b0', c2:'#158791' },
    { id:'sakura', name:'Sakura', c:'#ff6f9c', c2:'#e5547f' },
    { id:'gold',   name:'Gold', c:'#e6a90c', c2:'#c48f08' },
    { id:'indigo', name:'Indigo', c:'#6d7bff', c2:'#5563e6' },
    { id:'forest', name:'Forest', c:'#2fae6b', c2:'#249058' },
  ];
  const accentById = id => ACCENTS.find(a=>a.id===id) || ACCENTS[0];
  // Switchable colour palettes (kid-friendly, harmonised)
  const PALETTES = {
    Classic: PALETTE,
    Crayon: [{c:'#e5342b',n:'Red'},{c:'#f6902a',n:'Orange'},{c:'#f7c948',n:'Yellow'},{c:'#3aa655',n:'Green'},{c:'#2b7fd4',n:'Blue'},{c:'#7b52c9',n:'Purple'},{c:'#8d5524',n:'Brown'},{c:'#2b2b31',n:'Black'},{c:'#ffffff',n:'White'}],
    Pastel: [{c:'#f7a8b8',n:'Rose'},{c:'#ffd6a5',n:'Peach'},{c:'#fdf3a0',n:'Lemon'},{c:'#b8e3c6',n:'Mint'},{c:'#a9d6f0',n:'Sky'},{c:'#cdb4f0',n:'Lilac'},{c:'#e6c9a8',n:'Sand'},{c:'#6b6b73',n:'Grey'},{c:'#ffffff',n:'White'}],
    Neon: [{c:'#ff2e63',n:'Hot pink'},{c:'#ff9f1c',n:'Orange'},{c:'#eaff00',n:'Yellow'},{c:'#39ff14',n:'Green'},{c:'#00e5ff',n:'Cyan'},{c:'#c400ff',n:'Violet'},{c:'#ff5fa2',n:'Pink'},{c:'#101018',n:'Black'},{c:'#ffffff',n:'White'}],
    Earth: [{c:'#8d5524',n:'Umber'},{c:'#c68642',n:'Ochre'},{c:'#e0ac69',n:'Sand'},{c:'#7a8450',n:'Moss'},{c:'#4a6670',n:'Slate'},{c:'#a24936',n:'Clay'},{c:'#d9c8a9',n:'Bone'},{c:'#3d3b34',n:'Charcoal'},{c:'#ffffff',n:'White'}],
  };
  let activePalette = PALETTES.Classic;
  const STICKERS = [
    '⭐','🌟','✨','💫','🌈','❤️','🧡','💛','💚','💙','💜','🩷','⚡','🔥','💧','❄️','☀️','🌙','☁️','🌍',
    '🌸','🌷','🌹','🌻','🌼','🌺','🍀','🍁','🌵','🌴','🌲','🍄','🌊','🌟','🌞','🐢','🐱','🐶','🦋','🐝',
    '🐞','🐙','🐠','🐬','🐳','🦄','🐉','🦖','🦕','🐧','🦉','🦊','🐰','🐼','🐨','🐸','🐷','🐵','🦁','🐯',
    '🐮','🐔','🦩','🦥','🐳','🍎','🍓','🍉','🍌','🍕','🍭','🍩','🍪','🎂','🍦','🚀','🛸','⚽','🎈','🎁',
    '👑','💎','🎵','🎨','🌟','🏰','🌟','🪄','🦕','🌟'
  ];

  /* 💛 CRYPTO DONATIONS — replace the YOUR_… placeholders with your own wallet
     addresses. Delete a row you don't want. 100% free: no processor, no backend. */
  const DONATE = [
    { sym:'BTC',  name:'Bitcoin',                addr:'YOUR_BTC_ADDRESS',  scheme:'bitcoin' },
    { sym:'ETH',  name:'Ethereum · USDT/USDC (ERC-20)', addr:'YOUR_ETH_ADDRESS', scheme:'ethereum' },
    { sym:'SOL',  name:'Solana',                 addr:'YOUR_SOL_ADDRESS',  scheme:'solana' },
    { sym:'TON',  name:'Toncoin',                addr:'YOUR_TON_ADDRESS',  scheme:'ton' },
  ];
  const paperColor = () => state.glow ? '#07070c'
    : state.theme === 'dark' ? '#17181c'
    : ((PAPERS.find(x=>x.id===state.paper) || PAPERS[0]).bg);

  /* ---------------- persistence ---------------- */
  const KEY = 'enso.doc.v2';
  let quotaWarned = false;
  const save = () => { try {
    localStorage.setItem(KEY, JSON.stringify({ strokes: serialize(strokes), cam, layers, activeLayer, nextLayerId,
      state:{ theme:state.theme, grid:state.grid, axes:state.axes, shape:state.shapeSnap, paper:state.paper, palette:state.palette, accent:state.accent, glow:state.glow, music:(state.music==='custom'?null:state.music) } }));
  } catch(e){ if(!quotaWarned){ quotaWarned = true; toast('Storage full — older work may not auto-save. Export to keep it.'); } } };
  const saveSoon = debounce(save, 400);
  function serialize(list){ return list.map(s => s.tool==='stamp'
    ? { tool:'stamp', dataURL:s.dataURL, x:r2(s.x), y:r2(s.y), size:r2(s.size), ar:s.ar!==1?s.ar:undefined, rot:s.rot||undefined, layer:s.layer }
    : { tool:s.tool, color:s.color, size:s.size, layer:s.layer, snapped:s.snapped?1:undefined, pts:s.pts.map(p=>[r2(p.x),r2(p.y),r2(p.w)]) }); }
  function applyDoc(d){
    if(!d) return;
    strokes=[]; undoStack=[]; redoStack=[]; selection.clear();
    layers=[{id:1,name:'Layer 1',visible:true,opacity:1}]; activeLayer=1; nextLayerId=2;
    if(d.cam) Object.assign(cam, d.cam);
    if(d.state){ state.theme=d.state.theme||state.theme; state.grid=d.state.grid!==false; state.axes=d.state.axes||6; state.shapeSnap=!!d.state.shape;
      state.paper=d.state.paper || (d.state.grid===false?'cream':'dots'); state.palette=d.state.palette||'Classic';
      state.accent=d.state.accent||'verm'; state.glow=!!d.state.glow; state.music=(d.state.music==='custom'?null:(d.state.music||null)); }
    if(Array.isArray(d.layers) && d.layers.length){ layers=d.layers; activeLayer=d.activeLayer||layers[0].id; nextLayerId=d.nextLayerId||(Math.max(...layers.map(l=>l.id))+1); }
    if(Array.isArray(d.strokes)) for(const s of d.strokes){
      if(s.tool==='stamp'){ const st=makeStamp(s.dataURL, s.x, s.y, s.size, undefined, s.ar, s.rot); st.layer=s.layer||layers[0].id; strokes.push(st); }
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
    if(state.glow) return;                           // Glow room: clean black field
    const p = PAPERS.find(x=>x.id===state.paper) || PAPERS[0];
    if(p.pat==='dots') drawGrid(ctx);
    else if(p.pat==='grid') drawGridLines(ctx);
  }

  function render(){
    needsRender = false;
    try { renderInner(); }
    catch(err){ /* never let one bad frame kill the app */ }
  }
  function renderInner(){
    maybeRebase();
    paintPaper();
    if(replay.active){
      if(replay.outro){ drawEndCard(); return; }              // branded closing card (in recordings)
      octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,overCv.width,overCv.height);
      worldTransform(octx);
      if(replay.enhanced) drawSceneTimed(octx, strokes, replay.time);
      else drawScene(octx, strokes, replay.revealed);
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
    if(state.singing) drawSingHead();
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
      else if(s._grow){                               // magic-garden sprout: scale up about the base
        const gp=clamp((performance.now()-s._grow.t0)/s._grow.dur,0,1);
        if(gp>0){ const e=1-Math.pow(1-gp,3);
          target.save(); target.translate(s._grow.ax, s._grow.ay); target.scale(e,e); target.translate(-s._grow.ax,-s._grow.ay);
          drawStroke(target, s, 0, clip); target.restore(); }
      }
      else drawStroke(target, s, revealHere < len ? Math.ceil(revealHere) : 0, clip);
    }
  }

  // Timed replay: reveal each item by its OWN recorded start time + draw duration, so the
  // playback matches when things were actually drawn (used with the recorded camera path).
  function drawSceneTimed(target, list, st){
    const vr=viewRect(), pad=40/cam.scale, clip=clipRect();
    for(const s of list){
      const ts=s._ts!=null?s._ts:0;
      if(st < ts) continue;                              // not drawn yet at this moment
      if(s.bb && (s.bb.maxX<vr.minX-pad || s.bb.minX>vr.maxX+pad || s.bb.maxY<vr.minY-pad || s.bb.minY>vr.maxY+pad)) continue;
      if(s.bb && (s.bb.maxX-s.bb.minX)*cam.scale<0.6 && (s.bb.maxY-s.bb.minY)*cam.scale<0.6) continue;
      const frac=clamp((st-ts)/(s._td||1), 0, 1);
      if(s.tool==='stamp'){ drawStampItem(target, s); }
      else { const len=Math.max(1,s.pts.length); drawStroke(target, s, frac>=1?0:Math.max(1,Math.ceil(frac*len)), clip); }
    }
  }
  // Set the camera to its recorded position at session-time st (linear pos, log-lerp scale).
  function interpCam(st){
    const a=session.cam; if(!a.length) return;
    if(st<=a[0].t){ cam.x=a[0].x; cam.y=a[0].y; cam.scale=a[0].s; updateHud(); return; }
    const last=a[a.length-1];
    if(st>=last.t){ cam.x=last.x; cam.y=last.y; cam.scale=last.s; updateHud(); return; }
    let i=1; while(i<a.length && a[i].t<st) i++;
    const p=a[i-1], q=a[i], f=(st-p.t)/((q.t-p.t)||1);
    cam.x=p.x+(q.x-p.x)*f; cam.y=p.y+(q.y-p.y)*f; cam.scale=p.s*Math.pow(q.s/p.s, f); updateHud();
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
  function drawGridLines(g){
    let step = 34 * cam.scale;
    while(step < 16) step *= 4;
    while(step > 150) step /= 4;
    const ox = ((cam.x*cam.scale)%step+step)%step, oy = ((cam.y*cam.scale)%step+step)%step;
    g.strokeStyle = state.theme==='dark' ? 'rgba(255,255,255,.06)' : 'rgba(60,50,40,.08)';
    g.lineWidth = 1; g.beginPath();
    for(let x=ox; x<innerWidth; x+=step){ g.moveTo(x,0); g.lineTo(x,innerHeight); }
    for(let y=oy; y<innerHeight; y+=step){ g.moveTo(0,y); g.lineTo(innerWidth,y); }
    g.stroke();
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
    if((st && st.neon) || (state.glow && s.tool!=='eraser')){ drawNeon(target, s, runs); return; }
    if(st && st.water){ drawWater(target, s, runs); return; }
    setComposite(target, s.tool);
    target.fillStyle = s.color;
    for(const run of runs){
      if(run.length === 1){ target.beginPath(); target.arc(run[0].x, run[0].y, Math.max(.4/cam.scale,run[0].w/2), 0, 7); target.fill(); }
      else fillRibbon(target, run, 1);
    }
    resetComposite(target);
  }

  // Neon: soft wide glow + brighter core, layered.
  function drawNeon(target, s, runs){
    target.globalCompositeOperation = (state.theme==='dark' || state.glow) ? 'lighter' : 'source-over';
    const passes = [ [2.8, 0.18, s.color], [1.7, 0.35, s.color], [0.75, 1, lighten(s.color)] ];
    for(const [wm, a, col] of passes){
      target.globalAlpha = a; target.fillStyle = col;
      for(const run of runs){
        if(run.length === 1){ target.beginPath(); target.arc(run[0].x, run[0].y, Math.max(.4/cam.scale,run[0].w/2*wm), 0, 7); target.fill(); }
        else fillRibbon(target, run, wm);
      }
    }
    resetComposite(target);
  }

  // Watercolour "living ink": soft translucent bleed — a wide halo fading into a denser
  // core, drawn multiply (screen on dark) so overlapping washes deepen like real paint.
  function drawWater(target, s, runs){
    const dark = state.theme==='dark' || state.glow;
    target.globalCompositeOperation = dark ? 'screen' : 'multiply';
    target.fillStyle = s.color;
    for(const [wm, a] of [[2.7,0.05],[2.0,0.07],[1.4,0.11],[1.0,0.2]]){
      target.globalAlpha = a;
      for(const run of runs){
        if(run.length === 1){ target.beginPath(); target.arc(run[0].x, run[0].y, Math.max(.4/cam.scale, run[0].w/2*wm), 0, 7); target.fill(); }
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
    target.beginPath(); target.arc(pts[0].x, pts[0].y, Math.max(.3/cam.scale,pts[0].w/2*wmul), 0, 7); target.fill();
    const e = pts[pts.length-1]; target.beginPath(); target.arc(e.x, e.y, Math.max(.3/cam.scale,e.w/2*wmul), 0, 7); target.fill();
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
      const len=Math.hypot(dx,dy)||1, nx=-dy/len, ny=dx/len, hw=Math.max(.15/cam.scale,p.w/2*m);
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

  // axis-aligned bounding box of a stamp/image (accounts for aspect ratio + rotation)
  function stampBB(s){
    const hw=s.size/2, hh=(s.size*(s.ar||1))/2, r=s.rot||0, co=Math.abs(Math.cos(r)), si=Math.abs(Math.sin(r));
    const ex=co*hw+si*hh, ey=si*hw+co*hh;
    return { minX:s.x-ex, minY:s.y-ey, maxX:s.x+ex, maxY:s.y+ey };
  }
  function drawStampItem(target, s){
    if(!s._img || !s._img.complete || !s._img.naturalWidth) return;   // wait until decoded
    const w = s.size, h = s.size*(s.ar||1);
    target.globalAlpha = 1; target.globalCompositeOperation='source-over';
    target.imageSmoothingEnabled = true; target.imageSmoothingQuality = 'high';   // stays sharp scaling down, soft (not blocky) past native res
    target.save();
    target.translate(s.x, s.y);
    if(s.rot) target.rotate(s.rot);
    try { target.drawImage(s._img, -w/2, -h/2, w, h); } catch(e){}
    target.restore();
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
    if(document.body.classList.contains('tools-open') || document.body.classList.contains('colors-open')) document.body.classList.remove('tools-open','colors-open');
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
    const col = state.tool==='garden' ? '#4a9d54' : (state.rainbow ? nextRainbow() : state.color);
    // width is stored in WORLD units, so divide the screen-px slider size by the zoom:
    // brushes then paint the SAME on-screen thickness at any zoom (WYSIWYG), and zooming
    // in yields finer world strokes → effectively unlimited detail on the endless canvas.
    live = { tool:state.tool, color:col, size:state.size/cam.scale, layer:activeLayer, pts:[], _t:performance.now() };
    live._startMs = performance.now(); if(session.t0==null) session.t0=live._startMs;
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
        live._ts = live._startMs - session.t0; live._td = Math.max(80, performance.now()-live._startMs);
        noteStroke(live);
        if(live.tool==='garden'){
          const items=growGarden(live); commit(items); animateGarden(items); buzz(12);
          const tip=live.pts[live.pts.length-1]; const sp=worldToScreen(tip.x,tip.y); sparkleBurst(sp.x, sp.y, '#ff6f9c'); critterBurst(sp.x, sp.y);
        } else {
          if(state.shapeSnap && isDrawStyle(live.tool) && live.tool!=='marker'){
            const shaped=recognizeShape(live);
            if(shaped){ live.pts=shaped.pts; live.snapped=true; finalizeBB(live); buzz(10); toast('✦ Snapped to '+shaped.kind);
              const bb=live.bb; if(bb){ const sp=worldToScreen((bb.minX+bb.maxX)/2,(bb.minY+bb.maxY)/2); sparkleBurst(sp.x, sp.y, live.color); } }
          }
          commit(state.sym ? [live, ...symCopies(live)] : [live]);
        }
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

  /* ---------------- Magic garden ----------------
     A stem stroke sprouts leaves along its length and a little flower at the tip.
     Everything is generated as ordinary vector strokes, so it's undoable and stays
     razor-sharp at any zoom, just like hand-drawn ink. */
  function samplePath(pts, f){
    const n=pts.length; if(n<2) return { x:pts[0].x, y:pts[0].y, tx:0, ty:-1 };
    const idx=clamp(f,0,1)*(n-1), i=Math.min(n-2, Math.floor(idx)), t=idx-i;
    const a=pts[i], b=pts[i+1]; let tx=b.x-a.x, ty=b.y-a.y; const L=Math.hypot(tx,ty)||1;
    return { x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, tx:tx/L, ty:ty/L };
  }
  // A palette of living-garden elements. Each helper returns vector stroke items (world
  // coords) — undoable and razor-sharp at any zoom, just like hand-drawn ink.
  const G_FLOWER=['#ff6f9c','#ffd23f','#ff8c42','#9a5bff','#ff5d5d','#4db6ff','#ff7ab0','#f26fb2','#ffb347','#e85d75','#c77dff','#ff9ec7'];
  const G_LEAF=['#3f9d52','#57b46a','#2f8f49','#6cbf6c','#4aa85a'];
  const G_VINE=['#4a9d54','#3f8f49','#57a862'];
  const gpick=a=>a[Math.floor(Math.random()*a.length)];
  const gRnd=()=>Math.random();
  function gI(col,w,pts,snapped){ return { tool:'brush', color:col, size:w, layer:activeLayer, snapped:!!snapped, pts }; }
  function gDot(x,y,r,col){ return gI(col, r, [{x,y,w:r}]); }
  function gLeaf(bx,by,dx,dy,len,col,w){ const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L; const nx=-dy,ny=dx;
    const tx=bx+dx*len, ty=by+dy*len, mx=(bx+tx)/2+nx*len*0.24, my=(by+ty)/2+ny*len*0.24;
    return [ gI(col, w*1.4, [{x:bx,y:by,w:w*0.4},{x:mx,y:my,w:w*1.3},{x:tx,y:ty,w:w*0.16}]) ]; }
  function gFlower(x,y,r,col,n,w){ const out=[];
    for(let p=0;p<n;p++){ const a=p/n*Math.PI*2; out.push(gI(col, w*1.6, [{x,y,w:w*0.6},{x:x+Math.cos(a)*r,y:y+Math.sin(a)*r,w:w*1.7},{x:x+Math.cos(a+0.5)*r*0.5,y:y+Math.sin(a+0.5)*r*0.5,w:w*0.4}])); }
    out.push(gDot(x,y,w*2.1,'#ffd23f')); return out; }
  function gTulip(x,y,s,col,w){ return [
    gI(col,w*1.8,[{x:x-s*0.42,y:y,w:w*0.5},{x:x-s*0.2,y:y-s,w:w*1.6},{x:x-s*0.05,y:y-s*0.3,w:w*0.5}]),
    gI(col,w*1.8,[{x,y:y+s*0.1,w:w*0.5},{x,y:y-s*1.15,w:w*1.6},{x,y:y-s*0.3,w:w*0.5}]),
    gI(col,w*1.8,[{x:x+s*0.42,y:y,w:w*0.5},{x:x+s*0.2,y:y-s,w:w*1.6},{x:x+s*0.05,y:y-s*0.3,w:w*0.5}]) ]; }
  function gBlossom(x,y,r,col){ const out=[]; for(let p=0;p<5;p++){ const a=p/5*Math.PI*2; out.push(gDot(x+Math.cos(a)*r*0.7, y+Math.sin(a)*r*0.7, r, col)); } out.push(gDot(x,y,r*0.8,'#fff3b0')); return out; }
  function gGrass(x,y,size){ const out=[], n=3+Math.floor(gRnd()*3), col=gpick(G_VINE);
    for(let i=0;i<n;i++){ const off=(i-(n-1)/2)*size*0.22, sway=(gRnd()-0.5)*size*0.45;
      out.push(gI(col, size*0.14, [{x:x+off,y:y,w:size*0.18},{x:x+off+sway,y:y-size,w:size*0.02}])); } return out; }
  function gFern(x,y,dx,dy,len,w){ const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L; const nx=-dy,ny=dx, col=gpick(G_LEAF), out=[];
    out.push(gI(col,w, [{x,y,w:w*0.5},{x:x+dx*len,y:y+dy*len,w:w*0.12}]));
    for(let i=1;i<=4;i++){ const f=i/5, px=x+dx*len*f, py=y+dy*len*f, ll=len*0.3*(1-f*0.5);
      for(const s of [1,-1]) out.push(gI(col,w*0.8,[{x:px,y:py,w:w*0.4},{x:px+(nx*s*0.8+dx*0.4)*ll,y:py+(ny*s*0.8+dy*0.4)*ll,w:w*0.08}])); } return out; }
  function gVineCurl(x,y,size,dir,col,w){ const pts=[];
    for(let i=0;i<=18;i++){ const t=i/18, a=t*Math.PI*3.2*dir, r=size*0.5*t; pts.push({x:x+Math.cos(a)*r, y:y-size*t+Math.sin(a)*r, w:w*(1-t*0.6)}); }
    return [ gI(col,w,pts) ]; }
  function gMushroom(x,y,size){ const cap=gpick(['#e0503a','#d94f4f','#ff8c42','#c77dff']);
    return [ gI('#f2ead6', size*0.5, [{x,y,w:size*0.5},{x,y:y-size,w:size*0.5}]),
      gI(cap, size*0.7, [{x:x-size*0.9,y:y-size,w:size*0.25},{x,y:y-size-size*0.5,w:size*1.5},{x:x+size*0.9,y:y-size,w:size*0.25}], true),
      gDot(x-size*0.35,y-size-size*0.28,size*0.18,'#fff'), gDot(x+size*0.28,y-size-size*0.36,size*0.15,'#fff') ]; }
  function gRock(x,y,size){ const col=gpick(['#9a958c','#847f76','#a8a29a']);
    return [ gI(col, size, [{x:x-size*0.55,y:y,w:size*0.6},{x,y:y-size*0.42,w:size*1.15},{x:x+size*0.55,y:y,w:size*0.6}], true) ]; }
  function gTree(x,y,w){ const out=[], trunk='#8d5a3c', h=w*9, top={x, y:y-h}, canopy=gpick(['#57b46a','#7ec87e','#9ad49a','#6cbf6c']);
    out.push(gI(trunk, w*1.7, [{x,y,w:w*2},{x:x+w*0.6,y:y-h*0.55,w:w*1.2},{x,y:y-h,w:w*0.7}]));   // one clean curved trunk (no stray branches)
    for(let i=0;i<7;i++){ const a=i/7*Math.PI*2, r=h*0.3; out.push(gDot(top.x+Math.cos(a)*r, top.y+Math.sin(a)*r*0.85, w*4.2, canopy)); }
    out.push(gDot(top.x,top.y,w*5.4,canopy));
    for(let i=0;i<4;i++) out.push(gDot(top.x+(gRnd()-0.5)*h*0.5, top.y+(gRnd()-0.5)*h*0.4, w*1.6, gpick(G_FLOWER)));
    return out; }

  // Every garden stroke grows a different living scene — leaves, vines, ferns, grass,
  // blossoms, mushrooms, rocks and a flower or tree, sprinkled at random along the stem.
  function growGarden(stem){
    const pts=stem.pts, items=[stem];
    if(pts.length<2) return items;
    let total=0; for(let i=1;i<pts.length;i++) total+=Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    const w=stem.size||6/cam.scale;
    stem.color=gpick(G_VINE);
    const tip=pts[pts.length-1], base=pts[0];
    if(total < w*4){ items.push(...gGrass(tip.x,tip.y,w*4)); if(gRnd()<0.5) items.push(...gBlossom(tip.x,tip.y-w*3,w*1.4,gpick(G_FLOWER))); return items; }
    const el=Math.max(w*6, total*0.14);
    const n=clamp(Math.floor(total/(w*8)), 2, 11);
    for(let k=1;k<=n;k++){
      const f=k/(n+1), P=samplePath(pts,f), side=(k%2?1:-1);
      const nx=-P.ty*side, ny=P.tx*side, roll=gRnd();
      if(roll<0.44) items.push(...gLeaf(P.x,P.y, nx*0.85+P.tx*0.4, ny*0.85+P.ty*0.4, el, gpick(G_LEAF), w*1.4));
      else if(roll<0.60) items.push(...gGrass(P.x,P.y,el*0.9));
      else if(roll<0.72) items.push(...gVineCurl(P.x,P.y,el*0.8,side,gpick(G_VINE),w));
      else if(roll<0.84) items.push(...gBlossom(P.x+nx*el*0.5, P.y+ny*el*0.5, w*2.4, gpick(G_FLOWER)));
      else items.push(...gFern(P.x,P.y, nx*0.8+P.tx*0.3, ny*0.8+P.ty*0.3, el, w));
    }
    items.push(...gGrass(base.x,base.y,el));
    if(gRnd()<0.45) items.push(...gMushroom(base.x+(gRnd()-0.5)*el, base.y, w*2.4));
    if(gRnd()<0.4)  items.push(...gRock(base.x-(gRnd()-0.5)*el, base.y, w*2.2));
    const feat=gRnd();
    if(total > w*20 && feat<0.32) items.push(...gTree(tip.x,tip.y,w));
    else if(feat<0.68) items.push(...gFlower(tip.x,tip.y, Math.max(w*3.2,el*0.55), gpick(G_FLOWER), 5+Math.floor(gRnd()*4), w));
    else items.push(...gTulip(tip.x,tip.y, el*0.9, gpick(G_FLOWER), w));
    return items;
  }
  // gentle drifting critters (butterfly/bee/bird/petal) rise from a finished plant
  function critterBurst(sx, sy){
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const kinds=['🦋','🐝','🐞','🐦','🌸'], n=1+Math.floor(Math.random()*2);
    for(let i=0;i<n;i++){ const el=document.createElement('span'); el.className='critter'; el.textContent=kinds[Math.floor(Math.random()*kinds.length)];
      el.style.left=sx+'px'; el.style.top=sy+'px';
      const ang=-Math.PI/2+(Math.random()-0.5)*1.3, dist=55+Math.random()*80;
      el.style.setProperty('--cx',(Math.cos(ang)*dist).toFixed(0)+'px');
      el.style.setProperty('--cy',(Math.sin(ang)*dist-24).toFixed(0)+'px');
      el.style.animationDelay=(i*0.12)+'s';
      document.body.appendChild(el); setTimeout(()=>el.remove(), 2400); }
    // soft glowing fireflies drift out — the magical atmosphere
    const f=2+Math.floor(Math.random()*2);
    for(let i=0;i<f;i++){ const el=document.createElement('span'); el.className='firefly';
      el.style.left=sx+'px'; el.style.top=sy+'px';
      const ang=Math.random()*Math.PI*2, dist=40+Math.random()*90;
      el.style.setProperty('--fx',(Math.cos(ang)*dist).toFixed(0)+'px');
      el.style.setProperty('--fy',(Math.sin(ang)*dist-40).toFixed(0)+'px');
      el.style.animationDelay=(Math.random()*0.5).toFixed(2)+'s';
      document.body.appendChild(el); setTimeout(()=>el.remove(), 4400); }
  }

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
      if(s.tool==='stamp'){ s.x+=dx; s.y+=dy; s.bb=stampBB(s); }
      else { for(const p of s.pts){ p.x+=dx; p.y+=dy; } finalizeBB(s); }
      gridAdd(s);
    }
  }
  function commit(items){
    const now=performance.now(); if(session.t0==null) session.t0=now;
    for(const it of items){ if(it._ts==null){ it._ts=now-session.t0; it._td=it._td||120; } }
    addItems(items); pushOp({type:'add', items}); invalidate(); saveSoon();
  }
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
    if(s.tool==='stamp'){ const c=apply(s.x,s.y), e=apply(s.x+1,s.y); const dx=e.x-c.x, dy=e.y-c.y;
      s.x=c.x; s.y=c.y; s.size=Math.max(2, s.size*(Math.hypot(dx,dy)||1)); s.rot=(s.rot||0)+Math.atan2(dy,dx); s.bb=stampBB(s); }
    else { for(const p of s.pts){ const r=apply(p.x,p.y); p.x=r.x; p.y=r.y; p.w*=r.sc; } finalizeBB(s); }
    gridAdd(s);
  }
  function applyMatrixToItems(items, m){ const sc=matScaleOf(m);
    for(const s of items) xformOne(s, (x,y)=>({ x:m.a*x+m.c*y+m.e, y:m.b*x+m.d*y+m.f, sc })); }
  function snapshotSelection(){ return [...selection].map(s=>({ item:s, x:s.x, y:s.y, size:s.size, rot:s.rot||0, pts: s.pts?s.pts.map(p=>({x:p.x,y:p.y,w:p.w})):null })); }
  function applySnapshot(list, m){ const sc=matScaleOf(m), dr=Math.atan2(m.b, m.a);
    for(const snap of list){ const s=snap.item; gridRemove(s);
      if(s.tool==='stamp'){ s.x=m.a*snap.x+m.c*snap.y+m.e; s.y=m.b*snap.x+m.d*snap.y+m.f; s.size=Math.max(2, snap.size*sc);
        s.rot=snap.rot+dr; s.bb=stampBB(s); }
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
    if(cam.scale > (stats.zoom||1)) stats.zoom = cam.scale;   // tracked for the "deep diver" badge (saved on next stroke)
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

  // Floating origin: when the camera drifts far enough that float64 precision could
  // degrade (scale*|cam| large), shift ALL world coordinates by +cam and reset cam to 0.
  // The rendered image is unchanged, but coordinates stay small → crisp at any zoom, forever.
  // Only runs when fully idle, so it never desyncs a live stroke, gesture or animation.
  function maybeRebase(){
    if(live || sel || pinch || panLast || inertiaRAF || camAnim || replay.active) return;
    if(cam.scale * Math.max(Math.abs(cam.x), Math.abs(cam.y)) < REBASE_BUDGET) return;
    const dx = cam.x, dy = cam.y;
    for(const s of strokes){
      if(s.tool==='stamp'){ s.x+=dx; s.y+=dy; s.bb=stampBB(s); }
      else { for(const p of s.pts){ p.x+=dx; p.y+=dy; }
             if(s.bb){ s.bb.minX+=dx; s.bb.maxX+=dx; s.bb.minY+=dy; s.bb.maxY+=dy; } }
    }
    // transform ops carry an absolute matrix — conjugate its translation by the shift.
    // (move ops store deltas → translation-invariant; add/delete reference shifted objects.)
    for(const stack of [undoStack, redoStack]) for(const op of stack){
      if(op.type==='transform' && op.m){ const m=op.m;
        m.e += dx - (m.a*dx + m.c*dy);
        m.f += dy - (m.b*dx + m.d*dy);
      }
    }
    cam.x = 0; cam.y = 0;
    session.ok = false; session.cam.length = 0;   // world coords shifted — the recorded camera path no longer maps; fall back to auto-follow replay
    gridRebuild(); invalidate();
  }

  /* ---------------- UI: swatches / tools / size ---------------- */
  const sw = document.getElementById('swatches');
  const swatchEls = [];
  function setColor(c, el){ state.color=c; state.rainbow=false;
    if(!isDrawStyle(state.tool)) selectTool(lastBrushStyle);
    sw.querySelectorAll('.swatch').forEach(n=>n.classList.remove('active'));
    const match = el || sw.querySelector('.swatch[data-c="'+(c||'').toLowerCase()+'"]');
    if(match) match.classList.add('active'); updateBrushDot(); }
  // palette swatches live in their own wrapper so the palette can be swapped
  const paletteWrap=document.createElement('span'); paletteWrap.style.display='contents'; sw.appendChild(paletteWrap);
  function renderPalette(){ paletteWrap.innerHTML='';
    activePalette.forEach((s)=>{ const el=document.createElement('button'); el.className='swatch'; el.type='button';
      el.dataset.c=s.c.toLowerCase(); el.style.background=s.c; el.title=s.n; el.setAttribute('aria-label', s.n);
      if(s.c.toLowerCase()==='#ffffff') el.style.boxShadow='inset 0 0 0 1px rgba(0,0,0,.25)';
      el.addEventListener('click',()=>{ setColor(s.c, el); buzz(6); });
      paletteWrap.appendChild(el); });
    const m=sw.querySelector('.swatch[data-c="'+(state.color||'').toLowerCase()+'"]'); if(m) m.classList.add('active'); }
  renderPalette();
  // rainbow / magic swatch
  const rainbowEl=document.createElement('button'); rainbowEl.type='button'; rainbowEl.className='swatch rainbow'; rainbowEl.title='Rainbow (magic)'; rainbowEl.setAttribute('aria-label','Rainbow magic colour');
  rainbowEl.addEventListener('click',()=>{ state.rainbow=true;
    if(!isDrawStyle(state.tool)) selectTool(lastBrushStyle);
    sw.querySelectorAll('.swatch').forEach(n=>n.classList.remove('active')); rainbowEl.classList.add('active'); updateBrushDot(); buzz(6); toast('🌈 Rainbow! Every line a new colour'); });
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
    if(activePalette.some(p=>p.c.toLowerCase()===c)) return;
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

  const brushBtn = document.getElementById('brushBtn'), brushDot = brushBtn.querySelector('.brush-dot');

  // one-pill toolbar: pop-up tool tray + colour tray
  const toolBtn=document.getElementById('toolBtn'), toolIco=toolBtn.querySelector('.tb-ico');
  const colorBtn=document.getElementById('colorBtn');
  const toolTray=document.getElementById('toolTray'), colorTray=document.getElementById('colorTray');
  function setTray(name, open){
    if(open) document.body.classList.remove((name==='tools'?'colors':'tools')+'-open');
    document.body.classList.toggle(name+'-open', open);
    toolBtn.setAttribute('aria-expanded', document.body.classList.contains('tools-open')?'true':'false');
    colorBtn.setAttribute('aria-expanded', document.body.classList.contains('colors-open')?'true':'false');
  }
  toolBtn.addEventListener('click', e=>{ e.stopPropagation(); setTray('tools', !document.body.classList.contains('tools-open')); buzz(6); });
  colorBtn.addEventListener('click', e=>{ e.stopPropagation(); setTray('colors', !document.body.classList.contains('colors-open')); buzz(6); });
  document.addEventListener('click', e=>{
    if(document.body.classList.contains('tools-open') && !toolTray.contains(e.target) && !toolBtn.contains(e.target)) setTray('tools', false);
    if(document.body.classList.contains('colors-open') && !colorTray.contains(e.target) && !colorBtn.contains(e.target)) setTray('colors', false);
  });

  // favourite colours inline on the bar (first 4 of the active palette)
  const favWrap=document.getElementById('favColors'); const favEls=[];
  function renderFavs(){ favWrap.innerHTML=''; favEls.length=0;
    activePalette.slice(0,4).forEach((s)=>{ const el=document.createElement('button'); el.type='button'; el.className='favdot'; el.style.background=s.c; el.title=s.n; el.setAttribute('aria-label', s.n);
      if(s.c.toLowerCase()==='#ffffff') el.style.boxShadow='inset 0 0 0 1px rgba(0,0,0,.25)';
      el.addEventListener('click',()=>{ setColor(s.c); buzz(6); }); favWrap.appendChild(el); favEls.push({el, c:s.c.toLowerCase()}); });
    updateFav(); }
  function updateFav(){ favEls.forEach(f=>f.el.classList.toggle('on', !state.rainbow && (state.color||'').toLowerCase()===f.c)); }
  renderFavs();
  // colour-palette switcher + paper picker (top of the colour tray)
  function setPalette(name){ if(!PALETTES[name]) name='Classic'; state.palette=name; activePalette=PALETTES[name];
    renderPalette(); renderFavs(); document.querySelectorAll('.palchip').forEach(c=>c.classList.toggle('on', c.dataset.pal===name)); updateBrushDot(); saveSoon(); }
  function setPaper(id){ if(!PAPERS.some(p=>p.id===id)) id='dots'; state.paper=id;
    document.querySelectorAll('.papertile').forEach(t=>t.classList.toggle('on', t.dataset.paper===id)); invalidate(); saveSoon(); }
  // App accent — recolours every UI element (they all use var(--accent)) + the tab icon
  function faviconURL(hex){
    const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#141419"/>'
      +'<path d="M300 150 a120 120 0 1 0 78 96" fill="none" stroke="'+hex+'" stroke-width="34" stroke-linecap="round" transform="rotate(18 256 256)"/>'
      +'<path d="M356 220 q26 24 20 60" fill="none" stroke="'+hex+'" stroke-width="16" stroke-linecap="round"/></svg>';
    return 'data:image/svg+xml,'+encodeURIComponent(svg);
  }
  function setAccent(id){
    const a=accentById(id); state.accent=a.id;
    const r=document.documentElement.style; r.setProperty('--accent', a.c); r.setProperty('--accent-2', a.c2);
    const fav=document.querySelector('link[rel="icon"]'); if(fav) fav.href=faviconURL(a.c);
    document.querySelectorAll('.accdot').forEach(d=>d.classList.toggle('on', d.dataset.acc===a.id));
    saveSoon();
  }
  // Glow room — lights-off mode: black field, every stroke glows (routes through the neon engine)
  function toggleGlow(force){ const on = force!==undefined ? force : !state.glow; state.glow=on;
    document.body.classList.toggle('glowroom', on);
    toast(on ? '🌟 Glow room — lights off. Try bright colours!' : 'Glow room off');
    invalidate(); saveSoon(); buzz(8); }
  (function buildPickers(){
    const tray=document.getElementById('colorTray');
    const accRow=document.createElement('div'); accRow.id='accentRow'; accRow.setAttribute('aria-label','App colour');
    ACCENTS.forEach(a=>{ const b=document.createElement('button'); b.type='button'; b.className='accdot'; b.dataset.acc=a.id;
      b.title='App colour: '+a.name; b.setAttribute('aria-label','App colour '+a.name); b.style.background=a.c;
      b.addEventListener('click',()=>{ setAccent(a.id); buzz(6); toast('App colour: '+a.name); }); accRow.appendChild(b); });
    const palRow=document.createElement('div'); palRow.id='paletteRow';
    Object.keys(PALETTES).forEach(name=>{ const c=document.createElement('button'); c.type='button'; c.className='palchip'; c.dataset.pal=name; c.textContent=name;
      c.addEventListener('click',()=>{ setPalette(name); buzz(6); }); palRow.appendChild(c); });
    const paperRow=document.createElement('div'); paperRow.id='paperRow';
    PAPERS.forEach(p=>{ const t=document.createElement('button'); t.type='button'; t.className='papertile'; t.dataset.paper=p.id; t.title=p.label; t.setAttribute('aria-label','Paper: '+p.label);
      t.style.background=p.bg;
      if(p.pat==='dots'){ t.style.backgroundImage='radial-gradient(#c9c4b6 1.4px,transparent 1.4px)'; t.style.backgroundSize='9px 9px'; }
      if(p.pat==='grid'){ t.style.backgroundImage='linear-gradient(#d8d3c4 1px,transparent 1px),linear-gradient(90deg,#d8d3c4 1px,transparent 1px)'; t.style.backgroundSize='10px 10px'; }
      t.addEventListener('click',()=>{ setPaper(p.id); buzz(6); }); paperRow.appendChild(t); });
    tray.insertBefore(paperRow, tray.firstChild);
    tray.insertBefore(palRow, tray.firstChild);
    tray.insertBefore(accRow, tray.firstChild);
  })();
  // sparkle burst — fired on shape-snap and sticker placement
  function sparkleBurst(sx, sy, color){
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const chars=['✦','✧','⋆','✦','✧','·','✦'];
    for(let i=0;i<7;i++){ const el=document.createElement('span'); el.className='sparkle'; el.textContent=chars[i];
      const ang=(i/7)*Math.PI*2 + i*0.6, dist=20+(i%3)*11;
      el.style.left=sx+'px'; el.style.top=sy+'px'; if(color) el.style.color=color;
      el.style.setProperty('--tx', (Math.cos(ang)*dist).toFixed(1)+'px');
      el.style.setProperty('--ty', (Math.sin(ang)*dist).toFixed(1)+'px');
      el.style.animationDelay=(i*0.02)+'s';
      document.body.appendChild(el); setTimeout(()=>el.remove(), 900); }
  }

  function updateOrb(){
    const el = isDrawStyle(state.tool) ? brushBtn : document.querySelector('.tool[data-tool="'+state.tool+'"]');
    if(el){ const svg=el.querySelector('svg'); if(svg && toolIco) toolIco.innerHTML = svg.outerHTML; }
  }
  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.addEventListener('click',()=>{ selectTool(b.dataset.tool); setTray('tools', false); buzz(6); }));
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
    if(brushDot) brushDot.style.background = bg; if(colorBtn) colorBtn.style.background = bg; updateFav(); }

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
  brushBtn.addEventListener('click',()=>{ if(isDrawStyle(state.tool)) openBrushPicker(); else selectTool(lastBrushStyle); setTray('tools', false); buzz(6); });
  document.getElementById('brushClose').addEventListener('click',()=>brushModal.classList.add('hidden'));
  const sizeRange=document.getElementById('sizeRange');
  sizeRange.addEventListener('input',()=>{ state.size=+sizeRange.value; });
  document.getElementById('undo').addEventListener('click', ()=>{ undo(); buzz(6); });
  document.getElementById('redo').addEventListener('click', ()=>{ redo(); buzz(6); });
  { const sb=document.getElementById('shareBtn'); if(sb) sb.addEventListener('click', ()=>{ shareImage(); buzz(8); }); }

  const symBtn=document.getElementById('symBtn');
  symBtn.addEventListener('click',()=>{ state.sym=!state.sym; symBtn.classList.toggle('on',state.sym); symBtn.setAttribute('aria-pressed',state.sym?'true':'false');
    toast(state.sym?`✨ Mandala on · ${state.axes} axes`:'Mandala off'); buzz(6); requestRender(); });

  const zenBtn=document.getElementById('zenBtn'); if(zenBtn) zenBtn.addEventListener('click', ()=>toggleZen());
  function toggleZen(force){ const on = force!==undefined ? force : !document.body.classList.contains('zen');
    document.body.classList.toggle('zen', on); if(on) pushGuard(); }

  { const h=document.getElementById('hud'); if(h) h.addEventListener('click', ()=>{ zoomToFit(); }); }
  function clearAll(){
    if(!strokes.length) return;                           // already empty → do nothing, silently
    playClearAnim();                                      // snapshot the drawing + toss it away
    const items = strokes.slice();
    removeItems(items); pushOp({type:'delete', items});   // undoable via the undo button — no dialog, no message
    selection.clear(); sel=null; updateSelBar();
    invalidate(); saveSoon(); buzz(14);
  }
  // playful "whoosh into the trash": the drawing squashes, then shrinks and flies into the
  // trash button (which wiggles), revealing the fresh blank canvas. GPU-friendly CSS on a snapshot.
  function playClearAnim(){
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let url; try{ url=canvas.toDataURL('image/png'); }catch(e){ return; }
    const img=document.createElement('img'); img.className='clear-anim'; img.src=url; img.alt='';
    const btn=document.getElementById('clearBtn');
    if(btn){
      const r=btn.getBoundingClientRect(), tx=r.left+r.width/2, ty=r.top+r.height/2;
      img.style.setProperty('--clx', Math.round(tx - innerWidth/2)+'px');
      img.style.setProperty('--cly', Math.round(ty - innerHeight/2)+'px');
      btn.classList.add('clearwig'); setTimeout(()=>btn.classList.remove('clearwig'), 560);
      setTimeout(()=>{ try{ sparkleBurst(tx, ty); }catch(e){} buzz(8); }, 430);   // poof as it lands in the bin
    }
    document.body.appendChild(img);
    const done=()=>{ if(img.parentNode) img.remove(); };
    img.addEventListener('animationend', done); setTimeout(done, 900);
  }
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
    else if(a==='theme'){ state.theme=state.theme==='dark'?'light':'dark'; invalidate(); saveSoon(); toast(state.theme==='dark'?'Dark mode':'Light mode'); }
    else if(a==='shapesnap'){ state.shapeSnap=!state.shapeSnap; toast(state.shapeSnap?'✦ Shape snap ON — draw a circle, box, line…':'Shape snap off'); saveSoon(); }
    else if(a==='symaxes') cycleAxes();
    else if(a==='png') exportPNG();
    else if(a==='svg') exportSVG();
    else if(a==='savefile') exportDoc();
    else if(a==='openfile') importDoc();
    else if(a==='share') shareImage();
    else if(a==='photo'){ if(photoInput) photoInput.click(); }
    else if(a==='replay') startReplay();
    else if(a==='seal') openSeal();
    else if(a==='sticker') openStickers();
    else if(a==='intro') showIntro();
    else if(a==='install') doInstall();
    else if(a==='layers') openLayers();
    else if(a==='glow') toggleGlow();
    else if(a==='garden'){ selectTool('garden'); toast('🌱 Draw a stem — watch it grow!'); }
    else if(a==='sing') startSing();
    else if(a==='gallery') openGallery();
    else if(a==='music') openMusic();
    else if(a==='inspire') inspireMe();
    else if(a==='presets') openPresets();
    else if(a==='badges') openBadges();
    else if(a==='tour') startTour();
    else if(a==='a11y') openA11y();
    else if(a==='credits') openCredits();
    else if(a==='privacy') window.open('privacy.html','_blank','noopener');
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
    redoStack.length=0; commit([st]); clearPendingStamp(); buzz(14); sparkleBurst(sx, sy); requestRender();
  }
  function makeStamp(dataURL, x, y, size, img, ar, rot){
    const st={ tool:'stamp', dataURL, x, y, size, ar:ar||1, rot:rot||0, layer:activeLayer };
    st.bb=stampBB(st);
    st._img = img || (()=>{ const im=new Image(); im.onload=()=>{ invalidate(); }; im.src=dataURL; return im; })();
    return st;
  }
  function emojiDataURL(em){
    // render large so stickers stay sharp when the canvas is zoomed in
    const S=256, c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d');
    x.textAlign='center'; x.textBaseline='middle'; x.font='200px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif';
    x.fillText(em, S/2, S/2+10); return c.toDataURL('image/png');
  }

  /* ---------------- photos / images / artwork ---------------- */
  const photoInput = document.getElementById('photoInput');
  if(photoInput) photoInput.addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0]; if(f) addPhotoFromFile(f); e.target.value=''; });
  function addPhotoFromFile(file){
    if(!file || !/^image\//.test(file.type||'')){ toast('Please pick an image'); return; }
    toast('Adding photo…');
    const reader=new FileReader();
    reader.onerror=()=>toast('Could not read that file');
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>toast('Could not load that image');
      img.onload=()=>{
        // downscale to a sane max so it stays sharp but doesn't blow local storage
        const MAX=2048; let w=img.naturalWidth||1, h=img.naturalHeight||1;
        const dsc=Math.min(1, MAX/Math.max(w,h)); const cw=Math.max(1,Math.round(w*dsc)), ch=Math.max(1,Math.round(h*dsc));
        const c=document.createElement('canvas'); c.width=cw; c.height=ch;
        const cx=c.getContext('2d'); cx.imageSmoothingQuality='high'; cx.drawImage(img,0,0,cw,ch);
        // JPEG keeps photos small; PNG preserves transparency for smaller/graphic art
        const usePng = (w*h <= 700*700) || /png|gif|webp|svg/.test(file.type);
        const dataURL = c.toDataURL(usePng?'image/png':'image/jpeg', 0.86);
        placeImage(dataURL, ch/cw);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  }
  function placeImage(dataURL, ar){
    const ctr=toWorld(innerWidth/2, innerHeight/2);
    const size=(0.6*Math.min(innerWidth, innerHeight))/cam.scale;   // ~60% of the screen, in world units
    const pre=new Image();
    pre.onload=()=>{
      const st=makeStamp(dataURL, ctr.x, ctr.y, size, pre, ar, 0);
      redoStack.length=0; commit([st]);
      selectTool('select'); selection=new Set([st]); updateSelBar();
      invalidate(); requestRender(); buzz(14); toast('🖼️ Added — drag to move · corners resize · top handle rotates');
    };
    pre.onerror=()=>toast('Could not place that image');
    pre.src=dataURL;
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
  const easeInOut = t => (1 - Math.cos(Math.PI * clamp(t,0,1))) / 2;   // easeInOutSine — gentle start & finish
  // bounding box of the strokes/points revealed so far (uses stroke bbs + the one partial stroke)
  function revealedBounds(upTo){
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity,count=0,found=false;
    for(const s of strokes){
      const len = s.tool==='stamp' ? 1 : Math.max(1, s.pts?s.pts.length:1);
      if(count+len<=upTo){
        if(s.bb){ a=Math.min(a,s.bb.minX);b=Math.min(b,s.bb.minY);c=Math.max(c,s.bb.maxX);d=Math.max(d,s.bb.maxY);found=true; }
        count+=len;
      } else {
        const rem=Math.max(1, Math.ceil(upTo-count));
        if(s.pts){ for(let i=0;i<Math.min(rem,s.pts.length);i++){ const p=s.pts[i]; a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y);found=true; } }
        else if(s.bb){ a=Math.min(a,s.bb.minX);b=Math.min(b,s.bb.minY);c=Math.max(c,s.bb.maxX);d=Math.max(d,s.bb.maxY);found=true; }
        break;
      }
    }
    return found ? {minX:a,minY:b,maxX:c,maxY:d} : null;
  }
  // camera that frames what's revealed so far → starts tight on the first marks, eases out to the whole piece
  function replayCamTarget(revealed){
    const bb=revealedBounds(Math.max(1,revealed)); if(!bb) return null;
    const w=Math.max(bb.maxX-bb.minX, 24), h=Math.max(bb.maxY-bb.minY, 24);
    let s=clamp(Math.min(innerWidth/(w*1.6), innerHeight/(h*1.6)), MIN_SCALE, 4);
    const cx=(bb.minX+bb.maxX)/2, cy=(bb.minY+bb.maxY)/2;
    return { scale:s, x: innerWidth/(2*s)-cx, y: innerHeight/(2*s)-cy };
  }
  function drawEndCard(){
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle=paperColor(); ctx.fillRect(0,0,innerWidth,innerHeight);
    const dark = state.theme==='dark';
    const cx=innerWidth/2, cy=innerHeight/2 - Math.min(innerWidth,innerHeight)*0.06, R=Math.min(innerWidth,innerHeight)*0.13;
    ctx.strokeStyle='#e0503a'; ctx.lineWidth=Math.max(6,R*0.15); ctx.lineCap='round';
    ctx.beginPath(); ctx.arc(cx,cy,R, Math.PI*0.16, Math.PI*1.96); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle=dark?'#f4f1ee':'#26262e'; ctx.font='600 '+Math.round(R*0.52)+'px "Fredoka",system-ui,sans-serif';
    ctx.fillText('Ensō 円相', cx, cy+R+Math.round(R*0.62));
    ctx.fillStyle=dark?'#a6a6b2':'#8a877e'; ctx.font='500 '+Math.round(R*0.24)+'px system-ui,sans-serif';
    ctx.fillText('techtimerdubai.github.io/Enso', cx, cy+R+Math.round(R*1.05));
  }
  function startReplay(){
    if(!strokes.length){ toast('Draw something first ✍️'); return; }
    const timed = session.ok && session.cam.length>1 && strokes.some(s=>s._ts!=null);
    replay.enhanced=timed;
    replay.total=totalUnits(); replay.elapsed=0; replay.revealed=0; replay.time=0; replay.active=true; replay.playing=true; replay.last=performance.now();
    if(timed){ let T=0; for(const s of strokes){ if(s._ts!=null) T=Math.max(T, s._ts+(s._td||0)); }
      T=Math.max(T, session.cam[session.cam.length-1].t)+300; replay.T=T; replay.dur=clamp(T/1000, 3, 22); }
    else replay.dur=clamp(replay.total/150, 3, 14);
    replay.outro=0;
    replay.savedCam={ x:cam.x, y:cam.y, scale:cam.scale };   // restore the view on exit
    if(timed) interpCam(0); else { const t0=replayCamTarget(1); if(t0) Object.assign(cam, t0); }   // open on the first recorded frame
    replayBar.classList.remove('hidden'); rToggle.textContent='⏸'; toggleZen(true); pushGuard();
    if(state.music) musicPlaySelection();
    cancelAnimationFrame(replay.raf); loopReplay();
  }
  function loopReplay(){
    const now=performance.now(), durMs=replay.dur*1000;
    if(replay.playing){
      replay.elapsed = Math.min(durMs, replay.elapsed + (now-replay.last));
      if(replay.elapsed>=durMs){ replay.playing=false; rToggle.textContent='↺';
        if(replay.rec && !replay.outro) replay.outro=now;      // any recording → play the branded outro
        else if(!replay.rec) {}                                 // plain viewing → just rest on the finished art
      }
    }
    replay.last=now;
    if(replay.outro){
      if(now-replay.outro >= 1100){ replay.outro=0; stopRecording(); }
    } else {
      const t = durMs ? replay.elapsed/durMs : 1;
      if(replay.enhanced){
        replay.time = t*replay.T;                            // reproduce the real session: exact camera path + real stroke timing
        interpCam(replay.time);
      } else {
        replay.revealed = easeInOut(t) * replay.total;       // eased reveal → flows naturally
        const tg=replayCamTarget(replay.revealed);           // cinematic auto-follow camera (fallback)
        if(tg){ const k=0.10; cam.scale+=(tg.scale-cam.scale)*k; cam.x+=(tg.x-cam.x)*k; cam.y+=(tg.y-cam.y)*k; }
      }
      rSeek.value = Math.round(t*1000)||0;
      rSeek.style.setProperty('--rp', Math.round(t*100)+'%');
    }
    render();
    if(replay.active) replay.raf=requestAnimationFrame(loopReplay);
  }
  rToggle.addEventListener('click',()=>{ if(replay.elapsed>=replay.dur*1000) replay.elapsed=0;
    replay.playing=!replay.playing; replay.last=performance.now(); rToggle.textContent=replay.playing?'⏸':'▶'; });
  rSeek.addEventListener('input',()=>{ replay.playing=false; rToggle.textContent='▶'; replay.elapsed=(+rSeek.value/1000)*replay.dur*1000; replay.last=performance.now(); });
  document.getElementById('replayExit').addEventListener('click', exitReplay);
  function exitReplay(){ replay.active=false; replay.playing=false; replay.outro=0; cancelAnimationFrame(replay.raf);
    musicStop();
    if(replay.rec) stopRecording();
    if(replay.savedCam){ Object.assign(cam, replay.savedCam); replay.savedCam=null; }   // restore the pre-replay view
    if(music.chip) musicPlaySelection();                                                // resume the drawing soundtrack
    replayBar.classList.add('hidden'); document.body.classList.remove('zen'); invalidate(); }

  rRec.addEventListener('click',()=>{ replay.rec ? stopRecording() : startRecording(false); });
  const rShare=document.getElementById('replayShare');
  if(rShare) rShare.addEventListener('click',()=>{ if(replay.rec){ stopRecording(); return; } startRecording(true); });
  function startRecording(share){
    if(!canvas.captureStream || typeof MediaRecorder==='undefined'){ toast('Recording not supported on this browser'); return; }
    try{
      const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const stream=canvas.captureStream(30); replay.chunks=[]; replay.stream=stream; replay.shareMode=!!share;
      if(state.music){ try{ musicPlaySelection(); const at=musicTrack(); if(at) stream.addTrack(at); }catch(e){} }   // mix the soundtrack into the video
      replay.rec=new MediaRecorder(stream,{ mimeType:type, videoBitsPerSecond:8_000_000 });
      replay.rec.ondataavailable=e=>{ if(e.data.size) replay.chunks.push(e.data); };
      replay.rec.onstop=()=>{ const blob=new Blob(replay.chunks,{type:'video/webm'}); const wasShare=replay.shareMode;
        try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){} replay.rec=null; replay.stream=null; replay.shareMode=false;
        rRec.classList.remove('recording'); rRec.textContent='● REC';
        if(wasShare) shareReplayBlob(blob); else { downloadBlob(blob,'enso-'+stamp()+'.webm'); toast('Video saved 🎬'); } };
      replay.rec.start(); rRec.classList.add('recording'); rRec.textContent='◼ STOP';
      replay.elapsed=0; replay.outro=0; replay.playing=true; replay.last=performance.now(); rToggle.textContent='⏸';
      if(replay.enhanced) interpCam(0); else { const t0=replayCamTarget(1); if(t0) Object.assign(cam, t0); }   // snap to the opening frame
      toast(share ? 'Filming your replay to share…' : 'Recording the replay…');
    }catch(err){ toast('Could not start recording'); }
  }
  function stopRecording(){ try{ if(replay.rec && replay.rec.state!=='inactive') replay.rec.stop(); }catch(e){} }
  async function shareReplayBlob(blob){
    const file=new File([blob],'enso-replay-'+stamp()+'.webm',{type:'video/webm'});
    if(navigator.canShare && navigator.canShare({files:[file]})){
      try{ await navigator.share({ files:[file], title:'Ensō 円相', text:'Watch my drawing come to life ✨' }); return; }catch(e){ if(e && e.name==='AbortError') return; }
    }
    downloadBlob(blob,'enso-replay-'+stamp()+'.webm'); toast('Saved replay video (direct share not supported here)');
  }

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
    o.drawImage(ink,0,0); drawWatermark(o, out.width, out.height); return out;
  }
  function exportPNG(){ const out=renderToCanvas(); if(!out){ toast('Nothing to export yet'); return; } out.toBlob(b=>downloadBlob(b,'enso-'+stamp()+'.png'),'image/png'); }
  // save / open an editable Ensō document file (real backup + sharing)
  function exportDoc(){
    const data=JSON.stringify({ v:2, strokes:serialize(strokes), cam, layers, activeLayer, nextLayerId, state:{theme:state.theme,grid:state.grid,axes:state.axes,paper:state.paper,palette:state.palette,accent:state.accent,glow:state.glow} });
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
    stats.shares++; saveStats(); checkBadges();
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
      || !donateModal.classList.contains('hidden') || !galleryModal.classList.contains('hidden') || !musicModal.classList.contains('hidden') || !whatsnew.classList.contains('hidden') || !creditsModal.classList.contains('hidden')
      || !a11yModal.classList.contains('hidden') || !tour.classList.contains('hidden') || !badgesModal.classList.contains('hidden') || !presetModal.classList.contains('hidden')
      || replay.active || state.singing || document.body.classList.contains('zen') || !!state.pendingStamp; }
  function pushGuard(){ if(!guardActive){ guardActive=true; try{ history.pushState({enso:1},''); }catch(e){} } }
  function closeAllOverlays(){ toggleSheet(false); sealModal.classList.add('hidden'); stickerModal.classList.add('hidden'); brushModal.classList.add('hidden'); layerModal.classList.add('hidden'); donateModal.classList.add('hidden'); galleryModal.classList.add('hidden'); musicModal.classList.add('hidden'); whatsnew.classList.add('hidden'); creditsModal.classList.add('hidden'); a11yModal.classList.add('hidden'); badgesModal.classList.add('hidden'); presetModal.classList.add('hidden');
    if(tour && !tour.classList.contains('hidden')) endTour(false);
    if(replay.active) exitReplay(); stopSing(); musicStop(); document.body.classList.remove('zen'); clearPendingStamp(); }
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
  // toast with an action button (e.g. a "clear → Undo" snackbar)
  function toastAction(msg, label, fn){ const t=document.getElementById('toast');
    t.textContent=''; const s=document.createElement('span'); s.textContent=msg; t.appendChild(s);
    const b=document.createElement('button'); b.className='toast-act'; b.type='button'; b.textContent=label;
    const hide=()=>{ t.style.opacity='0'; setTimeout(()=>t.classList.add('hidden'),300); clearTimeout(toastT); };
    b.addEventListener('click',()=>{ fn(); hide(); });
    t.appendChild(b); t.classList.remove('hidden'); t.style.opacity='1';
    clearTimeout(toastT); toastT=setTimeout(hide, 5000); }
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
    // snapshot so an accidental delete can be undone from the snackbar (no confirm dialog)
    const items=strokes.filter(s=>(s.layer||layers[0].id)===L.id);
    const idx=layers.indexOf(L), prevActive=activeLayer;
    if(items.length) removeItems(items);
    layers=layers.filter(x=>x!==L);
    if(activeLayer===L.id) activeLayer=layers[layers.length-1].id;
    undoStack=[]; redoStack=[];             // history can't safely reference a removed layer
    renderLayers(); updateSelBar(); invalidate(); saveSoon(); buzz(12);
    toastAction(`Deleted “${L.name}”`, 'Undo', ()=>{
      layers.splice(Math.min(idx,layers.length), 0, L); activeLayer=prevActive;
      for(const it of items) addItems([it]);
      renderLayers(); updateSelBar(); invalidate(); saveSoon(); buzz(8);
    });
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

  /* ---------------- first-visit intro ---------------- */
  let introTimer=0;
  const INTRO_KEY='enso.intro2';   // bumped so the (fixed) intro shows once for everyone
  function playIntro(el){
    clearTimeout(introTimer);
    el.classList.add('hidden'); void el.offsetWidth; el.classList.remove('hidden');   // restart every child animation from 0
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){ if(!document.hidden) introTimer=setTimeout(hideIntro, 4200); return; }
    // dismiss shortly AFTER the finale animation actually finishes playing — this never
    // fires while the tab is hidden, so a backgrounded first load can't silently skip it.
    const fin=el.querySelector('.fin');
    if(fin) fin.addEventListener('animationend', ()=>{ clearTimeout(introTimer); introTimer=setTimeout(hideIntro, 250); }, {once:true});
  }
  function showIntro(){ const el=document.getElementById('intro'); if(!el) return; el.classList.remove('closing'); playIntro(el); }
  function hideIntro(){
    const el=document.getElementById('intro'); if(!el || el.classList.contains('hidden')) return;
    clearTimeout(introTimer); el.classList.add('closing');
    setTimeout(()=>{ el.classList.add('hidden'); el.classList.remove('closing'); }, 600);
    try{ localStorage.setItem(INTRO_KEY,'1'); }catch(e){}
  }
  { const el=document.getElementById('intro'); if(el) el.addEventListener('click', hideIntro);
    const sk=document.getElementById('introSkip'); if(sk) sk.addEventListener('click', e=>{ e.stopPropagation(); hideIntro(); });
    // if the tab was backgrounded during the intro, replay it from the top when it returns to view
    document.addEventListener('visibilitychange', ()=>{ const x=document.getElementById('intro'); if(!document.hidden && x && !x.classList.contains('hidden')) playIntro(x); }); }
  function maybeShowIntro(){ try{ if(localStorage.getItem(INTRO_KEY)) return false; }catch(e){ return false; } showIntro(); return true; }

  /* ---------------- Sing your drawing (Web Audio) ----------------
     A playhead sweeps left→right; each mark plays a soft note whose pitch comes from
     its height (top = high). Pitches snap to a major-pentatonic scale so it always
     sounds pleasant. 100% offline — nothing leaves the device. */
  const sing = { t:0, bb:null };
  let singRAF=0, singCtx=null;
  const PENT=[0,2,4,7,9];
  function yToFreq(y, minY, maxY){
    const t=clamp(1-(y-minY)/((maxY-minY)||1), 0, 1);
    const steps=Math.round(t*14), oct=Math.floor(steps/5), deg=steps%5;
    return 196*Math.pow(2, (PENT[deg]+12*oct)/12);      // base ~G3
  }
  function buildSong(bb){
    const evs=[], span=(bb.maxX-bb.minX)||1;
    for(const s of strokes){
      if(s.tool==='eraser') continue;
      let samp;
      if(s.tool==='stamp') samp=[{x:s.x,y:s.y}];
      else { const p=s.pts; if(!p||!p.length) continue; samp=[p[0], p[p.length>>1], p[p.length-1]]; }
      for(const pt of samp) evs.push({ t:(pt.x-bb.minX)/span, freq:yToFreq(pt.y,bb.minY,bb.maxY) });
    }
    evs.sort((a,b)=>a.t-b.t);
    return evs;
  }
  function drawSingHead(){
    if(!sing.bb) return;
    const wx=sing.bb.minX + (sing.bb.maxX-sing.bb.minX)*sing.t, sx=(wx+cam.x)*cam.scale;
    ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0);
    const g=ctx.createLinearGradient(sx-14,0,sx+14,0);
    g.addColorStop(0,'rgba(255,255,255,0)'); g.addColorStop(.5,'rgba(255,255,255,.5)'); g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.fillRect(sx-14,0,28,innerHeight);
    ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent')||'#e0503a';
    ctx.lineWidth=2.5; ctx.beginPath(); ctx.moveTo(sx,0); ctx.lineTo(sx,innerHeight); ctx.stroke();
    ctx.restore();
  }
  function startSing(){
    if(state.singing){ stopSing(); return; }
    const bb=bounds(); if(!bb || !strokes.length){ toast('Draw something to hear it 🎵'); return; }
    let evs=buildSong(bb); if(!evs.length){ toast('Draw something to hear it 🎵'); return; }
    if(evs.length>140){ const step=Math.ceil(evs.length/140); evs=evs.filter((_,i)=>i%step===0); }
    const dur=clamp(evs.length*0.09, 3.5, 12);
    const w=bb.maxX-bb.minX, h=bb.maxY-bb.minY;
    const sc=clamp(Math.min(innerWidth/w, innerHeight/h)*0.82, MIN_SCALE, 8);
    animateCam(innerWidth/(2*sc)-(bb.minX+w/2), innerHeight/(2*sc)-(bb.minY+h/2), sc, 400);
    try{ singCtx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ toast('Audio not supported here'); return; }
    const ac=singCtx; if(ac.state==='suspended') ac.resume();
    const master=ac.createGain(); master.gain.value=0.26; master.connect(ac.destination);
    const t0=ac.currentTime+0.5;
    for(const e of evs){ const when=t0+e.t*dur, o=ac.createOscillator(), g=ac.createGain();
      o.type='triangle'; o.frequency.value=e.freq;
      g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.9, when+0.02); g.gain.exponentialRampToValueAtTime(0.0001, when+0.5);
      o.connect(g); g.connect(master); o.start(when); o.stop(when+0.55); }
    sing.bb=bb; sing.t=0; state.singing=true; document.body.classList.add('singing');
    const bar=document.getElementById('singBar'); if(bar) bar.classList.remove('hidden');
    const startMs=performance.now()+500, durMs=dur*1000;
    cancelAnimationFrame(singRAF);
    const sweep=()=>{ const t=clamp((performance.now()-startMs)/durMs, 0, 1); sing.t=t; requestRender();
      if(t<1 && state.singing) singRAF=requestAnimationFrame(sweep); else if(state.singing) setTimeout(stopSing, 400); };
    singRAF=requestAnimationFrame(sweep);
    toast('🎵 Playing your drawing…'); pushGuard();
  }
  function stopSing(){ if(!state.singing) return; state.singing=false; cancelAnimationFrame(singRAF); singRAF=0;
    const bar=document.getElementById('singBar'); if(bar) bar.classList.add('hidden'); document.body.classList.remove('singing');
    if(singCtx){ try{ singCtx.close(); }catch(e){} singCtx=null; } invalidate(); }
  { const sc=document.getElementById('singStop'); if(sc) sc.addEventListener('click', stopSing); }

  /* ---------------- Magic garden sprout animation ----------------
     The stem shows instantly; leaves and the flower scale up in a gentle stagger so
     you actually watch the plant grow. Committed as one undoable op. */
  function animateGarden(items){
    for(const s of strokes){ if(s._grow) delete s._grow; }              // snap any earlier sprout to finished (no half-scaled leftovers)
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){ invalidate(); return; }
    const decos=items.slice(1); if(!decos.length){ invalidate(); return; }
    const now=performance.now(), stag=Math.min(58, 900/Math.max(1,decos.length));
    decos.forEach((it,i)=>{ const a=it.pts&&it.pts[0]; if(a) it._grow={ t0:now+i*stag, dur:340, ax:a.x, ay:a.y }; });
    cancelAnimationFrame(gardenRAF);
    const step=()=>{ const t=performance.now(); let any=false;
      for(const it of decos){ if(it._grow){ if(t < it._grow.t0+it._grow.dur) any=true; else delete it._grow; } }
      invalidate();
      if(any) gardenRAF=requestAnimationFrame(step); else { gardenRAF=0; for(const s of strokes){ if(s._grow) delete s._grow; } invalidate(); saveSoon(); } };
    gardenRAF=requestAnimationFrame(step);
  }

  /* ---------------- Gallery — my drawings (saved on this device) ---------------- */
  const galleryModal=document.getElementById('galleryModal'), galGrid=document.getElementById('galGrid');
  const GAL_KEY='enso.gallery';
  function getGallery(){ try{ return JSON.parse(localStorage.getItem(GAL_KEY)||'[]'); }catch(e){ return []; } }
  function setGallery(list){ try{ localStorage.setItem(GAL_KEY, JSON.stringify(list)); return true; }
    catch(e){ if(list.length>1){ list.shift(); return setGallery(list); } toast('Storage full — export to keep it instead'); return false; } }
  function thumbURL(){ const out=renderToCanvas(); if(!out) return null;
    const S=240, sc=Math.min(1, S/Math.max(out.width,out.height));
    const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(out.width*sc)); c.height=Math.max(1,Math.round(out.height*sc));
    const x=c.getContext('2d'); x.imageSmoothingQuality='high'; x.drawImage(out,0,0,c.width,c.height);
    return c.toDataURL('image/jpeg',0.72); }
  function saveCurrentToGallery(){
    if(!strokes.length){ toast('Draw something first ✍️'); return; }
    const thumb=thumbURL(); if(!thumb){ toast('Nothing to save yet'); return; }
    const doc={ v:2, strokes:serialize(strokes), cam, layers, activeLayer, nextLayerId,
      state:{theme:state.theme,grid:state.grid,axes:state.axes,paper:state.paper,palette:state.palette,accent:state.accent,glow:state.glow} };
    const list=getGallery();
    list.push({ id:'g'+Date.now().toString(36)+Math.floor(Math.random()*1e4), name:'Drawing '+(list.length+1), thumb, doc:JSON.stringify(doc) });
    if(setGallery(list)){ buzz(12); toast('Saved to your gallery ✓'); renderGallery(); stats.saved++; saveStats(); checkBadges(); }
  }
  function renderGallery(){
    const list=getGallery(); galGrid.innerHTML='';
    if(!list.length){ const e=document.createElement('div'); e.className='gal-empty'; e.textContent='No saved drawings yet — tap “Save current”.'; galGrid.appendChild(e); return; }
    for(let i=list.length-1;i>=0;i--){ const it=list[i];
      const card=document.createElement('div'); card.className='gal-card';
      const img=document.createElement('img'); img.className='gal-thumb'; img.src=it.thumb; img.alt=it.name; img.loading='lazy';
      img.addEventListener('click',()=>openFromGallery(it.id));
      const row=document.createElement('div'); row.className='gal-row';
      const nm=document.createElement('span'); nm.className='gal-name'; nm.textContent=it.name;
      const del=document.createElement('button'); del.className='gal-del'; del.setAttribute('aria-label','Delete'); del.textContent='✕';
      del.addEventListener('click',e=>{ e.stopPropagation(); deleteGalleryItem(it.id); });
      row.append(nm, del); card.append(img, row); galGrid.appendChild(card);
    }
  }
  function openFromGallery(id){ const it=getGallery().find(x=>x.id===id); if(!it) return;
    try{ applyDoc(JSON.parse(it.doc)); setAccent(state.accent); setPalette(state.palette); setPaper(state.paper);
      document.body.classList.toggle('glowroom', !!state.glow); updateSelBar(); updateHud(); invalidate(); save(); }
    catch(e){ toast('Could not open that drawing'); return; }
    galleryModal.classList.add('hidden'); buzz(8); toast('Opened ✓'); }
  function deleteGalleryItem(id){ setGallery(getGallery().filter(x=>x.id!==id)); renderGallery(); buzz(8); }
  function openGallery(){ renderGallery(); galleryModal.classList.remove('hidden'); pushGuard(); }
  if(galleryModal){
    document.getElementById('galSave').addEventListener('click', saveCurrentToGallery);
    document.getElementById('galClose').addEventListener('click', ()=>galleryModal.classList.add('hidden'));
    galleryModal.addEventListener('click', e=>{ if(e.target===galleryModal) galleryModal.classList.add('hidden'); });
  }

  /* ---------------- Music — a soundtrack for the drawing (offline) ----------------
     Built-in tracks are generated live with Web Audio (no files, no network); or record
     your own via the mic. Plays as a preview in the picker and during Replay. */
  const musicModal=document.getElementById('musicModal'), musList=document.getElementById('musList');
  const TRACKS=[];   // simplified: users record their own or upload a track
  const music={ ctx:null, master:null, streamDest:null, nodes:[], timer:0, clipURL:null, clipName:'', chip:false, audioEl:null, recorder:null, chunks:[], stream:null };
  const MSCALE=[0,2,4,7,9,12];
  function musicStop(){
    if(music.timer){ clearInterval(music.timer); music.timer=0; }
    for(const n of music.nodes){ try{ n.stop&&n.stop(); }catch(e){} try{ n.disconnect&&n.disconnect(); }catch(e){} }
    music.nodes=[];
    if(music.audioEl){ try{ music.audioEl.pause(); }catch(e){} music.audioEl=null; }
    if(music.ctx){ try{ music.ctx.close(); }catch(e){} }
    music.ctx=null; music.master=null; music.streamDest=null;
  }
  // The master gain feeds both the speakers AND a MediaStream node, so the soundtrack can be
  // mixed straight into the shared replay video.
  function musicCtx(){
    if(!music.ctx){ music.ctx=new (window.AudioContext||window.webkitAudioContext)();
      music.master=music.ctx.createGain(); music.master.gain.value=0.6; music.master.connect(music.ctx.destination);
      try{ music.streamDest=music.ctx.createMediaStreamDestination(); music.master.connect(music.streamDest); }catch(e){ music.streamDest=null; } }
    if(music.ctx.state==='suspended') music.ctx.resume(); return music.ctx;
  }
  function musicTrack(){ return (music.streamDest && music.streamDest.stream.getAudioTracks()[0]) || null; }
  function envNote(ac,dest,freq,when,dur,type,peak){ const o=ac.createOscillator(), g=ac.createGain();
    o.type=type||'sine'; o.frequency.value=freq;
    g.gain.setValueAtTime(0.0001,when); g.gain.exponentialRampToValueAtTime(peak||0.2,when+0.02); g.gain.exponentialRampToValueAtTime(0.0001,when+dur);
    o.connect(g); g.connect(dest); o.start(when); o.stop(when+dur+0.05); }
  function playTrack(id){
    musicStop(); const ac=musicCtx(); const master=music.master;
    if(id==='calm'){
      const filt=ac.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=900; filt.connect(master); music.nodes.push(filt);
      [110,164.81,220,277.18].forEach((f,i)=>{ const o=ac.createOscillator(), g=ac.createGain(); o.type='triangle'; o.frequency.value=f; o.detune.value=(i-1)*4;
        g.gain.value=0.12; o.connect(g); g.connect(filt); o.start(); music.nodes.push(o,g); });
      const lfo=ac.createOscillator(), lg=ac.createGain(); lfo.frequency.value=0.06; lg.gain.value=350; lfo.connect(lg); lg.connect(filt.frequency); lfo.start(); music.nodes.push(lfo,lg);
    } else if(id==='chimes'){
      music.timer=setInterval(()=>{ if(!music.ctx) return; const t=music.ctx.currentTime, deg=MSCALE[Math.floor(Math.random()*MSCALE.length)]+12*(Math.random()<0.4?1:0);
        envNote(music.ctx, master, 392*Math.pow(2,deg/12), t+0.02, 1.6, 'sine', 0.28); }, 900);
    } else if(id==='rain'){
      const buf=ac.createBuffer(1, ac.sampleRate*2, ac.sampleRate), d=buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*0.5;
      const src=ac.createBufferSource(); src.buffer=buf; src.loop=true; const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1200; bp.Q.value=0.7;
      const g=ac.createGain(); g.gain.value=0.22; src.connect(bp); bp.connect(g); g.connect(master); src.start(); music.nodes.push(src,bp,g);
      music.timer=setInterval(()=>{ if(!music.ctx) return; envNote(music.ctx, master, 1400+Math.random()*1600, music.ctx.currentTime+0.02, 0.25, 'sine', 0.05); }, 260);
    } else if(id==='lofi'){
      const chords=[[130.81,164.81,196],[146.83,174.61,220],[164.81,196,246.94],[110,138.59,164.81]]; let ci=0;
      const filt=ac.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=1200; filt.connect(master); music.nodes.push(filt);
      const play=()=>{ if(!music.ctx) return; const t=music.ctx.currentTime; chords[ci%chords.length].forEach(f=>envNote(music.ctx, filt, f, t+0.02, 2.4, 'triangle', 0.14)); ci++; };
      play(); music.timer=setInterval(play, 2200);
    }
  }
  function playClip(){ musicStop(); if(!music.clipURL) return; const ac=musicCtx(); const a=new Audio(music.clipURL); a.loop=true; music.audioEl=a;
    try{ a.crossOrigin='anonymous'; const src=ac.createMediaElementSource(a); src.connect(music.master); }catch(e){ a.volume=0.9; }
    a.play().catch(()=>{}); }
  function musicPlaySelection(){ const id=state.music; if(!id){ musicStop(); return; } if(id==='custom') playClip(); else playTrack(id); }
  function setMusic(id){ state.music=id; saveSoon(); renderMusList(); if(!musicModal.classList.contains('hidden')) musicPlaySelection(); }
  function renderMusList(){ if(!musList) return; musList.innerHTML='';
    const mk=(id,name)=>{ const b=document.createElement('button'); b.type='button'; b.className='mus-item'+(state.music===id?' on':''); b.textContent=name;
      b.addEventListener('click',()=>{ setMusic(id); buzz(6); }); return b; };
    for(const t of TRACKS) musList.appendChild(mk(t.id, t.name));
    if(music.clipURL) musList.appendChild(mk('custom', music.clipName||'Your recording'));
    if(!TRACKS.length && !music.clipURL){ const h=document.createElement('div'); h.className='mus-hint'; h.textContent='Record your voice or upload a track below.'; musList.appendChild(h); }
  }
  function openMusic(){ renderMusList(); musicModal.classList.remove('hidden'); pushGuard(); if(state.music) musicPlaySelection(); }
  async function toggleRecord(){
    const btn=document.getElementById('musRecBtn'), st=document.getElementById('musRecState');
    if(music.recorder){ try{ music.recorder.stop(); }catch(e){} return; }
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||typeof MediaRecorder==='undefined'){ toast('Recording not supported here'); return; }
    try{ musicStop(); music.stream=await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ toast('Microphone permission needed'); return; }
    music.chunks=[]; music.recorder=new MediaRecorder(music.stream);
    music.recorder.ondataavailable=e=>{ if(e.data.size) music.chunks.push(e.data); };
    music.recorder.onstop=()=>{ const blob=new Blob(music.chunks,{type:(music.chunks[0]&&music.chunks[0].type)||'audio/webm'});
      try{ music.stream.getTracks().forEach(t=>t.stop()); }catch(e){} music.stream=null; music.recorder=null;
      if(music.clipURL){ try{ URL.revokeObjectURL(music.clipURL); }catch(e){} }
      music.clipURL=URL.createObjectURL(blob); music.clipName='Your recording'; state.music='custom'; saveSoon();
      btn.classList.remove('recording'); btn.textContent='● Record your own'; if(st) st.textContent='Saved your recording ✓'; renderMusList(); buzz(10); };
    music.recorder.start(); btn.classList.add('recording'); btn.textContent='◼ Stop recording'; if(st) st.textContent='Recording…';
  }
  // "Now playing" chip keeps the soundtrack going while you draw
  const musicChip=document.getElementById('musicChip');
  function currentMusicName(){ if(state.music==='custom') return music.clipName||'Your recording'; const t=TRACKS.find(x=>x.id===state.music); return t?t.name:'Music'; }
  function musicChipShow(){ music.chip=true; if(musicChip){ const n=document.getElementById('mcName'); if(n) n.textContent=currentMusicName(); musicChip.classList.remove('hidden'); } }
  function musicChipHide(){ music.chip=false; if(musicChip) musicChip.classList.add('hidden'); }
  function closeMusic(){ musicModal.classList.add('hidden'); if(state.music){ musicPlaySelection(); musicChipShow(); } else musicStop(); }
  if(musicChip){ const s=document.getElementById('mcStop'); if(s) s.addEventListener('click',()=>{ musicStop(); musicChipHide(); buzz(6); }); }
  if(musicModal){
    document.getElementById('musRecBtn').addEventListener('click', toggleRecord);
    { const uf=document.getElementById('musFile'), ub=document.getElementById('musUploadBtn');
      if(ub) ub.addEventListener('click', ()=>uf&&uf.click());
      if(uf) uf.addEventListener('change', e=>{ const f=e.target.files&&e.target.files[0]; e.target.value=''; if(!f) return;
        if(!/^audio\//.test(f.type||'')){ toast('Please pick an audio file'); return; }
        if(music.clipURL){ try{ URL.revokeObjectURL(music.clipURL); }catch(_){} }
        music.clipURL=URL.createObjectURL(f); music.clipName=(f.name||'Track').replace(/\.[^.]+$/,'').slice(0,24);
        renderMusList(); setMusic('custom'); buzz(10); toast('🎵 Added “'+music.clipName+'”'); }); }
    document.getElementById('musNone').addEventListener('click', ()=>{ setMusic(null); musicStop(); musicChipHide(); buzz(6); toast('Music off'); });
    document.getElementById('musClose').addEventListener('click', closeMusic);
    musicModal.addEventListener('click', e=>{ if(e.target===musicModal) closeMusic(); });
  }

  /* ---------------- What's new (shown once after an update) ---------------- */
  const whatsnew=document.getElementById('whatsnew');
  const APP_VER='wow-3';
  const WN_ITEMS=[
    '🌱 A livelier Magic Garden — flowers, trees & fireflies',
    '🏆 Earn badges as you create',
    '🖊️ Save your favourite pens (My pens)',
    '🎨 Lots more stickers to collect',
    '🎵 Simpler music — record or upload your own',
    '✨ A cleaner, gentler start',
  ];
  function showWhatsNew(){ const list=document.getElementById('wnList');
    if(list){ list.innerHTML=''; for(const t of WN_ITEMS){ const li=document.createElement('li'); li.textContent=t; list.appendChild(li); } }
    whatsnew.classList.remove('hidden'); pushGuard(); }
  function maybeWhatsNew(){ let seen, introSeen;
    try{ seen=localStorage.getItem('enso.seenver'); introSeen=localStorage.getItem(INTRO_KEY); }catch(e){ return false; }
    try{ localStorage.setItem('enso.seenver', APP_VER); }catch(e){}
    if(seen===APP_VER || !introSeen) return false;   // already seen, or brand-new (intro covers it)
    showWhatsNew(); return true; }
  if(whatsnew){ document.getElementById('wnClose').addEventListener('click', ()=>whatsnew.classList.add('hidden'));
    whatsnew.addEventListener('click', e=>{ if(e.target===whatsnew) whatsnew.classList.add('hidden'); }); }

  /* ---------------- credits & acknowledgements ---------------- */
  const creditsModal=document.getElementById('creditsModal');
  function openCredits(){ if(!creditsModal) return; creditsModal.classList.remove('hidden'); pushGuard(); }
  if(creditsModal){ document.getElementById('crClose').addEventListener('click', ()=>creditsModal.classList.add('hidden'));
    creditsModal.addEventListener('click', e=>{ if(e.target===creditsModal) creditsModal.classList.add('hidden'); }); }

  /* ---------------- achievements / badges ---------------- */
  const badgesModal=document.getElementById('badgesModal'), badgesGrid=document.getElementById('badgesGrid');
  const STAT_KEY='enso.stats', BADGE_KEY='enso.badges';
  const BADGES=[
    { id:'first',   emoji:'🖌️', name:'First stroke',    test:s=>s.strokes>=1 },
    { id:'busy',    emoji:'✏️', name:'Getting going',   test:s=>s.strokes>=25 },
    { id:'artist',  emoji:'🎨', name:'Busy artist',     test:s=>s.strokes>=150 },
    { id:'garden1', emoji:'🌱', name:'Green thumb',     test:s=>s.gardens>=1 },
    { id:'garden8', emoji:'🌳', name:'Gardener',        test:s=>s.gardens>=8 },
    { id:'rainbow', emoji:'🌈', name:'Rainbow magic',   test:s=>!!s.rainbow },
    { id:'colours', emoji:'🖍️', name:'Colour explorer', test:s=>Object.keys(s.colors||{}).length>=8 },
    { id:'mandala', emoji:'❄️', name:'Symmetry star',   test:s=>!!s.mandala },
    { id:'zoom',    emoji:'🔭', name:'Deep diver',      test:s=>(s.zoom||1)>=50 },
    { id:'save1',   emoji:'🖼️', name:'Keepsake',        test:s=>s.saved>=1 },
    { id:'save5',   emoji:'📚', name:'Collector',       test:s=>s.saved>=5 },
    { id:'share1',  emoji:'📤', name:'Sharer',          test:s=>s.shares>=1 },
  ];
  let stats={ strokes:0, gardens:0, saved:0, shares:0, zoom:1, colors:{}, rainbow:false, mandala:false };
  let earnedBadges=[];
  try{ stats=Object.assign(stats, JSON.parse(localStorage.getItem(STAT_KEY)||'{}')); }catch(e){}
  try{ earnedBadges=JSON.parse(localStorage.getItem(BADGE_KEY)||'[]'); }catch(e){}
  function saveStats(){ try{ localStorage.setItem(STAT_KEY, JSON.stringify(stats)); localStorage.setItem(BADGE_KEY, JSON.stringify(earnedBadges)); }catch(e){} }
  function checkBadges(){ const newly=[];
    for(const b of BADGES){ if(earnedBadges.indexOf(b.id)<0 && b.test(stats)){ earnedBadges.push(b.id); newly.push(b); } }
    if(newly.length){ saveStats(); newly.forEach((b,i)=>setTimeout(()=>{ toast('🏆 Badge: '+b.name+' '+b.emoji); buzz(18); sparkleBurst(innerWidth/2, 92, '#ffd23f'); }, i*1500)); }
  }
  function noteStroke(s){ stats.strokes++; if(s && s.color) stats.colors[s.color]=1; if(state.rainbow) stats.rainbow=true; if(state.sym) stats.mandala=true; if(s && s.tool==='garden') stats.gardens++; saveStats(); checkBadges(); }
  function renderBadges(){ if(!badgesGrid) return; badgesGrid.innerHTML='';
    const sub=document.getElementById('bgSub'); if(sub) sub.textContent=earnedBadges.length+' of '+BADGES.length+' unlocked — keep creating!';
    for(const b of BADGES){ const on=earnedBadges.indexOf(b.id)>=0;
      const el=document.createElement('div'); el.className='badge'+(on?' earned':'');
      const em=document.createElement('span'); em.className='bg-emoji'; em.textContent=on?b.emoji:'🔒';
      const nm=document.createElement('span'); nm.className='bg-name'; nm.textContent=b.name;
      el.append(em,nm); badgesGrid.appendChild(el); }
  }
  function openBadges(){ renderBadges(); badgesModal.classList.remove('hidden'); pushGuard(); }
  if(badgesModal){ document.getElementById('bgClose').addEventListener('click',()=>badgesModal.classList.add('hidden'));
    badgesModal.addEventListener('click', e=>{ if(e.target===badgesModal) badgesModal.classList.add('hidden'); }); }

  /* ---------------- brush presets — "my pens" ---------------- */
  const presetModal=document.getElementById('presetModal'), presetGrid=document.getElementById('presetGrid');
  const PRESET_KEY='enso.presets';
  let presets=[]; try{ presets=JSON.parse(localStorage.getItem(PRESET_KEY)||'[]'); }catch(e){}
  function savePresets(){ try{ localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }catch(e){} }
  function saveCurrentPreset(){
    const p={ id:'p'+Date.now().toString(36), tool:isDrawStyle(state.tool)?state.tool:lastBrushStyle, size:state.size, color:state.color, rainbow:!!state.rainbow };
    presets.unshift(p); if(presets.length>12) presets.pop(); savePresets(); renderPresets(); buzz(10); toast('Pen saved ✓');
  }
  function applyPreset(p){ selectTool(p.tool); state.size=p.size; if(sizeRange) sizeRange.value=p.size;
    if(p.rainbow){ state.rainbow=true; sw.querySelectorAll('.swatch').forEach(n=>n.classList.remove('active')); if(rainbowEl) rainbowEl.classList.add('active'); updateBrushDot(); }
    else setColor(p.color);
    buzz(6); toast('Pen ready'); presetModal.classList.add('hidden'); }
  function deletePreset(id){ presets=presets.filter(p=>p.id!==id); savePresets(); renderPresets(); buzz(6); }
  function renderPresets(){ if(!presetGrid) return; presetGrid.innerHTML='';
    if(!presets.length){ const e=document.createElement('div'); e.className='preset-empty'; e.textContent='No pens yet — set a brush, colour and size, then tap “Save current pen”.'; presetGrid.appendChild(e); return; }
    for(const p of presets){ const st=STYLES[p.tool]||STYLES.brush;
      const wrap=document.createElement('div'); wrap.className='preset-wrap';
      const card=document.createElement('button'); card.type='button'; card.className='preset-card';
      const dot=document.createElement('span'); dot.className='pr-dot'; dot.style.background=p.rainbow?'conic-gradient(from 0deg,#ff4d4f,#ffd21a,#37c86b,#20b8e6,#9a5bff,#ff4d4f)':p.color;
      const lbl=document.createElement('span'); lbl.className='pr-lbl'; lbl.textContent=(st.emoji||'🖌️')+' '+Math.round(p.size);
      card.append(dot,lbl); card.addEventListener('click',()=>applyPreset(p));
      const del=document.createElement('button'); del.type='button'; del.className='pr-del'; del.setAttribute('aria-label','Delete pen'); del.textContent='✕';
      del.addEventListener('click',e=>{ e.stopPropagation(); deletePreset(p.id); });
      wrap.append(card, del); presetGrid.appendChild(wrap); }
  }
  function openPresets(){ renderPresets(); presetModal.classList.remove('hidden'); pushGuard(); }
  if(presetModal){ document.getElementById('prSave').addEventListener('click', saveCurrentPreset);
    document.getElementById('prClose').addEventListener('click',()=>presetModal.classList.add('hidden'));
    presetModal.addEventListener('click', e=>{ if(e.target===presetModal) presetModal.classList.add('hidden'); }); }

  /* ---------------- Inspiration — a creative prompt ---------------- */
  const PROMPTS=['a house for a friendly dragon','a garden on the moon','your favourite animal as a superhero',
    'an underwater city','a robot who loves flowers','a treehouse in the clouds','a magical forest at night',
    'a rocket made of sweets','a cat wizard casting a spell','the tallest tower you can imagine','a rainbow river',
    'a dinosaur having a picnic','a tiny world inside a bottle','a friendly monster','a castle in the desert',
    'a bird made of music','a snowman on a beach','a door to another world','a jellyfish parade','a city of mushrooms'];
  let lastPrompt=-1;
  function inspireMe(){ let i; do{ i=Math.floor(Math.random()*PROMPTS.length); }while(i===lastPrompt && PROMPTS.length>1); lastPrompt=i;
    toast('✨ Try drawing: '+PROMPTS[i]); buzz(8); }

  /* ---------------- Accessibility settings ---------------- */
  const a11yModal=document.getElementById('a11yModal');
  const A11Y_KEY='enso.a11y', a11y={ contrast:false, big:false, motion:false };
  function applyA11y(){ document.body.classList.toggle('hc', a11y.contrast); document.body.classList.toggle('bigtext', a11y.big); document.body.classList.toggle('reduce-motion', a11y.motion); }
  function saveA11y(){ try{ localStorage.setItem(A11Y_KEY, JSON.stringify(a11y)); }catch(e){} }
  function openA11y(){ if(!a11yModal) return;
    document.getElementById('a11yContrast').checked=a11y.contrast; document.getElementById('a11yBig').checked=a11y.big; document.getElementById('a11yMotion').checked=a11y.motion;
    a11yModal.classList.remove('hidden'); pushGuard(); }
  if(a11yModal){
    const bind=(id,key)=>{ const el=document.getElementById(id); if(el) el.addEventListener('change',()=>{ a11y[key]=el.checked; applyA11y(); saveA11y(); buzz(4); }); };
    bind('a11yContrast','contrast'); bind('a11yBig','big'); bind('a11yMotion','motion');
    document.getElementById('a11yClose').addEventListener('click',()=>a11yModal.classList.add('hidden'));
    a11yModal.addEventListener('click', e=>{ if(e.target===a11yModal) a11yModal.classList.add('hidden'); });
  }
  try{ Object.assign(a11y, JSON.parse(localStorage.getItem(A11Y_KEY)||'{}')); }catch(e){} applyA11y();

  /* ---------------- Guided tour (coach marks) ---------------- */
  const tour=document.getElementById('tour'), TOUR_KEY='enso.tour';
  const TOUR_STEPS=[
    { sel:null,        title:'Welcome to Ensō', text:'Draw anywhere — the page never ends. Pinch or scroll to zoom.' },
    { sel:'#colorBtn', title:'Colours & brush', text:'Tap here for colours, palettes and your brush size.' },
    { sel:'#menuBtn',  title:'Everything else', text:'Brushes, gallery, music, sharing and more live in the menu.' },
  ];
  let tourI=0;
  function tourAt(i){
    tourI=i; const step=TOUR_STEPS[i]; if(!step){ endTour(true); return; }
    const spot=document.getElementById('tourSpot'), tip=document.getElementById('tourTip');
    document.getElementById('tourStep').textContent=(i+1)+' / '+TOUR_STEPS.length;
    document.getElementById('tourTitle').textContent=step.title;
    document.getElementById('tourText').textContent=step.text;
    document.getElementById('tourNext').textContent = i===TOUR_STEPS.length-1 ? 'Done' : 'Next';
    const el=step.sel && document.querySelector(step.sel);
    const r = el ? el.getBoundingClientRect() : { left:innerWidth/2-70, top:innerHeight/2-70, width:140, height:140 };
    const pad=8;
    spot.style.left=(r.left-pad)+'px'; spot.style.top=(r.top-pad)+'px'; spot.style.width=(r.width+pad*2)+'px'; spot.style.height=(r.height+pad*2)+'px';
    tip.style.left=clamp(r.left+r.width/2-140, 12, Math.max(12, innerWidth-292))+'px';
    const below = r.top < innerHeight*0.5;
    tip.style.top = below ? (r.top+r.height+pad+12)+'px' : (r.top-pad-16-tip.offsetHeight)+'px';
  }
  function startTour(){ if(!tour) return; toggleSheet(false); tour.classList.remove('hidden'); pushGuard(); tourAt(0);
    requestAnimationFrame(()=>tourAt(0)); }   // re-place once the tip has measured height
  function endTour(done){ if(!tour) return; tour.classList.add('hidden'); try{ localStorage.setItem(TOUR_KEY,'1'); }catch(e){} if(done) buzz(8); }
  function maybeTour(){ let seen; try{ seen=localStorage.getItem(TOUR_KEY); }catch(e){ return false; } if(seen) return false; setTimeout(startTour, 450); return true; }
  if(tour){
    document.getElementById('tourNext').addEventListener('click',()=>{ buzz(5); tourAt(tourI+1); });
    document.getElementById('tourSkip').addEventListener('click',()=>endTour(false));
    addEventListener('resize', ()=>{ if(!tour.classList.contains('hidden')) tourAt(tourI); });
  }

  /* ---------------- share watermark — every share advertises Ensō ---------------- */
  function drawWatermark(o, W, H){
    if(state.watermark===false) return;
    const s=clamp(Math.min(W,H)*0.028, 13, 42), txt='Made with Ensō';
    o.save(); o.font='600 '+Math.round(s)+'px "Fredoka",system-ui,sans-serif';
    const tw=o.measureText(txt).width, ringR=s*0.6, gap=s*0.42, padx=s*0.7;
    const boxW=ringR*2+gap+tw+padx*2, boxH=s*1.9, mx=s*0.8;
    const bx=W-boxW-mx, by=H-boxH-mx, cx=bx+padx+ringR, cy=by+boxH/2;
    o.globalAlpha=0.9; o.fillStyle='rgba(18,18,22,0.34)'; roundRect(o,bx,by,boxW,boxH,boxH/2); o.fill();
    o.globalAlpha=1; o.strokeStyle='#e0503a'; o.lineWidth=Math.max(2,s*0.17); o.lineCap='round';
    o.beginPath(); o.arc(cx,cy,ringR,Math.PI*0.16,Math.PI*1.95); o.stroke();
    o.fillStyle='rgba(255,255,255,0.94)'; o.textAlign='left'; o.textBaseline='middle';
    o.fillText(txt, cx+ringR+gap, cy+s*0.04); o.restore();
  }

  /* ---------------- boot ---------------- */
  load(); gridRebuild(); selectTool(state.tool); setPalette(state.palette); setPaper(state.paper); setAccent(state.accent);
  if(state.glow) document.body.classList.add('glowroom');
  updateHud();
  // Simple onboarding: first-timers get a short guided tour (the long intro is optional, via Menu → Watch intro)
  if(!maybeTour()){ if(!maybeWhatsNew()) maybeShowAppPrompt(); }
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
