# TrashTrack — Universitas Klabat (Unklab)

Sistem Web Deteksi dan Pelaporan Titik Sampah Universitas Klabat Berbasis Gemini API (Vision-Language Model, Chatbot Solusi, dan Human-in-the-Loop Admin Dashboard).

## Menjalankan Aplikasi

```bash
npm install
npm run dev
```

Konfigurasi `.env` di folder `TrashTrack/`:

```dotenv
VITE_SUPABASE_URL=https://ryoffuoamnvilordwjrx.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
```

> **Keamanan (NFR-02):** `GEMINI_API_KEY` dan `SUPABASE_SERVICE_ROLE_KEY` hanya disimpan di sisi server (Supabase Edge Function Secrets) dan tidak pernah dikirim ke peramban klien.

## Kesesuaian dengan Dokumen Jurnal CogITo

1. **Area Layanan Khusus Kampus Universitas Klabat (NFR-06 & Skenario 5):**
   - Peta dipusatkan di Kampus Universitas Klabat (`1.4175, 124.9840`), Jl. Arnold Mononutu, Airmadidi, dengan batas koordinat kampus `latitude 1.4120–1.4235` dan `longitude 124.9790–124.9895` serta pemetaan gedung/area kampus Unklab otomatis.
2. **Alur Flowchart (Gambar 4) & Sequence Diagram (Gambar 5):**
   - Validasi format berkas (JPG/PNG), ukuran ($\le 5\text{ MB}$), batas lokasi kampus Unklab, dan *rate limit* 5 laporan/jam per `ip_hash` dilakukan **sebelum** memanggil Gemini Vision API.
   - Respons JSON divalidasi terhadap skema Tabel 2 (`is_waste`, `category`, `severity`, `confidence_score`) dengan *retry* 1 kali jika format JSON tidak sesuai dan batas *timeout* 10 detik (NFR-01).
   - Segera setelah laporan dan analisis AI disimpan, sistem otomatis menyusun saran penanganan awal Chatbot sesuai hasil deteksi dan menyimpannya ke tabel `chat_messages`.
3. **ERD & Skema Database ([supabase/schema.sql](supabase/schema.sql)):**
   - Mencakup 5 entitas utama pada Gambar 3 (`admins`, `reports` termasuk `updated_by`, `ai_analysis` termasuk `is_validated` & `corrected_by`, `chat_messages`, dan `ai_summaries`) ditambah tabel internal `report_rate_limits`.
4. **Chatbot Solusi Kontekstual & Pembatasan Topik (FR-04, Skenario 13 & 14):**
   - Menjawab pertanyaan pelapor berdasarkan konteks kategori & tingkat keparahan laporan, menyimpan riwayat ke `chat_messages`, dan menolak dengan sopan pertanyaan di luar topik sampah dan kebersihan kampus.
5. **Proteksi Admin, Validasi HITL, & Ringkasan AI (FR-06 s/d FR-09, Skenario 16–22):**
   - Halaman operasional Admin diproteksi login (`FR-06`, Skenario 18).
   - Admin dapat memfilter laporan, mengoreksi hasil AI (`is_validated = true`, `corrected_by`), mengubah status (`Menunggu` → `Diproses` → `Selesai`), dan membuat Ringkasan AI periode tertentu yang memuat jumlah laporan, perbandingan organik/anorganik, lokasi terbanyak di Unklab, serta laporan prioritas.
