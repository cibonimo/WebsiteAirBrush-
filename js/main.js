/* ═══════════════════════════════════════════
   AIRBRUSH — main.js
   ═══════════════════════════════════════════ */

// ── Auth state ──────────────────────────────
function isLoggedIn() {
  return !!localStorage.getItem('ab_current');
}

// ── Navbar: update based on login state ─────
function updateNavAuth() {
  const loginBtn  = document.getElementById('nav-login-btn');
  const signupBtn = document.getElementById('nav-signup-btn');
  if (!loginBtn) return;
  if (isLoggedIn()) {
    loginBtn.textContent  = 'App';
    loginBtn.href         = 'canvas.html';
    signupBtn.textContent = 'Log Out';
    signupBtn.href        = '#';
    signupBtn.onclick     = () => { localStorage.removeItem('ab_current'); location.reload(); };
  }
}
updateNavAuth();

// ── Start Now button ────────────────────────
const startNowBtn = document.getElementById('start-now-btn');
if (startNowBtn) {
  startNowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (isLoggedIn()) {
      window.location.href = 'canvas.html';
    } else {
      window.location.href = 'signup.html';
    }
  });
}

// ── Particles ───────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  const resize = () => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; };
  resize(); window.addEventListener('resize', resize);
  for (let i = 0; i < 80; i++) {
    particles.push({ x: Math.random()*W, y: Math.random()*H, r: Math.random()*1.5+0.5, vx: (Math.random()-.5)*0.3, vy: (Math.random()-.5)*0.3, a: Math.random() });
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    particles.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = `rgba(124,58,237,${p.a * 0.5})`; ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.x<0) p.x=W; if (p.x>W) p.x=0;
      if (p.y<0) p.y=H; if (p.y>H) p.y=0;
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

// ── Scroll Reveal ───────────────────────────
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// ── Animated Counters ───────────────────────
function animateCounter(el) {
  const target = parseInt(el.dataset.target);
  let current = 0;
  const step = target / 60;
  const timer = setInterval(() => {
    current += step;
    if (current >= target) { el.textContent = target.toLocaleString(); clearInterval(timer); return; }
    el.textContent = Math.floor(current).toLocaleString();
  }, 16);
}
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { animateCounter(e.target); counterObserver.unobserve(e.target); } });
});
document.querySelectorAll('.stat-number').forEach(el => counterObserver.observe(el));

// ── Tab Switcher (Makers section) ───────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const tab = document.getElementById('tab-' + btn.dataset.tab);
    if (tab) tab.classList.add('active');

    // Load section images
    const imgEl = tab.querySelector('img');
    if (!imgEl) {
      const img = document.createElement('img');
      img.src = `assets/sections/${btn.dataset.tab}.jpg`;
      img.onerror = () => tab.querySelector('div').textContent = `Add image: assets/sections/${btn.dataset.tab}.jpg`;
      tab.innerHTML = '';
      tab.appendChild(img);
    }
  });
  // Auto-load first tab image
  if (btn.classList.contains('active')) btn.click();
});

// ── Homepage Images → Scroll Gallery ────────
// Add your images to assets/homepage images/ and list them here:
const homepageImages = [
  // 'assets/homepage images/1.jpg',
  // 'assets/homepage images/2.jpg',
  // etc.
];
(function buildScrollGallery() {
  const track = document.getElementById('gallery-track');
  if (!track || homepageImages.length === 0) return;
  // Duplicate for seamless loop
  const imgs = [...homepageImages, ...homepageImages];
  imgs.forEach(src => {
    const img = document.createElement('img');
    img.src = src; img.alt = 'AirBrush creation';
    track.appendChild(img);
  });
})();

// ── Homepage Images → Collage ────────────────
(function buildCollage() {
  const grid = document.getElementById('collage-grid');
  if (!grid || homepageImages.length === 0) return;
  grid.innerHTML = '';
  homepageImages.slice(0, 3).forEach(src => {
    const img = document.createElement('img');
    img.src = src; grid.appendChild(img);
  });
})();

// ── Gallery Section ──────────────────────────
function loadGallery() {
  const area = document.getElementById('gallery-area');
  if (!area) return;
  const saved = JSON.parse(localStorage.getItem('airbrush_gallery') || '[]');
  if (saved.length === 0) {
    area.innerHTML = `<div class="gallery-empty">
      <p style="font-size:1.2rem;margin-bottom:1rem;">Create your own Art Gallery Here</p>
      <a href="${isLoggedIn() ? 'canvas.html' : 'signup.html'}">Start Drawing →</a>
    </div>`;
    return;
  }
  const track = document.createElement('div');
  track.className = 'gallery-track';
  saved.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.innerHTML = `
      <img src="${item.image}" alt="Generated art"/>
      <div class="gallery-card-info">
        <p>${item.description || 'No description'}</p>
        <button onclick="viewGalleryDetail(${i})" class="btn-nav-ghost" style="margin-top:0.4rem;font-size:0.75rem;">View Details</button>
      </div>`;
    track.appendChild(card);
  });
  area.appendChild(track);
}
loadGallery();

window.viewGalleryDetail = function(i) {
  const saved = JSON.parse(localStorage.getItem('airbrush_gallery') || '[]');
  const item = saved[i];
  if (!item) return;
  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:center;justify-content:center;gap:2rem;padding:2rem;';
  overlay.innerHTML = `
    <div style="background:var(--bg2);border-radius:var(--radius-lg);padding:1.5rem;max-width:400px;width:100%;">
      <p style="color:var(--text-muted);font-size:0.8rem;margin-bottom:0.5rem;">Original Sketch</p>
      <img src="${item.sketch || ''}" style="width:100%;border-radius:var(--radius);border:1px solid var(--border);" onerror="this.style.display='none'"/>
    </div>
    <div style="background:var(--bg2);border-radius:var(--radius-lg);padding:1.5rem;max-width:400px;width:100%;">
      <p style="color:var(--text-muted);font-size:0.8rem;margin-bottom:0.5rem;">Generated Image</p>
      <img src="${item.image}" style="width:100%;border-radius:var(--radius);"/>
      <p style="margin-top:1rem;color:var(--text-muted);font-size:0.9rem;">${item.description || 'No description entered.'}</p>
      <button onclick="this.closest('div').parentElement.remove()" style="margin-top:1rem;background:var(--accent1);border:none;color:#fff;padding:0.5rem 1.5rem;border-radius:8px;cursor:pointer;">Close</button>
    </div>`;
  document.body.appendChild(overlay);
};

// ── Gallery Nav btn: smooth scroll ──────────
document.getElementById('gallery-nav-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('gallery')?.scrollIntoView({ behavior: 'smooth' });
});

// ── QR Code (footer) ────────────────────────
window.addEventListener('load', () => {
  if (typeof QRCode !== 'undefined') {
    new QRCode(document.getElementById('qr-canvas'), {
      text: 'https://air-brush-website.vercel.app',
      width: 80, height: 80,
      colorDark: '#7C3AED', colorLight: 'transparent'
    });
  }
});

// ── Navbar scroll style ──────────────────────
window.addEventListener('scroll', () => {
  document.getElementById('navbar')?.classList.toggle('scrolled', scrollY > 40);
});

// ── Hero scroll hint ────────────────────────
const scrollHint = document.querySelector('.hero-scroll-hint');
if (scrollHint) {
  window.addEventListener('scroll', () => {
    scrollHint.style.opacity = scrollY > 60 ? '0' : '1';
  });
}
