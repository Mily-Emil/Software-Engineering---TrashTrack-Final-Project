import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  FileImage,
  Filter,
  Leaf,
  LocateFixed,
  LogIn,
  MapPin,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X
} from 'lucide-react'
import CampusGoogleMap from './components/CampusMap'
import { supabase } from './lib/supabase'
import {
  ADMIN_DEFAULT_PASSWORD,
  DEFAULT_LOCATION,
  SEEDED_ADMIN_ACCOUNTS,
  UNKLAB_CENTER,
  analyzeWasteClientFallback,
  buildInitialAdvice,
  buildPeriodSummary,
  generateChatbotAnswer,
  generateInitialAdviceWithAI,
  generateReportCode,
  getOrCreateDeviceId,
  isInUnklabArea,
  stripExifAndCompress,
  unklabZoneName
} from './lib/ai'

const statuses = ['Menunggu', 'Diproses', 'Selesai', 'Ditolak']

const dateLabel = date =>
  date
    ? new Intl.DateTimeFormat('id-ID', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(date))
    : 'Baru saja'

const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000 // Masa berlaku sesi Admin: 2 jam (Tema 10)
const LOCKOUT_STORAGE_KEY = 'unklab_admin_lockout'

function readValidSessionProfile() {
  try {
    const raw = sessionStorage.getItem('unklab_admin_profile')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.login_at || Date.now() - Number(parsed.login_at) > ADMIN_SESSION_TTL_MS) {
      sessionStorage.removeItem('unklab_admin_profile')
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function readLockoutState() {
  try {
    const raw = localStorage.getItem(LOCKOUT_STORAGE_KEY)
    if (!raw) return { count: 0, until: null }
    const parsed = JSON.parse(raw)
    if (parsed?.until && Date.now() >= Number(parsed.until)) {
      localStorage.removeItem(LOCKOUT_STORAGE_KEY)
      return { count: 0, until: null }
    }
    return {
      count: Number(parsed?.count || 0),
      until: parsed?.until ? Number(parsed.until) : null
    }
  } catch {
    return { count: 0, until: null }
  }
}

function App() {
  const [page, setPage] = useState('overview')
  const [reports, setReports] = useState([])
  const [selected, setSelected] = useState(null)
  const [statusFilter, setStatusFilter] = useState('Semua status')
  const [categoryFilter, setCategoryFilter] = useState('Semua kategori')
  const [severityFilter, setSeverityFilter] = useState('Semua tingkat')
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [isAdmin, setIsAdmin] = useState(() => Boolean(readValidSessionProfile()))
  const [adminProfile, setAdminProfile] = useState(() => readValidSessionProfile())
  const [loginEmail, setLoginEmail] = useState('admin@unklab.ac.id')
  const [loginPassword, setLoginPassword] = useState('')
  const [session, setSession] = useState(null)
  const [detailTab, setDetailTab] = useState('Detail laporan')
  const [newMessage, setNewMessage] = useState('')
  const [chat, setChat] = useState([
    {
      sender: 'ai',
      message: 'Halo! Saya Asisten Kebersihan Universitas Klabat. Masukkan kode laporan Anda atau kirim laporan baru untuk mendapatkan saran penanganan dan pemilahan sampah.'
    }
  ])
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [coords, setCoords] = useState(DEFAULT_LOCATION)
  const [locationSource, setLocationSource] = useState('manual')
  const [locationAccuracy, setLocationAccuracy] = useState(null)
  const [failedLoginCount, setFailedLoginCount] = useState(() => readLockoutState().count)
  const [lockoutUntil, setLockoutUntil] = useState(() => readLockoutState().until)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submissionTimestamps, setSubmissionTimestamps] = useState([])
  const [reportCode, setReportCode] = useState('')
  const [reportLookup, setReportLookup] = useState(null)
  const [summaryPeriod, setSummaryPeriod] = useState(7)
  const [latestSummary, setLatestSummary] = useState(null)
  const [isSummaryLoading, setIsSummaryLoading] = useState(false)

  // Pengecekan berkala kedaluwarsa sesi Admin (Tema 10: auto-logout setelah 2 jam)
  useEffect(() => {
    if (!isAdmin) return
    const checkExpiry = () => {
      const valid = readValidSessionProfile()
      if (!valid) {
        setIsAdmin(false)
        setAdminProfile(null)
        supabase?.auth?.signOut?.().catch(() => {})
        setNotice('Sesi login Admin telah kedaluwarsa (batas 2 jam). Silakan login kembali.')
      }
    }
    const timer = setInterval(checkExpiry, 30000)
    return () => clearInterval(timer)
  }, [isAdmin])

  // Muat sesi autentikasi Admin (FR-06)
  useEffect(() => {
    if (!supabase) return
    const applySession = async next => {
      setSession(next)
      if (!next) return
      const { data: profile } = await supabase
        .from('admins')
        .select('id, name, email')
        .eq('id', next.user.id)
        .maybeSingle()
      if (profile) {
        const existing = readValidSessionProfile()
        const withTimestamp = { ...profile, login_at: existing?.login_at || Date.now() }
        setIsAdmin(true)
        setAdminProfile(withTimestamp)
        sessionStorage.setItem('unklab_admin_profile', JSON.stringify(withTimestamp))
      }
    }
    supabase.auth.getSession().then(({ data }) => applySession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      if (next) setTimeout(() => applySession(next), 0)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // Auto-hide toast notice
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 4800)
      return () => clearTimeout(t)
    }
  }, [notice])

  // Muat data laporan untuk peta sebaran publik (FR-05) maupun dashboard Admin (FR-07)
  useEffect(() => {
    if (!supabase) return
    const loadReports = async () => {
      if (session) {
        const { data } = await supabase
          .from('reports')
          .select('*, ai_analysis(*), chat_messages(*)')
          .order('created_at', { ascending: false })
        if (data?.length) {
          const rows = data.map(r => ({
            ...r,
            analysis: Array.isArray(r.ai_analysis) ? r.ai_analysis[0] : r.ai_analysis,
            chat_messages: Array.isArray(r.chat_messages) ? r.chat_messages : []
          }))
          setReports(rows)
          setSelected(prev => prev || rows[0])
          return
        }
      }
      // Fallback RPC publik agar Pelapor tetap bisa melihat marker peta sebaran (FR-05)
      const { data: pubData } = await supabase.rpc('get_public_reports')
      if (Array.isArray(pubData) && pubData.length) {
        setReports(pubData)
        setSelected(prev => prev || pubData[0])
      }
    }
    loadReports()
  }, [session, isAdmin])

  const filtered = useMemo(
    () =>
      reports.filter(
        r =>
          (statusFilter === 'Semua status' || r.status === statusFilter) &&
          (categoryFilter === 'Semua kategori' || r.analysis?.category === categoryFilter) &&
          (severityFilter === 'Semua tingkat' || r.analysis?.severity === severityFilter) &&
          `${r.report_code} ${r.description || ''} ${unklabZoneName(r)}`
            .toLowerCase()
            .includes(query.toLowerCase())
      ),
    [reports, statusFilter, categoryFilter, severityFilter, query]
  )

  const count = status => reports.filter(r => r.status === status).length

  // Navigasi dengan proteksi halaman Admin (Skenario 18: Membuka halaman admin tanpa login -> diarahkan ke login)
  const navigate = next => {
    setMobileMenu(false)
    if (next === 'report') {
      setModal('report')
      return
    }
    if ((next === 'reports' || next === 'admin') && !isAdmin) {
      setModal('login')
      setNotice('Silakan login sebagai Admin Kebersihan Universitas Klabat terlebih dahulu.')
      return
    }
    setPage(next === 'admin' ? 'reports' : next)
  }

  // Validasi / koreksi hasil AI (FR-07, Skenario 20) & pembaruan status penanganan (FR-08, Skenario 21)
  const updateSelected = async changes => {
    if (!isAdmin) {
      setModal('login')
      setNotice('Hanya Admin Kebersihan yang dapat mengubah status atau memvalidasi hasil AI.')
      return
    }
    const adminId = session?.user?.id || adminProfile?.id || null
    const nextReport = {
      ...selected,
      ...changes,
      ...(changes.status ? { updated_by: adminId, updated_at: new Date().toISOString() } : {}),
      ...(changes.analysis
        ? {
            analysis: {
              ...selected.analysis,
              ...changes.analysis,
              is_validated: true,
              corrected_by: adminId,
              corrected_at: new Date().toISOString()
            }
          }
        : {})
    }

    setSelected(nextReport)
    setReports(prev => prev.map(r => (r.id === selected.id ? nextReport : r)))
    if (reportLookup?.id === selected.id) {
      setReportLookup(nextReport)
    }

    if (supabase && session) {
      if (changes.status) {
        const { error: statusErr } = await supabase
          .from('reports')
          .update({ status: changes.status, updated_by: adminId })
          .eq('id', selected.id)
        if (statusErr) {
          // Fallback jika kolom updated_by belum ditambahkan di DB lama
          await supabase.from('reports').update({ status: changes.status }).eq('id', selected.id)
        }
      }
      if (changes.analysis) {
        const updatePayload = {
          is_validated: true,
          corrected_by: adminId,
          corrected_at: new Date().toISOString(),
          ...(changes.analysis.corrected_category ? { corrected_category: changes.analysis.corrected_category } : {}),
          ...(changes.analysis.corrected_severity ? { corrected_severity: changes.analysis.corrected_severity } : {}),
          ...(changes.analysis.admin_notes !== undefined ? { admin_notes: changes.analysis.admin_notes } : {})
        }
        await supabase
          .from('ai_analysis')
          .update(updatePayload)
          .eq('report_id', selected.id)
      }
    }
    setNotice(
      changes.analysis
        ? 'Validasi dan koreksi hasil AI berhasil disimpan.'
        : `Status laporan ${selected.report_code} diperbarui menjadi "${changes.status}".`
    )
  }

  // Pemilihan berkas foto dengan validasi format JPG/PNG/WEBP & ukuran <= 5 MB (Tema 6 & 11)
  // Menghapus metadata EXIF otomatis melalui Canvas agar privasi terlindungi
  const handleFileChange = async e => {
    const f = e.target.files?.[0]
    if (!f) {
      setFile(null)
      setPreviewUrl('')
      return
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      setNotice('Format berkas ditolak. Hanya file JPG, PNG, atau WEBP yang diperbolehkan.')
      e.target.value = ''
      setFile(null)
      setPreviewUrl('')
      return
    }
    if (f.size > 5 * 1024 * 1024) {
      setNotice('Ukuran berkas melebihi batas maksimal 5 MB.')
      e.target.value = ''
      setFile(null)
      setPreviewUrl('')
      return
    }

    try {
      const { file: cleanFile, previewUrl: cleanUrl } = await stripExifAndCompress(f)
      setFile(cleanFile)
      setPreviewUrl(cleanUrl)
    } catch {
      setFile(f)
      const reader = new FileReader()
      reader.onload = () => setPreviewUrl(String(reader.result || ''))
      reader.readAsDataURL(f)
    }
  }

  // Alur Pengiriman Laporan & Analisis Foto (Tema 1, 2, 3, 4, 8, 9, 11)
  const handleReport = async event => {
    event.preventDefault()
    if (isSubmitting) return

    const form = new FormData(event.currentTarget)
    const rawDesc = String(form.get('description') || '').trim()
    const description = (rawDesc || 'Laporan titik sampah di lingkungan kampus Universitas Klabat.').slice(0, 500)
    const coordsNow = coords || DEFAULT_LOCATION
    const zoneNow = unklabZoneName(coordsNow)
    const deviceId = getOrCreateDeviceId()

    // Validasi Masukan SEBELUM memanggil AI (Tema 11)
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setNotice('Format berkas ditolak. Unggah foto berformat JPG, PNG, atau WEBP.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setNotice('Ukuran berkas melebihi batas maksimal 5 MB.')
      return
    }
    if (!isInUnklabArea(coordsNow)) {
      setNotice('Ditolak: Lokasi berada di luar area kampus Universitas Klabat.')
      return
    }

    const oneHourAgo = Date.now() - 3600000
    const recentSubmissions = submissionTimestamps.filter(ts => ts >= oneHourAgo)
    if (recentSubmissions.length >= 5) {
      setNotice('Batas 5 laporan per jam tercapai untuk perangkat Anda. Silakan coba lagi nanti.')
      return
    }

    setIsSubmitting(true)
    try {
      let savedReport = null

      // Prioritas 1: Kirim ke Server Edge Function jika tersedia
      if (supabase) {
        const body = new FormData()
        body.append('photo', file)
        body.append('latitude', String(coordsNow.latitude))
        body.append('longitude', String(coordsNow.longitude))
        body.append('description', description)
        body.append('location_source', locationSource)
        if (locationAccuracy) body.append('location_accuracy', String(locationAccuracy))
        body.append('zone_name', zoneNow)
        body.append('device_id', deviceId)

        const { data: edgeData, error: edgeError } = await supabase.functions.invoke('submit-report', { body })
        if (!edgeError && edgeData?.report_code) {
          const initialMsg = edgeData.initial_advice || buildInitialAdvice(edgeData.analysis, coordsNow)
          savedReport = {
            id: edgeData.id,
            report_code: edgeData.report_code,
            latitude: coordsNow.latitude,
            longitude: coordsNow.longitude,
            description,
            zone_name: zoneNow,
            location_source: locationSource,
            location_accuracy: locationAccuracy,
            status: edgeData.status || 'Menunggu',
            needs_review: Boolean(edgeData.needs_review),
            created_at: edgeData.created_at || new Date().toISOString(),
            photo_url: previewUrl || edgeData.photo_url,
            analysis: edgeData.analysis,
            chat_messages: [{ sender: 'ai', message: initialMsg, created_at: new Date().toISOString() }]
          }
        }
      }

      // Prioritas 2: Analisis Gemini VLM / Fallback & Simpan via RPC Supabase
      // Tema 1: Laporan TETAP DISIMPAN walaupun AI mendeteksi is_waste: false (needs_review = true)
      if (!savedReport) {
        let aiResult = null
        try {
          aiResult = await analyzeWasteClientFallback(file, description)
        } catch {
          // Jika AI error, fallback ke objek pending review agar laporan TIDAK HILANG (Tema 1)
          aiResult = {
            is_waste: true,
            category: 'anorganik',
            severity: 'sedang',
            confidence_score: 0.65,
            needs_review: true,
            detected_notes: 'Analisis AI tidak selesai dalam batas waktu. Laporan masuk antrean validasi manual admin.',
            is_validated: false
          }
        }

        const initialAdvice = await generateInitialAdviceWithAI(aiResult, coordsNow)
        const generatedCode = generateReportCode()
        let reportId = generatedCode
        let finalCode = generatedCode
        let createdAt = new Date().toISOString()

        if (supabase) {
          const { data: rpcData, error: rpcError } = await supabase.rpc('submit_report', {
            p_photo_url: previewUrl || file.name,
            p_latitude: coordsNow.latitude,
            p_longitude: coordsNow.longitude,
            p_description: description,
            p_analysis: aiResult,
            p_initial_advice: initialAdvice,
            p_location_source: locationSource,
            p_location_accuracy: locationAccuracy,
            p_zone_name: zoneNow,
            p_device_id: deviceId
          })
          if (rpcError && /batas 5 laporan|luar area|ditolak/i.test(rpcError.message)) {
            setNotice(rpcError.message)
            return
          }
          if (rpcData?.report_code) {
            reportId = rpcData.id
            finalCode = rpcData.report_code
            createdAt = rpcData.created_at || createdAt
          }
        }

        savedReport = {
          id: reportId,
          report_code: finalCode,
          latitude: coordsNow.latitude,
          longitude: coordsNow.longitude,
          description,
          zone_name: zoneNow,
          location_source: locationSource,
          location_accuracy: locationAccuracy,
          status: aiResult.is_waste === false ? 'Ditolak' : 'Menunggu',
          needs_review: Boolean(aiResult.needs_review),
          created_at: createdAt,
          photo_url: previewUrl,
          analysis: aiResult,
          chat_messages: [{ sender: 'ai', message: initialAdvice, created_at: createdAt }]
        }
      }

      if (previewUrl && savedReport?.report_code) {
        try {
          localStorage.setItem(`unklab_photo_${savedReport.report_code}`, previewUrl)
        } catch {
          // Abaikan jika kuota localStorage penuh
        }
      }

      setSubmissionTimestamps(prev => [...prev.filter(ts => ts >= oneHourAgo), Date.now()])
      setReports(prev => [savedReport, ...prev])
      setSelected(savedReport)
      setReportCode(savedReport.report_code)
      setReportLookup(savedReport)
      setChat(savedReport.chat_messages)
      setModal('')
      setPage('analysis')
      setFile(null)

      if (savedReport.analysis?.is_waste === false || savedReport.status === 'Ditolak') {
        setNotice(`Laporan ditolak oleh AI: Foto bukan sampah kampus. ${savedReport.analysis?.detected_notes || ''}`)
      } else if (savedReport.needs_review) {
        setNotice(`Laporan berhasil dikirim (${savedReport.report_code}). Memerlukan verifikasi lanjutan oleh petugas kebersihan kampus.`)
      } else {
        setNotice(`Laporan berhasil dikirim! Kode laporan Anda: ${savedReport.report_code}`)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Gagal mengirim laporan. Silakan coba kembali.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Cek Status Laporan dengan Kode Unik (FR-03, Skenario 11 & 12)
  const lookup = async e => {
    e.preventDefault()
    const cleanCode = reportCode.trim().toUpperCase()
    if (!cleanCode) {
      setNotice('Masukkan kode laporan Anda terlebih dahulu.')
      return
    }

    const foundLocal = reports.find(r => r.report_code?.toUpperCase() === cleanCode)
    if (foundLocal) {
      setReportLookup(foundLocal)
      setSelected(foundLocal)
      const initialHistory =
        foundLocal.chat_messages?.length > 0
          ? foundLocal.chat_messages
          : [{ sender: 'ai', message: buildInitialAdvice(foundLocal.analysis, foundLocal) }]
      setChat(initialHistory)
      return
    }

    if (supabase) {
      const { data, error } = await supabase.rpc('get_report_by_code', { p_code: cleanCode })
      if (data && !error) {
        const r = {
          ...data,
          analysis: data.analysis,
          chat_messages: Array.isArray(data.chat_messages) && data.chat_messages.length
            ? data.chat_messages
            : [{ sender: 'ai', message: buildInitialAdvice(data.analysis, data) }]
        }
        setReportLookup(r)
        setSelected(r)
        setChat(r.chat_messages)
        return
      }
    }

    setReportLookup(null)
    setNotice('Laporan tidak ditemukan. Periksa kembali kode laporan Anda.')
  }

  // Chatbot Solusi (Tema 5: Batas 10 pesan per laporan & maks 300 char)
  const sendChat = async () => {
    if (!newMessage.trim() || isChatLoading) return
    const activeReport = reportLookup || selected
    const userMsgCount = chat.filter(m => m.sender === 'user').length
    if (userMsgCount >= 10) {
      setNotice('Batas maksimal 10 pertanyaan per laporan telah tercapai.')
      return
    }

    const userText = newMessage.trim().slice(0, 300)
    const nextHistory = [...chat, { sender: 'user', message: userText }]
    setChat(nextHistory)
    setNewMessage('')
    setIsChatLoading(true)

    try {
      if (supabase && activeReport?.report_code) {
        await supabase.rpc('append_chat_message', {
          p_code: activeReport.report_code,
          p_sender: 'user',
          p_message: userText
        })
      }

      const aiReply = await generateChatbotAnswer({
        message: userText,
        report: activeReport,
        history: nextHistory,
        supabase
      })

      if (supabase && activeReport?.report_code) {
        await supabase.rpc('append_chat_message', {
          p_code: activeReport.report_code,
          p_sender: 'ai',
          p_message: aiReply
        })
      }

      const updatedHistory = [...nextHistory, { sender: 'ai', message: aiReply }]
      setChat(updatedHistory)
      if (activeReport) {
        const updatedReport = { ...activeReport, chat_messages: updatedHistory }
        if (reportLookup?.id === activeReport.id) setReportLookup(updatedReport)
        setReports(prev => prev.map(r => (r.id === activeReport.id ? updatedReport : r)))
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Gagal mengirim pesan chat.')
    } finally {
      setIsChatLoading(false)
    }
  }

  // Login Admin (Tema 10: Proteksi Brute-Force 5x Percobaan Persisten di localStorage & Sesi Terbatas 2 Jam)
  const login = async e => {
    e.preventDefault()

    const currentLock = readLockoutState()
    const activeLockUntil = currentLock.until || lockoutUntil
    if (activeLockUntil && Date.now() < activeLockUntil) {
      const waitMin = Math.ceil((activeLockUntil - Date.now()) / 60000)
      setNotice(`Akun terkunci sementara karena terlalu banyak percobaan gagal. Silakan tunggu ${waitMin} menit lagi.`)
      return
    }

    const fd = new FormData(e.currentTarget)
    const emailInput = String(fd.get('email') || loginEmail || '').trim().toLowerCase()
    const passwordInput = String(fd.get('password') || loginPassword || '')

    const seededMatch = SEEDED_ADMIN_ACCOUNTS.find(a => a.email.toLowerCase() === emailInput)

    if (supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: emailInput,
        password: passwordInput
      })
      if (!error && data?.user) {
        const { data: profile } = await supabase
          .from('admins')
          .select('id, name, email')
          .eq('id', data.user.id)
          .maybeSingle()
        const resolvedProfile = {
          ...(profile || seededMatch || {
            id: data.user.id,
            name: data.user.user_metadata?.name || 'Admin Kebersihan Unklab',
            email: data.user.email
          }),
          login_at: Date.now()
        }
        setIsAdmin(true)
        setAdminProfile(resolvedProfile)
        setFailedLoginCount(0)
        setLockoutUntil(null)
        try {
          localStorage.removeItem(LOCKOUT_STORAGE_KEY)
        } catch {}
        sessionStorage.setItem('unklab_admin_profile', JSON.stringify(resolvedProfile))
        setLoginPassword('')
        setModal('')
        setPage('reports')
        setNotice(`Selamat datang, ${resolvedProfile.name}!`)
        return
      }
    }

    // 2. Verifikasi Akun Admin Kelompok dari Environment Variable (.env)
    if (seededMatch && passwordInput === ADMIN_DEFAULT_PASSWORD) {
      const withLoginAt = { ...seededMatch, login_at: Date.now() }
      setIsAdmin(true)
      setAdminProfile(withLoginAt)
      setFailedLoginCount(0)
      setLockoutUntil(null)
      try {
        localStorage.removeItem(LOCKOUT_STORAGE_KEY)
      } catch {}
      sessionStorage.setItem('unklab_admin_profile', JSON.stringify(withLoginAt))
      setLoginPassword('')
      setModal('')
      setPage('reports')
      setNotice(`Berhasil masuk sebagai ${seededMatch.name} (${seededMatch.role}).`)
      return
    }

    const nextFails = (currentLock.count || failedLoginCount) + 1
    setFailedLoginCount(nextFails)
    if (nextFails >= 5) {
      const lockTime = Date.now() + 15 * 60 * 1000
      setLockoutUntil(lockTime)
      try {
        localStorage.setItem(LOCKOUT_STORAGE_KEY, JSON.stringify({ count: nextFails, until: lockTime }))
      } catch {}
      setNotice('5 kali percobaan login gagal berturut-turut. Akses login dibekukan selama 15 menit demi keamanan.')
    } else {
      try {
        localStorage.setItem(LOCKOUT_STORAGE_KEY, JSON.stringify({ count: nextFails, until: null }))
      } catch {}
      setNotice(`Login ditolak: Email atau kata sandi salah. Percobaan tersisa: ${5 - nextFails} kali.`)
    }
  }

  // Ringkasan Laporan dengan AI (FR-09, Tabel 3, Skenario 22)
  const makeSummary = async () => {
    if (!isAdmin) {
      setModal('login')
      return
    }
    if (!reports.length) {
      setNotice('Belum ada laporan untuk diringkas.')
      return
    }
    setIsSummaryLoading(true)
    try {
      const result = await buildPeriodSummary({
        reports,
        periodDays: summaryPeriod,
        supabase
      })
      if (supabase && session) {
        await supabase.from('ai_summaries').insert({
          admin_id: session.user.id,
          period_start: result.period_start,
          period_end: result.period_end,
          summary_text: result.summary_text
        })
      }
      setLatestSummary(result)
      setModal('summary')
      setNotice('Ringkasan laporan AI berhasil dibuat dan disimpan.')
    } finally {
      setIsSummaryLoading(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Leaf size={21} />
          </div>
          <div className="brand-name">
            trashtrack<span>UNIVERSITAS KLABAT</span>
          </div>
          <button className="icon-btn mobile-close" onClick={() => setMobileMenu(false)}>
            <X size={19} />
          </button>
        </div>

        <div className="workspace">
          <div className="workspace-avatar">UK</div>
          <div>
            <strong>Universitas Klabat</strong>
            <small>Airmadidi, Minahasa Utara</small>
          </div>
          <ChevronDown size={15} className="workspace-chevron" />
        </div>

        <p className="nav-label">MENU UTAMA</p>
        <nav className="nav-list">
          <NavButton
            icon={<Activity size={17} />}
            label="Ikhtisar"
            active={page === 'overview'}
            onClick={() => navigate('overview')}
          />
          <NavButton
            icon={<Sparkles size={17} />}
            label="Hasil analisis AI"
            active={page === 'analysis'}
            onClick={() => navigate('analysis')}
          />
          <NavButton
            icon={<MapPin size={17} />}
            label="Laporan masuk (Admin)"
            count={count('Menunggu')}
            active={page === 'reports'}
            onClick={() => navigate('reports')}
          />
          <NavButton
            icon={<MapPin size={17} />}
            label="Peta sebaran"
            active={page === 'map'}
            onClick={() => navigate('map')}
          />
          <NavButton
            icon={<Search size={17} />}
            label="Cek status & Chatbot"
            active={page === 'status'}
            onClick={() => navigate('status')}
          />
        </nav>

        <p className="nav-label nav-label-spaced">PANEL PETUGAS</p>
        <nav className="nav-list">
          <NavButton
            icon={<ShieldCheck size={17} />}
            label={isAdmin ? 'Dashboard Admin' : 'Login Admin'}
            active={page === 'admin'}
            onClick={() => (isAdmin ? navigate('reports') : setModal('login'))}
          />
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">
              <MessageCircle size={17} />
            </div>
            <strong>Kebersihan Kampus Unklab</strong>
            <p>Laporkan titik sampah di sekitar area kampus tanpa perlu akun.</p>
            <button onClick={() => navigate('report')}>
              Lapor sekarang <ArrowRight size={14} />
            </button>
          </div>

          <div className="profile">
            <div className="profile-avatar">
              {isAdmin ? (adminProfile?.name ? adminProfile.name.slice(0, 2).toUpperCase() : 'AD') : 'M'}
            </div>
            <div>
              <strong>{isAdmin ? adminProfile?.name || 'Admin Kebersihan' : 'Pelapor Kampus'}</strong>
              <small>{isAdmin ? adminProfile?.email || 'Petugas Universitas Klabat' : 'Mahasiswa / Warga Unklab'}</small>
            </div>
            {isAdmin && (
              <button
                className="icon-btn logout"
                title="Keluar (Logout)"
                onClick={async () => {
                  await supabase?.auth.signOut()
                  sessionStorage.removeItem('unklab_admin_profile')
                  setAdminProfile(null)
                  setIsAdmin(false)
                  setPage('overview')
                  setNotice('Anda telah keluar dari sesi Admin.')
                }}
              >
                <LogIn size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>

      {mobileMenu && <div className="backdrop" onClick={() => setMobileMenu(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-btn menu-toggle" onClick={() => setMobileMenu(true)}>
              <Menu size={20} />
            </button>
            <span>TrashTrack Unklab</span>
            <span className="crumb">/</span>
            <strong>{pageTitle(page)}</strong>
          </div>
          <div className="topbar-right">
            <div className="live-indicator">
              <span /> GEMINI VLM ACTIVE
            </div>
            <div className="topbar-date">Kampus Unklab, Airmadidi</div>
            <button className="btn btn-small btn-outline" onClick={() => navigate('report')}>
              <Plus size={16} /> Buat laporan
            </button>
          </div>
        </header>

        <div className="content">
          {page === 'overview' && (
            <>
              <div className="welcome-row">
                <div>
                  <p className="eyebrow">
                    SISTEM DETEKSI & PELAPORAN SAMPAH <span>•</span> UNIVERSITAS KLABAT
                  </p>
                  <h1>
                    Jaga kebersihan kampus
                    <br className="mobile-br" /> bersama <span className="highlight">TrashTrack Unklab.</span>
                  </h1>
                  <p className="welcome-sub">
                    Unggah foto titik sampah di lingkungan Universitas Klabat. Dianalisis otomatis dengan Vision-Language Model (Gemini API) beserta asisten chatbot pemilahan sampah.
                  </p>
                </div>
                <div className="welcome-actions">
                  <button className="btn btn-primary" onClick={() => navigate('report')}>
                    <Plus size={17} /> Buat laporan baru
                  </button>
                  <button className="btn btn-outline" onClick={() => navigate('map')}>
                    <MapPin size={16} /> Peta sebaran kampus
                  </button>
                </div>
              </div>

              <div className="stats-grid">
                <StatCard
                  title="Total laporan"
                  value={reports.length}
                  icon={<FileImage size={17} />}
                  tone="blue"
                  helper="titik sampah kampus"
                />
                <StatCard
                  title="Menunggu"
                  value={count('Menunggu')}
                  icon={<Clock3 size={17} />}
                  tone="orange"
                  helper="perlu tindak lanjut"
                />
                <StatCard
                  title="Diproses"
                  value={count('Diproses')}
                  icon={<Activity size={17} />}
                  tone="purple"
                  helper="sedang dibersihkan"
                />
                <StatCard
                  title="Selesai"
                  value={count('Selesai')}
                  icon={<CheckCircle2 size={17} />}
                  tone="green"
                  helper="sudah tertangani"
                />
              </div>

              <div className="dashboard-grid">
                <section className="panel recent-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Laporan terbaru di Universitas Klabat</h2>
                      <p>Daftar laporan titik sampah yang tervalidasi sistem AI</p>
                    </div>
                    <button className="text-btn" onClick={() => navigate('reports')}>
                      {isAdmin ? 'Kelola semua' : 'Login Admin'} <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="report-table-wrap">
                    <table className="report-table">
                      <thead>
                        <tr>
                          <th>KODE LAPORAN</th>
                          <th>KATEGORI AI</th>
                          <th>LOKASI KAMPUS UNKLAB</th>
                          <th>STATUS</th>
                          <th>WAKTU</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {reports.slice(0, 5).map(r => (
                          <tr
                            key={r.id}
                            onClick={() => {
                              setSelected(r)
                              if (isAdmin) {
                                setModal('detail')
                              } else {
                                setReportCode(r.report_code)
                                setReportLookup(r)
                                setChat(
                                  r.chat_messages?.length
                                    ? r.chat_messages
                                    : [{ sender: 'ai', message: buildInitialAdvice(r.analysis, r) }]
                                )
                                setPage('status')
                              }
                            }}
                          >
                            <td>
                              <strong className="report-code">{r.report_code}</strong>
                            </td>
                            <td>
                              <Category category={r.analysis?.category} />
                            </td>
                            <td className="location-cell">
                              <MapPin size={13} />
                              {unklabZoneName(r)}
                            </td>
                            <td>
                              <Status status={r.status} />
                            </td>
                            <td className="muted-cell">{dateLabel(r.created_at)}</td>
                            <td>
                              <button className="row-arrow">
                                <ArrowRight size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!reports.length && (
                      <div className="empty-state">
                        Belum ada laporan masuk di area kampus Universitas Klabat.
                      </div>
                    )}
                  </div>
                </section>

                <section className="panel map-preview">
                  <div className="panel-heading">
                    <div>
                      <h2>Peta sebaran Unklab</h2>
                      <p>Jl. Arnold Mononutu, Airmadidi</p>
                    </div>
                    <button className="icon-btn" onClick={() => navigate('map')}>
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                  <CampusGoogleMap
                    className="preview-map"
                    interactive={false}
                    reports={reports.filter(r => isInUnklabArea(r))}
                    onMarkerClick={r => {
                      setSelected(r)
                      setDetailTab('Detail laporan')
                      setModal('detail')
                    }}
                  />
                  <div className="map-legend">
                    <span>
                      <i className="dot red" />
                      Menunggu
                    </span>
                    <span>
                      <i className="dot yellow" />
                      Diproses
                    </span>
                    <span>
                      <i className="dot green" />
                      Selesai
                    </span>
                  </div>
                </section>
              </div>

              <div className="bottom-grid">
                <section className="panel priority-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Prioritas penanganan</h2>
                      <p>Titik sampah berstatus Menunggu di lingkungan kampus</p>
                    </div>
                    <span className="priority-count">
                      {reports.filter(r => r.status === 'Menunggu').length} MENUNGGU
                    </span>
                  </div>
                  {reports
                    .filter(r => r.status === 'Menunggu')
                    .slice(0, 2)
                    .map(r => (
                      <button
                        className="priority-item"
                        key={r.id}
                        onClick={() => {
                          setSelected(r)
                          if (isAdmin) setModal('detail')
                          else {
                            setReportCode(r.report_code)
                            setReportLookup(r)
                            setPage('status')
                          }
                        }}
                      >
                        <span className="priority-icon">
                          <AlertTriangle size={17} />
                        </span>
                        <span className="priority-main">
                          <strong>
                            {r.report_code} <Status status={r.status} />
                          </strong>
                          <small>{r.description}</small>
                          <small>
                            <MapPin size={12} />
                            {unklabZoneName(r)} · {dateLabel(r.created_at)}
                          </small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  {!reports.some(r => r.status === 'Menunggu') && (
                    <div className="empty-state">Tidak ada antrean laporan yang menunggu penanganan.</div>
                  )}
                </section>

                <section className="panel ai-card">
                  <div className="ai-orbit">
                    <Sparkles size={21} />
                  </div>
                  <span className="eyebrow">AI INSIGHT</span>
                  <h2>
                    Ringkasan laporan AI
                    <br />
                    Universitas Klabat
                  </h2>
                  <p>
                    Rangkum jumlah laporan, perbandingan organik/anorganik, lokasi terbanyak, dan laporan prioritas dengan Gemini AI.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', zIndex: 1, position: 'relative' }}>
                    <select
                      className="text-input"
                      style={{ maxWidth: '150px', padding: '7px 10px', fontSize: '0.82rem' }}
                      value={summaryPeriod}
                      onChange={e => setSummaryPeriod(Number(e.target.value))}
                    >
                      <option value={7}>7 Hari Terakhir</option>
                      <option value={14}>14 Hari Terakhir</option>
                      <option value={30}>30 Hari Terakhir</option>
                    </select>
                    <button
                      className="btn btn-primary"
                      disabled={isSummaryLoading}
                      onClick={isAdmin ? makeSummary : () => setModal('login')}
                    >
                      <Sparkles size={15} /> {isSummaryLoading ? 'Menyusun...' : 'Buat ringkasan'}
                    </button>
                  </div>
                  {latestSummary && (
                    <small style={{ display: 'block', opacity: 0.9, lineHeight: 1.45, zIndex: 1, position: 'relative' }}>
                      {latestSummary.summary_text}
                    </small>
                  )}
                  <div className="ai-glow" />
                </section>
              </div>
            </>
          )}

          {page === 'reports' && (
            <ReportsPage
              reports={filtered}
              selected={selected}
              setSelected={setSelected}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              severityFilter={severityFilter}
              setSeverityFilter={setSeverityFilter}
              query={query}
              setQuery={setQuery}
              onDetail={() => {
                setDetailTab('Detail laporan')
                setModal('detail')
              }}
              onMakeSummary={makeSummary}
              isSummaryLoading={isSummaryLoading}
            />
          )}

          {page === 'map' && (
            <div className="page-stack">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">PEMANTAUAN LOKASI</p>
                  <h1>Peta sebaran titik sampah Universitas Klabat</h1>
                  <p>Area Kampus Unklab, Jl. Arnold Mononutu, Airmadidi (batas garis hijau putus-putus)</p>
                </div>
                <button className="btn btn-primary" onClick={() => navigate('report')}>
                  <Plus size={16} /> Buat laporan
                </button>
              </div>
              <section className="panel full-map-panel">
                <div className="map-tools">
                  <span>
                    <i className="dot red" /> Menunggu <b>{count('Menunggu')}</b>
                  </span>
                  <span>
                    <i className="dot yellow" /> Diproses <b>{count('Diproses')}</b>
                  </span>
                  <span>
                    <i className="dot green" /> Selesai <b>{count('Selesai')}</b>
                  </span>
                  <span className="map-hint">
                    <MapPin size={14} /> Klik marker untuk melihat detail laporan & hasil analisis AI
                  </span>
                </div>
                <CampusGoogleMap
                  className="full-map"
                  fillOpacity={0.04}
                  reports={reports.filter(r => isInUnklabArea(r))}
                  onMarkerClick={r => {
                    setSelected(r)
                    setDetailTab('Detail laporan')
                    setModal('detail')
                  }}
                />
              </section>
            </div>
          )}

          {page === 'analysis' && (
            <AnalysisPage
              report={selected || reportLookup || reports[0]}
              reports={reports}
              onSelectReport={r => {
                setSelected(r)
                setReportCode(r.report_code)
                setReportLookup(r)
              }}
              onGoToChatbot={r => {
                setReportCode(r.report_code)
                setReportLookup(r)
                setSelected(r)
                const initialHistory =
                  r.chat_messages?.length > 0
                    ? r.chat_messages
                    : [{ sender: 'ai', message: buildInitialAdvice(r.analysis, r) }]
                setChat(initialHistory)
                setPage('status')
              }}
              dateLabel={dateLabel}
              unklabZoneName={unklabZoneName}
            />
          )}

          {page === 'status' && (
            <StatusPage
              reportCode={reportCode}
              setReportCode={setReportCode}
              lookup={lookup}
              report={reportLookup}
              reports={reports}
              onSelectReport={r => {
                setReportCode(r.report_code)
                setReportLookup(r)
                setSelected(r)
                const initialHistory =
                  r.chat_messages?.length > 0
                    ? r.chat_messages
                    : [{ sender: 'ai', message: buildInitialAdvice(r.analysis, r) }]
                setChat(initialHistory)
              }}
              chat={chat}
              newMessage={newMessage}
              setNewMessage={setNewMessage}
              sendChat={sendChat}
              isChatLoading={isChatLoading}
            />
          )}
        </div>

        <footer className="footer">
          <span>© 2026 TrashTrack — Sistem Deteksi & Pelaporan Titik Sampah Universitas Klabat.</span>
          <span>
            <span className="footer-dot" /> Gemini API Vision & Chatbot Terintegrasi
          </span>
        </footer>
      </main>

      {/* Modal Form Pelaporan Tanpa Login (FR-01, FR-02, NFR-01, NFR-04, NFR-06) */}
      {modal === 'report' && (
        <Modal
          title="Buat laporan titik sampah baru"
          subtitle="Khusus area Kampus Universitas Klabat (Unklab), Airmadidi."
          onClose={() => !isSubmitting && setModal('')}
        >
          <form className="form-stack" onSubmit={handleReport}>
            <label className="upload-zone">
              {file ? (
                <>
                  <CheckCircle2 size={23} />
                  <b>{file.name}</b>
                  <small>
                    {(file.size / 1024 / 1024).toFixed(2)} MB · Siap dianalisis Gemini Vision
                  </small>
                </>
              ) : (
                <>
                  <UploadCloud size={25} />
                  <b>Unggah foto titik sampah</b>
                  <small>Format JPG atau PNG · Maksimal 5 MB</small>
                  <span className="upload-cta">Pilih foto</span>
                </>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png"
                onChange={handleFileChange}
              />
            </label>

            <div className="field">
              <label>Lokasi titik sampah di Kampus Universitas Klabat</label>
              <div className="location-input">
                <MapPin size={17} />
                <span>
                  {coords
                    ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)} (${unklabZoneName(coords)})`
                    : 'Pilih titik pada peta kampus Unklab'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    navigator.geolocation?.getCurrentPosition(
                      pos => {
                        const p = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }
                        const acc = Math.round(pos.coords.accuracy || 0)
                        setCoords(p)
                        setLocationSource('gps')
                        setLocationAccuracy(acc)
                        if (!isInUnklabArea(p)) {
                          setNotice('Peringatan: Koordinat GPS berada di luar area kampus Universitas Klabat.')
                        } else {
                          setNotice(`Lokasi GPS terdeteksi di ${unklabZoneName(p)} (Akurasi: ±${acc}m).`)
                        }
                      },
                      () => setNotice('Izin lokasi GPS ditolak/tidak tersedia. Silakan pilih titik langsung pada peta di bawah.')
                    )
                  }
                >
                  <LocateFixed size={16} /> GPS
                </button>
              </div>
            </div>

            <div className="picker-map">
              <LocationPicker
                coords={coords}
                onPick={p => {
                  setCoords(p)
                  setLocationSource('manual')
                  setLocationAccuracy(null)
                  if (!isInUnklabArea(p)) {
                    setNotice('Titik yang dipilih berada di luar batas kampus Universitas Klabat.')
                  }
                }}
              />
              <div className="picker-hint">
                <MapPin size={13} /> Klik di dalam kotak garis hijau (Area Kampus Universitas Klabat)
              </div>
            </div>

            <div className="field">
              <label htmlFor="desc">
                Deskripsi patokan lokasi <span>Opsional (maks. 500 karakter)</span>
              </label>
              <textarea
                id="desc"
                name="description"
                rows="3"
                maxLength={500}
                placeholder="Contoh: Tumpukan sampah plastik/daun di dekat Student Center atau Gedung Kuliah GK..."
              />
            </div>

            <div className="form-info">
              <Sparkles size={15} />{' '}
              {isSubmitting
                ? 'Sedang menganalisis foto dengan Gemini Vision API (batas maks. 10 detik)...'
                : 'Foto akan divalidasi dan dianalisis otomatis oleh Gemini API sebelum disimpan.'}
            </div>

            <button className="btn btn-primary btn-wide" type="submit" disabled={!file || isSubmitting}>
              <Send size={16} />{' '}
              {isSubmitting ? 'Menganalisis foto & menyimpan laporan...' : 'Kirim laporan'}
            </button>
            <p className="form-disclaimer">
              Batas pengiriman: maksimal 5 laporan per jam per alamat IP.
            </p>
          </form>
        </Modal>
      )}

      {/* Modal Login Admin (FR-06) */}
      {modal === 'login' && (
        <Modal
          title="Login Admin Kebersihan Unklab"
          subtitle="Pilih akun anggota kelompok atau masukkan email & kata sandi."
          onClose={() => setModal('')}
        >
          <form className="form-stack" onSubmit={login}>
            <div className="field">
              <label>Pilih cepat akun Admin Kelompok (Seed Basis Data)</label>
              <select
                className="text-input"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
              >
                {SEEDED_ADMIN_ACCOUNTS.map(acc => (
                  <option key={acc.email} value={acc.email}>
                    {acc.name} ({acc.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Email Admin</label>
              <input
                className="text-input"
                type="email"
                name="email"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="admin@unklab.ac.id"
                required
              />
            </div>
            <div className="field">
              <label>Kata sandi</label>
              <input
                className="text-input"
                type="password"
                name="password"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                placeholder="Masukkan kata sandi Admin"
                required
              />
            </div>
            <div className="form-info">
              <ShieldCheck size={15} /> Autentikasi dilindungi pembatasan 5x percobaan gagal (lockout 15 menit) dan masa aktif sesi 2 jam.
            </div>
            <button className="btn btn-primary btn-wide" type="submit">
              <LogIn size={16} /> Masuk ke Dashboard Admin
            </button>
          </form>
        </Modal>
      )}

      {/* Modal Ringkasan AI (FR-09, Tabel 3, Skenario 22) */}
      {modal === 'summary' && latestSummary && (
        <Modal
          title="Ringkasan Laporan AI"
          subtitle={`Periode: ${dateLabel(latestSummary.period_start)} – ${dateLabel(latestSummary.period_end)}`}
          onClose={() => setModal('')}
        >
          <div className="form-stack">
            <div className="ai-result">
              <div className="ai-result-icon">
                <Sparkles size={21} />
              </div>
              <div>
                <strong>Hasil Ringkasan Gemini AI — Universitas Klabat</strong>
                <p>Disimpan ke tabel ai_summaries</p>
              </div>
            </div>
            <p style={{ lineHeight: 1.65, fontSize: '0.94rem', margin: '4px 0' }}>
              {latestSummary.summary_text}
            </p>
            <button className="btn btn-primary btn-wide" onClick={() => setModal('')}>
              <Check size={16} /> Tutup ringkasan
            </button>
          </div>
        </Modal>
      )}

      {/* Modal Detail Laporan, Ubah Status (FR-08) & Validasi AI Human-in-the-Loop (FR-07) */}
      {modal === 'detail' && selected && (
        <Modal
          wide
          title={selected.report_code}
          subtitle={`${unklabZoneName(selected)} · Dilaporkan ${dateLabel(selected.created_at)}`}
          onClose={() => setModal('')}
        >
          {isAdmin && (
            <div className="detail-tabs">
              <button
                className={detailTab === 'Detail laporan' ? 'active' : ''}
                onClick={() => setDetailTab('Detail laporan')}
              >
                Detail laporan
              </button>
              <button
                className={detailTab === 'Validasi AI' ? 'active' : ''}
                onClick={() => setDetailTab('Validasi AI')}
              >
                Validasi & Koreksi AI
              </button>
            </div>
          )}

          {detailTab === 'Detail laporan' || !isAdmin ? (
            <div className="detail-layout">
              <div className="detail-photo" style={{ overflow: 'hidden', position: 'relative' }}>
                {isAdmin ? (
                  <img
                    src={resolveReportPhoto(selected)}
                    alt={selected.report_code}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '14px' }}
                    onError={e => {
                      e.currentTarget.onerror = null
                      e.currentTarget.src = FALLBACK_WASTE_SVG
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      minHeight: '220px',
                      borderRadius: '14px',
                      background: '#f1f5f3',
                      border: '1px dashed #cbd5e1',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '24px',
                      textAlign: 'center',
                      color: '#334155',
                      gap: '8px'
                    }}
                  >
                    <ShieldCheck size={28} color="#1b6943" />
                    <strong style={{ fontSize: '14px' }}>Foto Dilindungi (Moderasi Privasi)</strong>
                    <span style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
                      Demi privasi & moderasi konten publik (Tema 6), peta publik hanya menampilkan titik lokasi, kategori, dan status. Foto asli hanya dapat diakses oleh Admin Kebersihan.
                    </span>
                  </div>
                )}
              </div>
              <div className="detail-info">
                <div className="detail-status-row">
                  <Status status={selected.status} />
                  <span className="confidence">
                    <Sparkles size={14} /> AI {Math.round((selected.analysis?.confidence_score ?? 0.9) * 100)}% yakin
                    {selected.analysis?.is_validated ? ' (Tervalidasi Admin)' : ''}
                  </span>
                </div>
                <h3>{selected.description || 'Laporan titik sampah di lingkungan Universitas Klabat'}</h3>
                <p>
                  <MapPin size={14} /> {selected.zone_name || unklabZoneName(selected)} ({selected.latitude.toFixed(5)},{' '}
                  {selected.longitude.toFixed(5)})
                </p>
                <div className="location-meta-chip">
                  <span>Sumber: <strong>{selected.location_source === 'gps' ? 'GPS Perangkat' : 'Pilihan Peta Kampus'}</strong></span>
                  {selected.location_accuracy && <span>Akurasi: ±{selected.location_accuracy}m</span>}
                  <span>Model: <strong>{selected.analysis?.ai_model || 'gemini-3.5-flash-lite'}</strong></span>
                  {selected.needs_review && <span className="review-badge">Perlu Review Khusus</span>}
                </div>
                <div className="detail-tags">
                  <Category category={selected.analysis?.corrected_category || selected.analysis?.category} />
                  <Severity severity={selected.analysis?.corrected_severity || selected.analysis?.severity} />
                  {selected.analysis?.is_validated && <span className="hitl-badge">Terkoreksi Admin</span>}
                </div>

                {isAdmin ? (
                  <div className="field" style={{ marginTop: '12px' }}>
                    <label>Perbarui status penanganan</label>
                    <select
                      className="text-input"
                      value={selected.status}
                      onChange={e => updateSelected({ status: e.target.value })}
                    >
                      {statuses.map(s => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <button
                    className="btn btn-outline"
                    onClick={() => {
                      setReportCode(selected.report_code)
                      setReportLookup(selected)
                      setChat(
                        selected.chat_messages?.length
                          ? selected.chat_messages
                          : [{ sender: 'ai', message: buildInitialAdvice(selected.analysis, selected) }]
                      )
                      setModal('')
                      setPage('status')
                    }}
                  >
                    <Bot size={16} /> Buka Cek Status & Asisten Chatbot
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="validation-content">
              <div className="ai-result">
                <div className="ai-result-icon">
                  <Bot size={21} />
                </div>
                <div>
                  <strong>Hasil Asli Prediksi AI (Gemini VLM)</strong>
                  <p>
                    Kategori Asli: <strong>{selected.analysis?.category || 'organik'}</strong> · Keparahan Asli: <strong>{selected.analysis?.severity || 'sedang'}</strong> · Confidence: <strong>{Math.round((selected.analysis?.confidence_score || 0.9) * 100)}%</strong>
                  </p>
                  {selected.analysis?.detected_notes && (
                    <p style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                      Catatan AI: {selected.analysis.detected_notes}
                    </p>
                  )}
                </div>
              </div>

              <div className="correction-box" style={{ background: '#f8fafc', padding: '14px', borderRadius: '10px', border: '1px solid #e2e8f0', margin: '14px 0' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#1e293b' }}>Form Koreksi & Validasi Admin (HITL)</h4>
                <div className="two-fields">
                  <div className="field">
                    <label>Koreksi Kategori</label>
                    <select
                      className="text-input"
                      value={selected.analysis?.corrected_category || selected.analysis?.category || 'organik'}
                      onChange={e =>
                        setSelected({
                          ...selected,
                          analysis: { ...selected.analysis, corrected_category: e.target.value }
                        })
                      }
                    >
                      <option value="organik">Organik</option>
                      <option value="anorganik">Anorganik</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Koreksi Tingkat Keparahan</label>
                    <select
                      className="text-input"
                      value={selected.analysis?.corrected_severity || selected.analysis?.severity || 'sedang'}
                      onChange={e =>
                        setSelected({
                          ...selected,
                          analysis: { ...selected.analysis, corrected_severity: e.target.value }
                        })
                      }
                    >
                      <option value="rendah">Rendah (Volume kecil)</option>
                      <option value="sedang">Sedang (Volume sedang)</option>
                      <option value="tinggi">Tinggi (Tumpukan besar/menghalangi/B3)</option>
                    </select>
                  </div>
                </div>
                <div className="field" style={{ marginTop: '10px' }}>
                  <label>Catatan Petugas Kebersihan / Admin</label>
                  <input
                    type="text"
                    className="text-input"
                    placeholder="Contoh: Teridentifikasi botol kaca B3, penanganan khusus..."
                    value={selected.analysis?.admin_notes || ''}
                    onChange={e =>
                      setSelected({
                        ...selected,
                        analysis: { ...selected.analysis, admin_notes: e.target.value }
                      })
                    }
                  />
                </div>
              </div>

              <button
                className="btn btn-primary btn-wide"
                onClick={() =>
                  updateSelected({
                    analysis: {
                      corrected_category: selected.analysis?.corrected_category || selected.analysis?.category || 'organik',
                      corrected_severity: selected.analysis?.corrected_severity || selected.analysis?.severity || 'sedang',
                      admin_notes: selected.analysis?.admin_notes || ''
                    }
                  })
                }
              >
                <Check size={16} /> Simpan Validasi & Koreksi HITL
              </button>
              <p className="validation-note">
                <ShieldCheck size={14} /> Nilai asli AI dipertahankan terpisah dari koreksi admin demi audit trail dan evaluasi model.
              </p>
            </div>
          )}
        </Modal>
      )}

      {notice && (
        <div className="toast">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function NavButton({ icon, label, count, active, onClick }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {count > 0 && <small>{count}</small>}
    </button>
  )
}

function StatCard({ title, value, change, icon, tone, trend, helper }) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <div className="stat-value-row">
        <strong>{value}</strong>
        {change && (
          <span className={`stat-change ${trend}`}>
            {trend === 'up' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {change}
          </span>
        )}
      </div>
      <div className="stat-helper">{helper}</div>
    </div>
  )
}

function Status({ status }) {
  const cls =
    status === 'Menunggu'
      ? 'waiting'
      : status === 'Diproses'
      ? 'progress'
      : status === 'Ditolak'
      ? 'rejected'
      : 'done'
  return (
    <span className={`status-chip ${cls}`}>
      <i />
      {status}
    </span>
  )
}

function Category({ category }) {
  return (
    <span className="category-chip">
      <i className={category === 'organik' ? 'organic' : 'inorganic'} />
      {category || '—'}
    </span>
  )
}

function Severity({ severity }) {
  return <span className={`severity-chip ${severity || 'sedang'}`}>{severity || 'sedang'}</span>
}

function formatInlineMarkdown(str) {
  if (!str) return null
  const regex = /(\*\*[^*]+?\*\*|\*[^*\n]+?\*|`[^`\n]+?`)/g
  const parts = str.split(regex)
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return <em key={idx}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return <code key={idx}>{part.slice(1, -1)}</code>
    }
    return part
  })
}

function FormattedChatMessage({ content }) {
  if (!content) return null
  const text = String(content)
  const normalized = text
    .replace(/([^\n])\s+(?=\d+\.\s+\*\*)/g, '$1\n\n')
    .replace(/([^\n])\s+(?=[-•*]\s+\*\*)/g, '$1\n')

  const paragraphs = normalized.split(/\n\s*\n/)

  return (
    <div className="formatted-chat-message">
      {paragraphs.map((p, pIdx) => {
        const lines = p.split('\n').filter(l => l.trim().length > 0)
        return (
          <div key={pIdx} className="chat-paragraph">
            {lines.map((line, lIdx) => {
              const trimmed = line.trim()
              if (/^[-•*]\s+/.test(trimmed) && !trimmed.startsWith('**')) {
                return (
                  <div key={lIdx} className="chat-bullet-row">
                    <span className="chat-bullet-dot">•</span>
                    <span className="chat-bullet-text">{formatInlineMarkdown(trimmed.replace(/^[-•*]\s+/, ''))}</span>
                  </div>
                )
              }
              const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/)
              if (numMatch) {
                return (
                  <div key={lIdx} className="chat-number-row">
                    <span className="chat-number-idx">{numMatch[1]}.</span>
                    <span className="chat-number-text">{formatInlineMarkdown(numMatch[2])}</span>
                  </div>
                )
              }
              return (
                <p key={lIdx} className="chat-text-line">
                  {formatInlineMarkdown(line)}
                </p>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function pageTitle(page) {
  return (
    {
      overview: 'Ikhtisar Kampus',
      analysis: 'Hasil analisis AI',
      reports: 'Dashboard Admin',
      map: 'Peta Sebaran Unklab',
      status: 'Cek Status & Chatbot Solusi AI',
      admin: 'Admin'
    }[page] || 'Ikhtisar'
  )
}

function Modal({ title, subtitle, onClose, children, wide }) {
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Pemilih titik koordinat pada peta Kampus Universitas Klabat (mengizinkan klik di luar batas untuk menguji Skenario 5)
function LocationPicker({ coords, onPick }) {
  return (
    <CampusGoogleMap
      className="picker-leaflet"
      fillOpacity={0.06}
      interactive={false}
      showControls={false}
      onPick={onPick}
      pickPosition={coords || { latitude: UNKLAB_CENTER[0], longitude: UNKLAB_CENTER[1] }}
    />
  )
}

function ReportsPage({
  reports,
  selected,
  setSelected,
  statusFilter,
  setStatusFilter,
  categoryFilter,
  setCategoryFilter,
  severityFilter,
  setSeverityFilter,
  query,
  setQuery,
  onDetail,
  onMakeSummary,
  isSummaryLoading
}) {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">DASHBOARD ADMIN KEBERSIHAN UNIVERSITAS KLABAT</p>
          <h1>Daftar laporan & validasi AI</h1>
          <p>Filter laporan berdasarkan status, kategori, dan tingkat keparahan, serta validasi hasil AI.</p>
        </div>
        <button className="btn btn-primary" disabled={isSummaryLoading} onClick={onMakeSummary}>
          <Sparkles size={16} /> {isSummaryLoading ? 'Menyusun ringkasan...' : 'Buat Ringkasan AI'}
        </button>
      </div>

      <div className="filter-row">
        <div className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Cari kode laporan, deskripsi, atau gedung kampus..."
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          {['Semua status', ...statuses].map(x => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
          <option value="Semua kategori">Semua kategori</option>
          <option value="organik">Organik</option>
          <option value="anorganik">Anorganik</option>
        </select>
        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}>
          <option value="Semua tingkat">Semua tingkat</option>
          {['rendah', 'sedang', 'tinggi'].map(x => (
            <option key={x} value={x}>
              {x[0].toUpperCase() + x.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <section className="panel report-list-panel">
        <div className="report-table-wrap">
          <table className="report-table report-table-full">
            <thead>
              <tr>
                <th>KODE LAPORAN</th>
                <th>LOKASI KAMPUS & DESKRIPSI</th>
                <th>KATEGORI AI</th>
                <th>KEPARAHAN</th>
                <th>VALIDASI HITL</th>
                <th>STATUS</th>
                <th>WAKTU</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reports.map(r => (
                <tr
                  key={r.id}
                  className={selected?.id === r.id ? 'selected-row' : ''}
                  onClick={() => setSelected(r)}
                >
                  <td>
                    <strong className="report-code">{r.report_code}</strong>
                  </td>
                  <td className="desc-cell">
                    <strong>{unklabZoneName(r)}</strong> — {r.description}
                  </td>
                  <td>
                    <Category category={r.analysis?.category} />
                  </td>
                  <td>
                    <Severity severity={r.analysis?.severity} />
                  </td>
                  <td className="muted-cell">
                    {r.analysis?.is_validated ? '✓ Tervalidasi' : `${Math.round((r.analysis?.confidence_score || 0.9) * 100)}% (Belum)`}
                  </td>
                  <td>
                    <Status status={r.status} />
                  </td>
                  <td className="muted-cell">{dateLabel(r.created_at)}</td>
                  <td>
                    <button
                      className="row-arrow"
                      onClick={e => {
                        e.stopPropagation()
                        setSelected(r)
                        onDetail()
                      }}
                    >
                      <ArrowRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!reports.length && <div className="empty-state">Tidak ada laporan yang sesuai dengan filter.</div>}
        </div>
      </section>

      {selected ? (
        <div className="selected-report-card">
          <div>
            <div className="selected-report-title">
              <strong>{selected.report_code}</strong>
              <Status status={selected.status} />
            </div>
            <p>{selected.description}</p>
            <span>
              <MapPin size={13} /> {unklabZoneName(selected)} · {dateLabel(selected.created_at)}
            </span>
          </div>
          <button className="btn btn-primary" onClick={onDetail}>
            Validasi AI & Ubah Status <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <div className="empty-state panel">Pilih salah satu laporan di atas untuk memvalidasi hasil AI atau memperbarui status.</div>
      )}
    </div>
  )
}

// Resolusi foto laporan agar selalu menampilkan gambar yang diunggah user (termasuk dari cache lokal / database)
const FALLBACK_WASTE_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#dfeee4"/>
          <stop offset="100%" stop-color="#c6e2cf"/>
        </linearGradient>
      </defs>
      <rect width="800" height="420" fill="url(#bg)"/>
      <circle cx="680" cy="90" r="110" fill="#b5d8c1" opacity="0.45"/>
      <path d="M0 320 Q220 270 440 310 T800 295 L800 420 L0 420 Z" fill="#9bc7aa" opacity="0.55"/>
      <rect x="310" y="135" width="180" height="125" rx="18" fill="#ffffff" opacity="0.92"/>
      <text x="400" y="202" text-anchor="middle" font-family="Plus Jakarta Sans, sans-serif" font-size="15" font-weight="700" fill="#236343">Foto Titik Sampah</text>
      <text x="400" y="226" text-anchor="middle" font-family="Plus Jakarta Sans, sans-serif" font-size="12" fill="#587b67">Kampus Universitas Klabat</text>
    </svg>`
  )

function resolveReportPhoto(report) {
  if (!report) return FALLBACK_WASTE_SVG
  try {
    const cached = localStorage.getItem(`unklab_photo_${report.report_code}`)
    if (cached && cached.startsWith('data:image/')) return cached
  } catch {
    // Abaikan jika localStorage tidak tersedia
  }
  const url = String(report.photo_url || '')
  if (url.startsWith('data:image/') || url.startsWith('blob:') || url.startsWith('http')) {
    return url
  }
  return FALLBACK_WASTE_SVG
}

const DEMO_ANALYSIS_REPORT = {
  id: 'demo-89a',
  report_code: 'TT-2026-89A',
  photo_url: 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800&auto=format&fit=crop&q=80',
  latitude: 1.4172,
  longitude: 124.9835,
  description: 'Daun kering dan sisa rumput teridentifikasi di tepi jalur pejalan kaki. Pisahkan dari sampah anorganik dan arahkan ke pengomposan.',
  status: 'Menunggu',
  created_at: '2026-11-10T09:41:00.000Z',
  analysis: {
    category: 'organik',
    severity: 'sedang',
    confidence_score: 94,
    recommendation: 'Daun kering dan sisa rumput teridentifikasi di tepi jalur pejalan kaki. Pisahkan dari sampah anorganik dan arahkan ke pengomposan.'
  }
}

function AnalysisPage({
  report,
  reports = [],
  onSelectReport,
  onGoToChatbot,
  dateLabel,
  unklabZoneName
}) {
  const [copied, setCopied] = useState(false)
  const [showReportList, setShowReportList] = useState(false)

  const active = report || reports[0] || DEMO_ANALYSIS_REPORT
  const code = active.report_code || 'TT-2026-89A'
  const isWaste = active.analysis?.is_waste !== false && active.status !== 'Ditolak'
  const rawConfidence = Number(active.analysis?.confidence_score ?? 0.94)
  // confidence_score disimpan sebagai desimal 0–1; konversi ke persen bila perlu
  const confidence = Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence)
  const category = (active.analysis?.category || 'organik').toLowerCase()
  const severity = (active.analysis?.severity || 'sedang').toLowerCase()
  const recommendation =
    active.analysis?.detected_notes ||
    active.analysis?.recommendation ||
    active.description ||
    'Daun kering dan sisa rumput teridentifikasi di tepi jalur pejalan kaki. Pisahkan dari sampah anorganik dan arahkan ke pengomposan.'
  const locationName = unklabZoneName(active)
  const isDemo = active.id === 'demo-89a'

  const copyCode = () => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    }
  }

  const formatWitaDate = dateStr => {
    try {
      const d = new Date(dateStr)
      return (
        new Intl.DateTimeFormat('id-ID', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(d) + ' WITA'
      )
    } catch {
      return dateLabel(dateStr)
    }
  }

  return (
    <div className="page-stack figma-analysis-page">
      <div className="page-heading figma-analysis-heading">
        <div>
          <p className="eyebrow">HASIL ANALISIS GEMINI VLM {isDemo ? '— CONTOH TAMPILAN' : ''}</p>
          {isWaste ? (
            <>
              <h1>Laporan diterima. Terima kasih sudah peduli.</h1>
              <p>Simpan kode laporan Anda untuk memantau penanganan dan berdiskusi dengan asisten AI.</p>
            </>
          ) : (
            <>
              <h1 style={{ color: '#b91c1c' }}>Laporan ditolak. Foto bukan sampah kampus.</h1>
              <p style={{ color: '#b91c1c' }}>AI mendeteksi objek dalam foto bukan merupakan titik sampah fisik di lingkungan Universitas Klabat.</p>
            </>
          )}
        </div>

        {reports.length > 0 && (
          <div className="minimal-picker-container">
            <button
              type="button"
              className="minimal-picker-pill"
              onClick={() => setShowReportList(!showReportList)}
              aria-label="Pilih laporan"
            >
              <span className="minimal-picker-dot" />
              <span className="minimal-picker-label">Laporan:</span>
              <strong className="minimal-picker-code">{code}</strong>
              <ChevronDown size={13} className={`minimal-picker-chevron ${showReportList ? 'rotate' : ''}`} />
            </button>

            {showReportList && (
              <>
                <div className="minimal-picker-backdrop" onClick={() => setShowReportList(false)} />
                <div className="minimal-picker-menu">
                  <div className="minimal-picker-header">
                    <span>PILIH LAPORAN ({reports.length})</span>
                  </div>
                  <div className="minimal-picker-scroll">
                    {reports.map(r => (
                      <button
                        key={r.id || r.report_code}
                        type="button"
                        className={`minimal-picker-item ${r.report_code === code ? 'selected' : ''}`}
                        onClick={() => {
                          onSelectReport(r)
                          setShowReportList(false)
                        }}
                      >
                        <div className="item-row-top">
                          <strong className="item-code">{r.report_code}</strong>
                          <span className={`item-badge ${(r.analysis?.category || 'anorganik').toLowerCase()}`}>
                            {r.analysis?.category || 'anorganik'}
                          </span>
                        </div>
                        <div className="item-row-sub">
                          <span>{unklabZoneName(r)}</span>
                          <span className="item-sep">•</span>
                          <span>{r.status || 'Menunggu'}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="figma-analysis-grid">
        {/* Kolom Kiri: Hasil Analisis Foto */}
        <section className="panel figma-analysis-card">
          <div className="figma-photo-container">
            <img
              src={resolveReportPhoto(active)}
              alt="Foto hasil analisis AI"
              className="figma-analysis-img"
              onError={e => {
                e.currentTarget.onerror = null
                e.currentTarget.src = FALLBACK_WASTE_SVG
              }}
            />
            {isWaste ? (
              <div className="figma-photo-detected-badge">
                <Check size={14} className="detected-check" />
                <span>Sampah Terdeteksi</span>
              </div>
            ) : (
              <div className="figma-photo-detected-badge rejected">
                <X size={14} className="detected-check" />
                <span>Bukan Sampah (Ditolak)</span>
              </div>
            )}
          </div>

          <div className="figma-analysis-body">
            <div className="figma-analysis-title-row">
              <h2>Hasil analisis foto</h2>
              <div className="figma-confidence-box">
                <span className="conf-label">CONFIDENCE SCORE</span>
                <span className="conf-value">{confidence}%</span>
              </div>
            </div>

            {isWaste ? (
              <div className="figma-chips-row">
                <span className={`figma-analysis-chip ${category === 'organik' ? 'chip-organic' : 'chip-inorganic'}`}>
                  {category.charAt(0).toUpperCase() + category.slice(1)}
                </span>
                <span className={`figma-analysis-chip chip-severity-${severity}`}>
                  {severity.charAt(0).toUpperCase() + severity.slice(1)}
                </span>
                <span className="figma-analysis-chip chip-rejected-sub">
                  Model: {active.analysis?.ai_model || 'gemini-3.5-flash-lite'}
                </span>
              </div>
            ) : (
              <div className="figma-chips-row">
                <span className="figma-analysis-chip chip-rejected">
                  Bukan Sampah
                </span>
                <span className="figma-analysis-chip chip-rejected-sub">
                  Non-Sampah Kampus
                </span>
                <span className="figma-analysis-chip chip-rejected-sub">
                  Model: {active.analysis?.ai_model || 'gemini-3.5-flash-lite'}
                </span>
              </div>
            )}

            <p className="figma-analysis-text">{recommendation}</p>

            <div className="figma-analysis-footer-note">
              {isWaste
                ? 'Analisis AI bersifat rekomendasi. Menunggu validasi petugas (HITL).'
                : 'Laporan ini ditolak secara otomatis oleh AI karena foto tidak memenuhi kriteria sampah kampus.'}
            </div>
          </div>
        </section>

        {/* Kolom Kanan: Kode Laporan + Langkah Selanjutnya */}
        <div className="figma-analysis-side">
          <section className="panel figma-code-box-card">
            <span className="figma-code-eyebrow">KODE LAPORAN ANDA</span>
            <div className="figma-code-headline">{code}</div>

            <button type="button" className="figma-copy-action-btn" onClick={copyCode}>
              {copied ? (
                <>
                  <Check size={14} className="copy-ok-icon" />
                  <span>Kode berhasil disalin!</span>
                </>
              ) : (
                <>
                  <Copy size={14} />
                  <span>Salin kode laporan</span>
                </>
              )}
            </button>

            <div className="figma-status-chip-row">
              <span className={`figma-status-indicator-badge ${!isWaste ? 'rejected' : ''}`}>
                <i className={!isWaste ? 'status-dot-red' : 'status-dot-orange'} /> {active.status || (isWaste ? 'Menunggu' : 'Ditolak')}
              </span>
            </div>

            <div className="figma-code-meta-info">
              <div className="meta-location">{locationName} · Universitas Klabat</div>
              <div className="meta-timestamp">{formatWitaDate(active.created_at)}</div>
            </div>
          </section>

          <section className="panel figma-steps-card">
            <h3>{isWaste ? 'Apa selanjutnya?' : 'Mengapa ditolak?'}</h3>
            <ol className="figma-steps-list">
              {isWaste ? (
                <>
                  <li>
                    <span className="step-num">1.</span>
                    <span>Petugas memvalidasi hasil deteksi AI.</span>
                  </li>
                  <li>
                    <span className="step-num">2.</span>
                    <span>Titik sampah dijadwalkan untuk dibersihkan.</span>
                  </li>
                  <li>
                    <span className="step-num">3.</span>
                    <span>Pantau progres melalui kode laporan Anda.</span>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <span className="step-num" style={{ background: '#fee2e2', color: '#b91c1c' }}>1.</span>
                    <span>Foto tidak teridentifikasi sebagai titik timbunan sampah fisik.</span>
                  </li>
                  <li>
                    <span className="step-num" style={{ background: '#fee2e2', color: '#b91c1c' }}>2.</span>
                    <span>Laporan diberi status Ditolak dan tidak dijadwalkan ke petugas.</span>
                  </li>
                  <li>
                    <span className="step-num" style={{ background: '#fee2e2', color: '#b91c1c' }}>3.</span>
                    <span>Silakan ambil foto ulang jika menemukan titik sampah nyata di Unklab.</span>
                  </li>
                </>
              )}
            </ol>

            <button
              type="button"
              className="btn btn-primary btn-block figma-cta-chatbot-btn"
              onClick={() => onGoToChatbot(active)}
            >
              Cek status & buka chatbot <ArrowRight size={16} />
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}

function StatusPage({
  reportCode,
  setReportCode,
  lookup,
  report,
  reports = [],
  onSelectReport,
  chat,
  newMessage,
  setNewMessage,
  sendChat,
  isChatLoading
}) {
  const [showReportList, setShowReportList] = useState(false)
  const userCount = chat.filter(m => m.sender === 'user').length
  const stepIndex = report ? Math.max(0, statuses.indexOf(report.status)) : 0

  const statusHeadline =
    report?.status === 'Selesai'
      ? 'Penanganan selesai'
      : report?.status === 'Diproses'
      ? 'Sedang ditangani petugas'
      : 'Menunggu validasi petugas'

  const statusSubtext =
    report?.status === 'Selesai'
      ? 'Titik sampah ini telah dibersihkan dan diverifikasi selesai oleh petugas kebersihan kampus.'
      : report?.status === 'Diproses'
      ? 'Petugas kebersihan Universitas Klabat sedang menindaklanjuti laporan di lokasi ini.'
      : 'Laporan Anda sudah diterima dan akan ditinjau oleh petugas kebersihan kampus.'

  return (
    <div className="page-stack status-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LAYANAN PELAPOR KAMPUS UNIVERSITAS KLABAT</p>
          <h1>Cek status laporan & Chatbot Solusi AI</h1>
          <p>Masukkan kode laporan unik Anda untuk memantau status penanganan dan berkonsultasi dengan asisten AI.</p>
        </div>
      </div>

      <form className="lookup-form" onSubmit={lookup}>
        <div>
          <div className="lookup-label-row">
            <label>Kode laporan unik</label>
            {reports.length > 0 && (
              <button
                type="button"
                className="forgot-code-btn"
                onClick={() => setShowReportList(prev => !prev)}
              >
                {showReportList ? 'Sembunyikan daftar laporan' : `Lupa kode laporan? Lihat daftar laporan (${reports.length})`}
                <ChevronDown size={14} className={showReportList ? 'chev-rotated' : ''} />
              </button>
            )}
          </div>
          <div className="lookup-input">
            <Search size={17} />
            <input
              value={reportCode}
              onChange={e => setReportCode(e.target.value)}
              placeholder="Contoh: TT-2026-XXXX"
            />
            <button type="submit" className="btn btn-primary">
              Cek status <ArrowRight size={15} />
            </button>
          </div>

          {showReportList && reports.length > 0 && (
            <div className="saved-reports-drawer">
              <p className="saved-reports-hint">
                Klik salah satu laporan di bawah ini jika Anda lupa kode laporan:
              </p>
              <div className="saved-reports-list">
                {reports.map(item => (
                  <button
                    type="button"
                    key={item.id || item.report_code}
                    className={`saved-report-item ${report?.report_code === item.report_code ? 'active' : ''}`}
                    onClick={() => {
                      onSelectReport?.(item)
                      setShowReportList(false)
                    }}
                  >
                    <div className="saved-report-left">
                      <strong className="saved-report-code">{item.report_code}</strong>
                      <span className="saved-report-desc">
                        {unklabZoneName(item)} — {item.description || 'Laporan titik sampah'}
                      </span>
                    </div>
                    <div className="saved-report-right">
                      <Category category={item.analysis?.category} />
                      <Status status={item.status} />
                      <small>{dateLabel(item.created_at)}</small>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </form>

      {report ? (
        <div className="status-grid">
          {/* Kartu Kiri: Sesuai Desain Figma (Header, Foto Hasil Upload, Pill Tags, Stepper Horizontal, Kotak Status) */}
          <section className="panel figma-status-card">
            <div className="figma-status-header">
              <div>
                <h2>{report.report_code}</h2>
                <p className="figma-status-meta">
                  {unklabZoneName(report)} · {dateLabel(report.created_at)}
                </p>
              </div>
              <span className="figma-check-badge">
                {report.analysis?.is_validated ? 'Tervalidasi Admin' : 'Dicek otomatis'}
              </span>
            </div>

            <div className="figma-photo-wrap">
              <img
                src={resolveReportPhoto(report)}
                alt={`Foto laporan ${report.report_code}`}
                className="figma-uploaded-photo"
                onError={e => {
                  e.currentTarget.onerror = null
                  e.currentTarget.src = FALLBACK_WASTE_SVG
                }}
              />
            </div>

            <div className="figma-tags-row">
              <span className={`figma-tag tag-${report.analysis?.category || 'organik'}`}>
                {(report.analysis?.category || 'organik').replace(/^./, c => c.toUpperCase())}
              </span>
              <span className={`figma-tag tag-sev-${report.analysis?.severity || 'sedang'}`}>
                {(report.analysis?.severity || 'sedang').replace(/^./, c => c.toUpperCase())}
              </span>
              <span className="figma-tag tag-confidence">
                {Math.round((report.analysis?.confidence_score || 0.9) * 100)}% yakin
              </span>
            </div>

            <div className="figma-stepper-block">
              <span className="figma-stepper-label">STATUS PENANGANAN</span>
              <div className="figma-horizontal-stepper">
                {statuses.map((s, i) => {
                  const isCurrent = stepIndex === i
                  const isDone = stepIndex > i
                  const stateClass = isCurrent ? 'current' : isDone ? 'done' : 'upcoming'
                  return (
                    <div className={`figma-step ${stateClass}`} key={s}>
                      <div className="figma-step-track">
                        <span className="figma-step-circle">
                          {isDone ? <Check size={12} /> : isCurrent ? <i className="figma-step-dot" /> : i + 1}
                        </span>
                        {i < statuses.length - 1 && (
                          <div className={`figma-step-line ${isDone ? 'line-done' : ''}`} />
                        )}
                      </div>
                      <strong className="figma-step-title">{s}</strong>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="figma-status-callout">
              <strong>{statusHeadline}</strong>
              <p>{report.description ? `${report.description} — ${statusSubtext}` : statusSubtext}</p>
            </div>
          </section>

          {/* Kartu Kanan: Chatbot Solusi AI Sesuai Desain Figma */}
          <section className="panel chat-panel figma-chat-panel">
            <div className="figma-chat-heading">
              <div className="figma-chat-title">
                <Sparkles size={15} />
                <strong>Chatbot Solusi AI</strong>
              </div>
              <small className="figma-chat-sub">
                <i className="active-dot" /> Aktif · Konteks laporan {report.report_code}
              </small>
            </div>

            <div className="chat-messages figma-chat-messages">
              {chat.map((m, i) => (
                <div key={i} className={`figma-chat-bubble-row ${m.sender}`}>
                  {m.sender === 'ai' && i === 0 ? (
                    <div className="figma-bubble ai-initial">
                      <strong className="figma-bubble-title">Halo! Saya sudah membaca hasil deteksi foto Anda.</strong>
                      <FormattedChatMessage content={m.message} />
                    </div>
                  ) : (
                    <div className={`figma-bubble ${m.sender}`}>
                      <FormattedChatMessage content={m.message} />
                    </div>
                  )}
                </div>
              ))}
              {isChatLoading && (
                <div className="figma-chat-bubble-row ai">
                  <div className="figma-bubble ai">
                    <p>Menyusun saran penanganan...</p>
                  </div>
                </div>
              )}
            </div>

            <div className="chat-suggestions">
              <button type="button" onClick={() => setNewMessage('Apakah sampah ini bisa dijadikan kompos atau didaur ulang?')}>
                Apakah bisa didaur ulang / kompos?
              </button>
              <button type="button" onClick={() => setNewMessage('Bagaimana cara memilah sampah ini di kampus?')}>
                Cara pemilahan
              </button>
            </div>

            <div className="figma-chat-footer">
              <div className="figma-chat-input-box">
                <input
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), sendChat())}
                  placeholder={userCount >= 10 ? 'Batas 10 pesan untuk laporan ini tercapai.' : 'Tanyakan cara memilah sampah (maks. 300 karakter)...'}
                  maxLength={300}
                  disabled={userCount >= 10 || isChatLoading}
                />
                <button type="button" onClick={sendChat} disabled={userCount >= 10 || isChatLoading || !newMessage.trim()}>
                  <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="figma-chat-footer-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                <small className="figma-chat-disclaimer">
                  Chatbot terproteksi & fokus pada kebersihan kampus.
                </small>
                <small style={{ fontSize: '11px', color: userCount >= 10 ? '#dc2626' : '#64748b', fontWeight: 600 }}>
                  {userCount}/10 pertanyaan ({300 - newMessage.length} char)
                </small>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="status-empty">
          <div>
            <Search size={22} />
          </div>
          <strong>Masukkan kode laporan unik Anda</strong>
          <p>Kode laporan diberikan secara otomatis setelah foto titik sampah di Universitas Klabat berhasil dianalisis.</p>
          {reports.length > 0 && (
            <button
              type="button"
              className="btn btn-outline"
              style={{ marginTop: '8px' }}
              onClick={() => setShowReportList(true)}
            >
              Lihat daftar laporan terbaru ({reports.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default App
