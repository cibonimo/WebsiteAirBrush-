/* ═══════════════════════════════════════════
   AIRBRUSH — canvas.js
   ═══════════════════════════════════════════ */

// ── Elements ─────────────────────────────────
const webcamVideo    = document.getElementById('webcam-feed');
const webcamOverlay  = document.getElementById('webcam-overlay');
const drawingCanvas  = document.getElementById('drawing-canvas');
const startStopBtn   = document.getElementById('start-stop-btn');
const doneBtn        = document.getElementById('done-drawing-btn');
const undoBtn        = document.getElementById('undo-btn');
const clearBtn       = document.getElementById('clear-btn');
const brushSizeInput = document.getElementById('brush-size');
const brushSizeLabel = document.getElementById('brush-size-label');
const colourPicker   = document.getElementById('colour-picker');
const genDescTA      = document.getElementById('gen-description');
const genStatus      = document.getElementById('gen-status');
const genGrid        = document.getElementById('gen-images-grid');

const wCtx  = webcamOverlay.getContext('2d');
const dCtx  = drawingCanvas.getContext('2d');

// ── State ─────────────────────────────────────
let isRunning      = false;
let inputMode      = 'air';   // 'air' | 'mouse'
let currentTool    = 'brush'; // 'brush' | 'eraser'
let brushSize      = 5;
let brushColour    = '#7C3AED';
let drawingActive  = false;
let lastX = 0, lastY = 0;
let history        = [];
let selectedStyle  = 'Realistic';
let genCount       = 1;
let mouseDown      = false;
let cameraStarted  = false;

// Shake detection
let prevHandX      = null;
let shakeCount     = 0;
let shakeTimer     = null;

// ── Preset colours ────────────────────────────
const presets = ['#7C3AED','#06B6D4','#f59e0b','#ef4444','#22c55e','#ffffff','#000000','#ec4899'];
const palette = document.getElementById('preset-colours');
presets.forEach(c => {
  const sw = document.createElement('button');
  sw.className = 'colour-swatch';
  sw.style.background = c;
  sw.addEventListener('click', () => { brushColour = c; colourPicker.value = c; });
  palette.appendChild(sw);
});
colourPicker.addEventListener('input', e => brushColour = e.target.value);
brushSizeInput.addEventListener('input', e => { brushSize = +e.target.value; brushSizeLabel.textContent = brushSize; });

// ── Canvas resize ─────────────────────────────
function resizeCanvases() {
  const wW = webcamVideo.videoWidth  || 640;
  const wH = webcamVideo.videoHeight || 480;
  webcamOverlay.width  = wW; webcamOverlay.height  = wH;
  drawingCanvas.width  = wW; drawingCanvas.height  = wH;
  dCtx.fillStyle = '#ffffff';
  dCtx.fillRect(0, 0, wW, wH);
}

// ── History (undo) ────────────────────────────
function saveHistory() {
  history.push(drawingCanvas.toDataURL());
  if (history.length > 30) history.shift();
}
undoBtn.addEventListener('click', () => {
  if (!history.length) return;
  const img = new Image();
  img.src = history.pop();
  img.onload = () => dCtx.drawImage(img, 0, 0);
});
clearBtn.addEventListener('click', () => {
  saveHistory();
  dCtx.fillStyle = '#ffffff';
  dCtx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
});

// ── Mode toggles ──────────────────────────────
document.getElementById('mode-air').addEventListener('click', () => {
  inputMode = 'air';
  document.getElementById('mode-air').classList.add('active');
  document.getElementById('mode-mouse').classList.remove('active');
});
document.getElementById('mode-mouse').addEventListener('click', () => {
  inputMode = 'mouse';
  document.getElementById('mode-mouse').classList.add('active');
  document.getElementById('mode-air').classList.remove('active');
});

// ── Tool toggles ──────────────────────────────
document.getElementById('tool-brush').addEventListener('click', () => {
  currentTool = 'brush';
  document.getElementById('tool-brush').classList.add('active');
  document.getElementById('tool-eraser').classList.remove('active');
});
document.getElementById('tool-eraser').addEventListener('click', () => {
  currentTool = 'eraser';
  document.getElementById('tool-eraser').classList.add('active');
  document.getElementById('tool-brush').classList.remove('active');
});

// ── Draw on canvas ────────────────────────────
function drawPoint(x, y, newStroke = false) {
  if (currentTool === 'eraser') {
    dCtx.globalCompositeOperation = 'destination-out';
  } else {
    dCtx.globalCompositeOperation = 'source-over';
    dCtx.strokeStyle = brushColour;
  }
  dCtx.lineWidth   = currentTool === 'eraser' ? brushSize * 3 : brushSize;
  dCtx.lineCap     = 'round';
  dCtx.lineJoin    = 'round';
  if (newStroke) {
    dCtx.beginPath();
    dCtx.moveTo(x, y);
  } else {
    dCtx.lineTo(x, y);
    dCtx.stroke();
  }
}

