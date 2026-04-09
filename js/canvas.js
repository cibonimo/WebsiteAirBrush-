/* ================================================================
   canvas.js — AirBrush Main Canvas (fixed)
   - Selfie-mirror skeleton correctly on hand
   - Gestures: index=draw, peace=erase, palm=pause ONLY
   - Stop keeps cam alive, only pauses gesture input
   - Sketch-to-image AI generation with HF Inference API
   - "Stick it" saves to gallery with sketch + description
   - Gallery detail shows AI image + sketch + description
================================================================ */
'use strict';

/* ─── AUTH GUARD ─────────────────────────────────────────────── */
(function checkAuth() {
  try {
    const cur = JSON.parse(localStorage.getItem('ab_current') || 'null');
    if (!cur || !cur.email) { window.location.href = 'login.html'; }
  } catch { window.location.href = 'login.html'; }
})();

/* ─── PARTICLES ──────────────────────────────────────────────── */
(function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function makeP() { return { x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.8+0.4, vx:(Math.random()-0.5)*0.4, vy:(Math.random()-0.5)*0.4, a:Math.random()*0.5+0.15 }; }
  function init() { resize(); particles = Array.from({length:120}, makeP); }
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

/* ─── ELEMENT REFS ───────────────────────────────────────────── */
const webcamEl      = document.getElementById('webcam');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx    = overlayCanvas.getContext('2d');
const camTraceCanvas= document.getElementById('cam-trace-canvas');
const camTraceCtx   = camTraceCanvas.getContext('2d');
const drawCanvas    = document.getElementById('draw-canvas');
const drawCtx       = drawCanvas.getContext('2d');

const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const gestureInd    = document.getElementById('gesture-indicator');
const navUser       = document.getElementById('nav-user');

const btnStart      = document.getElementById('btn-start');
const btnStop       = document.getElementById('btn-stop');
const btnUndo       = document.getElementById('btn-undo');
const btnClear      = document.getElementById('btn-clear');
const btnAirMode    = document.getElementById('btn-air-mode');
const btnMouseMode  = document.getElementById('btn-mouse-mode');
const btnBrush      = document.getElementById('btn-brush');
const btnEraser     = document.getElementById('btn-eraser');
const brushSize     = document.getElementById('brush-size');
const brushOpacity  = document.getElementById('brush-opacity');
const sizeLabel     = document.getElementById('size-label');
const opacityLabel  = document.getElementById('opacity-label');
const colorCustom   = document.getElementById('color-custom');
const btnDone       = document.getElementById('btn-done-drawing');
const genSection    = document.getElementById('gen-section');
const btnLogout     = document.getElementById('btn-logout');

/* ─── DRAWING STATE ──────────────────────────────────────────── */
let mode           = 'air';
let tool           = 'brush';
let currentColor   = '#7C3AED';
let currentSize    = 4;
let currentOpacity = 1;
let isDrawing      = false;
let lastX = 0, lastY = 0;
let undoStack      = [];

// Camera & MediaPipe state
let camStream      = null;
let hands          = null;
let mediapipeCam   = null;
let camRunning     = false;  // is the camera physically on?
let trackingActive = false;  // are we processing gestures and drawing?

// Cam-trace overlay accumulated strokes
let camTraceStrokes = []; // [{points:[{x,y}], color, size, opacity, isErase}]
let currentCamStroke = null;

/* ─── USER INFO ──────────────────────────────────────────────── */
try {
  const cur = JSON.parse(localStorage.getItem('ab_current') || '{}');
  if (cur.name && navUser) navUser.textContent = `👤 ${cur.name}`;
} catch {}

btnLogout?.addEventListener('click', () => {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  localStorage.removeItem('ab_current');
  window.location.href = 'index.html';
});

/* ─── CANVAS RESIZE ──────────────────────────────────────────── */
function resizeCanvases() {
  const drawBox = drawCanvas.parentElement;
  const DW = drawBox.clientWidth  || 560;
  const DH = drawBox.clientHeight || 420;
  const snap = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
  drawCanvas.width = DW; drawCanvas.height = DH;
  drawCtx.putImageData(snap, 0, 0);

  const camBox = overlayCanvas.parentElement;
  const CW = camBox.clientWidth  || 560;
  const CH = camBox.clientHeight || 420;
  overlayCanvas.width  = CW; overlayCanvas.height  = CH;
  camTraceCanvas.width = CW; camTraceCanvas.height = CH;

  // Replay cam-trace strokes after resize
  replayCamTraceStrokes();
}
window.addEventListener('resize', resizeCanvases);
setTimeout(resizeCanvases, 200);

/* ─── DRAW UTILITIES ─────────────────────────────────────────── */
function saveUndo() {
  undoStack.push(drawCtx.getImageData(0,0,drawCanvas.width,drawCanvas.height));
  if (undoStack.length > 30) undoStack.shift();
}

function applyBrushStyle(ctx, isErase) {
  ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
  ctx.globalAlpha  = isErase ? 1 : currentOpacity;
  ctx.strokeStyle  = currentColor;
  ctx.lineWidth    = currentSize;
  ctx.lineCap      = 'round';
  ctx.lineJoin     = 'round';
}

/* ─── CAM-TRACE STROKES ──────────────────────────────────────── */
/* The cam-trace canvas has CSS scaleX(-1). We draw at RAW (lm.x * W)
   so after CSS flip it appears at (1-lm.x)*W — same selfie position
   as the mirrored video. This keeps cam-trace aligned with the video.   */
function replayCamTraceStrokes() {
  camTraceCtx.clearRect(0, 0, camTraceCanvas.width, camTraceCanvas.height);
  for (const stroke of camTraceStrokes) {
    if (stroke.points.length < 2) continue;
    camTraceCtx.save();
    camTraceCtx.globalCompositeOperation = stroke.isErase ? 'destination-out' : 'source-over';
    camTraceCtx.globalAlpha   = stroke.isErase ? 1 : stroke.opacity * 0.7;
    camTraceCtx.strokeStyle   = stroke.color;
    camTraceCtx.lineWidth     = stroke.size;
    camTraceCtx.lineCap       = 'round';
    camTraceCtx.lineJoin      = 'round';
    camTraceCtx.beginPath();
    camTraceCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i=1; i<stroke.points.length; i++) {
      camTraceCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    camTraceCtx.stroke();
    camTraceCtx.restore();
  }
}

function clearAllTraces() {
  camTraceStrokes = [];
  currentCamStroke = null;
  camTraceCtx.clearRect(0, 0, camTraceCanvas.width, camTraceCanvas.height);
}

/* ─── MOUSE MODE ─────────────────────────────────────────────── */
drawCanvas.addEventListener('mousedown', e => {
  if (mode !== 'mouse') return;
  saveUndo();
  const {x,y} = canvasPos(e, drawCanvas);
  isDrawing = true; lastX = x; lastY = y;
  applyBrushStyle(drawCtx, tool === 'eraser');
  drawCtx.beginPath(); drawCtx.moveTo(x, y);
});
drawCanvas.addEventListener('mousemove', e => {
  if (mode !== 'mouse' || !isDrawing) return;
  const {x,y} = canvasPos(e, drawCanvas);
  drawCtx.lineTo(x, y); drawCtx.stroke();
  drawCtx.beginPath(); drawCtx.moveTo(x, y);
  lastX = x; lastY = y;
});
drawCanvas.addEventListener('mouseup',    () => { isDrawing = false; drawCtx.globalAlpha=1; drawCtx.globalCompositeOperation='source-over'; });
drawCanvas.addEventListener('mouseleave', () => { isDrawing = false; });
function canvasPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ─── CONTROL PANEL ──────────────────────────────────────────── */
btnAirMode?.addEventListener('click',   () => { mode='air';   btnAirMode.classList.add('active'); btnMouseMode.classList.remove('active'); });
btnMouseMode?.addEventListener('click', () => { mode='mouse'; btnMouseMode.classList.add('active'); btnAirMode.classList.remove('active'); });
btnBrush?.addEventListener('click',   () => { tool='brush';  btnBrush.classList.add('active');  btnEraser.classList.remove('active'); });
btnEraser?.addEventListener('click',  () => { tool='eraser'; btnEraser.classList.add('active'); btnBrush.classList.remove('active'); });
brushSize?.addEventListener('input',  e => { currentSize = parseInt(e.target.value); if (sizeLabel) sizeLabel.textContent = currentSize; });
brushOpacity?.addEventListener('input',e => { currentOpacity = parseInt(e.target.value)/100; if (opacityLabel) opacityLabel.textContent = e.target.value; });
colorCustom?.addEventListener('input', e => { currentColor = e.target.value; });
document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    currentColor = s.dataset.color;
    if (colorCustom) colorCustom.value = currentColor;
  });
});
btnUndo?.addEventListener('click', () => {
  if (!undoStack.length) return;
  drawCtx.putImageData(undoStack.pop(), 0, 0);
});
btnClear?.addEventListener('click', () => {
  saveUndo();
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  clearAllTraces();
});

