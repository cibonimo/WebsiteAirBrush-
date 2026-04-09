// ═══════════════════════════════════════════
//  AIRBRUSH — login.js  (v6)
//  Changes:
//   • maxNumHands: 2 — enables 6-10 via two hands
//   • Auto-detect tracking — no Start/Stop buttons
//   • Face match % moved to top of window
//   • Tracking stops automatically on Verify
// ═══════════════════════════════════════════

const state = {
  user: null,
  isDrawing: false,
  trackingEnabled: false,          // ★ FIX: gate all gesture detection
  drawPoints: [], overlayStrokes: [], currentOverlayStroke: null,
  handVisible: false,
  pinDigits: [], pinCurrentDigit: 0, pinCurrentCount: -1,
  pinTimer: null, pinCountdown: 3,
  modelsLoaded: false, faceResult: null, faceDistance: Infinity,
  FACE_THRESHOLD: 0.65, PATH_THRESHOLD: 0.45,
  faceLoopRunning: false,
  wasPinching: false, gestureHoldFrames: 0,
  latestLandmarks: null, latestHandResults: null,
};

let _bestFaceDist = Infinity;

// ── DOM REFS ─────────────────────────────
const step1El    = document.getElementById('step1');
const step2El    = document.getElementById('step2');
const step3El    = document.getElementById('step3');
const stepFail   = document.getElementById('step-fail');
const inpEmail   = document.getElementById('inp-email');
const btnNext    = document.getElementById('btn-step1-next');
const btnBack    = document.getElementById('btn-back');
const btnVerify  = document.getElementById('btn-verify');
const btnClear   = document.getElementById('btn-clear-draw');
const btnRetry   = document.getElementById('btn-retry');
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
const faceBadge  = document.getElementById('face-badge');
const faceIcon   = document.getElementById('face-icon');
const faceStat   = document.getElementById('face-status');
const webcamEl      = document.getElementById('webcam');
const overlayCanvas = document.getElementById('overlay-canvas');
const drawCanvas    = document.getElementById('draw-canvas');
const overlayCtx    = overlayCanvas.getContext('2d');
const drawCtx       = drawCanvas.getContext('2d');

webcamEl.style.transform      = 'scaleX(-1)';
overlayCanvas.style.transform = 'scaleX(-1)';

// ── STEP 1 — EMAIL LOOKUP ─────────────────
btnNext.addEventListener('click', () => {
  const email = inpEmail.value.trim().toLowerCase();
  if (!email || !email.includes('@'))
    return showError(err1, 'Please enter a valid email address.');
  const users = JSON.parse(localStorage.getItem('airbrush_users') || '[]');
  const match = users.find(u => u.email.toLowerCase() === email);
  if (!match)
    return showError(err1, 'No account found. Please sign up first.');
  if (!match.faceDescriptor || !Array.isArray(match.faceDescriptor) || match.faceDescriptor.length < 128)
    return showError(err1, 'Account has no face data. Please sign up again.');
  hideError(err1);
  state.user = match;
  goToStep2();
});

