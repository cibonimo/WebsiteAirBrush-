/* ═══════════════════════════════════════════
   AIRBRUSH — auth.js (Sign Up + Login)
   ═══════════════════════════════════════════ */

const isLoginPage = !!document.getElementById('email-login-btn');

// ── Auth method tabs ─────────────────────────
document.querySelectorAll('.auth-method-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('[id^="method-"]').forEach(el => el.style.display = 'none');
    document.getElementById('method-' + btn.dataset.method).style.display = 'block';
  });
});

// ── Email Signup ─────────────────────────────
document.getElementById('email-signup-btn')?.addEventListener('click', () => {
  const email    = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-password').value;
  const confirm  = document.getElementById('su-confirm').value;
  if (!email || !password) return alert('Please fill all fields.');
  if (password.length < 6)  return alert('Password must be at least 6 characters.');
  if (password !== confirm)  return alert('Passwords do not match.');
  localStorage.setItem('airbrush_user', JSON.stringify({ email, password, method: 'email' }));
  alert('Account created! Please log in.');
  window.location.href = 'login.html';
});

// ── Email Login ──────────────────────────────
document.getElementById('email-login-btn')?.addEventListener('click', () => {
  const email    = document.getElementById('li-email').value.trim();
  const password = document.getElementById('li-password').value;
  const user     = JSON.parse(localStorage.getItem('airbrush_user') || 'null');
  if (!user) return alert('No account found. Please sign up first.');
  if (user.email !== email || user.password !== password) return alert('Incorrect email or password.');
  localStorage.setItem('airbrush_session', '1');
  window.location.href = 'canvas.html';
});

// ── Air Pattern (Gesture Draw) ───────────────
// This uses MediaPipe Hands to track index finger tip
// and records a path as the "pattern"

let patternPoints  = [];
let patternStream  = null;
let patternCapturing = false;

async function startPatternCamera(videoId, canvasId) {
  const video  = document.getElementById(videoId);
  const canvas = document.getElementById(canvasId);
  if (!video || !canvas) return;
  patternStream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = patternStream;
  await video.play();
  canvas.width  = video.videoWidth  || 320;
  canvas.height = video.videoHeight || 240;

  // Dynamically load MediaPipe
  if (!window.Hands) {
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
  }

  const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
  hands.onResults(results => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (!results.multiHandLandmarks?.length) return;
    const lm = results.multiHandLandmarks[0];
    const tip = lm[8]; // index finger tip
    const x = tip.x * canvas.width;
    const y = tip.y * canvas.height;
    if (patternCapturing) {
      patternPoints.push({ x: tip.x, y: tip.y });
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2);
      ctx.fillStyle = '#7C3AED'; ctx.fill();
    }
  });

  const camera = new Camera(video, { onFrame: async () => { await hands.send({ image: video }); }, width: 320, height: 240 });
  camera.start();
  patternCapturing = true;
}

function loadScript(src) {
  return new Promise(res => { const s = document.createElement('script'); s.src = src; s.onload = res; document.head.appendChild(s); });
}

// Signup pattern
document.getElementById('pattern-start-btn')?.addEventListener('click', async () => {
  document.getElementById('pattern-start-btn').style.display = 'none';
  await startPatternCamera('pattern-video', 'pattern-canvas');
  document.getElementById('pattern-save-btn').style.display = 'block';
});

document.getElementById('pattern-save-btn')?.addEventListener('click', () => {
  if (patternPoints.length < 20) return alert('Pattern too short. Draw a longer path.');
  const existing = JSON.parse(localStorage.getItem('airbrush_user') || '{}');
  existing.pattern = patternPoints;
  existing.method  = 'pattern';
  localStorage.setItem('airbrush_user', JSON.stringify(existing));
  alert('Pattern saved! Please log in.');
  window.location.href = 'login.html';
});

// Login pattern (simplified: just re-draw and auto-verify as "match" for MVP)
document.getElementById('pattern-login-btn')?.addEventListener('click', async () => {
  const user = JSON.parse(localStorage.getItem('airbrush_user') || 'null');
  if (!user?.pattern) return alert('No pattern registered. Please sign up with Air Pattern first.');
  patternPoints = [];
  await startPatternCamera('pattern-video', 'pattern-canvas');
  // For MVP: after 5 seconds of capture, compare length (simplified match)
  setTimeout(() => {
    if (patternPoints.length > 15) {
      localStorage.setItem('airbrush_session', '1');
      alert('Pattern verified!');
      window.location.href = 'canvas.html';
    } else {
      alert('Pattern not recognized. Try again.');
    }
  }, 6000);
});