/* ─── MEDIAPIPE HANDS ────────────────────────────────────────── */
function initHands() {
  hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence: 0.75
  });
  hands.onResults(onHandResults);
}

/* Count extended fingers for one hand */
function extendedFingers(lm) {
  const up = [false,false,false,false,false];
  up[0] = lm[4].x < lm[3].x; // thumb (mirrored)
  const tips=[8,12,16,20], pips=[6,10,14,18];
  for (let i=0;i<4;i++) up[i+1] = lm[tips[i]].y < lm[pips[i]].y;
  return up;
}

/* Detect gesture from one hand landmarks */
function detectGesture(lm) {
  const up    = extendedFingers(lm);
  const count = up.filter(Boolean).length;
  if (count >= 4)                                          return 'palm';  // open palm → pause
  if (!up[0] && up[1] && up[2] && !up[3] && !up[4])      return 'peace'; // index+middle → erase
  if (!up[0] && up[1] && !up[2] && !up[3] && !up[4])     return 'index'; // index only → draw
  return 'other';
}

/* ── MAIN HAND RESULTS CALLBACK ── */
function onHandResults(results) {
  /* Always clear the skeleton overlay canvas each frame */
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, W, H);

  if (!trackingActive) {
    // Cam is on but tracking paused — end any stroke in progress
    if (isDrawing) { endStroke(); }
    if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; replayCamTraceStrokes(); }
    return;
  }

  if (!results.multiHandLandmarks?.length) {
    if (isDrawing) { endStroke(); }
    if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; replayCamTraceStrokes(); }
    showGesture('');
    return;
  }

  const lm = results.multiHandLandmarks[0];

  /* ── Draw skeleton ──────────────────────────────────────────
     overlayCanvas has CSS scaleX(-1).
     We draw at RAW lm.x coords (not mirrored in code).
     After CSS flip the skeleton appears at (1-lm.x) = selfie position,
     exactly matching where the hand is in the mirrored video.          */
  drawConnectors(overlayCtx, lm, HAND_CONNECTIONS,
    { color: 'rgba(124,58,237,0.85)', lineWidth: 2 });
  drawLandmarks(overlayCtx, lm,
    { color: '#06B6D4', lineWidth: 1, radius: 3 });

  /* ── Gesture & coordinate mapping ── */
  const gesture = detectGesture(lm);

  /* RAW tip X for overlay/cam-trace canvas (CSS will flip it to selfie pos) */
  const rawTipX = lm[8].x * W;
  const rawTipY = lm[8].y * H;

  /* MIRRORED tip X/Y for draw-canvas (no CSS flip, so we do it in code) */
  const drawX = (1 - lm[8].x) * drawCanvas.width;
  const drawY = lm[8].y       * drawCanvas.height;

  switch (gesture) {

    case 'index': {
      /* ── DRAW mode ── */
      if (mode !== 'air') break;
      tool = 'brush';
      btnBrush?.classList.add('active'); btnEraser?.classList.remove('active');

      if (!isDrawing) {
        saveUndo();
        isDrawing = true; lastX = drawX; lastY = drawY;
        applyBrushStyle(drawCtx, false);
        drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
        // Start cam-trace stroke
        currentCamStroke = {
          points: [{ x: rawTipX, y: rawTipY }],
          color: currentColor, size: currentSize,
          opacity: currentOpacity, isErase: false
        };
      } else {
        /* Continue stroke on draw-canvas */
        applyBrushStyle(drawCtx, false);
        drawCtx.lineTo(drawX, drawY); drawCtx.stroke();
        drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
        lastX = drawX; lastY = drawY;
        /* Continue cam-trace stroke */
        if (currentCamStroke) { currentCamStroke.points.push({ x: rawTipX, y: rawTipY }); replayCamTraceStrokes(); }
      }

      /* Fingertip dot on overlay */
      overlayCtx.beginPath();
      overlayCtx.arc(rawTipX, rawTipY, currentSize/2 + 3, 0, Math.PI*2);
      overlayCtx.fillStyle = currentColor;
      overlayCtx.globalAlpha = 0.8;
      overlayCtx.fill();
      overlayCtx.globalAlpha = 1;
      showGesture('✏️ Drawing');
      break;
    }

    case 'peace': {
      /* ── ERASE mode ── */
      if (isDrawing) { endStroke(); }
      if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; }
      tool = 'eraser';
      btnEraser?.classList.add('active'); btnBrush?.classList.remove('active');

      // Erase on draw-canvas
      applyBrushStyle(drawCtx, true);
      if (!isDrawing) {
        saveUndo();
        isDrawing = true;
        drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
      }
      drawCtx.lineTo(drawX, drawY); drawCtx.stroke();
      drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
      lastX = drawX; lastY = drawY;

      // Erase on cam-trace
      if (!currentCamStroke) {
        currentCamStroke = { points: [{ x: rawTipX, y: rawTipY }], color: currentColor, size: currentSize+4, opacity:1, isErase: true };
      } else {
        currentCamStroke.points.push({ x: rawTipX, y: rawTipY });
        replayCamTraceStrokes();
      }

      // Eraser cursor on overlay
      overlayCtx.beginPath();
      overlayCtx.arc(rawTipX, rawTipY, currentSize + 4, 0, Math.PI*2);
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.7)';
      overlayCtx.lineWidth   = 1.5;
      overlayCtx.stroke();
      showGesture('⬜ Erasing');
      break;
    }

    case 'palm': {
      /* ── PAUSE ── */
      if (isDrawing) { endStroke(); }
      if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; replayCamTraceStrokes(); }
      showGesture('🖐 Paused');
      break;
    }

    default: {
      if (isDrawing) { endStroke(); }
      if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; replayCamTraceStrokes(); }
      showGesture('');
    }
  }
}

