// ============================================================
//  FILE: api/generate.js
//  Vercel serverless function for AI image generation.
//
//  In Vercel Dashboard → Settings → Environment Variables add:
//    HF_TOKEN = hf_xxxxxxxxxxxxxxxx   (your HuggingFace token)
//
//  Supports two modes:
//    • Sketch-guided  (body: { prompt, sketchBase64 })  → ControlNet scribble
//    • Text-only      (body: { prompt })                → FLUX / SDXL / SD1.5
// ============================================================

const NEG_PROMPT = 'blurry, low quality, ugly, distorted, deformed, text, watermark, cartoon, anime';

async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { prompt, sketchBase64 } = req.body;
  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN environment variable not set.' });

  const hdrs = {
    'Authorization': `Bearer ${HF_TOKEN}`,
    'Content-Type' : 'application/json',
    'x-use-cache'  : 'false'
  };

  // ── 1. ControlNet Scribble — only when a sketch is provided ──
  if (sketchBase64) {
    const controlNetModels = [
      'lllyasviel/control_v11p_sd15_scribble',
      'lllyasviel/sd-controlnet-scribble'
    ];
    for (const model of controlNetModels) {
      try {
        const response = await timedFetch(
          `https://api-inference.huggingface.co/models/${model}`,
          {
            method : 'POST',
            headers: hdrs,
            body   : JSON.stringify({
              inputs    : sketchBase64,
              parameters: {
                prompt,
                negative_prompt    : NEG_PROMPT,
                num_inference_steps: 25,
                guidance_scale     : 7.5
              },
              options: { wait_for_model: true, use_cache: false }
            })
          },
          150000
        );
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          return res.status(200).json({ image: `data:image/png;base64,${base64}`, method: 'controlnet' });
        }
        console.warn(`ControlNet [${model}] status:`, response.status);
      } catch(e) { console.warn(`ControlNet [${model}] error:`, e.message); }
    }
  }

  // ── 2. FLUX.1-schnell — fastest text-only fallback ──
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await timedFetch(
        'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
        { method:'POST', headers:hdrs, body:JSON.stringify({
          inputs    : prompt,
          parameters: { num_inference_steps: 4, guidance_scale: 0 },
          options   : { wait_for_model: true, use_cache: false }
        })},
        90000
      );
      if (response.status === 503) {
        const json = await response.json().catch(() => ({}));
        await new Promise(r => setTimeout(r, Math.min((json.estimated_time ?? 20) * 1000, 25000)));
        continue;
      }
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        return res.status(200).json({ image: `data:image/jpeg;base64,${base64}`, method: 'flux' });
      }
    } catch(e) { console.warn('FLUX error:', e.message); break; }
  }

  // ── 3. SDXL fallback ──
  try {
    const response = await timedFetch(
      'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
      { method:'POST', headers:hdrs, body:JSON.stringify({
        inputs    : prompt,
        parameters: { num_inference_steps:25, guidance_scale:7.5, negative_prompt:NEG_PROMPT },
        options   : { wait_for_model: true, use_cache: false }
      })},
      120000
    );
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return res.status(200).json({ image: `data:image/jpeg;base64,${base64}`, method: 'sdxl' });
    }
  } catch(e) { console.warn('SDXL error:', e.message); }

  // ── 4. SD v1.5 last resort ──
  try {
    const response = await timedFetch(
      'https://api-inference.huggingface.co/models/runwayml/stable-diffusion-v1-5',
      { method:'POST', headers:hdrs, body:JSON.stringify({
        inputs    : prompt,
        parameters: { num_inference_steps:30, guidance_scale:8, negative_prompt:NEG_PROMPT },
        options   : { wait_for_model: true, use_cache: false }
      })},
      120000
    );
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return res.status(200).json({ image: `data:image/jpeg;base64,${base64}`, method: 'sd15' });
    }
  } catch(e) { console.warn('SD1.5 error:', e.message); }

  return res.status(504).json({ error: 'All models failed. Please check your HF token and try again.' });
}
