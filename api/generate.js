// ============================================================
//  FILE: api/generate.js
//  Create an "api" folder at your project root, put this inside.
//  In Vercel Dashboard → Settings → Environment Variables add:
//    HF_TOKEN = hf_xxxxxxxxxxxxxxxx   (your HuggingFace token)
// ============================================================

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { prompt, model } = req.body;
  const HF_TOKEN = process.env.HF_TOKEN;

  const url = `https://api-inference.huggingface.co/models/${model}`;
  const headers = {
    "Content-Type": "application/json",
    ...(HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
  };

  // Retry up to 8 times — HF free models go to sleep and need ~20s to wake
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ inputs: prompt }),
    });

    // Model is loading — wait and retry
    if (response.status === 503) {
      const json = await response.json().catch(() => ({}));
      const wait = (json.estimated_time ?? 20) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 25000)));
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    // Success — HF returns raw image bytes
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return res.status(200).json({ image: `data:image/jpeg;base64,${base64}` });
  }

  return res.status(504).json({ error: "Model timed out after retries. Try again or add your HF token for faster responses." });
}