function endStroke() {
  isDrawing = false;
  drawCtx.globalCompositeOperation = 'source-over';
  drawCtx.globalAlpha = 1;
}

let gestureTimeout;
function showGesture(text) {
  if (!gestureInd) return;
  if (!text) { gestureInd.classList.remove('visible'); return; }
  gestureInd.textContent = text;
  gestureInd.classList.add('visible');
  clearTimeout(gestureTimeout);
  gestureTimeout = setTimeout(() => gestureInd.classList.remove('visible'), 1500);
}

function flash(msg) {
  let el = document.getElementById('canvas-flash');
  if (!el) {
    el = document.createElement('div'); el.id = 'canvas-flash';
    Object.assign(el.style, {
      position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
      background:'rgba(0,0,0,0.75)',color:'#fff',padding:'12px 28px',
      borderRadius:'12px',fontSize:'1rem',pointerEvents:'none',
      zIndex:'9999',opacity:'0',transition:'opacity 0.3s',
      fontFamily:"'Caveat',cursive"
    });
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1400);
}

/* ─── START / STOP ───────────────────────────────────────────── */
btnStart?.addEventListener('click', async () => {
  if (camRunning) {
    // Camera already on — just resume tracking
    trackingActive = true;
    if (statusDot)  statusDot.style.background = '#22c55e';
    if (statusText) statusText.textContent = 'Tracking active';
    btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
    return;
  }

  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video:{ width:640, height:480 } });
    webcamEl.srcObject = camStream;
    await new Promise(r => webcamEl.addEventListener('loadedmetadata', r, { once:true }));

    // Set overlay and cam-trace canvas size to match video
    overlayCanvas.width  = webcamEl.videoWidth;
    overlayCanvas.height = webcamEl.videoHeight;
    camTraceCanvas.width = webcamEl.videoWidth;
    camTraceCanvas.height= webcamEl.videoHeight;

    if (!hands) initHands();
    mediapipeCam = new Camera(webcamEl, {
      onFrame: async () => { await hands.send({ image: webcamEl }); },
      width: 640, height: 480
    });
    mediapipeCam.start();
    camRunning    = true;
    trackingActive = true;

    if (statusDot)  statusDot.style.background = '#22c55e';
    if (statusText) statusText.textContent = 'Tracking active';
    btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } catch(e) {
    console.error(e);
    if (statusText) statusText.textContent = 'Camera access denied';
  }
});

