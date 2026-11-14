// Vercel Serverless Function (/api/gemini)
// Menjalankan pemanggilan Gemini VLM & Chatbot di sisi server produksi (Vercel)
// sehingga GEMINI_API_KEY tetap aman di server (sesuai NFR-02 & Skenario 23).

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim()
  const primaryModel = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim()
  const candidateModels = Array.from(
    new Set([
      primaryModel,
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.5-flash'
    ])
  )

  if (!apiKey || apiKey === 'your-gemini-api-key') {
    return res.status(503).json({ error: 'GEMINI_API_KEY belum diisi di Environment Variables Vercel.' })
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    let lastError = 'Gagal memanggil Gemini API.'
    let lastStatus = 500

    for (const model of candidateModels) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 14000)
      try {
        const generationConfig = {
          temperature: payload.temperature ?? 0.1
        }
        if (payload.responseMimeType) {
          generationConfig.responseMimeType = payload.responseMimeType
        }

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: payload.contents,
              generationConfig
            }),
            signal: controller.signal
          }
        )
        const data = await response.json()
        if (response.ok) {
          const parts = data?.candidates?.[0]?.content?.parts || []
          const text = parts
            .filter(p => !p.thought)
            .map(p => p.text || '')
            .join('')
            .trim()
          return res.status(200).json({ text, model })
        }
        lastStatus = response.status
        lastError = data?.error?.message || `Gemini HTTP ${response.status}`
        if (![404, 429, 503].includes(response.status)) break
      } catch (modelErr) {
        lastStatus = modelErr?.name === 'AbortError' ? 504 : 500
        lastError =
          modelErr?.name === 'AbortError'
            ? `Model ${model} melewati batas waktu tunggu.`
            : modelErr?.message || 'Gagal menghubungi model Gemini.'
      } finally {
        clearTimeout(timeout)
      }
    }

    return res.status(lastStatus).json({ error: lastError })
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Gagal memanggil Gemini API.' })
  }
}