// ── Mouse drawing ─────────────────────────────
drawingCanvas.addEventListener('mousedown', (e) => {
  if (!isRunning || inputMode !== 'mouse') return;
  mouseDown = true;
  saveHistory();
  const r = drawingCanvas.getBoundingClientRect();
  const scaleX = drawingCanvas.width / r.width;
  const scaleY = drawingCanvas.height / r.height;
  drawPoint((e.clientX - r.left)*scaleX, (e.clientY - r.top)*scaleY, true);
});
drawingCanvas.addEventListener('mousemove', (e) => {
  if (!mouseDown || !isRunning || inputMode !== 'mouse') return;
  const r = drawingCanvas.getBoundingClientRect();
  const scaleX = drawingCanvas.width / r.width;
  const scaleY = drawingCanvas.height / r.height;
  drawPoint((e.clientX - r.left)*scaleX, (e.clientY - r.top)*scaleY);
});
window.addEventListener('mouseup', () => { mouseDown = false; });

// ── Start / Stop ──────────────────────────────
startStopBtn.addEventListener('click', () => {
  isRunning = !isRunning;
  startStopBtn.textContent = isRunning ? '⏹ Stop' : '▶ Start';
  startStopBtn.className = 'start-stop-btn ' + (isRunning ? 'stop' : 'start');
  if (isRunning && !cameraStarted) {
    cameraStarted = true;
    initCamera();
  }
});

// ── Camera + MediaPipe ────────────────────────
function countExtendedFingers(lm) {
  let count = 0;
  const tips  = [8, 12, 16, 20];
  const bases = [6, 10, 14, 18];
  tips.forEach((t, i) => { if (lm[t].y < lm[bases[i]].y) count++; });
  if (lm[4].x < lm[3].x) count++; // thumb
  return count;
}

function detectGesture(lm) {
  const fingers = countExtendedFingers(lm);
  const indexUp  = lm[8].y < lm[6].y;
  const middleUp = lm[12].y < lm[10].y;
  const ringDown  = lm[16].y > lm[14].y;
  const pinkyDown = lm[20].y > lm[18].y;
  const thumbDown = lm[4].x > lm[3].x;

  if (fingers === 0) return 'fist';
  if (fingers >= 4)  return 'open_palm';
  if (indexUp && middleUp && ringDown && pinkyDown) return 'two_fingers'; // erase
  if (indexUp && !middleUp) return 'draw';
  return 'idle';
}

function detectShake(lm) {
  const cx = lm[9].x;
  if (prevHandX !== null) {
    const dx = Math.abs(cx - prevHandX);
    if (dx > 0.08) {
      shakeCount++;
      clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => shakeCount = 0, 1000);
      if (shakeCount >= 4) {
        shakeCount = 0;
        dCtx.fillStyle = '#ffffff';
        dCtx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
      }
    }
  }
  prevHandX = cx;
}

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    webcamVideo.srcObject = stream;
    await webcamVideo.play();
    resizeCanvases();
  } catch (err) {
    alert('Camera access denied: ' + err.message);
    return;
  }

  const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });

  hands.onResults(results => {
    wCtx.clearRect(0, 0, webcamOverlay.width, webcamOverlay.height);
    wCtx.drawImage(webcamVideo, 0, 0, webcamOverlay.width, webcamOverlay.height);

    if (!isRunning || inputMode !== 'air' || !results.multiHandLandmarks?.length) {
      drawingActive = false; return;
    }

    const lm = results.multiHandLandmarks[0];
    const gesture = detectGesture(lm);
    detectShake(lm);

    const tip = lm[8]; // index tip
    const x = tip.x * webcamOverlay.width;
    const y = tip.y * webcamOverlay.height;

    // Draw cursor dot on webcam overlay
    wCtx.beginPath(); wCtx.arc(x, y, 8, 0, Math.PI*2);
    wCtx.fillStyle = gesture === 'draw' ? brushColour : 'rgba(255,255,255,0.5)';
    wCtx.fill();

    // ── Gesture logic ──
    if (gesture === 'open_palm') {
      drawingActive = false;
      return;
    }
    if (gesture === 'two_fingers') {
      currentTool = 'eraser';
      document.getElementById('tool-eraser').classList.add('active');
      document.getElementById('tool-brush').classList.remove('active');
    }
    if (gesture === 'draw') {
      currentTool = 'brush';
      document.getElementById('tool-brush').classList.add('active');
      document.getElementById('tool-eraser').classList.remove('active');
      if (!drawingActive) { saveHistory(); drawPoint(x, y, true); drawingActive = true; }
      else drawPoint(x, y);
    } else {
      drawingActive = false;
    }
  });

  const camera = new Camera(webcamVideo, { onFrame: async () => { await hands.send({ image: webcamVideo }); }, width: 640, height: 480 });
  camera.start();
}