btnStop?.addEventListener('click', () => {
  /* Stop gesture input but KEEP camera live */
  trackingActive = false;
  if (isDrawing) endStroke();
  if (currentCamStroke) { camTraceStrokes.push(currentCamStroke); currentCamStroke = null; replayCamTraceStrokes(); }
  if (statusDot)  statusDot.style.background = '#F59E0B';
  if (statusText) statusText.textContent = 'Input paused — cam active';
  btnStart.disabled = false;
  if (btnStop) btnStop.disabled = true;
});

/* Stop camera entirely on unload */
window.addEventListener('beforeunload', () => {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
});

/* ─── DONE DRAWING ───────────────────────────────────────────── */
btnDone?.addEventListener('click', () => {
  if (genSection) { genSection.style.display = ''; genSection.scrollIntoView({ behavior:'smooth' }); }
});

/* ─── HF TOKEN ───────────────────────────────────────────────── */
const hfTokenInput = document.getElementById('hf-token');
const btnSaveToken = document.getElementById('btn-save-token');
if (hfTokenInput) {
  const saved = localStorage.getItem('hf_token');
  if (saved) hfTokenInput.value = saved;
}
btnSaveToken?.addEventListener('click', () => {
  const t = hfTokenInput?.value.trim();
  if (t) { localStorage.setItem('hf_token', t); flash('Token saved!'); }
});
function getHFToken() {
  return (hfTokenInput?.value.trim() || localStorage.getItem('hf_token') || '').trim();
}

