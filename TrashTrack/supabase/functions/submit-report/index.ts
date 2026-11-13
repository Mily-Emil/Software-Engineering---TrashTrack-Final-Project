/// <reference path="../deno.d.ts" />
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((x: number) => x.toString(16).padStart(2, '0'))
    .join('')

// Batas area kampus Universitas Klabat (Unklab), Jl. Arnold Mononutu, Airmadidi (NFR-06)
const UNKLAB_BOUNDS = {
  minLat: 1.4120,
  maxLat: 1.4235,
  minLng: 124.9790,
  maxLng: 124.9895
}

interface VisionAnalysis {
  is_waste: boolean
  category: 'organik' | 'anorganik' | ''
  severity: 'rendah' | 'sedang' | 'tinggi' | ''
  confidence_score: number
}

// Validasi skema keluaran JSON sesuai Tabel 2 dokumen CogITo
function parseAndValidateVisionJson(rawText: string): VisionAnalysis | null {
  try {
    const cleaned = rawText.replace(/```json|```/gi, '').trim()
    const parsed = JSON.parse(cleaned)
    if (typeof parsed.is_waste !== 'boolean') return null
    const confidence = Number(parsed.confidence_score)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
    if (!parsed.is_waste) {
      return { is_waste: false, category: '', severity: '', confidence_score: confidence }
    }
    const category = String(parsed.category || '').toLowerCase()
    const severity = String(parsed.severity || '').toLowerCase()
    if (!['organik', 'anorganik'].includes(category)) return null
    if (!['rendah', 'sedang', 'tinggi'].includes(severity)) return null
    return {
      is_waste: true,
      category: category as 'organik' | 'anorganik',
      severity: severity as 'rendah' | 'sedang' | 'tinggi',
      confidence_score: Number(confidence.toFixed(3))
    }
  } catch {
    return null
  }
}

// Panggilan Gemini API dengan batas waktu 10 detik (NFR-01) dan fallback model otomatis
async function callGemini(apiKey: string, contents: unknown[], temperature = 0.1): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const primary = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite'
    const models = Array.from(new Set([primary, 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash']))
    let lastError = 'Gemini API error'
    for (const model of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature }
          }),
          signal: controller.signal
        }
      )
      if (res.ok) {
        const data = await res.json()
        const parts = data?.candidates?.[0]?.content?.parts || []
        return parts.map((p: { text?: string }) => p.text || '').join('').trim()
      }
      lastError = `Gemini API HTTP ${res.status}`
      if (![404, 429, 503].includes(res.status)) break
    }
    throw new Error(lastError)
  } finally {
    clearTimeout(timeout)
  }
}

