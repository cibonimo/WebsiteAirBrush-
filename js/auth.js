/* ================================================================
   auth.js — AirBrush Authentication
   Handles: Email, Air Pattern (+ face 2FA), Air PIN (+ face 2FA)
   Storage: localStorage  |  Face: face-api.js  |  Hand: MediaPipe
================================================================ */

'use strict';

/* ── Constants ── */
const FACE_MODELS_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';
const FACE_MATCH_THRESHOLD = 0.52;
const PIN_STABLE_MS  = 2000;  // ms hand must be still to confirm a digit
const PIN_MOVE_THRESH = 0.05; // normalized movement threshold
const PATTERN_MIN_PTS = 12;   // minimum points to constitute a valid pattern
const PATTERN_MATCH_THRESH = 0.22; // DTW distance threshold (lower = stricter)

/* ── Page detection ── */
const isSignup = !!document.getElementById('email-signup-btn');
const isLogin  = !!document.getElementById('email-login-btn');

/* ── State ── */
let faceApiReady = false;

/* ─────────────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────────────── */
function getUsers() {
  try { return JSON.parse(localStorage.getItem('ab_users') || '[]'); }
  catch { return []; }
}
function saveUsers(arr) {
  localStorage.setItem('ab_users', JSON.stringify(arr));
}
function findUser(email) {
  return getUsers().find(u => u.email === email);
}
function toast(msg, type = 'info') {
  let el = document.getElementById('ab-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ab-toast';
    Object.assign(el.style, {
      position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
      padding:'10px 22px', borderRadius:'10px', fontSize:'0.88rem',
      color:'#fff', zIndex:'9999', pointerEvents:'none',
      fontFamily:"'Calibri Light',Calibri,sans-serif",
      transition:'opacity 0.3s', opacity:'0'
    });
    document.body.appendChild(el);
  }
  const colors = { info:'#7C3AED', success:'#16a34a', error:'#dc2626' };
  el.style.background = colors[type] || colors.info;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}
function setStatus(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

/* ─────────────────────────────────────────────────────────────
   FACE-API LOADER
───────────────────────────────────────────────────────────── */
async function loadFaceApi() {
  if (faceApiReady) return true;
  if (typeof faceapi === 'undefined') {
    // Script might still be loading
    await new Promise(r => setTimeout(r, 1500));
    if (typeof faceapi === 'undefined') {
      toast('face-api.js not loaded', 'error'); return false;
    }
  }
  try {
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(FACE_MODELS_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL),
    ]);
    faceApiReady = true;
    return true;
  } catch(e) {
    console.error('face-api load error', e);
    toast('Face model loading failed. Check network.', 'error');
    return false;
  }
}

/* Capture face descriptor from a <video> element */
async function captureFaceDescriptor(videoEl) {
  const detection = await faceapi
    .detectSingleFace(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return Array.from(detection.descriptor);
}

/* Compare stored descriptor vs live video */
async function verifyFace(videoEl, storedDescriptorArr) {
  const liveDesc = await captureFaceDescriptor(videoEl);
  if (!liveDesc) return { ok: false, reason: 'No face detected' };
  const dist = faceapi.euclideanDistance(
    new Float32Array(storedDescriptorArr),
    new Float32Array(liveDesc)
  );
  return { ok: dist < FACE_MATCH_THRESHOLD, dist };
}

/* Start camera on a video element */
async function startCam(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 } });
  videoEl.srcObject = stream;
  return stream;
}
function stopCam(stream) {
  if (stream) stream.getTracks().forEach(t => t.stop());
}

/* Draw face boxes on a canvas overlay */
async function drawFaceOverlay(videoEl, canvasEl) {
  if (!faceApiReady || !videoEl.srcObject) return;
  const dims = { width: videoEl.videoWidth, height: videoEl.videoHeight };
  faceapi.matchDimensions(canvasEl, dims);
  const detections = await faceapi.detectAllFaces(videoEl, new faceapi.SsdMobilenetv1Options())
    .withFaceLandmarks();
  const resized = faceapi.resizeResults(detections, dims);
  const ctx = canvasEl.getContext('2d');
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  faceapi.draw.drawDetections(canvasEl, resized);
  faceapi.draw.drawFaceLandmarks(canvasEl, resized);
}

