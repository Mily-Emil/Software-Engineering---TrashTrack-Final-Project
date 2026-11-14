import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const configDir = fileURLToPath(new URL('.', import.meta.url))

// Plugin server lokal agar pemanggilan Gemini API dilakukan dari sisi server (Node.js)
// dan GEMINI_API_KEY di berkas .env tidak pernah dikirim ke peramban klien (sesuai NFR-02 & Skenario 22).
function geminiServerPlugin() {
  return {
    name: 'unklab-gemini-server-api',
    configureServer(server) {
      server.middlewares.use('/api/gemini', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const env = loadEnv('', configDir, '')
        const apiKey = (env.GEMINI_API_KEY || '').trim()
        const primaryModel = (env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim()
        const candidateModels = Array.from(
          new Set([
            primaryModel,
            'gemini-3.5-flash-lite',
            'gemini-3.8-flash',
            'gemini-3.5-flash'
          ])
        )

        if (!apiKey || apiKey === 'your-gemini-api-key') {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'GEMINI_API_KEY belum diisi di berkas .env' }))
          return
        }

        let rawBody = ''
        req.on('data', chunk => {
          rawBody += chunk
        })
        req.on('end', async () => {
          try {
            const payload = JSON.parse(rawBody || '{}')
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
                  res.statusCode = 200
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ text, model }))
                  return
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

            res.statusCode = lastStatus
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: lastError }))
          } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: err?.message || 'Gagal memanggil Gemini API.'
              })
            )
          }
        })
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), geminiServerPlugin()]
})
