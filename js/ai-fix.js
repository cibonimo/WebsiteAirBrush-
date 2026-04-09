// ============================================================
//  FILE: js/ai-fix.js
//  Add ONE line to the bottom of canvas.html, just before </body>:
//    <script src="js/ai-fix.js"></script>
//
//  This completely replaces the broken generate logic.
//  Your drawing, colours, hand-tracking — all untouched.
// ============================================================

(function () {
  const btn         = document.getElementById("btn-generate");
  const placeholder = document.getElementById("ai-placeholder");
  const loading     = document.getElementById("ai-loading");
  const loadingText = document.getElementById("ai-loading-text");
  const resultImg   = document.getElementById("ai-result-img");
  const aiActions   = document.getElementById("ai-actions");
  const retryBtn    = document.getElementById("btn-retry-ai");
  const saveBtn     = document.getElementById("btn-save-ai");
  const descInput   = document.getElementById("ai-description");
  const modelSelect = document.getElementById("ai-model-select");

  function showLoading(msg) {
    placeholder.style.display = "none";
    resultImg.style.display   = "none";
    aiActions.style.display   = "none";
    loading.style.display     = "flex";
    loadingText.textContent   = msg || "Generating…";
  }

  function showResult(src) {
    loading.style.display     = "none";
    resultImg.src             = src;
    resultImg.style.display   = "block";
    aiActions.style.display   = "flex";
  }

  function showError(msg) {
    loading.style.display       = "none";
    placeholder.style.display   = "flex";
    placeholder.innerHTML       = `<span style="color:#f87171;font-size:13px;text-align:center">⚠️ ${msg}</span>`;
  }

  async function generate() {
    const prompt = descInput.value.trim() || "a beautiful digital painting";
    const model  = modelSelect.value;

    showLoading("Waking up the model… (can take ~30s on free tier)");

    // Poll the server — it handles HF retries internally
    let pollCount = 0;
    const messages = [
      "Waking up the model… (can take ~30s on free tier)",
      "Still warming up — hang tight…",
      "Almost there, model is loading…",
      "Rendering your art…",
    ];

    const intervalId = setInterval(() => {
      pollCount++;
      if (loadingText && messages[pollCount]) {
        loadingText.textContent = messages[Math.min(pollCount, messages.length - 1)];
      }
    }, 10000);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model }),
      });

      clearInterval(intervalId);

      const data = await res.json();

      if (!res.ok || data.error) {
        showError(data.error || "Something went wrong.");
        return;
      }

      showResult(data.image);

      // Wire up save button
      saveBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = data.image;
        a.download = "airbrush-ai.jpg";
        a.click();
      };

    } catch (err) {
      clearInterval(intervalId);
      showError("Network error: " + err.message);
    }
  }

  // Override the generate button
  btn.addEventListener("click", generate);

  // Wire retry
  if (retryBtn) retryBtn.addEventListener("click", generate);
})();
