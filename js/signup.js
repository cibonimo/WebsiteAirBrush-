// ═══════════════════════════════════════════
//  AIRBRUSH — signup.js  (v6)
//  Changes:
//   • maxNumHands: 2 — enables 6-10 via two hands
//   • Auto-detect tracking — no Start/Stop buttons
//   • Face badge shown in signup page
//   • Tracking stops when Done is clicked
// ═══════════════════════════════════════════

const state = {
  name: '', email: '', method: '',
  authData: null, faceDescriptor: null,
  isDrawing: false,
  trackingEnabled: false,          // ★ FIX: gate all gesture detection
  drawPoints: [], overlayStrokes: [], currentOverlayStroke: null,
  handVisible: false,
  pinDigits: [], pinCurrentDigit: 0, pinCurrentCount: -1,
  pinTimer: null, pinCountdown: 3,
  modelsLoaded: false, cameraReady: false, faceLoopRunning: false,
  wasPinching: false, gestureHoldFrames: 0,
  latestLandmarks: null,
  latestHandResults: null,
  handsInstance: null,
  cameraInstance: null,
};

// ── DOM REFS ─────────────────────────────
const step1El    = document.getElementById('step1');
const step2El    = document.getElementById('step2');
const step3El    = document.getElementById('step3');
const inpName    = document.getElementById('inp-name');
const inpEmail   = document.getElementById('inp-email');
const methodCards= document.querySelectorAll('.method-card');
const btnNext    = document.getElementById('btn-step1-next');
const btnBack    = document.getElementById('btn-back');
const btnDone    = document.getElementById('btn-done');
const btnClear   = document.getElementById('btn-clear-draw');
const err1       = document.getElementById('step1-error');
const err2       = document.getElementById('step2-error');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const step2Title = document.getElementById('step2-title');
const step2Sub   = document.getElementById('step2-sub');
const drawBox    = document.getElementById('draw-box');
const pinBox     = document.getElementById('pin-box');
const drawCtrlEl = document.getElementById('draw-controls');
const pinCtrlEl  = document.getElementById('pin-controls');
const webcamEl      = document.getElementById('webcam');
const overlayCanvas = document.getElementById('overlay-canvas');
const drawCanvas    = document.getElementById('draw-canvas');
const overlayCtx    = overlayCanvas.getContext('2d');
const drawCtx       = drawCanvas.getContext('2d');

webcamEl.style.transform      = 'scaleX(-1)';
overlayCanvas.style.transform = 'scaleX(-1)';

// ── STEP 1 ───────────────────────────────
methodCards.forEach(card => {
  card.addEventListener('click', () => {
    methodCards.forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.method = card.dataset.method;
  });
});

btnNext.addEventListener('click', () => {
  const name  = inpName.value.trim();
  const email = inpEmail.value.trim().toLowerCase();
  if (!name)                return showError(err1, 'Please enter your name.');
  if (!email.includes('@')) return showError(err1, 'Please enter a valid email.');
  if (!state.method)        return showError(err1, 'Please choose an auth method.');
  const users = JSON.parse(localStorage.getItem('airbrush_users') || '[]');
  if (users.find(u => u.email === email))
    return showError(err1, 'Account already exists with that email. Please log in.');
  hideError(err1);
  state.name  = name;
  state.email = email;
  goToStep2();
});

// ── STEP 2 ───────────────────────────────
function goToStep2() {
  step1El.style.display = 'none';
  step2El.style.display = 'flex';
  const labels = {
    sign:    ['Set up your Signature',  'Pinch (👌 thumb+index) to draw. Open palm (🖐) to stop.'],
    pattern: ['Set up your Pattern',    'Pinch (👌 thumb+index) to draw. Open palm (🖐) to stop.'],
    pin:     ['Set up your Finger PIN', 'Hold up fingers — 3-second hold confirms each digit.'],
  };
  step2Title.textContent = labels[state.method][0];
  step2Sub.textContent   = labels[state.method][1];
  if (state.method === 'pin') {
    drawBox.style.display    = 'none';
    pinBox.style.display     = 'block';
    drawCtrlEl.style.display = 'none';
    pinCtrlEl.style.display  = 'block';
  } else {
    drawBox.style.display    = 'block';
    pinBox.style.display     = 'none';
    drawCtrlEl.style.display = 'flex';
    pinCtrlEl.style.display  = 'none';
  }
  initDrawCanvas();
  startCamera();
}

// ── CANVAS INIT ──────────────────────────
function initDrawCanvas() {
  drawCanvas.width  = drawCanvas.offsetWidth  || 400;
  drawCanvas.height = drawCanvas.offsetHeight || 300;
  drawCtx.fillStyle = '#ffffff';
  drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
  state.drawPoints = [];
  state.overlayStrokes = [];
  state.currentOverlayStroke = null;
}