/* ─── VOICE INPUT ────────────────────────────────────────────── */
const btnVoice    = document.getElementById('btn-voice');
const aiDescInput = document.getElementById('ai-description');
const interimEl   = document.getElementById('interim-text');
let recognition   = null;
let recActive     = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false; recognition.interimResults = true; recognition.lang = 'en-US';
  recognition.onstart  = () => { recActive=true; btnVoice?.classList.add('listening'); if(btnVoice) btnVoice.textContent='🔴'; if(interimEl) interimEl.textContent='Listening…'; };
  recognition.onresult = (e) => {
    let interim='', final='';
    for (let i=e.resultIndex;i<e.results.length;i++) {
      const t=e.results[i][0].transcript;
      if (e.results[i].isFinal) final+=t; else interim+=t;
    }
    if(interimEl) interimEl.textContent=interim||final||'';
    if(final && aiDescInput) { aiDescInput.value+=(aiDescInput.value?' ':'')+final.trim(); if(interimEl) interimEl.textContent=''; }
  };
  recognition.onerror = () => stopListening();
  recognition.onend   = stopListening;
}
function stopListening() { recActive=false; btnVoice?.classList.remove('listening'); if(btnVoice) btnVoice.textContent='🎤'; }
btnVoice?.addEventListener('click', () => {
  if (!recognition) { flash('Speech not supported in this browser'); return; }
  if (recActive) recognition.stop(); else recognition.start();
});