// ── Air PIN ───────────────────────────────────
let pinDigits  = [];
let pinStream  = null;
let pinActive  = false;
let stableCount = 0, lastFingers = -1, stableFrames = 0;
const PIN_STABLE_FRAMES = 90; // ~3 seconds at 30fps

function countFingers(landmarks) {
  // Count extended fingers (simplified)
  const tips   = [4, 8, 12, 16, 20];
  const bases  = [3, 6, 10, 14, 18];
  let count = 0;
  for (let i = 1; i < 5; i++) {
    if (landmarks[tips[i]].y < landmarks[bases[i]].y) count++;
  }
  // Thumb
  if (landmarks[4].x < landmarks[3].x) count++;
  return count;
}

function updatePinDisplay() {
  const el = document.getElementById('pin-display');
  if (!el) return;
  el.textContent = pinDigits.map((d, i) => i < pinDigits.length ? '●' : '_').join(' ');
  for (let i = pinDigits.length; i < 4; i++) el.textContent += ' _';
}

async function startPinCamera(videoId, canvasId, onComplete) {
  const video  = document.getElementById(videoId);
  const canvas = document.getElementById(canvasId);
  if (!video || !canvas) return;
  pinStream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = pinStream;
  await video.play();
  canvas.width = 320; canvas.height = 240;

  if (!window.Hands) {
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
  }

  const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
  hands.onResults(results => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (pinDigits.length >= 4) { onComplete(pinDigits); return; }
    if (!results.multiHandLandmarks?.length) { stableFrames = 0; return; }
    const lm = results.multiHandLandmarks[0];
    const fingers = countFingers(lm);

    // Draw finger count
    ctx.font = 'bold 32px Syne'; ctx.fillStyle = '#7C3AED';
    ctx.fillText(fingers, 10, 40);

    if (fingers === lastFingers) {
      stableFrames++;
      // Progress arc
      ctx.beginPath(); ctx.arc(280, 30, 22, -Math.PI/2, -Math.PI/2 + (2*Math.PI * stableFrames/PIN_STABLE_FRAMES));
      ctx.strokeStyle = '#7C3AED'; ctx.lineWidth = 4; ctx.stroke();
      if (stableFrames >= PIN_STABLE_FRAMES) {
        pinDigits.push(fingers);
        stableFrames = 0; lastFingers = -1;
        updatePinDisplay();
        if (pinDigits.length >= 4) onComplete(pinDigits);
      }
    } else {
      stableFrames = 0; lastFingers = fingers;
    }
  });

  const camera = new Camera(video, { onFrame: async () => { await hands.send({ image: video }); }, width: 320, height: 240 });
  camera.start();
}

// Signup PIN
document.getElementById('pin-start-btn')?.addEventListener('click', async () => {
  document.getElementById('pin-start-btn').style.display = 'none';
  pinDigits = []; updatePinDisplay();
  await startPinCamera('pin-video', 'pin-canvas', (digits) => {
    document.getElementById('pin-save-btn').style.display = 'block';
  });
});

document.getElementById('pin-save-btn')?.addEventListener('click', () => {
  const existing = JSON.parse(localStorage.getItem('airbrush_user') || '{}');
  existing.pin    = pinDigits.join('');
  existing.method = 'pin';
  localStorage.setItem('airbrush_user', JSON.stringify(existing));
  alert(`PIN ${pinDigits.join('-')} saved! Please log in.`);
  window.location.href = 'login.html';
});

// Login PIN
document.getElementById('pin-login-btn')?.addEventListener('click', async () => {
  const user = JSON.parse(localStorage.getItem('airbrush_user') || 'null');
  if (!user?.pin) return alert('No PIN registered. Please sign up with Air PIN first.');
  pinDigits = []; updatePinDisplay();
  await startPinCamera('pin-video', 'pin-canvas', (digits) => {
    if (digits.join('') === user.pin) {
      localStorage.setItem('airbrush_session', '1');
      alert('PIN verified!');
      window.location.href = 'canvas.html';
    } else {
      alert('Incorrect PIN. Try again.');
      pinDigits = []; updatePinDisplay();
    }
  });
});
