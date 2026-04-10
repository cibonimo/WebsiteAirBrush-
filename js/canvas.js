/* ================================================================
   canvas.js — AirBrush  (Full rewrite — all bugs fixed)
   FIXES:
   ✔ Gesture detection relaxed (index finger draws reliably)
   ✔ Eraser works continuously without resetting every frame
   ✔ Mouse mode draws correctly with proper scaled coordinates
   ✔ AI generation uses FLUX.1-schnell (fast, free, reliable)
   ✔ Page scrollable after Done Sketching
================================================================ */
'use strict';

/* AUTH GUARD */
(function checkAuth() {
  try {
    const cur = JSON.parse(localStorage.getItem('ab_current') || 'null');
    if (!cur || !cur.email) { window.location.href = 'login.html'; }
  } catch { window.location.href = 'login.html'; }
})();

/* PARTICLES */
(function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function makeP() { return { x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.8+0.4, vx:(Math.random()-0.5)*0.4, vy:(Math.random()-0.5)*0.4, a:Math.random()*0.5+0.15 }; }
  function init() { resize(); particles = Array.from({length:100}, makeP); }
  function draw() {
    ctx.clearRect(0,0,W,H);
    for (const p of particles) {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(124,58,237,${p.a})`; ctx.fill();
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0||p.x>W) p.vx*=-1; if(p.y<0||p.y>H) p.vy*=-1;
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', resize);
  init(); draw();
})();

/* ELEMENT REFS */
const webcamEl       = document.getElementById('webcam');
const overlayCanvas  = document.getElementById('overlay-canvas');
const overlayCtx     = overlayCanvas.getContext('2d');
const camTraceCanvas = document.getElementById('cam-trace-canvas');
const camTraceCtx    = camTraceCanvas.getContext('2d');
const drawCanvas     = document.getElementById('draw-canvas');
const drawCtx        = drawCanvas.getContext('2d');
const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const gestureInd     = document.getElementById('gesture-indicator');
const navUser        = document.getElementById('nav-user');
const btnStart       = document.getElementById('btn-start');
const btnStop        = document.getElementById('btn-stop');
const btnUndo        = document.getElementById('btn-undo');
const btnRedo        = document.getElementById('btn-redo');
const btnClear       = document.getElementById('btn-clear');
const btnAirMode     = document.getElementById('btn-air-mode');
const btnMouseMode   = document.getElementById('btn-mouse-mode');
const btnBrush       = document.getElementById('btn-brush');
const btnEraser      = document.getElementById('btn-eraser');
const brushSizeEl    = document.getElementById('brush-size');
const sizeLabelEl    = document.getElementById('size-label');
const btnDone        = document.getElementById('btn-done-drawing');
const genSection     = document.getElementById('gen-section');
const btnLogout      = document.getElementById('btn-logout');

/* DRAWING STATE */
let mode         = 'air';
let tool         = 'brush';
let currentColor = '#7C3AED';
let currentSize  = 4;
let undoStack    = [];
let redoStack    = [];

/* Air-draw state */
let airIsDrawing   = false;
let airLastGesture = '';

/* Mouse state */
let mouseIsDrawing = false;

/* Camera / MediaPipe */
let camStream    = null;
let hands        = null;
let mediapipeCam = null;
let camRunning   = false;
let trackingActive = false;

/* Cam-trace strokes */
let camTraceStrokes  = [];
let currentCamStroke = null;

/* USER */
try {
  const cur = JSON.parse(localStorage.getItem('ab_current') || '{}');
  if (cur.name && navUser) navUser.textContent = '👤 ' + cur.name;
} catch {}

btnLogout?.addEventListener('click', () => {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  localStorage.removeItem('ab_current');
  window.location.href = 'index.html';
});

/* CANVAS RESIZE */
function resizeCanvases() {
  const drawBox = drawCanvas.parentElement;
  const DW = drawBox.clientWidth  || 640;
  const DH = drawBox.clientHeight || 480;
  if (drawCanvas.width !== DW || drawCanvas.height !== DH) {
    const snap = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    drawCanvas.width  = DW;
    drawCanvas.height = DH;
    if (snap.width > 0 && snap.height > 0) {
      try { drawCtx.putImageData(snap, 0, 0); } catch(e) {}
    }
  }
  const camBox = overlayCanvas.parentElement;
  const CW = camBox.clientWidth  || 640;
  const CH = camBox.clientHeight || 480;
  overlayCanvas.width   = CW; overlayCanvas.height  = CH;
  camTraceCanvas.width  = CW; camTraceCanvas.height = CH;
  replayCamTraceStrokes();
}
window.addEventListener('resize', () => setTimeout(resizeCanvases, 80));
setTimeout(resizeCanvases, 350);

/* UNDO / REDO */
function saveUndo() {
  undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
}

btnUndo?.addEventListener('click', () => {
  if (!undoStack.length) return;
  redoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
  drawCtx.putImageData(undoStack.pop(), 0, 0);
});

btnRedo?.addEventListener('click', () => {
  if (!redoStack.length) return;
  undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
  drawCtx.putImageData(redoStack.pop(), 0, 0);
});

btnClear?.addEventListener('click', () => {
  saveUndo();
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  camTraceStrokes = []; currentCamStroke = null;
  camTraceCtx.clearRect(0, 0, camTraceCanvas.width, camTraceCanvas.height);
});

/* CAM-TRACE */
function replayCamTraceStrokes() {
  camTraceCtx.clearRect(0, 0, camTraceCanvas.width, camTraceCanvas.height);
  for (const stroke of camTraceStrokes) {
    if (stroke.points.length < 2) continue;
    camTraceCtx.save();
    camTraceCtx.globalCompositeOperation = stroke.isErase ? 'destination-out' : 'source-over';
    camTraceCtx.globalAlpha = stroke.isErase ? 1 : 0.7;
    camTraceCtx.strokeStyle = stroke.color;
    camTraceCtx.lineWidth   = stroke.size;
    camTraceCtx.lineCap     = 'round';
    camTraceCtx.lineJoin    = 'round';
    camTraceCtx.beginPath();
    camTraceCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      camTraceCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    camTraceCtx.stroke();
    camTraceCtx.restore();
  }
}

function finishAirStroke() {
  if (airIsDrawing) {
    airIsDrawing = false;
    drawCtx.globalAlpha = 1;
    drawCtx.globalCompositeOperation = 'source-over';
  }
  if (currentCamStroke) {
    if (currentCamStroke.points.length >= 2) camTraceStrokes.push(currentCamStroke);
    currentCamStroke = null;
  }
}

/* MOUSE MODE
   Uses getBoundingClientRect + scale factor so coords are always correct
   regardless of CSS vs canvas pixel dimensions. */
function getScaledPos(e, canvas) {
  const r     = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / r.width;
  const scaleY = canvas.height / r.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
}

function applyMouseBrush() {
  drawCtx.globalCompositeOperation = (tool === 'eraser') ? 'destination-out' : 'source-over';
  drawCtx.globalAlpha = 1;
  drawCtx.strokeStyle = (tool === 'eraser') ? 'rgba(0,0,0,1)' : currentColor;
  drawCtx.lineWidth   = currentSize;
  drawCtx.lineCap     = 'round';
  drawCtx.lineJoin    = 'round';
}

drawCanvas.addEventListener('mousedown', e => {
  if (mode !== 'mouse') return;
  e.preventDefault();
  saveUndo();
  const {x,y} = getScaledPos(e, drawCanvas);
  mouseIsDrawing = true;
  applyMouseBrush();
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
});

drawCanvas.addEventListener('mousemove', e => {
  if (mode !== 'mouse' || !mouseIsDrawing) return;
  e.preventDefault();
  const {x,y} = getScaledPos(e, drawCanvas);
  drawCtx.lineTo(x, y);
  drawCtx.stroke();
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
});

function endMouseDraw() {
  mouseIsDrawing = false;
  drawCtx.globalAlpha = 1;
  drawCtx.globalCompositeOperation = 'source-over';
}
drawCanvas.addEventListener('mouseup',    endMouseDraw);
drawCanvas.addEventListener('mouseleave', endMouseDraw);

/* Touch for mobile/trackpad */
drawCanvas.addEventListener('touchstart', e => {
  if (mode !== 'mouse') return;
  e.preventDefault();
  saveUndo();
  const {x,y} = getScaledPos(e, drawCanvas);
  mouseIsDrawing = true;
  applyMouseBrush();
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
}, {passive:false});
drawCanvas.addEventListener('touchmove', e => {
  if (mode !== 'mouse' || !mouseIsDrawing) return;
  e.preventDefault();
  const {x,y} = getScaledPos(e, drawCanvas);
  drawCtx.lineTo(x, y);
  drawCtx.stroke();
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
}, {passive:false});
drawCanvas.addEventListener('touchend', () => { mouseIsDrawing = false; }, {passive:false});

/* CONTROL PANEL */
btnAirMode?.addEventListener('click', () => {
  mode = 'air';
  btnAirMode.classList.add('active'); btnMouseMode.classList.remove('active');
  drawCanvas.style.cursor = 'default';
});
btnMouseMode?.addEventListener('click', () => {
  mode = 'mouse';
  btnMouseMode.classList.add('active'); btnAirMode.classList.remove('active');
  drawCanvas.style.cursor = 'crosshair';
});
btnBrush?.addEventListener('click',  () => { tool='brush';  btnBrush.classList.add('active');  btnEraser.classList.remove('active'); });
btnEraser?.addEventListener('click', () => { tool='eraser'; btnEraser.classList.add('active'); btnBrush.classList.remove('active'); });

brushSizeEl?.addEventListener('input', e => {
  currentSize = parseInt(e.target.value);
  if (sizeLabelEl) sizeLabelEl.textContent = currentSize;
});

document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    currentColor = s.dataset.color;
  });
});

/* MEDIAPIPE HANDS */
function initHands() {
  hands = new Hands({ locateFile: f => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + f });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });
  hands.onResults(onHandResults);
}

/* GESTURE DETECTION — relaxed, no thumb requirement
   index only  → draw
   index+middle → erase
   all 4 fingers → pause
*/
function detectGesture(lm) {
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  const up = tips.map((t, i) => lm[t].y < lm[pips[i]].y);
  // Palm: all 4 fingers up
  if (up[0] && up[1] && up[2] && up[3]) return 'palm';
  // Peace (erase): index + middle up, ring + pinky down
  if (up[0] && up[1] && !up[2] && !up[3]) return 'peace';
  // Index (draw): index up, middle down
  if (up[0] && !up[1]) return 'index';
  return 'other';
}

function onHandResults(results) {
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, W, H);

  if (!trackingActive) { finishAirStroke(); return; }

  if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
    finishAirStroke();
    showGesture('');
    airLastGesture = '';
    return;
  }

  const lm = results.multiHandLandmarks[0];

  /* Draw skeleton — overlay has CSS scaleX(-1) so raw coords auto-mirror */
  drawConnectors(overlayCtx, lm, HAND_CONNECTIONS, { color: 'rgba(124,58,237,0.9)', lineWidth: 2 });
  drawLandmarks(overlayCtx, lm, { color: '#06B6D4', lineWidth: 1, radius: 3 });

  const gesture = detectGesture(lm);

  /* Raw coords for overlay/cam-trace (CSS mirrors them to selfie position) */
  const rawX = lm[8].x * W;
  const rawY = lm[8].y * H;

  /* Mirrored coords for draw-canvas (no CSS flip on draw canvas) */
  const drawX = (1 - lm[8].x) * drawCanvas.width;
  const drawY = lm[8].y        * drawCanvas.height;

  /* If gesture changed, finish previous stroke */
  if (gesture !== airLastGesture) {
    finishAirStroke();
    airLastGesture = gesture;
  }

  if (gesture === 'index') {
    /* === DRAW === */
    if (mode !== 'air') { showGesture('(Air Draw mode off)'); return; }

    if (!airIsDrawing) {
      saveUndo();
      airIsDrawing = true;
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.globalAlpha = 1;
      drawCtx.strokeStyle = currentColor;
      drawCtx.lineWidth   = currentSize;
      drawCtx.lineCap     = 'round';
      drawCtx.lineJoin    = 'round';
      drawCtx.beginPath();
      drawCtx.moveTo(drawX, drawY);
      currentCamStroke = { points:[{x:rawX,y:rawY}], color:currentColor, size:currentSize, isErase:false };
    } else {
      /* Continue drawing */
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.globalAlpha = 1;
      drawCtx.strokeStyle = currentColor;
      drawCtx.lineWidth   = currentSize;
      drawCtx.lineTo(drawX, drawY);
      drawCtx.stroke();
      drawCtx.beginPath();
      drawCtx.moveTo(drawX, drawY);

      /* Incremental cam-trace — draw new segment directly */
      if (currentCamStroke) {
        const pts = currentCamStroke.points;
        currentCamStroke.points.push({x:rawX, y:rawY});
        const len = pts.length;
        if (len >= 2) {
          camTraceCtx.save();
          camTraceCtx.globalCompositeOperation = 'source-over';
          camTraceCtx.globalAlpha = 0.7;
          camTraceCtx.strokeStyle = currentColor;
          camTraceCtx.lineWidth   = currentSize;
          camTraceCtx.lineCap     = 'round';
          camTraceCtx.lineJoin    = 'round';
          camTraceCtx.beginPath();
          camTraceCtx.moveTo(pts[len-2].x, pts[len-2].y);
          camTraceCtx.lineTo(pts[len-1].x, pts[len-1].y);
          camTraceCtx.stroke();
          camTraceCtx.restore();
        }
      }
    }

    /* Fingertip dot on overlay */
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.arc(rawX, rawY, Math.max(currentSize/2, 4)+2, 0, Math.PI*2);
    overlayCtx.fillStyle   = currentColor;
    overlayCtx.globalAlpha = 0.9;
    overlayCtx.fill();
    overlayCtx.restore();
    showGesture('✏️ Drawing');

  } else if (gesture === 'peace') {
    /* === ERASE === */
    if (mode !== 'air') { showGesture('(Air Draw mode off)'); return; }

    const eraseSize = Math.max(currentSize * 2.5, 20);

    if (!airIsDrawing) {
      saveUndo();
      airIsDrawing = true;
      currentCamStroke = { points:[{x:rawX,y:rawY}], color:'#000', size:eraseSize, isErase:true };
    } else {
      /* Continue erasing — line erase from last point to current */
      if (currentCamStroke && currentCamStroke.points.length > 0) {
        const pts  = currentCamStroke.points;
        const last = pts[pts.length - 1];

        /* Erase on draw-canvas — convert last raw point to draw coords */
        const lastDrawX = (1 - last.x / W) * drawCanvas.width;
        const lastDrawY = (last.y / H)      * drawCanvas.height;

        drawCtx.save();
        drawCtx.globalCompositeOperation = 'destination-out';
        drawCtx.globalAlpha = 1;
        drawCtx.strokeStyle = 'rgba(0,0,0,1)';
        drawCtx.lineWidth   = eraseSize;
        drawCtx.lineCap     = 'round';
        drawCtx.lineJoin    = 'round';
        drawCtx.beginPath();
        drawCtx.moveTo(lastDrawX, lastDrawY);
        drawCtx.lineTo(drawX, drawY);
        drawCtx.stroke();
        drawCtx.restore();

        /* Erase on cam-trace */
        camTraceCtx.save();
        camTraceCtx.globalCompositeOperation = 'destination-out';
        camTraceCtx.globalAlpha = 1;
        camTraceCtx.strokeStyle = 'rgba(0,0,0,1)';
        camTraceCtx.lineWidth   = eraseSize;
        camTraceCtx.lineCap     = 'round';
        camTraceCtx.beginPath();
        camTraceCtx.moveTo(last.x, last.y);
        camTraceCtx.lineTo(rawX, rawY);
        camTraceCtx.stroke();
        camTraceCtx.restore();

        currentCamStroke.points.push({x:rawX, y:rawY});
      }
    }

    /* Eraser ring on overlay */
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.arc(rawX, rawY, eraseSize/2 + 4, 0, Math.PI*2);
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    overlayCtx.lineWidth   = 2;
    overlayCtx.stroke();
    overlayCtx.restore();
    showGesture('⬜ Erasing');

  } else if (gesture === 'palm') {
    finishAirStroke();
    showGesture('🖐 Paused');
  } else {
    finishAirStroke();
    showGesture('');
  }
}

let gestureTimer;
function showGesture(text) {
  if (!gestureInd) return;
  if (!text) { gestureInd.classList.remove('visible'); return; }
  gestureInd.textContent = text;
  gestureInd.classList.add('visible');
  clearTimeout(gestureTimer);
  gestureTimer = setTimeout(() => gestureInd.classList.remove('visible'), 1800);
}

/* START / STOP */
btnStart?.addEventListener('click', async () => {
  if (camRunning) {
    trackingActive = true;
    setStatus('green', '✅ Tracking — raise index finger to draw');
    btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
    return;
  }
  setStatus('yellow', 'Starting camera…');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: {ideal:640}, height: {ideal:480}, facingMode: 'user' }
    });
    webcamEl.srcObject = camStream;
    await new Promise(r => webcamEl.addEventListener('loadedmetadata', r, {once:true}));
    await webcamEl.play().catch(()=>{});

    const vw = webcamEl.videoWidth  || 640;
    const vh = webcamEl.videoHeight || 480;
    overlayCanvas.width   = vw; overlayCanvas.height  = vh;
    camTraceCanvas.width  = vw; camTraceCanvas.height = vh;

    if (!hands) initHands();
    mediapipeCam = new Camera(webcamEl, {
      onFrame: async () => { if (hands) await hands.send({ image: webcamEl }); },
      width: 640, height: 480
    });
    mediapipeCam.start();
    camRunning     = true;
    trackingActive = true;
    setStatus('green', '✅ Tracking — raise index finger to draw');
    btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
    setTimeout(resizeCanvases, 500);
  } catch(e) {
    console.error(e);
    setStatus('red', '❌ Camera denied — allow camera & reload');
    showFlash('Camera access denied — please allow camera in your browser');
  }
});

btnStop?.addEventListener('click', () => {
  trackingActive = false;
  finishAirStroke();
  setStatus('yellow', '⏸ Input paused — camera still live');
  if (btnStart) btnStart.disabled = false;
  if (btnStop)  btnStop.disabled  = true;
});

function setStatus(color, msg) {
  const map = { green:'#22c55e', yellow:'#f59e0b', red:'#ef4444' };
  if (statusDot)  statusDot.style.background = map[color] || '#6b7280';
  if (statusText) statusText.textContent = msg;
}

window.addEventListener('beforeunload', () => {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
});

/* DONE SKETCHING — unlock scroll */
btnDone?.addEventListener('click', () => {
  if (!genSection) return;
  genSection.style.display = '';
  /* Remove overflow locks so the page can scroll freely */
  document.body.style.overflow        = 'auto';
  document.body.style.height          = 'auto';
  document.documentElement.style.overflow = 'auto';
  document.documentElement.style.height   = 'auto';
  const layout = document.querySelector('.canvas-layout');
  if (layout) layout.style.overflow = 'visible';
  setTimeout(() => genSection.scrollIntoView({ behavior:'smooth', block:'start' }), 80);
});

/* HF TOKEN */
const hfTokenInput = document.getElementById('hf-token');
const btnSaveToken = document.getElementById('btn-save-token');
if (hfTokenInput) {
  const saved = localStorage.getItem('hf_token');
  if (saved) hfTokenInput.value = saved;
}
btnSaveToken?.addEventListener('click', () => {
  const t = hfTokenInput?.value.trim();
  if (t) { localStorage.setItem('hf_token', t); showFlash('✅ Token saved!'); }
});
function getHFToken() { return (hfTokenInput?.value.trim() || localStorage.getItem('hf_token') || '').trim(); }

/* VOICE INPUT */
const btnVoice    = document.getElementById('btn-voice');
const aiDescInput = document.getElementById('ai-description');
const interimEl   = document.getElementById('interim-text');
let recognition = null, recActive = false;
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false; recognition.interimResults = true; recognition.lang = 'en-US';
  recognition.onstart  = () => { recActive=true; btnVoice?.classList.add('listening'); if(btnVoice) btnVoice.textContent='🔴'; if(interimEl) interimEl.textContent='Listening…'; };
  recognition.onresult = e => {
    let interim='', final='';
    for (let i=e.resultIndex;i<e.results.length;i++) { const t=e.results[i][0].transcript; if(e.results[i].isFinal) final+=t; else interim+=t; }
    if(interimEl) interimEl.textContent=interim||'';
    if(final && aiDescInput) { aiDescInput.value+=(aiDescInput.value?' ':'')+final.trim(); if(interimEl) interimEl.textContent=''; }
  };
  recognition.onerror = () => stopListening();
  recognition.onend   = stopListening;
}
function stopListening() { recActive=false; btnVoice?.classList.remove('listening'); if(btnVoice) btnVoice.textContent='🎤'; }
btnVoice?.addEventListener('click', () => {
  if (!recognition) { showFlash('Speech recognition not supported in this browser'); return; }
  if (recActive) recognition.stop(); else recognition.start();
});

/* AI IMAGE GENERATION
   Primary engine : Pollinations.AI — 100% free, no API key needed, uses real FLUX
   Fallback        : HuggingFace (if user has a valid token)
*/
const btnGenerate   = document.getElementById('btn-generate');
const aiPlaceholder = document.getElementById('ai-placeholder');
const aiLoading     = document.getElementById('ai-loading');
const aiLoadingText = document.getElementById('ai-loading-text');
const aiError       = document.getElementById('ai-error');
const aiImgWrap     = document.getElementById('ai-img-wrap');
const aiResultImg   = document.getElementById('ai-result-img');
const btnStick      = document.getElementById('btn-stick-it');

const NEG_PROMPT = 'blurry, low quality, ugly, distorted, deformed, text, watermark, cartoon, anime';

btnGenerate?.addEventListener('click', async () => {
  const userDesc = aiDescInput?.value.trim() || '';

  /* Build a clean, descriptive prompt from whatever the user typed.
     If nothing typed, fall back to generic art prompt. */
  const prompt = userDesc
    ? userDesc + ', high quality, detailed, sharp, digital art, 8k'
    : 'beautiful abstract colorful art, vibrant, high quality, detailed';

  setGenLoading(true, '🎨 Generating your image…');
  hideAiError();
  if (aiPlaceholder) aiPlaceholder.style.display = 'none';
  if (aiImgWrap)     aiImgWrap.style.display      = 'none';
  if (btnStick)      btnStick.style.display        = 'none';

  try {
    const imgUrl = await runGeneration(prompt, getHFToken());
    setGenLoading(false);
    aiResultImg.src         = imgUrl;
    aiImgWrap.style.display = '';
    btnStick.style.display  = '';
    btnStick._aiUrl         = imgUrl;
    btnStick._sketchUrl     = drawCanvas.toDataURL('image/png');
    btnStick._description   = userDesc;
  } catch(e) {
    setGenLoading(false);
    showAiError('Generation failed: ' + e.message);
    console.error(e);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   runGeneration
   1. Pollinations.AI — free, no key, real FLUX model, always works
   2. HuggingFace FLUX  — fallback if user has a valid HF token
   3. HuggingFace SDXL  — second fallback
   ───────────────────────────────────────────────────────────────────────── */
function runGeneration(prompt, hfToken) {
  return new Promise(async (resolve, reject) => {

    /* ── 1. Pollinations.AI ─────────────────────────────────────────────
       Simple GET request. The URL *is* the image — no API key required.
       Model: flux (default), width/height 768, random seed each call.
    ─────────────────────────────────────────────────────────────────────── */
    setGenLoading(true, '🎨 Generating via Pollinations (FLUX)… usually 15–30s');
    try {
      const seed = Math.floor(Math.random() * 2147483647);
      const url  = 'https://image.pollinations.ai/prompt/'
                 + encodeURIComponent(prompt)
                 + '?width=768&height=768&nologo=true&seed=' + seed
                 + '&model=flux&enhance=false';

      await new Promise((imgResolve, imgReject) => {
        const img     = new Image();
        const timeout = setTimeout(() => {
          img.src = '';
          imgReject(new Error('Pollinations timed out after 90s'));
        }, 90000);

        img.onload = () => {
          clearTimeout(timeout);
          imgResolve();
        };
        img.onerror = () => {
          clearTimeout(timeout);
          imgReject(new Error('Pollinations image failed to load'));
        };
        img.src = url;   // triggers the generation + download
      });

      // Image loaded successfully — use the URL directly as the src
      return resolve(
        'https://image.pollinations.ai/prompt/'
        + encodeURIComponent(prompt)
        + '?width=768&height=768&nologo=true&seed=' + seed
        + '&model=flux&enhance=false'
      );

    } catch(e) {
      console.warn('Pollinations failed:', e.message);
    }

    /* ── 2. HuggingFace FLUX (fallback, needs token) ───────────────────── */
    if (hfToken) {
      const hdrs = {
        'Authorization': 'Bearer ' + hfToken,
        'Content-Type' : 'application/json',
        'x-use-cache'  : 'false'
      };
      try {
        setGenLoading(true, '⚡ Trying HuggingFace FLUX…');
        const res = await timedFetch(
          'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
          { method:'POST', headers:hdrs, body:JSON.stringify({
            inputs    : prompt,
            parameters: { num_inference_steps: 4, guidance_scale: 0 },
            options   : { wait_for_model: true, use_cache: false }
          })},
          90000
        );
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 500 && blob.type.startsWith('image/')) {
            return resolve(URL.createObjectURL(blob));
          }
        }
        const errText = await res.text().catch(() => '');
        console.warn('HF FLUX failed', res.status, errText.slice(0, 200));
      } catch(e) { console.warn('HF FLUX error:', e.message); }

      /* ── 3. HuggingFace SDXL (last resort) ─────────────────────────── */
      try {
        setGenLoading(true, '🎨 Trying SDXL… (may take 30–60s)');
        const hdrs2 = {
          'Authorization': 'Bearer ' + hfToken,
          'Content-Type' : 'application/json'
        };
        const res = await timedFetch(
          'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
          { method:'POST', headers:hdrs2, body:JSON.stringify({
            inputs    : prompt,
            parameters: { num_inference_steps:25, guidance_scale:7.5, negative_prompt:NEG_PROMPT },
            options   : { wait_for_model: true, use_cache: false }
          })},
          120000
        );
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 500 && blob.type.startsWith('image/')) {
            return resolve(URL.createObjectURL(blob));
          }
        }
        console.warn('SDXL failed', res.status);
      } catch(e) { console.warn('SDXL error:', e.message); }
    }

    reject(new Error(
      hfToken
        ? 'All generation methods failed. Check your internet connection and try again.'
        : 'Pollinations.AI is temporarily unavailable. Please try again in a moment.\n\nAlternatively, add a HuggingFace token above as a backup option.'
    ));
  });
}

/* Convert the draw canvas into a 512×512 scribble for ControlNet (kept for future use).
   Returns raw base64 PNG or null if canvas is blank. */
function getSketchForControlNet(canvas) {
  try {
    const ctx  = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasContent = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 20) { hasContent = true; break; }
    }
    if (!hasContent) return null;
    const SIZE = 512;
    const off  = document.createElement('canvas');
    off.width  = SIZE; off.height = SIZE;
    const offCtx = off.getContext('2d');
    offCtx.fillStyle = '#000000';
    offCtx.fillRect(0, 0, SIZE, SIZE);
    offCtx.drawImage(canvas, 0, 0, SIZE, SIZE);
    const imgData = offCtx.getImageData(0, 0, SIZE, SIZE);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] > 20) { d[i]=255; d[i+1]=255; d[i+2]=255; d[i+3]=255; }
      else              { d[i]=0;   d[i+1]=0;   d[i+2]=0;   d[i+3]=255; }
    }
    offCtx.putImageData(imgData, 0, 0);
    return off.toDataURL('image/png').split(',')[1];
  } catch(e) { return null; }
}

function timedFetch(url, opts, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out after ' + (ms/1000) + 's')), ms);
    fetch(url, opts).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
  });
}

/* SAVE TO GALLERY */
btnStick?.addEventListener('click', () => {
  const { _aiUrl:aiUrl, _sketchUrl:sketchUrl, _description:desc } = btnStick;
  if (!aiUrl) return;
  try {
    const gallery = JSON.parse(localStorage.getItem('ab_gallery') || '[]');
    gallery.unshift({ aiUrl, sketchUrl, description: desc||'', ts: Date.now() });
    if (gallery.length > 50) gallery.length = 50;
    localStorage.setItem('ab_gallery', JSON.stringify(gallery));
    showFlash('📌 Saved to your Gallery!');
    btnStick.textContent = '✅ Saved!';
    btnStick.disabled    = true;
    setTimeout(() => { btnStick.textContent='📌 Save to Gallery'; btnStick.disabled=false; }, 3000);
  } catch { showFlash('Could not save — storage may be full'); }
});

/* UI HELPERS */
function setGenLoading(on, msg) {
  if (aiLoading)    aiLoading.style.display    = on ? 'flex' : 'none';
  if (aiLoadingText && msg) aiLoadingText.textContent = msg;
  if (btnGenerate)  btnGenerate.disabled        = on;
}
function showAiError(msg) {
  if (!aiError) return;
  aiError.style.whiteSpace = 'pre-line';
  aiError.textContent      = msg;
  aiError.style.display    = '';
}
function hideAiError() { if (aiError) aiError.style.display = 'none'; }

function showFlash(msg) {
  let el = document.getElementById('ab-flash');
  if (!el) {
    el = document.createElement('div'); el.id='ab-flash';
    Object.assign(el.style, {
      position:'fixed', bottom:'28px', left:'50%', transform:'translateX(-50%)',
      background:'rgba(15,15,28,0.97)', border:'1px solid rgba(255,255,255,0.15)',
      borderRadius:'50px', padding:'10px 22px', color:'#fff', fontSize:'0.9rem',
      fontWeight:'500', zIndex:'9999', opacity:'0', transition:'opacity 0.3s',
      pointerEvents:'none', whiteSpace:'nowrap', fontFamily:"'Calibri Light',Calibri,sans-serif"
    });
    document.body.appendChild(el);
  }
  el.textContent=msg; el.style.opacity='1';
  clearTimeout(el._t); el._t=setTimeout(()=>{ el.style.opacity='0'; }, 2800);
}

/* GALLERY MODAL */
const galleryModal       = document.getElementById('gallery-modal');
const galleryGrid        = document.getElementById('gallery-grid');
const galleryClose       = document.getElementById('gallery-close');
const galleryDetailModal = document.getElementById('gallery-detail-modal');
const galleryDetailClose = document.getElementById('gallery-detail-close');
const detailAiImg        = document.getElementById('detail-ai-img');
const detailSketchImg    = document.getElementById('detail-sketch-img');
const detailDesc         = document.getElementById('detail-desc');
const btnOpenGallery     = document.getElementById('btn-open-gallery');

function openGallery() {
  if (!galleryModal||!galleryGrid) return;
  const items = JSON.parse(localStorage.getItem('ab_gallery')||'[]');
  galleryGrid.innerHTML = '';
  if (!items.length) {
    galleryGrid.innerHTML = '<div class="gallery-empty">No images yet — generate some AI art and save it here!</div>';
  } else {
    items.forEach(item => {
      const div = document.createElement('div'); div.className='gallery-item';
      const img = document.createElement('img'); img.src=item.aiUrl||''; img.alt=item.description||'AI Art';
      div.appendChild(img);
      div.addEventListener('click', () => {
        detailAiImg.src     = item.aiUrl    || '';
        detailSketchImg.src = item.sketchUrl|| '';
        detailDesc.textContent   = item.description ? 'Description: '+item.description : '';
        detailDesc.style.display = item.description ? '' : 'none';
        galleryDetailModal.style.display = 'flex';
      });
      galleryGrid.appendChild(div);
    });
  }
  galleryModal.style.display = 'flex';
}

btnOpenGallery?.addEventListener('click', openGallery);
galleryClose?.addEventListener('click',       () => { galleryModal.style.display='none'; });
galleryDetailClose?.addEventListener('click', () => { galleryDetailModal.style.display='none'; });
galleryModal?.addEventListener('click',       e  => { if(e.target===galleryModal) galleryModal.style.display='none'; });
galleryDetailModal?.addEventListener('click', e  => { if(e.target===galleryDetailModal) galleryDetailModal.style.display='none'; });