// ── CAMERA + MEDIAPIPE ───────────────────
async function startCamera() {
  setStatus('loading', 'Loading AI models…');
  state.faceLoopRunning = false;
  state.trackingEnabled = false;   // ★ always start with tracking OFF

  try {
    setStatus('loading', 'Loading face models…');
    const MODEL_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    state.modelsLoaded = true;
    setStatus('loading', 'Starting webcam…');
  } catch (e) {
    setStatus('error', 'Could not load face models. Reload the page.');
    return;
  }

  const hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(onHandResults);
  state.handsInstance = hands;

  const camera = new Camera(webcamEl, {
    onFrame: async () => {
      const vw = webcamEl.videoWidth  || 640;
      const vh = webcamEl.videoHeight || 480;
      if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
        overlayCanvas.width  = vw;
        overlayCanvas.height = vh;
      }
      await hands.send({ image: webcamEl });
    },
    width: 640, height: 480,
  });
  state.cameraInstance = camera;

  camera.start().then(() => {
    state.cameraReady = true;
    // ★ FIX: force video element to be visible
    webcamEl.style.display    = 'block';
    webcamEl.style.opacity    = '1';
    webcamEl.style.visibility = 'visible';

    setStatus('loading', 'Camera ready — scanning for your face…');
    if (!state.faceLoopRunning) {
      state.faceLoopRunning = true;
      captureFaceLoop();
    }
    // Auto-enable tracking for ALL modes (no Start button needed)
    state.trackingEnabled = true;
    if (state.method === 'pin') {
      updatePinUI();
    }
  }).catch(e => {
    setStatus('error', 'Camera access denied. Allow webcam and reload.');
    showError(err2, e.message);
  });
}

// ── HAND RESULTS → state only, render via rAF ──
function onHandResults(results) {
  state.latestLandmarks    = (results.multiHandLandmarks && results.multiHandLandmarks.length > 0)
    ? results.multiHandLandmarks[0] : null;
  state.latestHandResults  = results;
  requestAnimationFrame(renderFrame);
}

// ── RENDER FRAME ─────────────────────────
function renderFrame() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!state.latestLandmarks) {
    if (state.currentOverlayStroke && state.currentOverlayStroke.length > 1)
      state.overlayStrokes.push([...state.currentOverlayStroke]);
    state.currentOverlayStroke = null;
    state.handVisible    = false;
    state.wasPinching    = false;
    state.gestureHoldFrames = 0;
    redrawOverlayTrail();
    return;
  }

  state.handVisible = true;
  const lm = state.latestLandmarks;

  drawConnectors(overlayCtx, lm, HAND_CONNECTIONS,
    { color: 'rgba(124,58,237,0.75)', lineWidth: 2 });
  drawLandmarks(overlayCtx, lm,
    { color: '#06B6D4', lineWidth: 1, radius: 3 });

  // ★ FIX: Only process gestures when tracking is enabled
  if (state.trackingEnabled) {
    if (state.method === 'pin') {
      handlePIN(state.latestHandResults);
    } else {
      handleGestureDrawing(lm);
    }
  }
  redrawOverlayTrail();
}

// ── GESTURE HELPERS ──────────────────────
function isPinching(lm) {
  const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
  const handSize  = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.1;
  return (pinchDist / handSize) < 0.35;
}

function isOpenPalm(lm) {
  return [[8,6],[12,10],[16,14],[20,18]].every(([t,p]) => lm[t].y < lm[p].y)
    && Math.abs(lm[4].x - lm[3].x) > 0.04;
}