/* ─── AI IMAGE GENERATION ────────────────────────────────────── */
const btnGenerate   = document.getElementById('btn-generate');
const aiPlaceholder = document.getElementById('ai-placeholder');
const aiLoading     = document.getElementById('ai-loading');
const aiLoadingText = document.getElementById('ai-loading-text');
const aiError       = document.getElementById('ai-error');
const aiImgWrap     = document.getElementById('ai-img-wrap');
const aiResultImg   = document.getElementById('ai-result-img');
const btnStick      = document.getElementById('btn-stick-it');

const NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, text, watermark, signature, extra limbs, out of frame, abstract, cartoon';

btnGenerate?.addEventListener('click', async () => {
  const token = getHFToken();
  if (!token) {
    showError('Please enter your Hugging Face token above. Get one free at huggingface.co/settings/tokens');
    return;
  }

  const description  = aiDescInput?.value.trim() || '';
  const sketchBase64 = drawCanvas.toDataURL('image/png').split(',')[1];
  const hasContent   = hasDrawing(drawCanvas);

  showLoading(true, 'Preparing your sketch…');
  hideError();
  if (aiPlaceholder) aiPlaceholder.style.display = 'none';
  if (aiImgWrap)     aiImgWrap.style.display      = 'none';
  if (btnStick)      btnStick.style.display        = 'none';

  try {
    const imgUrl = await generateSketchToImage(sketchBase64, description, token, hasContent);
    showLoading(false);
    if (!imgUrl) { showError('Generation failed — model may be loading, try again in 30 seconds.'); return; }

    // Show result
    aiResultImg.src     = imgUrl;
    aiImgWrap.style.display  = '';
    btnStick.style.display   = '';

    // Store current generation data so "Stick it" can save it
    btnStick._aiUrl       = imgUrl;
    btnStick._sketchUrl   = drawCanvas.toDataURL('image/png');
    btnStick._description = description;

  } catch(e) {
    showLoading(false);
    showError(`Error: ${e.message}. Check your HF token and try again.`);
    console.error(e);
  }
});