/* ─────────────────────────────────────────────────────────────
   MEDIAPIPE HANDS SETUP
───────────────────────────────────────────────────────────── */
function buildHands(onResults) {
  const hands = new Hands({ locateFile: f =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence: 0.75
  });
  hands.onResults(onResults);
  return hands;
}

/* Count extended fingers (returns 0–5) */
function countFingers(landmarks) {
  // Tip indices: 4(thumb),8(index),12(middle),16(ring),20(pinky)
  // MCP indices: 2(thumb),5(index),9(middle),13(ring),17(pinky)
  let count = 0;
  // Thumb: compare x position (mirrored)
  if (landmarks[4].x < landmarks[3].x) count++;
  // Other fingers: tip y < pip y means extended
  const tips = [8,12,16,20];
  const pips = [6,10,14,18];
  for (let i = 0; i < 4; i++) {
    if (landmarks[tips[i]].y < landmarks[pips[i]].y) count++;
  }
  return count;
}

/* ─────────────────────────────────────────────────────────────
   AUTH TAB SWITCHER (shared by signup & login)
───────────────────────────────────────────────────────────── */
document.querySelectorAll('.auth-method-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const m = btn.dataset.method;
    ['email','pattern','pin'].forEach(k => {
      const el = document.getElementById(`method-${k}`);
      if (el) el.style.display = k === m ? '' : 'none';
    });
  });
});