// ── GESTURE DRAWING ──────────────────────
function handleGestureDrawing(lm) {
  const pinching = isPinching(lm);
  const openPalm = isOpenPalm(lm);

  if (pinching) {
    state.gestureHoldFrames = 0;
    if (!state.isDrawing) _startDrawing();

    const tip   = lm[8];
    const drawX = (1 - tip.x) * drawCanvas.width;
    const drawY = tip.y * drawCanvas.height;
    state.drawPoints.push({ x: drawX, y: drawY });

    drawCtx.strokeStyle = '#6C63FF';
    drawCtx.lineWidth   = 3;
    drawCtx.lineCap     = 'round';
    drawCtx.lineJoin    = 'round';
    if (state.drawPoints.length > 1) {
      const prev = state.drawPoints[state.drawPoints.length - 2];
      drawCtx.beginPath();
      drawCtx.moveTo(prev.x, prev.y);
      drawCtx.lineTo(drawX, drawY);
      drawCtx.stroke();
    }

    const ox = tip.x * overlayCanvas.width;
    const oy = tip.y * overlayCanvas.height;
    if (!state.currentOverlayStroke) state.currentOverlayStroke = [];
    state.currentOverlayStroke.push({ x: ox, y: oy });

    overlayCtx.beginPath();
    overlayCtx.arc(ox, oy, 10, 0, Math.PI * 2);
    overlayCtx.fillStyle = 'rgba(255,80,80,0.85)';
    overlayCtx.fill();

    state.wasPinching = true;
    setStatus('ready', '👌 Drawing… open palm to stop');
    return;
  }

  if (openPalm && state.isDrawing) {
    state.gestureHoldFrames++;
    if (state.gestureHoldFrames >= 3) { _stopDrawing(); state.gestureHoldFrames = 0; }
    return;
  }

  if (!pinching) {
    if (state.wasPinching && state.isDrawing) {
      if (state.currentOverlayStroke && state.currentOverlayStroke.length > 1)
        state.overlayStrokes.push([...state.currentOverlayStroke]);
      state.currentOverlayStroke = null;
    }
    state.wasPinching = false;
    if (!openPalm) state.gestureHoldFrames = 0;
  }
}

// ★ Pure sync — no async, no RAF, no DOM reflows
function _startDrawing() {
  if (state.isDrawing) return;
  state.isDrawing      = true;
  state.currentOverlayStroke = null;
  setStatus('ready', '👌 Pinch to draw — open palm to stop');
}

function _stopDrawing() {
  if (!state.isDrawing) return;
  state.isDrawing       = false;
  // Keep tracking enabled — user can draw again without pressing Start
  if (state.currentOverlayStroke && state.currentOverlayStroke.length > 1)
    state.overlayStrokes.push([...state.currentOverlayStroke]);
  state.currentOverlayStroke = null;
  if (state.drawPoints.length > 10) {
    btnDone.disabled = false;
    setStatus('ready', '✅ Drawing captured — click Done to save');
  } else {
    showError(err2, 'Drawing too short. Pinch and draw a larger shape.');
  }
}

function redrawOverlayTrail() {
  const drawStroke = pts => {
    if (!pts || pts.length < 2) return;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(99,255,200,0.95)';
    overlayCtx.lineWidth   = 3.5;
    overlayCtx.lineCap     = 'round';
    overlayCtx.lineJoin    = 'round';
    overlayCtx.shadowColor = 'rgba(6,182,212,0.6)';
    overlayCtx.shadowBlur  = 8;
    overlayCtx.beginPath();
    overlayCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) overlayCtx.lineTo(pts[i].x, pts[i].y);
    overlayCtx.stroke();
    overlayCtx.restore();
  };
  state.overlayStrokes.forEach(drawStroke);
  if (state.currentOverlayStroke) drawStroke(state.currentOverlayStroke);
}

// ── BUTTON FALLBACKS ─────────────────────
btnClear.addEventListener('click', () => {
  state.drawPoints = [];
  state.overlayStrokes = [];
  state.currentOverlayStroke = null;
  btnDone.disabled = true;
  initDrawCanvas();
  setStatus('ready', 'Cleared — pinch to draw again');
});
// ── DONE / SAVE ──────────────────────────
btnDone.addEventListener('click', () => {
  if (state.method !== 'pin' && state.drawPoints.length < 10)
    return showError(err2, 'Drawing too short — draw more to register.');
  if (state.method === 'pin' && state.pinDigits.length < 4)
    return showError(err2, 'PIN incomplete — enter all 4 digits.');
  if (!state.faceDescriptor)
    return showError(err2, 'Face not captured yet — look at the camera.');
  hideError(err2);
  // Stop tracking before saving
  state.trackingEnabled = false;
  clearPinTimer();
  saveUser();
});

// ── PIN ───────────────────────────────────
function handlePIN(results) {
  // ★ FIX: don't process if PIN is already complete
  if (state.pinCurrentDigit >= 4) return;
  if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
    document.getElementById('finger-count').textContent = 0;
    clearPinTimer();
    return;
  }
  let total = 0;
  results.multiHandLandmarks.forEach((lm, i) => {
    total += countFingers(lm, results.multiHandedness[i].label);
  });
  document.getElementById('finger-count').textContent = total;
  if (total === state.pinCurrentCount) return;
  state.pinCurrentCount = total;
  clearPinTimer();
  if (total > 0) {
    document.getElementById('pin-timer-wrap').style.display = 'block';
    state.pinCountdown = 3;
    document.getElementById('pin-timer').textContent = 3;
    state.pinTimer = setInterval(() => {
      state.pinCountdown--;
      document.getElementById('pin-timer').textContent = state.pinCountdown;
      if (state.pinCountdown <= 0) { clearPinTimer(); confirmPinDigit(total); }
    }, 1000);
  } else {
    document.getElementById('pin-timer-wrap').style.display = 'none';
  }
}