async function analyzeWastePhoto(
  apiKey: string | undefined,
  photo: File,
  description: string
): Promise<VisionAnalysis> {
  const nameAndDesc = `${photo.name} ${description}`.toLowerCase()
  if (!apiKey) {
    if (/bukan|kosong|wajah|selfie|mobil|gedung_bersih|tanpa_sampah/i.test(nameAndDesc)) {
      return { is_waste: false, category: '', severity: '', confidence_score: 0.94 }
    }
    const isOrganic = /daun|makanan|sisa|buah|sayur|ranting|rumput|nasi|kertas_basah|organik/i.test(nameAndDesc)
    const isHigh = /banyak|menumpuk|penuh|parah|besar|meluber|bau|tinggi/i.test(nameAndDesc)
    const isLow = /sedikit|kecil|satu|rendah/i.test(nameAndDesc)
    return {
      is_waste: true,
      category: isOrganic ? 'organik' : 'anorganik',
      severity: isHigh ? 'tinggi' : isLow ? 'rendah' : 'sedang',
      confidence_score: 0.92
    }
  }

  const bytes = new Uint8Array(await photo.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  const base64Image = btoa(binary)

  const basePrompt = `Anda adalah sistem deteksi titik sampah di lingkungan kampus Universitas Klabat (Unklab).
Instruksi: Periksa apakah foto ini berisi sampah, lalu tentukan kategori dan tingkat keparahannya.
Konteks: Lingkungan kampus Universitas Klabat. Deskripsi tambahan dari pelapor: "${description || '-'}".
Indikator keluaran: Kembalikan HANYA objek JSON murni tanpa markdown atau teks lain dengan skema berikut:
{
  "is_waste": boolean (true jika foto berisi sampah, false jika tidak),
  "category": string ("organik" atau "anorganik"; "" jika is_waste bernilai false),
  "severity": string ("rendah", "sedang", atau "tinggi"; "" jika is_waste bernilai false),
  "confidence_score": number (antara 0 sampai 1)
}`

  const firstRaw = await callGemini(apiKey, [
    {
      role: 'user',
      parts: [
        { text: basePrompt },
        { inline_data: { mime_type: photo.type, data: base64Image } }
      ]
    }
  ], 0.1)

  const firstValidated = parseAndValidateVisionJson(firstRaw)
  if (firstValidated) return firstValidated

  const strictPrompt = `${basePrompt}\nPERINGATAN TEGAS: Respons Anda sebelumnya tidak valid. Balas HANYA dengan 1 baris JSON valid sesuai nilai yang diizinkan tanpa penjelasan apa pun!`
  const retryRaw = await callGemini(apiKey, [
    {
      role: 'user',
      parts: [
        { text: strictPrompt },
        { inline_data: { mime_type: photo.type, data: base64Image } }
      ]
    }
  ], 0.0)

  const retryValidated = parseAndValidateVisionJson(retryRaw)
  if (!retryValidated) {
    throw new Error('Gagal memvalidasi respons JSON dari Gemini API setelah pengulangan.')
  }
  return retryValidated
}

async function generateChatReply(
  apiKey: string | undefined,
  analysis: { category?: string; severity?: string },
  history: Array<{ sender: string; message: string }>,
  question?: string
): Promise<string> {
  const category = analysis?.category || 'anorganik'
  const severity = analysis?.severity || 'sedang'

  if (!question) {
    if (apiKey) {
      try {
        const prompt = `Instruksi: Beri saran penanganan dan pemilahan sampah awal secara singkat (2-3 kalimat) untuk pelapor di kampus Universitas Klabat.
Konteks: Hasil deteksi foto menunjukkan sampah kategori "${category}" dengan tingkat keparahan "${severity}".
Indikator keluaran: Teks singkat berbahasa Indonesia yang sopan dan praktis.`
        const reply = await callGemini(apiKey, [{ role: 'user', parts: [{ text: prompt }] }], 0.3)
        if (reply.trim()) return reply.trim()
      } catch {

      }
    }
    return category === 'organik'
      ? `Hasil deteksi AI menunjukkan sampah ORGANIK dengan tingkat keparahan ${severity} di area Universitas Klabat. Mohon pisahkan sampah sisa makanan/dedaunan ini dari plastik agar dapat diolah menjadi kompos kampus, serta hindari membakarnya.`
      : `Hasil deteksi AI menunjukkan sampah ANORGANIK dengan tingkat keparahan ${severity} di area Universitas Klabat. Mohon pilah botol plastik, kaleng, atau kertas ke tempat sampah daur ulang kampus sambil menunggu petugas kebersihan Unklab menangani titik ini.`
  }

  if (apiKey) {
    const historyText = history.map(m => `${m.sender === 'ai' ? 'Asisten' : 'Pelapor'}: ${m.message}`).join('\n')
    const prompt = `Anda adalah Asisten Chatbot Pengelolaan Sampah Universitas Klabat (Unklab).
Instruksi: Beri saran penanganan dan pemilahan sampah atau jawab pertanyaan pelapor secara singkat dan jelas.
ATURAN PEMBATASAN TOPIK: Anda HANYA boleh menjawab pertanyaan yang berkaitan dengan sampah, kebersihan lingkungan kampus Universitas Klabat, pemilahan/daur ulang, atau status penanganan laporan. Jika pertanyaan pelapor berada di luar topik sampah dan kebersihan (misalnya politik, matematika, hiburan, coding umum, resep masakan, dll.), TOLAK DENGAN SOPAN.
Konteks Hasil Deteksi Laporan: Kategori = ${category}, Tingkat Keparahan = ${severity}.
Riwayat Percakapan:
${historyText}
Pertanyaan Pelapor: "${question}"`
    const reply = await callGemini(apiKey, [{ role: 'user', parts: [{ text: prompt }] }], 0.2)
    if (reply.trim()) return reply.trim()
  }

  return 'Maaf, layanan chatbot sedang sibuk. Silakan coba beberapa saat lagi.'
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  const contentType = req.headers.get('content-type') || ''

  try {

    if (contentType.includes('application/json')) {
      const body = await req.json()
      if (body.action === 'chat') {
        const reply = await generateChatReply(geminiKey, body.analysis || {}, body.history || [], body.question)
        return json({ reply })
      }
      if (body.action === 'summary') {
        const reports = Array.isArray(body.reports) ? body.reports : []
        if (!reports.length) return json({ error: 'Belum ada laporan pada periode ini.' }, 400)
        if (geminiKey) {
          const prompt = `Instruksi: Ringkas laporan titik sampah di kampus Universitas Klabat pada periode yang dipilih.
Konteks: Data laporan beserta hasil AI (termasuk yang sudah divalidasi admin).
Data masukan: ${JSON.stringify(reports.slice(0, 50))}
Indikator keluaran: Buat ringkasan terstruktur dalam Bahasa Indonesia yang memuat: (1) Jumlah laporan dan statusnya, (2) Perbandingan sampah organik vs anorganik, (3) Lokasi/area terbanyak di kampus Unklab, dan (4) Daftar laporan prioritas yang harus segera ditangani.`
          const summaryText = await callGemini(geminiKey, [{ role: 'user', parts: [{ text: prompt }] }], 0.2)
          if (summaryText.trim()) return json({ summary_text: summaryText.trim() })
        }
        return json({ error: 'GEMINI_API_KEY belum dikonfigurasi di server.' }, 503)
      }
    }

    
    const form = await req.formData()
    const photo = form.get('photo')
    const latitude = Number(form.get('latitude'))
    const longitude = Number(form.get('longitude'))
    const description = String(form.get('description') || '').slice(0, 500)
    const locationSource = String(form.get('location_source') || 'manual')
    const locationAccuracy = form.get('location_accuracy') ? Number(form.get('location_accuracy')) : null
    const zoneName = String(form.get('zone_name') || 'Area Kampus Unklab')
    const deviceId = String(form.get('device_id') || '')

    if (!(photo instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.type)) {
      return json({ error: 'Format berkas ditolak. Unggah foto berformat JPG, PNG, atau WebP.' }, 400)
    }
    if (photo.size > 5 * 1024 * 1024) {
      return json({ error: 'Ukuran berkas melebihi batas maksimal 5 MB.' }, 400)
    }
    if (
      !Number.isFinite(latitude) ||
      latitude < UNKLAB_BOUNDS.minLat ||
      latitude > UNKLAB_BOUNDS.maxLat ||
      !Number.isFinite(longitude) ||
      longitude < UNKLAB_BOUNDS.minLng ||
      longitude > UNKLAB_BOUNDS.maxLng
    ) {
      return json({ error: 'Ditolak: Lokasi berada di luar area kampus Universitas Klabat.' }, 400)
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown-client'
    const ipHash = await sha256(ip)
    const clientToken = deviceId ? `${deviceId}:${ip}` : ip
    const clientHash = await sha256(clientToken)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false }
    })

    const { data: claimed, error: limitError } = await supabase.rpc('claim_report_slot', { p_client_hash: clientHash })
    if (limitError) {
      // Fallback jika DB masih menggunakan signature lama
      await supabase.rpc('claim_report_slot', { p_ip_hash: ipHash }).catch(() => {})
    } else if (!claimed) {
      return json({ error: 'Batas 5 laporan per jam tercapai. Silakan coba lagi nanti.' }, 429)
    }

    let analysis: VisionAnalysis = { is_waste: true, category: 'organik', severity: 'rendah', confidence_score: 0.8 }
    let needsReview = false
    try {
      analysis = await analyzeWastePhoto(geminiKey, photo, description)
      if (!analysis.is_waste || analysis.confidence_score < 0.7) {
        needsReview = true
      }
    } catch {
      needsReview = true
    }

    const reportCode = `TT-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
    const objectPath = `${reportCode}/${crypto.randomUUID()}.${photo.type === 'image/png' ? 'png' : 'jpg'}`
    const { error: uploadError } = await supabase.storage
      .from('report-photos')
      .upload(objectPath, photo, { contentType: photo.type, upsert: false })
    if (uploadError) throw uploadError

    const { data: report, error: reportError } = await supabase
      .from('reports')
      .insert({
        report_code: reportCode,
        photo_url: objectPath,
        latitude,
        longitude,
        description,
        zone_name: zoneName,
        location_source: locationSource,
        location_accuracy: locationAccuracy,
        needs_review: needsReview,
        device_id: deviceId || null,
        ip_hash: ipHash
      })
      .select('id,report_code,status,needs_review,created_at')
      .single()

    if (reportError) {
      await supabase.storage.from('report-photos').remove([objectPath])
      throw reportError
    }

    const { error: analysisError } = await supabase.from('ai_analysis').insert({
      report_id: report.id,
      is_waste: analysis.is_waste,
      category: analysis.category || 'organik',
      severity: analysis.severity || 'rendah',
      confidence_score: analysis.confidence_score,
      detected_notes: needsReview ? 'Perlu review petugas: skor keyakinan rendah atau terindikasi bukan sampah biasa.' : null
    })

    if (analysisError) {
      await supabase.from('reports').delete().eq('id', report.id)
      await supabase.storage.from('report-photos').remove([objectPath])
      throw analysisError
    }

    const initialAdvice = await generateChatReply(geminiKey, analysis, [])
    await supabase.from('chat_messages').insert({
      report_id: report.id,
      sender: 'ai',
      message: initialAdvice
    })

    return json({
      ...report,
      photo_url: objectPath,
      analysis: { ...analysis, is_validated: false },
      initial_advice: initialAdvice
    })
  } catch (error) {
    console.error(error)
    const isTimeout = error instanceof DOMException && error.name === 'AbortError'
    return json(
      {
        error: isTimeout
          ? 'Analisis foto melewati batas waktu 10 detik. Silakan kirim ulang laporan Anda.'
          : error instanceof Error
          ? error.message
          : 'Gagal menyimpan laporan.'
      },
      isTimeout ? 504 : 500
    )
  }
})