// Auto-start camera on page load
initCamera();
isRunning = true;
startStopBtn.textContent = '⏹ Stop';
startStopBtn.className = 'start-stop-btn stop';

// ── Done Drawing button ───────────────────────
doneBtn.addEventListener('click', () => {
  document.getElementById('generation-section').scrollIntoView({ behavior: 'smooth' });
});

// ── Style selector ─────────────────────────────
document.querySelectorAll('.style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStyle = btn.dataset.style;
  });
});

// ── Generation count ──────────────────────────
document.querySelectorAll('.gen-count-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gen-count-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    genCount = +btn.dataset.count;
    genGrid.className = `gen-images-grid count-${genCount}`;
  });
});

// ── Microphone (voice input) ──────────────────
document.getElementById('mic-btn')?.addEventListener('click', () => {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    return alert('Speech recognition not supported in this browser.');
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = false;
  rec.onresult = e => { genDescTA.value += ' ' + e.results[0][0].transcript; };
  rec.start();
});

// ── GENERATE ─────────────────────────────────
document.getElementById('generate-btn').addEventListener('click', async () => {
  const sketchDataURL = drawingCanvas.toDataURL('image/png');
  const description   = genDescTA.value.trim();
  const style         = selectedStyle;

  genStatus.textContent = '🎨 Generating...';
  genGrid.innerHTML = '';

  for (let i = 0; i < genCount; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'gen-img-wrap';
    wrap.textContent = `Generating image ${i+1}...`;
    genGrid.appendChild(wrap);
  }

  // Convert sketch canvas to base64 (strip prefix)
  const sketchBase64 = sketchDataURL.split(',')[1];

  // Build prompt — sketch-first, description supplements
  const prompt = buildPrompt(description, style);

  try {
    for (let i = 0; i < genCount; i++) {
      const imgEl = await generateImage(sketchBase64, prompt, style);
      genGrid.children[i].innerHTML = '';
      genGrid.children[i].appendChild(imgEl);
    }
    genStatus.textContent = '✅ Done!';

    // Auto-save to gallery
    const imgSrc = genGrid.children[0].querySelector('img')?.src;
    if (imgSrc) {
      const gallery = JSON.parse(localStorage.getItem('airbrush_gallery') || '[]');
      gallery.push({ image: imgSrc, sketch: sketchDataURL, description });
      localStorage.setItem('airbrush_gallery', JSON.stringify(gallery));
    }
  } catch (err) {
    genStatus.textContent = '❌ Generation failed: ' + err.message;
    console.error(err);
  }
});

function buildPrompt(description, style) {
  // Primary: style treatment of what was drawn, refined by description
  let base = '';
  if (description) base = description + ', ';
  base += `${style} art style, high quality, detailed`;
  return base;
}

// ── IMAGE GENERATION (img2img via Hugging Face) ───
async function generateImage(sketchBase64, prompt, style) {
  // Using Hugging Face Inference API — img2img (ControlNet / img2img)
  // For sketch-to-image fidelity, we use the sketch as the init image.

  // ⚠️ REPLACE with your Hugging Face API token:
  const HF_TOKEN = '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';

  // Use a ControlNet scribble model for best sketch fidelity
  const MODEL = 'lllyasviel/sd-controlnet-scribble'; // or 'runwayml/stable-diffusion-v1-5' with img2img

  // Convert base64 to Blob
  const blob = base64ToBlob(sketchBase64, 'image/png');

  const formData = new FormData();
  formData.append('inputs', blob, 'sketch.png');

  // Use Hugging Face image-to-image endpoint
  const response = await fetch(
    `https://api-inference.huggingface.co/models/lllyasviel/control_v11p_sd15_scribble`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'X-Wait-For-Model': 'true'
      },
      body: JSON.stringify({
        inputs: sketchBase64,
        parameters: { prompt: prompt, num_inference_steps: 30, guidance_scale: 8.5 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }

  const blob2 = await response.blob();
  const url   = URL.createObjectURL(blob2);
  const img   = document.createElement('img');
  img.src = url;
  return img;
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const arr    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
