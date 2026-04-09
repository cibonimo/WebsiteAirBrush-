/* ================================================================
   canvas.js — AirBrush Main Canvas
   Features: MediaPipe hand tracking, gesture drawing, mirrored cam,
   skeleton overlay, particles BG, voice input, sketch-based AI gen
================================================================ */
'use strict';

/* ─────────────────────────────────────────────────────────────
   PARTICLES BACKGROUND
───────────────────────────────────────────────────────────── */
(function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function makeParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.8 + 0.4,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      a: Math.random() * 0.5 + 0.15,
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 120 }, makeParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(124,58,237,${p.a})`;
      ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    // Draw faint connecting lines
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d  = Math.sqrt(dx*dx + dy*dy);
        if (d < 100) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(124,58,237,${0.08 * (1 - d/100)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

/* ─────────────────────────────────────────────────────────────
   ELEMENT REFS
───────────────────────────────────────────────────────────── */
const webcamEl     = document.getElementById('webcam');
const overlayCanvas= document.getElementById('overlay-canvas');
const overlayCtx   = overlayCanvas.getContext('2d');
const drawCanvas   = document.getElementById('draw-canvas');
const drawCtx      = drawCanvas.getContext('2d');

const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const gestureInd   = document.getElementById('gesture-indicator');

const btnStart     = document.getElementById('btn-start');
const btnStop      = document.getElementById('btn-stop');
const btnUndo      = document.getElementById('btn-undo');
const btnClear     = document.getElementById('btn-clear');
const btnDownload  = document.getElementById('btn-download');
const btnAirMode   = document.getElementById('btn-air-mode');
const btnMouseMode = document.getElementById('btn-mouse-mode');
const btnBrush     = document.getElementById('btn-brush');
const btnEraser    = document.getElementById('btn-eraser');
const brushSize    = document.getElementById('brush-size');
const brushOpacity = document.getElementById('brush-opacity');
const sizeLabel    = document.getElementById('size-label');
const opacityLabel = document.getElementById('opacity-label');
const colorCustom  = document.getElementById('color-custom');
const navUser      = document.getElementById('nav-user');
const btnLogout    = document.getElementById('btn-logout');
const btnDone      = document.getElementById('btn-done-drawing');
const genSection   = document.getElementById('gen-section');

/* ─────────────────────────────────────────────────────────────
   DRAWING STATE
───────────────────────────────────────────────────────────── */
let mode           = 'air';   // 'air' | 'mouse'
let tool           = 'brush'; // 'brush' | 'eraser'
let currentColor   = '#7C3AED';
let currentSize    = 4;
let currentOpacity = 1;
let isDrawing      = false;
let lastX = 0, lastY = 0;
let undoStack      = [];
let handActive     = false;
let camStream      = null;
let hands          = null;
let mediapipeCam   = null;
let running        = false;

/* Gesture: fist + shake to clear */
let fistDetectedAt = null;
let fistPrevPos    = null;
let shakeCount     = 0;
const FIST_SHAKE_THRESHOLD = 0.06;
const FIST_SHAKE_NEEDED    = 3;

/* Gesture: draw on overlay too */
let overlayLastX = 0, overlayLastY = 0, overlayDrawing = false;

/* ─────────────────────────────────────────────────────────────
   USER INFO
───────────────────────────────────────────────────────────── */
try {
  const cur = JSON.parse(localStorage.getItem('ab_current') || '{}');
  if (cur.name && navUser) navUser.textContent = `👤 ${cur.name}`;
} catch {}

btnLogout?.addEventListener('click', () => {
  localStorage.removeItem('ab_current');
  window.location.href = 'index.html';
});

/* ─────────────────────────────────────────────────────────────
   CANVAS RESIZE
───────────────────────────────────────────────────────────── */
function resizeCanvases() {
  const drawBox = drawCanvas.parentElement;
  const W = drawBox.clientWidth  || 560;
  const H = drawBox.clientHeight || 420;
  // Save draw content
  const snapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
  drawCanvas.width  = W;
  drawCanvas.height = H;
  drawCtx.putImageData(snapshot, 0, 0);

  // Overlay matches webcam
  const camBox = overlayCanvas.parentElement;
  overlayCanvas.width  = camBox.clientWidth  || 560;
  overlayCanvas.height = camBox.clientHeight || 420;
}
window.addEventListener('resize', resizeCanvases);
setTimeout(resizeCanvases, 200);

/* ─────────────────────────────────────────────────────────────
   DRAW UTILITIES
───────────────────────────────────────────────────────────── */
function saveUndo() {
  undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
  if (undoStack.length > 30) undoStack.shift();
}

function startStroke(x, y, ctx, w, h, isOverlay) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  if (isOverlay) {
    overlayDrawing = true; overlayLastX = x; overlayLastY = y;
  } else {
    isDrawing = true; lastX = x; lastY = y;
  }
}

function applyBrushStyle(ctx, isErase) {
  ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
  ctx.globalAlpha  = isErase ? 1 : currentOpacity;
  ctx.strokeStyle  = currentColor;
  ctx.lineWidth    = currentSize;
  ctx.lineCap      = 'round';
  ctx.lineJoin     = 'round';
}

function drawStroke(x, y) {
  if (!isDrawing) return;
  applyBrushStyle(drawCtx, tool === 'eraser');
  drawCtx.lineTo(x, y);
  drawCtx.stroke();
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
  lastX = x; lastY = y;
}

/* Also trace on overlay (on top of webcam feed) */
function drawOverlayStroke(x, y) {
  if (!overlayDrawing) return;
  overlayCtx.save();
  overlayCtx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  overlayCtx.globalAlpha = tool === 'eraser' ? 1 : currentOpacity * 0.7;
  overlayCtx.strokeStyle = currentColor;
  overlayCtx.lineWidth   = currentSize;
  overlayCtx.lineCap     = 'round';
  overlayCtx.lineJoin    = 'round';
  overlayCtx.beginPath();
  overlayCtx.moveTo(overlayLastX, overlayLastY);
  overlayCtx.lineTo(x, y);
  overlayCtx.stroke();
  overlayCtx.restore();
  overlayLastX = x; overlayLastY = y;
}

function endStroke() {
  if (isDrawing) {
    drawCtx.globalCompositeOperation = 'source-over';
    drawCtx.globalAlpha = 1;
  }
  isDrawing = false; overlayDrawing = false;
}

/* ─────────────────────────────────────────────────────────────
   MOUSE MODE
───────────────────────────────────────────────────────────── */
drawCanvas.addEventListener('mousedown', e => {
  if (mode !== 'mouse') return;
  saveUndo();
  const {x,y} = canvasPos(e, drawCanvas);
  startStroke(x, y, drawCtx, drawCanvas.width, drawCanvas.height, false);
  drawStroke(x, y);
});
drawCanvas.addEventListener('mousemove', e => {
  if (mode !== 'mouse' || !isDrawing) return;
  const {x,y} = canvasPos(e, drawCanvas);
  drawStroke(x, y);
});
drawCanvas.addEventListener('mouseup',   endStroke);
drawCanvas.addEventListener('mouseleave',endStroke);

function canvasPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ─────────────────────────────────────────────────────────────
   CONTROL PANEL
───────────────────────────────────────────────────────────── */
btnAirMode?.addEventListener('click',   () => { mode = 'air';   btnAirMode.classList.add('active'); btnMouseMode.classList.remove('active'); });
btnMouseMode?.addEventListener('click', () => { mode = 'mouse'; btnMouseMode.classList.add('active'); btnAirMode.classList.remove('active'); });
btnBrush?.addEventListener('click',   () => { tool = 'brush';  btnBrush.classList.add('active');  btnEraser.classList.remove('active'); });
btnEraser?.addEventListener('click',  () => { tool = 'eraser'; btnEraser.classList.add('active'); btnBrush.classList.remove('active'); });

brushSize?.addEventListener('input', e => {
  currentSize = parseInt(e.target.value);
  if (sizeLabel) sizeLabel.textContent = currentSize;
});
brushOpacity?.addEventListener('input', e => {
  currentOpacity = parseInt(e.target.value) / 100;
  if (opacityLabel) opacityLabel.textContent = e.target.value;
});
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
  if (undoStack.length === 0) return;
  drawCtx.putImageData(undoStack.pop(), 0, 0);
});
btnClear?.addEventListener('click', () => {
  saveUndo();
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
});
btnDownload?.addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `airbrush-${Date.now()}.png`;
  a.href = drawCanvas.toDataURL('image/png');
  a.click();
});

/* ─────────────────────────────────────────────────────────────
   MEDIAPIPE HANDS
───────────────────────────────────────────────────────────── */
function initHands() {
  hands = new Hands({ locateFile: f =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence: 0.75
  });
  hands.onResults(onHandResults);
}

/* ── Gesture detection ── */
function extendedFingers(lm) {
  // Returns array of which fingers are up: [thumb, index, middle, ring, pinky]
  const up = [false,false,false,false,false];
  up[0] = lm[4].x < lm[3].x; // thumb (mirrored)
  const tips = [8,12,16,20], pips = [6,10,14,18];
  for (let i=0;i<4;i++) up[i+1] = lm[tips[i]].y < lm[pips[i]].y;
  return up;
}

function detectGesture(lm) {
  const up = extendedFingers(lm);
  const count = up.filter(Boolean).length;

  // Open palm (4-5 fingers up) → pause
  if (count >= 4) return 'palm';
  // Index + middle only → erase
  if (!up[0] && up[1] && up[2] && !up[3] && !up[4]) return 'peace';
  // Index only → draw
  if (!up[0] && up[1] && !up[2] && !up[3] && !up[4]) return 'index';
  // Fist (0 fingers) → maybe clear
  if (count === 0) return 'fist';
  return 'other';
}

function onHandResults(results) {
  if (!running) return;

  // Clear overlay skeleton — but preserve drawn strokes (drawn beneath)
  // We use two separate layers:
  // 1. overlayCanvas draws strokes on top of webcam
  // 2. We draw skeleton fresh each frame in a temporary context
  //    by drawing strokes first, then skeleton on top

  // For simplicity: overlay is the skeleton layer; we draw strokes to draw-canvas only
  // To also show strokes on cam: we maintain a separate "cam drawing" canvas
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;

  overlayCtx.clearRect(0, 0, W, H);

  if (!results.multiHandLandmarks?.length) {
    // No hand: end any ongoing stroke
    if (isDrawing) { endStroke(); saveUndo(); }
    showGesture('');
    return;
  }

  const lm = results.multiHandLandmarks[0];

  /* ── Draw skeleton (mirrored coordinates since video is CSS-mirrored)
     Landmarks come from original un-mirrored video internally,
     so we flip x: drawX = (1 - lm.x) * W  ── */
  const mirroredLm = lm.map(p => ({ ...p, x: 1 - p.x }));

  drawConnectors(overlayCtx, mirroredLm, HAND_CONNECTIONS,
    { color: 'rgba(124,58,237,0.7)', lineWidth: 2 });
  drawLandmarks(overlayCtx, mirroredLm,
    { color: '#06B6D4', lineWidth: 1, radius: 3 });

  /* ── Gesture detection ── */
  const gesture = detectGesture(lm); // use original lm for logic
  const tipX = (1 - lm[8].x) * W;  // mirrored tip X
  const tipY = lm[8].y * H;

  /* Map to draw-canvas coordinates */
  const scaleX = drawCanvas.width  / W;
  const scaleY = drawCanvas.height / H;
  const drawX  = tipX * scaleX;
  const drawY  = tipY * scaleY;

  switch (gesture) {
    case 'index': {
      // Draw mode
      if (mode !== 'air') break;
      tool = 'brush';
      btnBrush?.classList.add('active');
      btnEraser?.classList.remove('active');

      if (!isDrawing) {
        saveUndo();
        isDrawing = true; lastX = drawX; lastY = drawY;
        overlayDrawing = true; overlayLastX = tipX; overlayLastY = tipY;
        applyBrushStyle(drawCtx, false);
        drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
      }

      applyBrushStyle(drawCtx, false);
      drawCtx.lineTo(drawX, drawY);
      drawCtx.stroke();
      drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);

      // Also draw on overlay (cam feed layer)
      drawOverlayStroke(tipX, tipY);

      lastX = drawX; lastY = drawY;
      showGesture('✏️ Drawing');

      // Draw fingertip dot
      overlayCtx.beginPath();
      overlayCtx.arc(tipX, tipY, currentSize/2 + 3, 0, Math.PI*2);
      overlayCtx.fillStyle = currentColor;
      overlayCtx.globalAlpha = 0.7;
      overlayCtx.fill();
      overlayCtx.globalAlpha = 1;
      break;
    }

    case 'peace': {
      // Eraser mode
      if (isDrawing) { endStroke(); }
      tool = 'eraser';
      btnEraser?.classList.add('active');
      btnBrush?.classList.remove('active');

      if (!isDrawing) {
        saveUndo();
        isDrawing = true; lastX = drawX; lastY = drawY;
        applyBrushStyle(drawCtx, true);
        drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
      }
      applyBrushStyle(drawCtx, true);
      drawCtx.lineTo(drawX, drawY);
      drawCtx.stroke();
      drawCtx.beginPath(); drawCtx.moveTo(drawX, drawY);
      lastX = drawX; lastY = drawY;
      showGesture('⬜ Erasing');

      // Eraser cursor on overlay
      overlayCtx.beginPath();
      overlayCtx.arc(tipX, tipY, currentSize + 4, 0, Math.PI*2);
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.6)';
      overlayCtx.lineWidth = 1;
      overlayCtx.stroke();
      break;
    }

    case 'palm': {
      // Pause
      if (isDrawing) { endStroke(); saveUndo(); }
      showGesture('🖐 Paused');
      break;
    }

    case 'fist': {
      // Track shake to clear
      if (isDrawing) { endStroke(); }
      const wx = lm[0].x, wy = lm[0].y;

      if (!fistDetectedAt) {
        fistDetectedAt = Date.now();
        fistPrevPos    = { x: wx, y: wy };
        shakeCount     = 0;
      } else {
        if (fistPrevPos) {
          const dx = Math.abs(wx - fistPrevPos.x);
          if (dx > FIST_SHAKE_THRESHOLD) {
            shakeCount++;
            fistPrevPos = { x: wx, y: wy };
          }
        }
        if (shakeCount >= FIST_SHAKE_NEEDED) {
          saveUndo();
          drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
          shakeCount = 0; fistDetectedAt = null; fistPrevPos = null;
          showGesture('🗑 Cleared!');
          flash('Canvas cleared');
        } else {
          showGesture(`✊ Shake to clear (${shakeCount}/${FIST_SHAKE_NEEDED})`);
        }
      }
      break;
    }

    default: {
      if (isDrawing) { endStroke(); saveUndo(); }
      fistDetectedAt = null; shakeCount = 0;
      showGesture('');
    }
  }

  // Reset fist if gesture changed
  if (gesture !== 'fist') { fistDetectedAt = null; shakeCount = 0; fistPrevPos = null; }
}

let gestureTimeout;
function showGesture(text) {
  if (!gestureInd) return;
  if (!text) {
    gestureInd.classList.remove('visible');
    return;
  }
  gestureInd.textContent = text;
  gestureInd.classList.add('visible');
  clearTimeout(gestureTimeout);
  gestureTimeout = setTimeout(() => gestureInd.classList.remove('visible'), 1500);
}

function flash(msg) {
  let el = document.getElementById('canvas-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'canvas-flash';
    Object.assign(el.style, {
      position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
      background:'rgba(0,0,0,0.75)',color:'#fff',
      padding:'12px 28px',borderRadius:'12px',fontSize:'1rem',
      pointerEvents:'none',zIndex:'9999',opacity:'0',transition:'opacity 0.3s',
      fontFamily:"'Calibri Light',Calibri,sans-serif"
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

/* ─────────────────────────────────────────────────────────────
   START / STOP
───────────────────────────────────────────────────────────── */
btnStart?.addEventListener('click', async () => {
  if (running) return;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 } });
    webcamEl.srcObject = camStream;
    await new Promise(r => webcamEl.addEventListener('loadedmetadata', r, { once:true }));

    overlayCanvas.width  = webcamEl.videoWidth;
    overlayCanvas.height = webcamEl.videoHeight;

    if (!hands) initHands();
    mediapipeCam = new Camera(webcamEl, {
      onFrame: async () => { if (running) await hands.send({ image: webcamEl }); },
      width: 640, height: 480
    });
    mediapipeCam.start();
    running = true;

    if (statusDot)  statusDot.style.background  = '#22c55e';
    if (statusText) statusText.textContent = 'Tracking active';
    btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } catch(e) {
    console.error(e);
    if (statusText) statusText.textContent = 'Camera access denied';
  }
});

btnStop?.addEventListener('click', () => {
  running = false;
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  webcamEl.srcObject = null;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (statusDot)  statusDot.style.background  = '#ef4444';
  if (statusText) statusText.textContent = 'Stopped';
  btnStart.disabled = false;
  if (btnStop) btnStop.disabled = true;
});

/* ─────────────────────────────────────────────────────────────
   DONE DRAWING → SHOW GENERATION SECTION
───────────────────────────────────────────────────────────── */
btnDone?.addEventListener('click', () => {
  if (genSection) {
    genSection.style.display = '';
    genSection.scrollIntoView({ behavior:'smooth' });
  }
});

/* ─────────────────────────────────────────────────────────────
   HF TOKEN
───────────────────────────────────────────────────────────── */
const hfTokenInput = document.getElementById('hf-token');
const btnSaveToken = document.getElementById('btn-save-token');

// Load saved token
if (hfTokenInput) {
  const saved = localStorage.getItem('hf_token');
  if (saved) hfTokenInput.value = saved;
}
btnSaveToken?.addEventListener('click', () => {
  const t = hfTokenInput.value.trim();
  if (t) { localStorage.setItem('hf_token', t); flash('Token saved!'); }
});

function getHFToken() {
  return (hfTokenInput?.value.trim() || localStorage.getItem('hf_token') || '').trim();
}

/* ─────────────────────────────────────────────────────────────
   VOICE INPUT — with visual "listening" feedback
───────────────────────────────────────────────────────────── */
const btnVoice    = document.getElementById('btn-voice');
const aiDescInput = document.getElementById('ai-description');
const interimEl   = document.getElementById('interim-text');

let recognition = null;
let recActive   = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous     = false;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.onstart = () => {
    recActive = true;
    btnVoice?.classList.add('listening');
    if (btnVoice) btnVoice.textContent = '🔴';
    if (interimEl) interimEl.textContent = 'Listening…';
  };

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interimEl) interimEl.textContent = interim || final || '';
    if (final && aiDescInput) {
      aiDescInput.value += (aiDescInput.value ? ' ' : '') + final.trim();
      if (interimEl) interimEl.textContent = '';
    }
  };

  recognition.onerror = (e) => {
    console.warn('Speech error:', e.error);
    stopListening();
    if (interimEl) interimEl.textContent = `Mic error: ${e.error}`;
  };

  recognition.onend = stopListening;
}

function stopListening() {
  recActive = false;
  btnVoice?.classList.remove('listening');
  if (btnVoice) btnVoice.textContent = '🎤';
}

btnVoice?.addEventListener('click', () => {
  if (!recognition) { flash('Speech not supported in this browser'); return; }
  if (recActive) { recognition.stop(); }
  else { recognition.start(); }
});

/* ─────────────────────────────────────────────────────────────
   AI IMAGE GENERATION — sketch-based (img2img / ControlNet)
───────────────────────────────────────────────────────────── */
const btnGenerate     = document.getElementById('btn-generate');
const aiPlaceholder   = document.getElementById('ai-placeholder');
const aiLoading       = document.getElementById('ai-loading');
const aiLoadingText   = document.getElementById('ai-loading-text');
const aiImagesGrid    = document.getElementById('ai-images-grid');
const aiError         = document.getElementById('ai-error');

const STYLE_PROMPTS = {
  realistic:  'photorealistic, ultra-detailed, professional photography, 8k, sharp focus',
  creative:   'creative digital art, vibrant colors, artistic, imaginative, detailed illustration',
  dynamic:    'dynamic composition, dramatic lighting, motion blur, energetic, cinematic',
  portrait:   'portrait photography, bokeh background, professional lighting, detailed face',
  stock:      'stock photo, clean background, professional, commercial photography, sharp',
  watercolour:'watercolor painting, soft brushstrokes, pastel colors, artistic, delicate',
  bw:         'black and white photography, high contrast, dramatic shadows, monochrome, cinematic',
  vibrant:    'vibrant colors, high saturation, vivid, colorful digital art, neon accents',
};

const NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, text, watermark, signature, extra limbs, out of frame';

btnGenerate?.addEventListener('click', async () => {
  const token = getHFToken();
  if (!token) {
    showError('Please enter your Hugging Face token above (get one free at huggingface.co/settings/tokens).');
    return;
  }

  const count       = parseInt(document.getElementById('gen-count')?.value || '1');
  const style       = document.getElementById('gen-style')?.value || 'realistic';
  const description = aiDescInput?.value.trim() || '';
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.realistic;

  // Get sketch as base64
  const sketchBase64 = drawCanvas.toDataURL('image/png').split(',')[1];

  // Check if canvas has any content
  const hasContent = hasDrawing(drawCanvas);

  showLoading(true, 'Preparing sketch…');
  hideError();
  if (aiPlaceholder) aiPlaceholder.style.display = 'none';
  if (aiImagesGrid)  aiImagesGrid.innerHTML = '';

  try {
    const images = [];
    for (let i = 0; i < count; i++) {
      showLoading(true, `Generating image ${i+1} of ${count}…`);
      const imgBlob = await generateSketchToImage(sketchBase64, description, stylePrompt, token, hasContent);
      if (imgBlob) images.push(imgBlob);
    }

    showLoading(false);
    if (images.length === 0) {
      showError('Generation failed — model may be loading, please try again in 30 seconds.');
      return;
    }
    displayImages(images);
  } catch(e) {
    showLoading(false);
    showError(`Generation error: ${e.message}. Try again — model may be warming up.`);
    console.error(e);
  }
});

/* Core generation function: tries img2img first, falls back to text2img */
async function generateSketchToImage(sketchBase64, description, stylePrompt, token, hasContent) {
  const fullPrompt = description
    ? `${description}, ${stylePrompt}, preserving the composition and shapes of the original sketch`
    : `${stylePrompt}, detailed and high quality`;

  // === Method 1: instruct-pix2pix (best for sketch-to-image) ===
  if (hasContent) {
    try {
      showLoading(true, 'Sending sketch to AI (img2img)…');
      const res = await fetchWithTimeout(
        'https://api-inference.huggingface.co/models/timbrooks/instruct-pix2pix',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-use-cache': 'false',
          },
          body: JSON.stringify({
            inputs: `Make this sketch into a ${description || 'detailed artwork'}. Style: ${stylePrompt}`,
            parameters: {
              image: sketchBase64,
              num_inference_steps: 20,
              image_guidance_scale: 1.8,   // high = preserve sketch structure
              guidance_scale: 7.5,
              negative_prompt: NEGATIVE_PROMPT,
            },
            options: { wait_for_model: true, use_cache: false }
          })
        },
        90000  // 90 second timeout
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) return URL.createObjectURL(blob);
      }
      const errText = await res.text().catch(() => '');
      console.warn('pix2pix failed:', res.status, errText);
    } catch(e) {
      console.warn('pix2pix exception:', e.message);
    }
  }

  // === Method 2: ControlNet scribble (great sketch fidelity) ===
  if (hasContent) {
    try {
      showLoading(true, 'Trying ControlNet sketch model…');
      const res = await fetchWithTimeout(
        'https://api-inference.huggingface.co/models/lllyasviel/sd-controlnet-scribble',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-use-cache': 'false',
          },
          body: JSON.stringify({
            inputs: fullPrompt,
            parameters: {
              image: sketchBase64,
              num_inference_steps: 20,
              guidance_scale: 8,
              negative_prompt: NEGATIVE_PROMPT,
              controlnet_conditioning_scale: 0.9,
            },
            options: { wait_for_model: true, use_cache: false }
          })
        },
        90000
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) return URL.createObjectURL(blob);
      }
    } catch(e) {
      console.warn('ControlNet exception:', e.message);
    }
  }

  // === Method 3: SDXL text-to-image with sketch-describing prompt ===
  // Analyse sketch colour and build rich prompt
  showLoading(true, 'Generating from description…');
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
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-use-cache': 'false',
          },
          body: JSON.stringify({
            inputs: enrichedPrompt,
            parameters: {
              num_inference_steps: 25,
              guidance_scale: 8,
              negative_prompt: NEGATIVE_PROMPT,
            },
            options: { wait_for_model: true, use_cache: false }
          })
        },
        120000
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) return URL.createObjectURL(blob);
      }
      const errText = await res.text().catch(() => '');
      console.warn(`${model} failed:`, res.status, errText);
    } catch(e) {
      console.warn(`${model} exception:`, e.message);
    }
  }

  throw new Error('All generation methods failed. Please check your HF token and try again.');
}

/* Check if canvas has any non-white, non-transparent pixels */
function hasDrawing(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 10) return true; }
  return false;
}

/* Rough sketch description from canvas pixel data */
function describeSketch(canvas) {
  const ctx = canvas.getContext('2d');
  const d   = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const counts = {};
  for (let i = 0; i < d.length; i += 16) {
    if (d[i+3] < 10) continue;
    const r = Math.round(d[i]/64)*64, g = Math.round(d[i+1]/64)*64, b = Math.round(d[i+2]/64)*64;
    const key = `${r},${g},${b}`;
    counts[key] = (counts[key]||0)+1;
  }
  const topColors = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if (!topColors.length) return '';
  const colorNames = topColors.map(([k]) => {
    const [r,g,b] = k.split(',').map(Number);
    if (r>180 && g<80 && b<80) return 'red';
    if (r<80 && g>180 && b<80) return 'green';
    if (r<80 && g<80 && b>180) return 'blue';
    if (r>180 && g>180 && b<80) return 'yellow';
    if (r>180 && g<80 && b>180) return 'purple';
    if (r<80 && g>180 && b>180) return 'cyan';
    if (r>180 && g>120 && b<80) return 'orange';
    if (r>180 && g>180 && b>180) return 'white';
    if (r<80 && g<80 && b<80)   return 'black';
    return 'colorful';
  }).filter((v,i,a)=>a.indexOf(v)===i);
  return `with ${colorNames.join(' and ')} colors`;
}

/* Timeout-aware fetch */
function fetchWithTimeout(url, opts, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), ms);
    fetch(url, opts).then(r => { clearTimeout(timer); resolve(r); })
                    .catch(e => { clearTimeout(timer); reject(e); });
  });
}

/* ── Display images ── */
function displayImages(blobUrls) {
  if (!aiImagesGrid) return;
  aiImagesGrid.innerHTML = '';
  blobUrls.forEach((url, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'ai-img-wrap';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Generated image ${i+1}`;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ai-img-save';
    saveBtn.textContent = '⬇ Save';
    saveBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = url; a.download = `airbrush-ai-${Date.now()}.png`; a.click();
    });
    wrap.appendChild(img); wrap.appendChild(saveBtn);
    aiImagesGrid.appendChild(wrap);

    // Save to gallery
    img.onload = () => saveToGallery(url);
  });
}

/* ── Gallery ── */
function saveToGallery(url) {
  try {
    const g = JSON.parse(localStorage.getItem('ab_gallery') || '[]');
    g.unshift({ url, ts: Date.now() });
    if (g.length > 50) g.length = 50;
    localStorage.setItem('ab_gallery', JSON.stringify(g));
  } catch {}
}

/* ── UI helpers ── */
function showLoading(on, msg) {
  if (aiLoading)     aiLoading.style.display     = on ? 'flex' : 'none';
  if (aiLoadingText) aiLoadingText.textContent    = msg || 'Generating…';
  if (btnGenerate)   btnGenerate.disabled         = on;
}
function showError(msg) {
  if (aiError) { aiError.textContent = msg; aiError.style.display = ''; }
}
function hideError() {
  if (aiError) aiError.style.display = 'none';
}