// ── STEP 2 SETUP ─────────────────────────
function goToStep2() {
  step1El.style.display = 'none';
  step2El.style.display = 'flex';
  const method = state.user.method;
  const labels = {
    sign:    ['Verify your Signature',  'Pinch (👌) to draw, open palm (🖐) to stop.'],
    pattern: ['Verify your Pattern',    'Pinch (👌) to draw, open palm (🖐) to stop.'],
    pin:     ['Verify your Finger PIN', 'Show fingers for each digit (3-second hold).'],
  };
  step2Title.textContent = labels[method][0];
  step2Sub.textContent   = labels[method][1];
  if (method === 'pin') {
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
  state.trackingEnabled = false;   // ★ start with tracking OFF
  _bestFaceDist = Infinity;

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

  camera.start().then(() => {
    // ★ FIX: force video to be visible
    webcamEl.style.display    = 'block';
    webcamEl.style.opacity    = '1';
    webcamEl.style.visibility = 'visible';

    setStatus('ready', 'Camera ready — look at the camera ✓');
    if (!state.faceLoopRunning) {
      state.faceLoopRunning = true;
      runFaceVerification();
    }
    // Auto-enable tracking for ALL modes (no Start button needed)
    state.trackingEnabled = true;
    if (state.user.method === 'pin') {
      updatePinUI();
    }
  }).catch(e => {
    setStatus('error', 'Camera access denied. Allow webcam and reload.');
    showError(err2, e.message);
  });
}

// ── HAND RESULTS → state only ────────────
function onHandResults(results) {
  state.latestLandmarks   = (results.multiHandLandmarks && results.multiHandLandmarks.length > 0)
    ? results.multiHandLandmarks[0] : null;
  state.latestHandResults = results;
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

  // ★ FIX: only process gestures when tracking is enabled
  if (state.trackingEnabled) {
    if (state.user.method === 'pin') {
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

function _startDrawing() {
  if (state.isDrawing) return;
  state.isDrawing       = true;
  state.currentOverlayStroke = null;
  setStatus('ready', '👌 Pinch to draw — open palm to stop');
}

function _stopDrawing() {
  if (!state.isDrawing) return;
  state.isDrawing       = false;
  // Keep tracking enabled so user can draw again
  clearPinTimer();
  if (state.currentOverlayStroke && state.currentOverlayStroke.length > 1)
    state.overlayStrokes.push([...state.currentOverlayStroke]);
  state.currentOverlayStroke = null;
  if (state.drawPoints.length > 10) {
    btnVerify.disabled = false;
    setStatus('ready', '✅ Drawing captured — click Verify');
  } else {
    showError(err2, 'Drawing too short — pinch and draw a longer shape.');
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
  btnVerify.disabled = true;
  initDrawCanvas();
  setStatus('ready', 'Cleared — pinch to draw again');
});

// ── PIN ───────────────────────────────────
function handlePIN(results) {
  // ★ FIX: stop when PIN is complete
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
    // ★ FIX: disable tracking when PIN is complete
    state.trackingEnabled = false;
    clearPinTimer();
    setStatus('ready', 'PIN entered ✓  Click Verify.');
    document.getElementById('pin-current').textContent = 'PIN complete! ✓';
    btnVerify.disabled = false;
  } else {
    updatePinUI();
  }
}

function updatePinUI() {
  document.getElementById('pin-current').textContent = `Entering digit ${state.pinCurrentDigit + 1} of 4`;
  const el = document.getElementById(`pd${state.pinCurrentDigit}`);
  if (el) el.classList.add('active');
}

// ── FACE VERIFICATION LOOP ───────────────
async function runFaceVerification() {
  if (!state.faceLoopRunning) return;
  if (!state.modelsLoaded || !webcamEl.videoWidth) {
    setTimeout(runFaceVerification, 500);
    return;
  }
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.1 });
    const det  = await faceapi.detectSingleFace(webcamEl, opts)
      .withFaceLandmarks().withFaceDescriptor();
    if (det) {
      const rawStored = state.user.faceDescriptor;
      const stored = rawStored instanceof Float32Array ? rawStored
        : Array.isArray(rawStored) ? new Float32Array(rawStored)
        : new Float32Array(Object.values(rawStored));

      if (stored.length !== det.descriptor.length) {
        setFaceBadge('fail', '⚠️', 'Model mismatch — sign up again');
        setTimeout(runFaceVerification, 3000);
        return;
      }

      const dist  = euclideanDist(stored, det.descriptor);
      if (dist < _bestFaceDist) _bestFaceDist = dist;
      const score = (1 - dist).toFixed(2);
      const best  = (1 - _bestFaceDist).toFixed(2);
      const need  = (1 - state.FACE_THRESHOLD).toFixed(2);

      if (dist < state.FACE_THRESHOLD) {
        state.faceResult = 'pass';
        setFaceBadge('pass', '✅', `Face matched ✓  score: ${score}`);
      } else {
        if (state.faceResult !== 'pass') state.faceResult = 'fail';
        setFaceBadge(
          state.faceResult === 'pass' ? 'pass' : 'fail',
          state.faceResult === 'pass' ? '✅' : '🔄',
          `Scanning… score: ${score}  best: ${best}  need: >${need}`
        );
      }
    } else {
      if (state.faceResult !== 'pass') {
        setFaceBadge('checking', '👤', 'No face — look directly at the camera');
      } else {
        setFaceBadge('pass', '✅', 'Face verified ✓');
      }
    }
  } catch(e) {
    console.warn('[login] face err:', e.message);
    setFaceBadge('checking', '⏳', 'Retrying face scan…');
  }
  setTimeout(runFaceVerification, 600);
}

function euclideanDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function setFaceBadge(type, icon, text) {
  if (!faceBadge) return;
  faceBadge.className  = 'face-badge ' + type;
  faceIcon.textContent = icon;
  faceStat.textContent = text;
}