function countFingers(lm, handedness) {
  const pairs = [[8,6],[12,10],[16,14],[20,18]];
  let count = pairs.filter(([t,p]) => lm[t].y < lm[p].y).length;
  if (handedness === 'Right') { if (lm[4].x < lm[3].x) count++; }
  else                        { if (lm[4].x > lm[3].x) count++; }
  return count;
}

function clearPinTimer() {
  if (state.pinTimer) { clearInterval(state.pinTimer); state.pinTimer = null; }
  const tw = document.getElementById('pin-timer-wrap');
  if (tw) tw.style.display = 'none';
}

function confirmPinDigit(value) {
  const clamped = Math.min(value, 9);
  state.pinDigits.push(clamped);
  const el = document.getElementById(`pd${state.pinCurrentDigit}`);
  el.textContent = clamped;
  el.classList.add('filled');
  el.classList.remove('active');
  state.pinCurrentDigit++;
  state.pinCurrentCount = -1;
  if (state.pinCurrentDigit >= 4) {
    // ★ FIX: disable tracking once PIN is complete
    state.trackingEnabled = false;
    clearPinTimer();
    setStatus('ready', 'PIN entered ✓  Click Done to save.');
    document.getElementById('pin-current').textContent = 'PIN complete! ✓';
    btnDone.disabled = false;
  } else {
    updatePinUI();
  }
}

function updatePinUI() {
  document.getElementById('pin-current').textContent = `Entering digit ${state.pinCurrentDigit + 1} of 4`;
  const el = document.getElementById(`pd${state.pinCurrentDigit}`);
  if (el) el.classList.add('active');
}

// ── FACE CAPTURE ─────────────────────────
async function captureFaceLoop() {
  if (!state.faceLoopRunning) return;
  if (!state.modelsLoaded || !webcamEl.videoWidth) {
    setTimeout(captureFaceLoop, 500);
    return;
  }
  const faceBadge = document.getElementById('face-badge');
  const faceIcon  = document.getElementById('face-icon');
  const faceStat  = document.getElementById('face-status');
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.1 });
    const det  = await faceapi.detectSingleFace(webcamEl, opts)
      .withFaceLandmarks().withFaceDescriptor();
    if (det) {
      state.faceDescriptor = Array.from(det.descriptor);
      faceBadge.className  = 'face-badge pass';
      faceIcon.textContent = '✅';
      faceStat.textContent = 'Face captured ✓';
      setStatus('ready', `Face enrolled! Now ${state.method === 'pin' ? 'enter your PIN' : 'draw your ' + state.method}.`);
    } else {
      if (!state.faceDescriptor) {
        faceBadge.className  = 'face-badge checking';
        faceIcon.textContent = '👤';
        faceStat.textContent = 'Look at camera…';
      }
    }
  } catch (e) {
    console.warn('[signup] face:', e.message);
  }
  setTimeout(captureFaceLoop, 600);
}

// ── SAVE USER ─────────────────────────────
function saveUser() {
  const users = JSON.parse(localStorage.getItem('airbrush_users') || '[]');
  users.push({
    name:           state.name,
    email:          state.email,
    method:         state.method,
    authData:       state.method === 'pin' ? state.pinDigits : state.drawPoints,
    faceDescriptor: state.faceDescriptor,
    createdAt:      Date.now(),
  });
  localStorage.setItem('airbrush_users', JSON.stringify(users));
  stopCamera();
  step2El.style.display = 'none';
  step3El.style.display = 'flex';
  document.getElementById('success-name').textContent = `All set, ${state.name}! 🎉`;
}

btnBack.addEventListener('click', () => {
  stopCamera();
  step2El.style.display = 'none';
  step1El.style.display = 'flex';
});

function stopCamera() {
  state.faceLoopRunning = false;
  state.trackingEnabled = false;   // ★ always disable tracking on camera stop
  clearPinTimer();
  if (webcamEl.srcObject) webcamEl.srcObject.getTracks().forEach(t => t.stop());
  webcamEl.srcObject = null;
}
function setStatus(type, msg) {
  statusDot.className    = 'status-dot ' + type;
  statusText.textContent = msg;
}
function showError(el, msg) { el.textContent = msg; el.style.display = 'block'; }
function hideError(el)      { el.style.display = 'none'; }