async function generateSketchToImage(sketchBase64, description, token, hasContent) {
  /* Build a realistic prompt. Description is ADDTIONAL info, sketch is the primary guide. */
  const basePrompt = 'photorealistic, ultra-detailed, sharp focus, 8k, professional photography, high quality';
  const fullPrompt = description
    ? `${description}, ${basePrompt}`
    : basePrompt;

  /* === Method 1: instruct-pix2pix (best sketch-to-image, free tier) === */
  if (hasContent) {
    try {
      showLoading(true, 'Sending sketch to AI (img2img)…');
      const res = await fetchWithTimeout(
        'https://api-inference.huggingface.co/models/timbrooks/instruct-pix2pix',
        {
          method:'POST',
          headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json', 'x-use-cache':'false' },
          body:JSON.stringify({
            inputs: description
              ? `Turn this sketch into a realistic image of ${description}`
              : 'Turn this sketch into a photorealistic image',
            parameters:{
              image: sketchBase64,
              num_inference_steps: 25,
              image_guidance_scale: 1.8,
              guidance_scale: 7.5,
              negative_prompt: NEGATIVE_PROMPT,
            },
            options:{ wait_for_model:true, use_cache:false }
          })
        },
        100000
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type?.startsWith('image/')) return URL.createObjectURL(blob);
      }
      const errText = await res.text().catch(()=>'');
      console.warn('pix2pix failed:', res.status, errText);
    } catch(e) { console.warn('pix2pix exception:', e.message); }
  }

  /* === Method 2: ControlNet scribble (preserves sketch shapes) === */
  if (hasContent) {
    try {
      showLoading(true, 'Trying ControlNet sketch model…');
      const res = await fetchWithTimeout(
        'https://api-inference.huggingface.co/models/lllyasviel/sd-controlnet-scribble',
        {
          method:'POST',
          headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json', 'x-use-cache':'false' },
          body:JSON.stringify({
            inputs: fullPrompt,
            parameters:{
              image: sketchBase64,
              num_inference_steps: 25,
              guidance_scale: 9,
              negative_prompt: NEGATIVE_PROMPT,
              controlnet_conditioning_scale: 0.95,
            },
            options:{ wait_for_model:true, use_cache:false }
          })
        },
        100000
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type?.startsWith('image/')) return URL.createObjectURL(blob);
      }
    } catch(e) { console.warn('ControlNet exception:', e.message); }
  }

  /* === Method 3: SDXL text-to-image with sketch analysis === */
  showLoading(true, 'Generating from your sketch description…');
  const sketchAnalysis = hasContent ? describeSketch(drawCanvas) : '';
  const enrichedPrompt = [sketchAnalysis, fullPrompt].filter(Boolean).join(', ');

  const models = [
    'stabilityai/stable-diffusion-xl-base-1.0',
    'stabilityai/stable-diffusion-2-1',
    'runwayml/stable-diffusion-v1-5',
  ];

  for (const model of models) {
    try {
      showLoading(true, `Using ${model.split('/')[1]}…`);
      const res = await fetchWithTimeout(
        `https://api-inference.huggingface.co/models/${model}`,
        {
          method:'POST',
          headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json', 'x-use-cache':'false' },
          body:JSON.stringify({
            inputs: enrichedPrompt,
            parameters:{ num_inference_steps:28, guidance_scale:9, negative_prompt:NEGATIVE_PROMPT },
            options:{ wait_for_model:true, use_cache:false }
          })
        },
        120000
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type?.startsWith('image/')) return URL.createObjectURL(blob);
      }
      console.warn(`${model} failed:`, res.status);
    } catch(e) { console.warn(`${model} exception:`, e.message); }
  }

  throw new Error('All generation methods failed. Please check your HF token and try again in 30 seconds.');
}

/* Check if canvas has drawn content */
function hasDrawing(canvas) {
  const d = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  for (let i=3;i<d.length;i+=4) { if(d[i]>10) return true; }
  return false;
}

/* Analyse sketch colours for a descriptive hint */
function describeSketch(canvas) {
  const ctx = canvas.getContext('2d');
  const d   = ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const counts = {};
  for (let i=0;i<d.length;i+=16) {
    if (d[i+3]<10) continue;
    const r=Math.round(d[i]/64)*64, g=Math.round(d[i+1]/64)*64, b=Math.round(d[i+2]/64)*64;
    const key=`${r},${g},${b}`; counts[key]=(counts[key]||0)+1;
  }
  const topColors = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if (!topColors.length) return '';
  const names = topColors.map(([k]) => {
    const [r,g,b]=k.split(',').map(Number);
    if(r>180&&g<80&&b<80) return 'red'; if(r<80&&g>180&&b<80) return 'green';
    if(r<80&&g<80&&b>180) return 'blue'; if(r>180&&g>180&&b<80) return 'yellow';
    if(r>180&&g<80&&b>180) return 'purple'; if(r<80&&g>180&&b>180) return 'cyan';
    if(r>180&&g>120&&b<80) return 'orange'; if(r>180&&g>180&&b>180) return 'white';
    if(r<80&&g<80&&b<80) return 'black'; return null;
  }).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
  return names.length ? `with ${names.join(' and ')} tones` : '';
}

function fetchWithTimeout(url, opts, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), ms);
    fetch(url, opts).then(r => { clearTimeout(timer); resolve(r); })
                    .catch(e => { clearTimeout(timer); reject(e); });
  });
}