// ── VERIFY & LOG IN ───────────────────────
btnVerify.addEventListener('click', () => {
  hideError(err2);
  // Stop tracking when submit is pressed
  state.trackingEnabled = false;
  clearPinTimer();
  const method = state.user.method;
  const gesturePass = method === 'pin'
    ? verifyPIN(state.pinDigits, state.user.authData)
    : verifyPath(state.drawPoints, state.user.authData);
  const facePass = state.faceResult === 'pass' || _bestFaceDist < state.FACE_THRESHOLD;

  if (gesturePass && facePass) {
    goToSuccess();
  } else if (!gesturePass && !facePass) {
    const bs   = (1 - _bestFaceDist).toFixed(2);
    const need = (1 - state.FACE_THRESHOLD).toFixed(2);
    goToFail(`Both gesture and face failed.\n\nFace best score: ${bs} (need >${need})\nTip: ensure good lighting on your face.\n\nGesture: redraw the same shape as sign-up.`);
  } else if (!gesturePass) {
    goToFail('Gesture failed — redraw the same shape you used at sign-up.\nDraw slowly and clearly.');
  } else {
    const bs   = (1 - _bestFaceDist).toFixed(2);
    const need = (1 - state.FACE_THRESHOLD).toFixed(2);
    goToFail(`Face verification failed.\n\nBest score: ${bs}  (need >${need})\n\nTips:\n• Light must be on your face\n• Look directly into camera\n• Wait for ✅ badge before clicking Verify`);
  }
});

function verifyPIN(entered, stored) {
  if (entered.length !== 4 || stored.length !== 4) return false;
  return entered.every((d, i) => d === stored[i]);
}

function verifyPath(drawnPoints, storedPoints) {
  if (drawnPoints.length < 10 || storedPoints.length < 10) return false;
  const N = 64;
  const normD = normalizePath(resamplePath(drawnPoints, N));
  const normS = normalizePath(resamplePath(storedPoints, N));
  let total = 0;
  for (let i = 0; i < N; i++) {
    total += Math.hypot(normD[i].x - normS[i].x, normD[i].y - normS[i].y);
  }
  const avgDist = total / N;
  console.log(`[login] Path dist: ${avgDist.toFixed(3)} / threshold: ${state.PATH_THRESHOLD}`);
  return avgDist < state.PATH_THRESHOLD;
}

function resamplePath(points, N) {
  if (!points.length) return [];
  let totalLen = 0;
  for (let i = 1; i < points.length; i++)
    totalLen += Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
  if (!totalLen) return Array(N).fill({ ...points[0] });
  const interval = totalLen / (N - 1);
  const result   = [{ ...points[0] }];
  let acc = 0;
  for (let i = 1; i < points.length && result.length < N; i++) {
    const dx = points[i].x - points[i-1].x, dy = points[i].y - points[i-1].y;
    const segLen = Math.hypot(dx, dy);
    while (acc + segLen >= interval * result.length && result.length < N) {
      const t = (interval * result.length - acc) / segLen;
      result.push({ x: points[i-1].x + t*dx, y: points[i-1].y + t*dy });
    }
    acc += segLen;
  }
  while (result.length < N) result.push({ ...points[points.length - 1] });
  return result;
}

function normalizePath(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rX = maxX - minX || 1, rY = maxY - minY || 1;
  return pts.map(p => ({ x: (p.x - minX)/rX, y: (p.y - minY)/rY }));
}

// ── SUCCESS ───────────────────────────────
function goToSuccess() {
  stopCamera();
  step2El.style.display = 'none';
  step3El.style.display = 'flex';
  document.getElementById('success-name').textContent = `Welcome back, ${state.user.name}! 👋`;
  sessionStorage.setItem('airbrush_session', JSON.stringify({
    email: state.user.email,
    name:  state.user.name,
  }));
  requestAnimationFrame(() => {
    document.getElementById('redirect-fill').style.width = '100%';
  });
  setTimeout(() => { window.location.href = 'canvas.html'; }, 2400);
}

// ── FAIL ─────────────────────────────────
function goToFail(reason) {
  stopCamera();
  step2El.style.display  = 'none';
  stepFail.style.display = 'flex';
  document.getElementById('fail-reason').textContent = reason;
}

btnRetry.addEventListener('click', () => {
  stepFail.style.display = 'none';
  state.drawPoints = []; state.overlayStrokes = []; state.currentOverlayStroke = null;
  state.pinDigits = []; state.pinCurrentDigit = 0; state.pinCurrentCount = -1;
  state.faceResult = null; state.wasPinching = false; state.gestureHoldFrames = 0;
  state.trackingEnabled = false;
  _bestFaceDist = Infinity;
  clearPinTimer();
  btnVerify.disabled = true;
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`pd${i}`);
    el.textContent = '_';
    el.className = 'pin-digit';
  }
  goToStep2();
});

btnBack.addEventListener('click', () => {
  stopCamera();
  _bestFaceDist = Infinity;
  step2El.style.display = 'none';
  step1El.style.display = 'flex';
});

// ── HELPERS ──────────────────────────────
function stopCamera() {
  state.faceLoopRunning = false;
  state.trackingEnabled = false;   // ★ always disable on stop
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
