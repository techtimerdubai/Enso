/* Ensō 円相 — free infinite-canvas ink app.
   Strokes are vectors in WORLD space, so zoom stays razor-sharp at any scale. */
(() => {
  'use strict';

  const canvas = document.getElementById('paper');
  const ctx = canvas.getContext('2d');
  // separate ink layer so the eraser removes ink only (revealing paper/grid, not the page behind)
  const inkCanvas = document.createElement('canvas');
  const ictx = inkCanvas.getContext('2d');

  /* ---------------- camera & document ---------------- */
  const cam = { x: 0, y: 0, scale: 1 };
  let dpr = clamp(window.devicePixelRatio || 1, 1, 3);

  let strokes = [];          // committed items (strokes + stamps), in draw order
  let opSizes = [];          // undo groups: how many items each committed action added
  let redoStack = [];        // arrays of items
  let live = null;           // stroke being drawn

  const state = {
    tool: 'brush',
    color: '#1a1a1a',
    size: 6,
    theme: 'light',          // light | dark
    grid: true,
    sym: false,
    axes: 6,
    pendingSeal: null,       // {img, dataURL} awaiting stamp placement
  };

  const PALETTE = [
    { c:'#1a1a1a', n:'墨 Sumi' }, { c:'#165E83', n:'藍 Ai' }, { c:'#e0503a', n:'朱 Shu' },
    { c:'#c9171e', n:'紅 Kurenai' }, { c:'#e69b3a', n:'山吹 Yamabuki' }, { c:'#5dac81', n:'萌黄 Moegi' },
    { c:'#8b81c3', n:'藤 Fuji' }, { c:'#d05a6e', n:'桃 Momo' }, { c:'#f2f2ee', n:'白 Shiro' },
  ];
  const paperColor = () => state.theme === 'dark' ? '#17181c' : '#f6f3ec';

  /* ---------------- persistence ---------------- */
  const KEY = 'enso.doc.v2';
  const save = () => { try {
    localStorage.setItem(KEY, JSON.stringify({ strokes: serialize(strokes), cam,
      state:{ theme:state.theme, grid:state.grid, axes:state.axes } }));
  } catch(e){} };
  const saveSoon = debounce(save, 400);
  function serialize(list){ return list.map(s => s.tool==='stamp'
    ? { tool:'stamp', dataURL:s.dataURL, x:s.x, y:s.y, size:s.size }
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
    canvas.width = inkCanvas.width = Math.round(innerWidth * dpr);
    canvas.height = inkCanvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    requestRender();
  }

  /* ---------------- transforms ---------------- */
  const toWorld = (sx, sy) => ({ x: sx / cam.scale - cam.x, y: sy / cam.scale - cam.y });

  /* ---------------- rendering ---------------- */
  let needsRender = false;
  const requestRender = () => { if(!needsRender){ needsRender = true; requestAnimationFrame(render); } };

  function render(){
    needsRender = false;
    // 1) paper + grid on the visible canvas
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = paperColor();
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    if(state.grid) drawGrid();

    // 2) ink on its own transparent layer (eraser erases ink only)
    ictx.setTransform(1, 0, 0, 1, 0, 0);
    ictx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    ictx.setTransform(cam.scale*dpr, 0, 0, cam.scale*dpr, cam.x*cam.scale*dpr, cam.y*cam.scale*dpr);
    if(replay.active){ drawScene(ictx, strokes, replay.revealed); }
    else {
      drawScene(ictx, strokes, Infinity);
      if(live){
        drawStroke(ictx, live);
        if(state.sym) for(const c of symCopies(live)) drawStroke(ictx, c);
      }
    }
    // 3) composite ink over paper
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(inkCanvas, 0, 0);

    if(state.sym && !replay.active) drawSymGuide();
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
      // cull off-screen
      if(s.bb && (s.bb.maxX < vr.minX-pad || s.bb.minX > vr.maxX+pad || s.bb.maxY < vr.minY-pad || s.bb.minY > vr.maxY+pad)) continue;
      if(s.tool==='stamp') drawStampItem(target, s);
      else drawStroke(target, s, revealHere < len ? Math.ceil(revealHere) : 0);
    }
  }

  function drawGrid(){
    let step = 34 * cam.scale;
    while(step < 16) step *= 4;
    while(step > 150) step /= 4;
    const ox = ((cam.x*cam.scale)%step+step)%step, oy = ((cam.y*cam.scale)%step+step)%step;
    ctx.fillStyle = state.theme==='dark' ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)';
    const r = clamp(cam.scale, .6, 1.4);
    for(let x=ox; x<innerWidth; x+=step) for(let y=oy; y<innerHeight; y+=step) ctx.fillRect(x-r/2, y-r/2, r, r);
  }

  function drawSymGuide(){
    ctx.save();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const cx = (0 + cam.x)*cam.scale, cy = (0 + cam.y)*cam.scale;
    ctx.strokeStyle = 'rgba(224,80,58,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx-9,cy); ctx.lineTo(cx+9,cy); ctx.moveTo(cx,cy-9); ctx.lineTo(cx,cy+9); ctx.stroke();
    ctx.restore();
  }

  /* ---- draw one vector stroke as a smooth variable-width ribbon ---- */
  function drawStroke(target, s, partial){
    const pts = partial ? s.pts.slice(0, partial) : s.pts;
    if(!pts.length) return;
    setComposite(target, s.tool);
    target.fillStyle = s.color; target.strokeStyle = s.color;

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
    // round the two ends
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
    if(!s._img){ return; }
    const half = s.size/2;
    target.globalAlpha = 1; target.globalCompositeOperation='source-over';
    target.drawImage(s._img, s.x-half, s.y-half, s.size, s.size);
  }

  /* ---------------- input / drawing ---------------- */
  const pointers = new Map();
  let drawingId = null, panLast = null, pinch = null, spaceDown = false;
  const isPan = () => state.tool==='pan' || spaceDown;

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch(_){}
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if(state.pendingSeal && e.isPrimary){ placeSeal(e.clientX, e.clientY); return; }

    if(pointers.size === 2){ startPinch(); if(live){ live=null; drawingId=null; requestRender(); } return; }
    if(isPan()){ panLast={x:e.clientX,y:e.clientY}; document.body.classList.add('panning'); return; }

    drawingId = e.pointerId; redoStack.length = 0;
    const w = toWorld(e.clientX, e.clientY);
    live = { tool:state.tool, color:state.color, size:state.size, pts:[], _t:performance.now() };
    addPoint(live, w.x, w.y, pressure(e), 0);
    hideHint(); requestRender();
  });

  canvas.addEventListener('pointermove', e => {
    if(pointers.has(e.pointerId)) pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(pinch && pointers.size>=2){ updatePinch(); return; }
    if(panLast && isPan()){
      cam.x += (e.clientX-panLast.x)/cam.scale; cam.y += (e.clientY-panLast.y)/cam.scale;
      panLast={x:e.clientX,y:e.clientY}; requestRender(); saveSoon(); return;
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
    pointers.delete(e.pointerId);
    if(pointers.size<2) pinch=null;
    if(drawingId===e.pointerId){
      if(live && live.pts.length){ finalizeStroke(live); commit(state.sym ? [live, ...symCopies(live)] : [live]); }
      live=null; drawingId=null; requestRender();
    }
    if(panLast){ panLast=null; document.body.classList.remove('panning'); saveSoon(); }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function pressure(e){
    if(e.pointerType==='pen' && e.pressure>0) return e.pressure;
    if(e.pointerType==='touch' && e.pressure>0 && e.pressure!==0.5) return e.pressure;
    return 0.5;
  }

  // add a point, computing brush width from pressure + speed, with a start taper
  function addPoint(s, x, y, p, t){
    const pts=s.pts; const base=s.size;
    let w;
    if(s.tool==='marker'){ w = base*2.2; }
    else if(s.tool==='eraser'){ w = base*2.4; }
    else {
      let speedF = 1;
      const last = pts[pts.length-1];
      if(last && s.tool==='brush'){
        const dt = Math.max(1, t-(last._t||0));
        const v = Math.hypot(x-last.x, y-last.y)/dt;   // world units / ms
        speedF = clamp(1 - v*0.18, 0.35, 1);
      }
      const pf = s.tool==='brush' ? (0.25+0.75*p) : (0.55+0.45*p);
      w = base * pf * speedF;
      // start taper
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

  /* ---------------- symmetry (mandala) ---------------- */
  function symCopies(stroke){
    const out=[]; const N=state.axes;
    for(let k=0;k<N;k++){
      for(const mir of [1,-1]){
        if(k===0 && mir===1) continue;          // original already drawn
        const a = k*2*Math.PI/N;
        const cos=Math.cos(a), sin=Math.sin(a);
        const pts = stroke.pts.map(p=>{
          const y = mir*p.y;                     // mirror across x-axis
          return { x: p.x*cos - y*sin, y: p.x*sin + y*cos, w:p.w };
        });
        const c={ tool:stroke.tool, color:stroke.color, size:stroke.size, pts };
        if(stroke.bb) finalizeBB(c);
        out.push(c);
      }
    }
    return out;
  }

  /* ---------------- undo / redo commit ---------------- */
  function commit(items){
    for(const it of items) if(!it.bb) finalizeBB(it);
    strokes.push(...items); opSizes.push(items.length); saveSoon();
  }
  function undo(){ if(!opSizes.length) return; const n=opSizes.pop(); const removed=strokes.splice(-n); redoStack.push(removed); requestRender(); saveSoon(); }
  function redo(){ if(!redoStack.length) return; const items=redoStack.pop(); strokes.push(...items); opSizes.push(items.length); requestRender(); saveSoon(); }

  /* ---------------- pinch / wheel zoom ---------------- */
  const twoPts = () => [...pointers.values()];
  function startPinch(){ const [a,b]=twoPts(); pinch={ d:Math.hypot(a.x-b.x,a.y-b.y), cx:(a.x+b.x)/2, cy:(a.y+b.y)/2 }; panLast=null; }
  function updatePinch(){
    const [a,b]=twoPts(); const d=Math.hypot(a.x-b.x,a.y-b.y)||1, cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    zoomAt(cx, cy, d/pinch.d);
    cam.x += (cx-pinch.cx)/cam.scale; cam.y += (cy-pinch.cy)/cam.scale;
    pinch={d,cx,cy}; requestRender(); saveSoon();
  }
  function zoomAt(sx, sy, f){
    const before=toWorld(sx,sy);
    cam.scale = clamp(cam.scale*f, 0.02, 64);
    const after=toWorld(sx,sy);
    cam.x += after.x-before.x; cam.y += after.y-before.y;
    updateHud();
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if(e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)){
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY*0.0016));
    } else { cam.x -= e.deltaX/cam.scale; cam.y -= e.deltaY/cam.scale; }
    requestRender(); saveSoon();
  }, { passive:false });

  // block iOS Safari page-zoom / double-tap zoom
  ['gesturestart','gesturechange','gestureend'].forEach(t => document.addEventListener(t, e=>e.preventDefault(), {passive:false}));
  document.addEventListener('dblclick', e=>e.preventDefault());
  document.addEventListener('touchmove', e=>{ if(e.touches.length>1) e.preventDefault(); }, {passive:false});

  /* ---------------- UI: swatches / tools / size ---------------- */
  const sw = document.getElementById('swatches');
  PALETTE.forEach((s,i)=>{
    const el=document.createElement('div'); el.className='swatch'+(i===0?' active':'');
    el.style.background=s.c; el.title=s.n;
    if(s.c.toLowerCase()==='#f2f2ee') el.style.boxShadow='inset 0 0 0 1px rgba(0,0,0,.25)';
    el.addEventListener('click',()=>{ state.color=s.c;
      if(state.tool==='eraser'||state.tool==='pan') selectTool('brush');
      [...sw.children].forEach(n=>n.classList.remove('active')); el.classList.add('active');
    });
    sw.appendChild(el);
  });
  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.addEventListener('click',()=>selectTool(b.dataset.tool)));
  function selectTool(tool){ state.tool=tool; clearPendingSeal();
    document.querySelectorAll('.tool[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
    document.body.classList.toggle('pan', tool==='pan');
  }
  const sizeRange=document.getElementById('sizeRange');
  sizeRange.addEventListener('input',()=>{ state.size=+sizeRange.value; });
  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);

  // symmetry toggle
  const symBtn=document.getElementById('symBtn');
  symBtn.addEventListener('click',()=>{ state.sym=!state.sym; symBtn.classList.toggle('on',state.sym);
    toast(state.sym?`Mandala on · ${state.axes} axes`:'Mandala off'); requestRender(); });

  // zen
  document.getElementById('zenBtn').addEventListener('click', toggleZen);
  function toggleZen(){ document.body.classList.toggle('zen'); }

  /* ---------------- sheet menu ---------------- */
  const sheet=document.getElementById('sheet');
  document.getElementById('menuBtn').addEventListener('click', e=>{ e.stopPropagation(); sheet.classList.toggle('hidden'); });
  document.addEventListener('click', e=>{ if(!sheet.contains(e.target)) sheet.classList.add('hidden'); });
  sheet.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',()=>{
    const a=b.dataset.act; sheet.classList.add('hidden');
    if(a==='home'){ cam.x=0;cam.y=0;cam.scale=1;updateHud();requestRender();saveSoon(); }
    else if(a==='theme'){ state.theme=state.theme==='dark'?'light':'dark'; requestRender(); saveSoon(); }
    else if(a==='grid'){ state.grid=!state.grid; requestRender(); saveSoon(); }
    else if(a==='symaxes'){ cycleAxes(); }
    else if(a==='png') exportPNG();
    else if(a==='svg') exportSVG();
    else if(a==='share') shareImage();
    else if(a==='replay') startReplay();
    else if(a==='seal') openSeal();
    else if(a==='clear'){ if(confirm('Clear the whole canvas? This cannot be undone.')){ strokes=[];opSizes=[];redoStack=[];requestRender();save(); } }
  }));
  const axesLabel=document.getElementById('axesLabel');
  function cycleAxes(){ const opts=[2,3,4,6,8,12]; state.axes=opts[(opts.indexOf(state.axes)+1)%opts.length];
    axesLabel.textContent=state.axes; if(!state.sym){ state.sym=true; symBtn.classList.add('on'); }
    toast(`Mandala · ${state.axes} axes`); requestRender(); saveSoon(); }
  axesLabel.textContent=state.axes;

  /* ---------------- ink seal (hanko) ---------------- */
  const sealModal=document.getElementById('sealModal'), sealInput=document.getElementById('sealInput'),
        sealCanvas=document.getElementById('sealCanvas');
  function openSeal(){ sealModal.classList.remove('hidden'); if(!sealInput.value) sealInput.value='円相'; renderSeal(sealInput.value); sealInput.focus(); sealInput.select(); }
  sealInput.addEventListener('input',()=>renderSeal(sealInput.value));
  document.getElementById('sealClose').addEventListener('click',()=>sealModal.classList.add('hidden'));
  document.getElementById('sealDownload').addEventListener('click',()=>{ renderSeal(sealInput.value);
    sealCanvas.toBlob(b=>downloadBlob(b, 'enso-seal.png')); });
  document.getElementById('sealStamp').addEventListener('click',()=>{
    renderSeal(sealInput.value);
    const dataURL=sealCanvas.toDataURL('image/png');
    const img=new Image(); img.onload=()=>{ requestRender(); };
    img.src=dataURL;
    state.pendingSeal={ dataURL, img };
    sealModal.classList.add('hidden'); document.body.classList.add('stamping');
    toast('Tap on the canvas to place your seal');
  });
  function clearPendingSeal(){ state.pendingSeal=null; document.body.classList.remove('stamping'); }
  function placeSeal(sx, sy){
    const w=toWorld(sx,sy); const size=90/cam.scale;
    const st=makeStamp(state.pendingSeal.dataURL, w.x, w.y, size, state.pendingSeal.img);
    redoStack.length=0; commit([st]); clearPendingSeal(); requestRender();
  }
  function makeStamp(dataURL, x, y, size, img){
    const st={ tool:'stamp', dataURL, x, y, size };
    st.bb={minX:x-size/2,minY:y-size/2,maxX:x+size/2,maxY:y+size/2};
    st._img = img || (()=>{ const im=new Image(); im.onload=()=>requestRender(); im.src=dataURL; return im; })();
    return st;
  }

  function renderSeal(text){
    const c=sealCanvas, x=c.getContext('2d'), S=c.width; x.clearRect(0,0,S,S);
    const name=(text||'円相').trim()||'円相';
    const rnd=mulberry32(hashStr(name));
    const reds=['#c8202a','#b81f28','#d1382f','#a51c25','#cf3b2e'];
    const ink=reds[Math.floor(rnd()*reds.length)];
    const round=rnd()>0.45;
    const pad=22, box=S-pad*2, bw=Math.round(10+rnd()*4);
    x.save(); x.translate(S/2,S/2); x.rotate((rnd()-0.5)*0.05); x.translate(-S/2,-S/2);
    x.strokeStyle=ink; x.fillStyle=ink; x.lineJoin='round';
    // border
    x.lineWidth=bw;
    if(round){ x.beginPath(); x.arc(S/2,S/2,box/2,0,7); x.stroke(); }
    else { roundRect(x,pad,pad,box,box,14); x.stroke(); }
    // characters
    const chars=[...name].slice(0,4);
    const cells = chars.length<=1 ? [[0,0,1]] :
      chars.length===2 ? [[0,-1,1],[0,1,1]] :
      [[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]].slice(0,chars.length);
    const inner=box-bw*2-14, unit=inner/2, cx=S/2, cy=S/2;
    x.textAlign='center'; x.textBaseline='middle';
    chars.forEach((ch,i)=>{
      const [gx,gy]=cells[i]; const single=chars.length<=1;
      const fs = single?Math.round(inner*0.72):Math.round(unit*0.92);
      x.font=`700 ${fs}px "Yu Mincho","Hiragino Mincho ProN","MS Mincho",serif`;
      const px = cx + (single?0:gx*unit/2), py = cy + (single?0:gy*unit/2) + (chars.length===2? gy*unit*0.02:0);
      x.save(); x.translate(px,py); x.rotate((rnd()-0.5)*0.04); x.fillText(ch,0,0); x.restore();
    });
    x.restore();
    // carved / aged texture (punch out flecks)
    x.globalCompositeOperation='destination-out';
    for(let i=0;i<220;i++){ const rx=rnd()*S, ry=rnd()*S, rr=rnd()*1.6; x.beginPath(); x.arc(rx,ry,rr,0,7); x.fill(); }
    x.globalCompositeOperation='source-over';
  }

  /* ---------------- replay + record ---------------- */
  const replay={ active:false, revealed:0, total:0, playing:false, last:0, raf:0, dur:6, rec:null, chunks:[] };
  const replayBar=document.getElementById('replayBar');
  const rSeek=document.getElementById('replaySeek'), rToggle=document.getElementById('replayToggle'),
        rRec=document.getElementById('replayRec');
  function totalUnits(){ let n=0; for(const s of strokes) n += s.tool==='stamp'?1:Math.max(1,s.pts.length); return n; }
  function startReplay(){
    if(!strokes.length){ toast('Draw something first ✍️'); return; }
    replay.total=totalUnits(); replay.revealed=0; replay.active=true; replay.playing=true; replay.last=performance.now();
    replay.dur=clamp(replay.total/140, 2.5, 12);
    replayBar.classList.remove('hidden'); rToggle.textContent='⏸'; document.body.classList.add('zen');
    cancelAnimationFrame(replay.raf); loopReplay();
  }
  function loopReplay(){
    const now=performance.now();
    if(replay.playing){
      const rate=replay.total/(replay.dur*1000);
      replay.revealed=Math.min(replay.total, replay.revealed + (now-replay.last)*rate);
      if(replay.revealed>=replay.total){ replay.revealed=replay.total; replay.playing=false; rToggle.textContent='↺';
        if(replay.rec) stopRecording(); }
    }
    replay.last=now;
    rSeek.value=Math.round(replay.revealed/replay.total*1000)||0;
    render();
    if(replay.active) replay.raf=requestAnimationFrame(loopReplay);
  }
  rToggle.addEventListener('click',()=>{
    if(replay.revealed>=replay.total){ replay.revealed=0; }
    replay.playing=!replay.playing; replay.last=performance.now();
    rToggle.textContent=replay.playing?'⏸':'▶';
  });
  rSeek.addEventListener('input',()=>{ replay.playing=false; rToggle.textContent='▶'; replay.revealed=(+rSeek.value/1000)*replay.total; });
  document.getElementById('replayExit').addEventListener('click', exitReplay);
  function exitReplay(){ replay.active=false; replay.playing=false; cancelAnimationFrame(replay.raf);
    if(replay.rec) stopRecording(); replayBar.classList.add('hidden'); document.body.classList.remove('zen'); requestRender(); }

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
    // ink on its own transparent buffer so the eraser only removes ink
    const ink=document.createElement('canvas'); ink.width=out.width; ink.height=out.height;
    const i=ink.getContext('2d');
    i.setTransform(scale,0,0,scale,-bb.minX*scale,-bb.minY*scale);
    for(const s of strokes){ if(s.tool==='stamp') drawStampItem(i,s); else drawStroke(i,s,0); }
    o.drawImage(ink,0,0);
    return out;
  }

  function exportPNG(){ const out=renderToCanvas(); if(!out){ toast('Nothing to export yet'); return; }
    out.toBlob(b=>downloadBlob(b,'enso-'+stamp()+'.png'),'image/png'); }

  async function shareImage(){
    const out=renderToCanvas(); if(!out){ toast('Draw something first ✍️'); return; }
    out.toBlob(async blob=>{
      const file=new File([blob],'enso-'+stamp()+'.png',{type:'image/png'});
      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{ await navigator.share({ files:[file], title:'Ensō', text:'Made with Ensō 円相' }); }
        catch(e){ /* user cancelled */ }
      } else if(navigator.clipboard && window.ClipboardItem){
        try{ await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]); toast('Image copied to clipboard 📋'); }
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
      const fill = s.tool==='eraser' ? paperColor() : s.color;
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

  /* ---------------- keyboard ---------------- */
  addEventListener('keydown', e=>{
    if(e.target && /input|textarea/i.test(e.target.tagName)) return;
    if(e.code==='Space' && !spaceDown){ spaceDown=true; document.body.classList.add('pan'); return; }
    if(e.ctrlKey||e.metaKey){
      const k=e.key.toLowerCase();
      if(k==='z'&&!e.shiftKey){ e.preventDefault(); undo(); }
      else if((k==='z'&&e.shiftKey)||k==='y'){ e.preventDefault(); redo(); }
      return;
    }
    const k=e.key.toLowerCase();
    if(k==='b') selectTool('brush'); else if(k==='p') selectTool('pen');
    else if(k==='m') selectTool('marker'); else if(k==='e') selectTool('eraser');
    else if(k==='h') selectTool('pan'); else if(k==='z') toggleZen();
    else if(k==='s'){ symBtn.click(); } else if(k==='escape'){ clearPendingSeal(); if(replay.active) exitReplay(); }
  });
  addEventListener('keyup', e=>{ if(e.code==='Space'){ spaceDown=false; if(state.tool!=='pan') document.body.classList.remove('pan'); } });

  /* ---------------- helpers ---------------- */
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function r2(n){ return Math.round(n*100)/100; }
  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
  function hashStr(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
  function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function downloadBlob(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }
  function stamp(){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  const hud=document.getElementById('hud');
  function updateHud(){ hud.textContent = cam.scale>=1 ? Math.round(cam.scale*100)+'%' : (cam.scale*100).toFixed(cam.scale<0.1?1:0)+'%'; }
  let toastT; function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); t.style.opacity='1';
    clearTimeout(toastT); toastT=setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.classList.add('hidden'),300); }, 1900); }
  let hintT=setTimeout(hideHint,6500); function hideHint(){ const h=document.getElementById('hint'); if(h) h.style.opacity='0'; clearTimeout(hintT); }

  /* ---------------- boot ---------------- */
  load(); selectTool(state.tool); updateHud();
  addEventListener('resize', resize); resize();
  addEventListener('beforeunload', save);
  if('serviceWorker' in navigator) addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
})();