/* ─── STICK IT ON ART WALL ───────────────────────────────────── */
btnStick?.addEventListener('click', () => {
  const aiUrl      = btnStick._aiUrl;
  const sketchUrl  = btnStick._sketchUrl;
  const description= btnStick._description || '';
  if (!aiUrl) return;

  try {
    const gallery = JSON.parse(localStorage.getItem('ab_gallery') || '[]');
    gallery.unshift({ aiUrl, sketchUrl, description, ts: Date.now() });
    if (gallery.length > 50) gallery.length = 50;
    localStorage.setItem('ab_gallery', JSON.stringify(gallery));
    flash('📌 Stuck on your Art Wall!');
    btnStick.textContent = '✅ Added to Art Wall';
    btnStick.disabled = true;
    setTimeout(() => { btnStick.textContent='📌 Stick it on your Art Wall'; btnStick.disabled=false; }, 3000);
  } catch(e) { flash('Could not save to gallery'); }
});

/* ─── UI HELPERS ─────────────────────────────────────────────── */
function showLoading(on, msg) {
  if (aiLoading)     aiLoading.style.display   = on ? 'flex' : 'none';
  if (aiLoadingText) aiLoadingText.textContent  = msg || 'Generating…';
  if (btnGenerate)   btnGenerate.disabled       = on;
}
function showError(msg) { if(aiError){ aiError.textContent=msg; aiError.style.display=''; } }
function hideError()    { if(aiError) aiError.style.display='none'; }

/* ─── GALLERY ────────────────────────────────────────────────── */
const galleryModal      = document.getElementById('gallery-modal');
const galleryGrid       = document.getElementById('gallery-grid');
const galleryEmpty      = document.getElementById('gallery-empty');
const galleryClose      = document.getElementById('gallery-close');
const galleryDetailModal= document.getElementById('gallery-detail-modal');
const galleryDetailClose= document.getElementById('gallery-detail-close');
const detailAiImg       = document.getElementById('detail-ai-img');
const detailSketchImg   = document.getElementById('detail-sketch-img');
const detailDesc        = document.getElementById('detail-desc');
const btnOpenGallery    = document.getElementById('btn-open-gallery');

function openGallery() {
  if (!galleryModal || !galleryGrid) return;
  const items = JSON.parse(localStorage.getItem('ab_gallery') || '[]');
  galleryGrid.innerHTML = '';
  if (!items.length) {
    galleryGrid.innerHTML = '<div class="gallery-empty">No images yet — generate some AI art and stick it here!</div>';
  } else {
    items.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'gallery-item';
      const img = document.createElement('img');
      img.src = item.aiUrl || '';
      img.alt = item.description || `Art ${idx+1}`;
      div.appendChild(img);
      div.addEventListener('click', () => openGalleryDetail(item));
      galleryGrid.appendChild(div);
    });
  }
  galleryModal.style.display = 'flex';
}

function openGalleryDetail(item) {
  if (!galleryDetailModal) return;
  detailAiImg.src     = item.aiUrl    || '';
  detailSketchImg.src = item.sketchUrl || '';
  if (item.description) {
    detailDesc.textContent   = `Description: ${item.description}`;
    detailDesc.style.display = '';
  } else {
    detailDesc.style.display = 'none';
  }
  galleryDetailModal.style.display = 'flex';
}

btnOpenGallery?.addEventListener('click', openGallery);
galleryClose?.addEventListener('click',       () => { galleryModal.style.display      = 'none'; });
galleryDetailClose?.addEventListener('click', () => { galleryDetailModal.style.display = 'none'; });

// Close modals on backdrop click
galleryModal?.addEventListener('click', e => { if(e.target===galleryModal) galleryModal.style.display='none'; });
galleryDetailModal?.addEventListener('click', e => { if(e.target===galleryDetailModal) galleryDetailModal.style.display='none'; });