/* ═══════════════════════════════════════════════════════════
   SIGNUP PAGE
═══════════════════════════════════════════════════════════ */
if (isSignup) {

  /* ── Email Signup ── */
  document.getElementById('email-signup-btn').addEventListener('click', () => {
    const name     = document.getElementById('su-name-email').value.trim();
    const email    = document.getElementById('su-email').value.trim().toLowerCase();
    const pass     = document.getElementById('su-password').value;
    const confirm  = document.getElementById('su-confirm').value;
    if (!name)                    { toast('Please enter your name', 'error'); return; }
    if (!email)                   { toast('Please enter your email', 'error'); return; }
    if (pass.length < 6)          { toast('Password must be at least 6 characters', 'error'); return; }
    if (pass !== confirm)         { toast('Passwords do not match', 'error'); return; }
    if (findUser(email))          { toast('Email already registered', 'error'); return; }
    const users = getUsers();
    users.push({ type:'email', name, email, password: pass });
    saveUsers(users);
    localStorage.setItem('ab_current', JSON.stringify({ email, name }));
    toast('Account created! Redirecting…', 'success');
    setTimeout(() => window.location.href = 'canvas.html', 1200);
  });

  /* ─────────────────────────────────────────────────────────
     AIR PATTERN SIGNUP
  ───────────────────────────────────────────────────────── */
  let patternStream = null;
  let patternHands  = null;
  let patternPoints = [];
  let patternDrawing = false;
  let patternSavedPoints = null;

  const patternVideo  = document.getElementById('pattern-video');
  const patternCanvas = document.getElementById('pattern-canvas');
  const patternCtx    = patternCanvas ? patternCanvas.getContext('2d') : null;

  document.getElementById('pattern-start-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('su-name-pattern').value.trim();
    if (!name) { toast('Please enter your name first', 'error'); return; }

    setStatus('pattern-status', 'Starting camera…');
    patternStream = await startCam(patternVideo);
    patternPoints = [];
    patternDrawing = true;

    // Resize canvas to match video
    patternVideo.addEventListener('loadedmetadata', () => {
      patternCanvas.width  = patternVideo.videoWidth;
      patternCanvas.height = patternVideo.videoHeight;
    }, { once: true });

    if (!patternHands) {
      patternHands = buildHands(onPatternResults);
    }

    const camera = new Camera(patternVideo, {
      onFrame: async () => { await patternHands.send({ image: patternVideo }); },
      width: 640, height: 480
    });
    camera.start();

    document.getElementById('pattern-start-btn').style.display = 'none';
    document.getElementById('pattern-save-btn').style.display  = '';
    setStatus('pattern-status', 'Draw your pattern with your index finger. Click Save when done.');
  });

  function onPatternResults(results) {
    if (!patternCtx || !patternDrawing) return;
    patternCtx.clearRect(0, 0, patternCanvas.width, patternCanvas.height);

    // Draw skeleton
    if (results.multiHandLandmarks?.length) {
      const lm = results.multiHandLandmarks[0];
      drawConnectors(patternCtx, lm, HAND_CONNECTIONS, { color:'#7C3AED', lineWidth:2 });
      drawLandmarks(patternCtx, lm, { color:'#06B6D4', lineWidth:1, radius:3 });

      // Track index fingertip (landmark 8)
      const tip = lm[8];
      // Mirror X because video is mirrored
      const x = (1 - tip.x) * patternCanvas.width;
      const y = tip.y * patternCanvas.height;
      patternPoints.push({ x: 1 - tip.x, y: tip.y }); // normalized, mirrored

      // Draw trail
      patternCtx.beginPath();
      patternCtx.strokeStyle = '#06B6D4';
      patternCtx.lineWidth   = 3;
      patternCtx.lineCap     = 'round';
      if (patternPoints.length > 1) {
        for (let i = 1; i < patternPoints.length; i++) {
          const px = (1 - patternPoints[i-1].x) * patternCanvas.width; // re-mirror for display
          // Wait, points are already stored mirrored. Display unmirrored:
          const p0x = patternPoints[i-1].x * patternCanvas.width;
          const p0y = patternPoints[i-1].y * patternCanvas.height;
          const p1x = patternPoints[i].x   * patternCanvas.width;
          const p1y = patternPoints[i].y   * patternCanvas.height;
          patternCtx.moveTo(p0x, p0y);
          patternCtx.lineTo(p1x, p1y);
        }
        patternCtx.stroke();
      }

      // Dot at fingertip
      patternCtx.beginPath();
      patternCtx.arc(x, y, 6, 0, Math.PI*2);
      patternCtx.fillStyle = '#EC4899';
      patternCtx.fill();
    }
  }

  document.getElementById('pattern-save-btn')?.addEventListener('click', () => {
    if (patternPoints.length < PATTERN_MIN_PTS) {
      toast('Pattern too short — draw more!', 'error'); return;
    }
    patternSavedPoints = downsamplePattern(patternPoints, 32);
    patternDrawing = false;
    stopCam(patternStream);

    // Move to face capture step
    document.getElementById('pattern-step-1').style.display = 'none';
    document.getElementById('pattern-step-2').style.display = '';
    startPatternFaceCapture();
  });

  /* ── Pattern face capture ── */
  let patternFaceStream = null;
  async function startPatternFaceCapture() {
    const faceVideo  = document.getElementById('pattern-face-video');
    const faceCanvas = document.getElementById('pattern-face-canvas');
    setStatus('pattern-face-status', 'Loading face detection models…');
    const ok = await loadFaceApi();
    if (!ok) return;
    patternFaceStream = await startCam(faceVideo);
    setStatus('pattern-face-status', 'Look at the camera and click "Capture My Face".');

    // Continuous face overlay
    const loop = setInterval(async () => {
      if (!faceVideo.srcObject) { clearInterval(loop); return; }
      faceCanvas.width  = faceVideo.videoWidth;
      faceCanvas.height = faceVideo.videoHeight;
      await drawFaceOverlay(faceVideo, faceCanvas);
    }, 200);
    faceVideo._overlayLoop = loop;
  }

  document.getElementById('pattern-face-capture-btn')?.addEventListener('click', async () => {
    const faceVideo = document.getElementById('pattern-face-video');
    setStatus('pattern-face-status', 'Capturing face…');

    // Countdown
    const cd = document.getElementById('pattern-face-countdown');
    cd.style.display = 'block';
    for (let i = 3; i >= 1; i--) {
      cd.textContent = i;
      await sleep(1000);
    }
    cd.style.display = 'none';

    const desc = await captureFaceDescriptor(faceVideo);
    if (!desc) {
      setStatus('pattern-face-status', '❌ No face detected. Make sure your face is clearly visible.');
      return;
    }

    clearInterval(faceVideo._overlayLoop);
    stopCam(patternFaceStream);

    // Save user
    const name  = document.getElementById('su-name-pattern').value.trim();
    const email = `pattern_${name.toLowerCase().replace(/\s+/g,'_')}_${Date.now()}`;
    const users = getUsers();
    users.push({ type:'pattern', name, email, pattern: patternSavedPoints, faceDescriptor: desc });
    saveUsers(users);
    localStorage.setItem('ab_current', JSON.stringify({ email, name }));
    toast('Pattern & Face saved! Redirecting…', 'success');
    setTimeout(() => window.location.href = 'canvas.html', 1400);
  });

  /* ─────────────────────────────────────────────────────────
     AIR PIN SIGNUP
  ───────────────────────────────────────────────────────── */
  let pinStream   = null;
  let pinHands    = null;
  let pinDigits   = [];
  let pinCurrent  = null; // current detected count
  let pinStableStart = null;
  let pinLastPos  = null;
  let pinActive   = false;

  const pinVideo  = document.getElementById('pin-video');
  const pinCanvas = document.getElementById('pin-canvas');
  const pinCtx    = pinCanvas ? pinCanvas.getContext('2d') : null;

  document.getElementById('pin-start-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('su-name-pin').value.trim();
    if (!name) { toast('Please enter your name first', 'error'); return; }

    setStatus('pin-status', 'Starting camera…');
    pinStream = await startCam(pinVideo);
    pinDigits = [];
    pinActive = true;
    updatePinDisplay();

    pinVideo.addEventListener('loadedmetadata', () => {
      pinCanvas.width  = pinVideo.videoWidth;
      pinCanvas.height = pinVideo.videoHeight;
    }, { once: true });

    if (!pinHands) {
      pinHands = buildHands(onPinResults);
    }
    const camera = new Camera(pinVideo, {
      onFrame: async () => { await pinHands.send({ image: pinVideo }); },
      width: 640, height: 480
    });
    camera.start();

    document.getElementById('pin-start-btn').style.display = 'none';
    setStatus('pin-status', `Digit 1: Hold up 1-5 fingers and keep still for 2 seconds.`);
  });

  function onPinResults(results) {
    if (!pinCtx || !pinActive) return;
    pinCtx.clearRect(0, 0, pinCanvas.width, pinCanvas.height);
    if (pinDigits.length >= 4) return;

    if (results.multiHandLandmarks?.length) {
      const lm = results.multiHandLandmarks[0];
      drawConnectors(pinCtx, lm, HAND_CONNECTIONS, { color:'#7C3AED', lineWidth:2 });
      drawLandmarks(pinCtx, lm, { color:'#06B6D4', lineWidth:1, radius:3 });

      const count = countFingers(lm);
      const wrist = lm[0];

      // Movement detection
      const isMoving = pinLastPos
        ? (Math.abs(wrist.x - pinLastPos.x) > PIN_MOVE_THRESH ||
           Math.abs(wrist.y - pinLastPos.y) > PIN_MOVE_THRESH)
        : false;
      pinLastPos = { x: wrist.x, y: wrist.y };

      if (isMoving) {
        pinStableStart = null;
        pinCurrent = null;
        setStatus('pin-status', `Digit ${pinDigits.length+1}: Hold still… (moving)`);
        return;
      }

      if (count !== pinCurrent) {
        pinCurrent = count;
        pinStableStart = Date.now();
        setStatus('pin-status', `Digit ${pinDigits.length+1}: Showing ${count} finger${count!==1?'s':''}… hold still`);
      } else if (pinStableStart && (Date.now() - pinStableStart) >= PIN_STABLE_MS) {
        // Confirmed!
        pinDigits.push(count);
        pinStableStart = null;
        pinCurrent = null;
        pinLastPos = null;
        updatePinDisplay();

        if (pinDigits.length < 4) {
          setStatus('pin-status', `✅ Digit ${pinDigits.length} set! Now digit ${pinDigits.length+1}.`);
        } else {
          setStatus('pin-status', '✅ PIN complete! Click "Save PIN" to continue.');
          document.getElementById('pin-save-btn').style.display = '';
          pinActive = false;
        }
      } else {
        // Show countdown
        const elapsed = pinStableStart ? (Date.now() - pinStableStart) : 0;
        const remain  = ((PIN_STABLE_MS - elapsed) / 1000).toFixed(1);
        setStatus('pin-status', `Digit ${pinDigits.length+1}: ${count} finger${count!==1?'s':''} — holding… ${remain}s`);
      }

      // Draw finger count label
      const tipX = (1 - lm[8].x) * pinCanvas.width;
      const tipY = lm[8].y * pinCanvas.height - 20;
      pinCtx.fillStyle = '#fff';
      pinCtx.font = 'bold 18px Calibri Light, Calibri, sans-serif';
      pinCtx.fillText(`${count}`, tipX, tipY);
    } else {
      pinLastPos = null;
      pinStableStart = null;
      setStatus('pin-status', `Digit ${pinDigits.length+1}: Show your hand to the camera.`);
    }
  }

  function updatePinDisplay() {
    const el = document.getElementById('pin-display');
    if (!el) return;
    const chars = ['_','_','_','_'];
    pinDigits.forEach((d,i) => chars[i] = `<span style="color:#22c55e">${d}</span>`);
    el.innerHTML = chars.join(' ');
  }

  document.getElementById('pin-save-btn')?.addEventListener('click', () => {
    if (pinDigits.length < 4) { toast('PIN not complete', 'error'); return; }
    stopCam(pinStream);
    document.getElementById('pin-step-1').style.display = 'none';
    document.getElementById('pin-step-2').style.display = '';
    startPinFaceCapture();
  });

  /* ── PIN face capture ── */
  let pinFaceStream = null;
  async function startPinFaceCapture() {
    const faceVideo  = document.getElementById('pin-face-video');
    const faceCanvas = document.getElementById('pin-face-canvas');
    setStatus('pin-face-status', 'Loading face detection models…');
    const ok = await loadFaceApi();
    if (!ok) return;
    pinFaceStream = await startCam(faceVideo);
    setStatus('pin-face-status', 'Look at the camera and click "Capture My Face".');

    const loop = setInterval(async () => {
      if (!faceVideo.srcObject) { clearInterval(loop); return; }
      faceCanvas.width  = faceVideo.videoWidth;
      faceCanvas.height = faceVideo.videoHeight;
      await drawFaceOverlay(faceVideo, faceCanvas);
    }, 200);
    faceVideo._overlayLoop = loop;
  }

  document.getElementById('pin-face-capture-btn')?.addEventListener('click', async () => {
    const faceVideo = document.getElementById('pin-face-video');
    setStatus('pin-face-status', 'Capturing face…');

    const cd = document.getElementById('pin-face-countdown');
    if (cd) { cd.style.display = 'block'; }
    for (let i = 3; i >= 1; i--) {
      if (cd) cd.textContent = i;
      await sleep(1000);
    }
    if (cd) cd.style.display = 'none';

    const desc = await captureFaceDescriptor(faceVideo);
    if (!desc) {
      setStatus('pin-face-status', '❌ No face detected. Make sure your face is clearly visible.');
      return;
    }

    clearInterval(faceVideo._overlayLoop);
    stopCam(pinFaceStream);

    const name  = document.getElementById('su-name-pin').value.trim();
    const email = `pin_${name.toLowerCase().replace(/\s+/g,'_')}_${Date.now()}`;
    const users = getUsers();
    users.push({ type:'pin', name, email, pin: pinDigits, faceDescriptor: desc });
    saveUsers(users);
    localStorage.setItem('ab_current', JSON.stringify({ email, name }));
    toast('PIN & Face saved! Redirecting…', 'success');
    setTimeout(() => window.location.href = 'canvas.html', 1400);
  });

} /* end isSignup */

/* ═══════════════════════════════════════════════════════════
   LOGIN PAGE
═══════════════════════════════════════════════════════════ */
if (isLogin) {

  /* ── Email Login ── */
  document.getElementById('email-login-btn').addEventListener('click', () => {
    const email = document.getElementById('li-email').value.trim().toLowerCase();
    const pass  = document.getElementById('li-password').value;
    const user  = findUser(email);
    if (!user || user.type !== 'email') { toast('No account found with this email', 'error'); return; }
    if (user.password !== pass)          { toast('Incorrect password', 'error'); return; }
    localStorage.setItem('ab_current', JSON.stringify({ email, name: user.name }));
    toast(`Welcome back, ${user.name}!`, 'success');
    setTimeout(() => window.location.href = 'canvas.html', 1000);
  });

  /* ─────────────────────────────────────────────────────────
     PATTERN LOGIN
  ───────────────────────────────────────────────────────── */
  let loginPatternStream = null;
  let loginPatternHands  = null;
  let loginPatternPoints = [];
  let loginPatternActive = false;

  const loginPatternVideo  = document.getElementById('pattern-video');
  const loginPatternCanvas = document.getElementById('pattern-canvas');
  const loginPatternCtx    = loginPatternCanvas ? loginPatternCanvas.getContext('2d') : null;

  document.getElementById('pattern-login-btn')?.addEventListener('click', async () => {
    setStatus('pattern-status', 'Starting camera…');
    loginPatternStream = await startCam(loginPatternVideo);
    loginPatternPoints = [];
    loginPatternActive = true;

    loginPatternVideo.addEventListener('loadedmetadata', () => {
      loginPatternCanvas.width  = loginPatternVideo.videoWidth;
      loginPatternCanvas.height = loginPatternVideo.videoHeight;
    }, { once: true });

    if (!loginPatternHands) {
      loginPatternHands = buildHands(onLoginPatternResults);
    }
    const camera = new Camera(loginPatternVideo, {
      onFrame: async () => { await loginPatternHands.send({ image: loginPatternVideo }); },
      width: 640, height: 480
    });
    camera.start();

    document.getElementById('pattern-login-btn').style.display  = 'none';
    document.getElementById('pattern-verify-btn').style.display = '';
    setStatus('pattern-status', 'Draw your registered pattern with your index finger.');
  });

  function onLoginPatternResults(results) {
    if (!loginPatternCtx || !loginPatternActive) return;
    loginPatternCtx.clearRect(0, 0, loginPatternCanvas.width, loginPatternCanvas.height);
    if (!results.multiHandLandmarks?.length) return;
    const lm = results.multiHandLandmarks[0];
    drawConnectors(loginPatternCtx, lm, HAND_CONNECTIONS, { color:'#7C3AED', lineWidth:2 });
    drawLandmarks(loginPatternCtx, lm, { color:'#06B6D4', lineWidth:1, radius:3 });

    const tip = lm[8];
    const x = (1 - tip.x) * loginPatternCanvas.width;
    const y = tip.y * loginPatternCanvas.height;
    loginPatternPoints.push({ x: 1 - tip.x, y: tip.y });

    loginPatternCtx.beginPath();
    loginPatternCtx.strokeStyle = '#06B6D4';
    loginPatternCtx.lineWidth   = 3;
    if (loginPatternPoints.length > 1) {
      for (let i = 1; i < loginPatternPoints.length; i++) {
        loginPatternCtx.moveTo(loginPatternPoints[i-1].x * loginPatternCanvas.width, loginPatternPoints[i-1].y * loginPatternCanvas.height);
        loginPatternCtx.lineTo(loginPatternPoints[i].x   * loginPatternCanvas.width, loginPatternPoints[i].y   * loginPatternCanvas.height);
      }
      loginPatternCtx.stroke();
    }
    loginPatternCtx.beginPath();
    loginPatternCtx.arc(x, y, 6, 0, Math.PI*2);
    loginPatternCtx.fillStyle = '#EC4899';
    loginPatternCtx.fill();
  }

  document.getElementById('pattern-verify-btn')?.addEventListener('click', async () => {
    if (loginPatternPoints.length < PATTERN_MIN_PTS) {
      toast('Pattern too short — draw more!', 'error'); return;
    }
    loginPatternActive = false;
    stopCam(loginPatternStream);

    const drawn = downsamplePattern(loginPatternPoints, 32);
    // Find matching user
    const users = getUsers().filter(u => u.type === 'pattern');
    let matched = null;
    let bestDist = Infinity;
    for (const u of users) {
      const d = dtwDistance(drawn, u.pattern);
      if (d < PATTERN_MATCH_THRESH && d < bestDist) { bestDist = d; matched = u; }
    }

    if (!matched) {
      setStatus('pattern-status', '❌ Pattern does not match any account. Try again.');
      toast('Pattern not recognised', 'error');
      return;
    }

    toast(`Pattern matched: ${matched.name}. Now verify face.`, 'info');
    document.getElementById('pattern-login-step1').style.display = 'none';
    document.getElementById('pattern-login-step2').style.display = '';
    startLoginFaceVerify('pattern', matched);
  });

  /* ─────────────────────────────────────────────────────────
     PIN LOGIN
  ───────────────────────────────────────────────────────── */
  let loginPinStream   = null;
  let loginPinHands    = null;
  let loginPinDigits   = [];
  let loginPinCurrent  = null;
  let loginPinStable   = null;
  let loginPinLastPos  = null;
  let loginPinActive   = false;

  const loginPinVideo  = document.getElementById('pin-video');
  const loginPinCanvas = document.getElementById('pin-canvas');
  const loginPinCtx    = loginPinCanvas ? loginPinCanvas.getContext('2d') : null;

  document.getElementById('pin-login-btn')?.addEventListener('click', async () => {
    setStatus('pin-status', 'Starting camera…');
    loginPinStream = await startCam(loginPinVideo);
    loginPinDigits = [];
    loginPinActive = true;
    updateLoginPinDisplay();

    loginPinVideo.addEventListener('loadedmetadata', () => {
      loginPinCanvas.width  = loginPinVideo.videoWidth;
      loginPinCanvas.height = loginPinVideo.videoHeight;
    }, { once: true });

    if (!loginPinHands) loginPinHands = buildHands(onLoginPinResults);
    const camera = new Camera(loginPinVideo, {
      onFrame: async () => { await loginPinHands.send({ image: loginPinVideo }); },
      width: 640, height: 480
    });
    camera.start();

    document.getElementById('pin-login-btn').style.display  = 'none';
    setStatus('pin-status', `Digit 1: Hold up fingers and keep still for 2 seconds.`);
  });

  function onLoginPinResults(results) {
    if (!loginPinCtx || !loginPinActive) return;
    loginPinCtx.clearRect(0, 0, loginPinCanvas.width, loginPinCanvas.height);
    if (loginPinDigits.length >= 4) return;

    if (results.multiHandLandmarks?.length) {
      const lm = results.multiHandLandmarks[0];
      drawConnectors(loginPinCtx, lm, HAND_CONNECTIONS, { color:'#7C3AED', lineWidth:2 });
      drawLandmarks(loginPinCtx, lm, { color:'#06B6D4', lineWidth:1, radius:3 });
      const count = countFingers(lm);
      const wrist = lm[0];

      const isMoving = loginPinLastPos
        ? (Math.abs(wrist.x - loginPinLastPos.x) > PIN_MOVE_THRESH ||
           Math.abs(wrist.y - loginPinLastPos.y) > PIN_MOVE_THRESH)
        : false;
      loginPinLastPos = { x: wrist.x, y: wrist.y };

      if (isMoving) { loginPinStable = null; loginPinCurrent = null; return; }

      if (count !== loginPinCurrent) {
        loginPinCurrent = count;
        loginPinStable  = Date.now();
      } else if (loginPinStable && (Date.now() - loginPinStable) >= PIN_STABLE_MS) {
        loginPinDigits.push(count);
        loginPinStable = null; loginPinCurrent = null; loginPinLastPos = null;
        updateLoginPinDisplay();
        if (loginPinDigits.length >= 4) {
          setStatus('pin-status', '✅ PIN entered! Click "Verify PIN".');
          document.getElementById('pin-verify-btn').style.display = '';
          loginPinActive = false;
        } else {
          setStatus('pin-status', `✅ Digit ${loginPinDigits.length} done. Now digit ${loginPinDigits.length+1}.`);
        }
      }
    }
  }

  function updateLoginPinDisplay() {
    const el = document.getElementById('pin-display');
    if (!el) return;
    const chars = ['_','_','_','_'];
    loginPinDigits.forEach((d,i) => chars[i] = `<span style="color:#22c55e">${d}</span>`);
    el.innerHTML = chars.join(' ');
  }

  document.getElementById('pin-verify-btn')?.addEventListener('click', async () => {
    stopCam(loginPinStream);
    const users = getUsers().filter(u => u.type === 'pin');
    const matched = users.find(u =>
      u.pin.length === 4 && u.pin.every((d,i) => d === loginPinDigits[i])
    );
    if (!matched) {
      toast('PIN does not match any account', 'error');
      setStatus('pin-status', '❌ Incorrect PIN.');
      return;
    }
    toast(`PIN matched: ${matched.name}. Now verify face.`, 'info');
    document.getElementById('pin-login-step1').style.display = 'none';
    document.getElementById('pin-login-step2').style.display = '';
    startLoginFaceVerify('pin', matched);
  });

  /* ─────────────────────────────────────────────────────────
     FACE VERIFICATION FOR LOGIN (shared)
  ───────────────────────────────────────────────────────── */
  let faceVerifyStream = null;

  async function startLoginFaceVerify(method, user) {
    const faceVideo  = document.getElementById(`${method}-face-video`);
    const faceCanvas = document.getElementById(`${method}-face-canvas`);
    const statusId   = `${method}-face-status`;
    const btnId      = `${method}-face-verify-btn`;

    setStatus(statusId, 'Loading face detection models…');
    const ok = await loadFaceApi();
    if (!ok) return;
    faceVerifyStream = await startCam(faceVideo);
    setStatus(statusId, 'Look at the camera and click "Verify Face & Login".');

    const loop = setInterval(async () => {
      if (!faceVideo.srcObject) { clearInterval(loop); return; }
      faceCanvas.width  = faceVideo.videoWidth;
      faceCanvas.height = faceVideo.videoHeight;
      await drawFaceOverlay(faceVideo, faceCanvas);
    }, 200);
    faceVideo._overlayLoop = loop;

    document.getElementById(btnId).addEventListener('click', async () => {
      setStatus(statusId, 'Verifying face…');
      const result = await verifyFace(faceVideo, user.faceDescriptor);
      clearInterval(faceVideo._overlayLoop);
      stopCam(faceVerifyStream);

      if (!result.ok) {
        setStatus(statusId, `❌ Face not recognised (distance: ${result.dist?.toFixed(2)}). Try again.`);
        toast('Face verification failed', 'error');
        return;
      }
      localStorage.setItem('ab_current', JSON.stringify({ email: user.email, name: user.name }));
      toast(`Welcome back, ${user.name}! 🎉`, 'success');
      setTimeout(() => window.location.href = 'canvas.html', 1200);
    }, { once: true });
  }

} /* end isLogin */

/* ─────────────────────────────────────────────────────────────
   PATTERN UTILITIES
───────────────────────────────────────────────────────────── */
function downsamplePattern(pts, n) {
  if (pts.length <= n) return pts;
  const result = [];
  const step   = (pts.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    result.push(pts[Math.round(i * step)]);
  }
  return result;
}

function dtwDistance(a, b) {
  const m = a.length, n = b.length;
  const dtw = Array.from({ length: m+1 }, () => new Array(n+1).fill(Infinity));
  dtw[0][0] = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = Math.hypot(a[i-1].x - b[j-1].x, a[i-1].y - b[j-1].y);
      dtw[i][j]  = cost + Math.min(dtw[i-1][j], dtw[i][j-1], dtw[i-1][j-1]);
    }
  }
  return dtw[m][n] / (m + n);
}

/* ── Helpers ── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
