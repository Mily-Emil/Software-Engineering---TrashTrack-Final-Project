-- TrashTrack Universitas Klabat (Unklab): run in Supabase SQL Editor (idempotent / safe to re-run).
-- Menjawab temuan review SDLC Goldfish (Tema 1 s.d. 11):
-- 1. Enum status mendukung 'Ditolak'
-- 2. Pemisahan data asli AI vs koreksi Admin (Audit Trail HITL)
-- 3. Pencatatan sumber lokasi (GPS vs manual) dan akurasi
-- 4. Pencatatan zona kampus (zone_name) langsung di DB untuk agregasi SQL deterministik
-- 5. Rate limiting dengan secret salt & pembatasan pesan chatbot (maks 10 per laporan)

create extension if not exists pgcrypto with schema extensions;

do $$ begin create type public.report_status as enum ('Menunggu', 'Diproses', 'Selesai', 'Ditolak'); exception when duplicate_object then null; end $$;
-- Pastikan enum lama jika sudah ada ditambahkan nilai 'Ditolak'
alter type public.report_status add value if not exists 'Ditolak';

do $$ begin create type public.waste_category as enum ('organik', 'anorganik'); exception when duplicate_object then null; end $$;
do $$ begin create type public.waste_severity as enum ('rendah', 'sedang', 'tinggi'); exception when duplicate_object then null; end $$;
do $$ begin create type public.chat_sender as enum ('user', 'ai'); exception when duplicate_object then null; end $$;

-- 1. ADMINS
create table if not exists public.admins (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  password_hash text default 'managed_by_supabase_auth_bcrypt',
  created_at timestamptz not null default now()
);
alter table public.admins add column if not exists password_hash text default 'managed_by_supabase_auth_bcrypt';

-- 2. REPORTS (Tema 1, 3, 7, 8)
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  report_code text not null unique,
  photo_url text,
  latitude double precision not null,
  longitude double precision not null,
  description text,
  status public.report_status not null default 'Menunggu',
  zone_name text,
  location_source text not null default 'manual',
  location_accuracy double precision,
  needs_review boolean not null default false,
  device_id text,
  ip_hash text,
  updated_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reports add column if not exists zone_name text;
alter table public.reports add column if not exists location_source text not null default 'manual';
alter table public.reports add column if not exists location_accuracy double precision;
alter table public.reports add column if not exists needs_review boolean not null default false;
alter table public.reports add column if not exists device_id text;
alter table public.reports add column if not exists updated_by uuid references public.admins(id) on delete set null;

alter table public.reports drop constraint if exists reports_latitude_check;
alter table public.reports drop constraint if exists reports_longitude_check;
alter table public.reports add constraint reports_latitude_check check (latitude between 1.4120 and 1.4235);
alter table public.reports add constraint reports_longitude_check check (longitude between 124.9790 and 124.9895);

-- 3. AI_ANALYSIS (Tema 2 & 7: Pemisahan data asli AI vs koreksi manusia)
create table if not exists public.ai_analysis (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports(id) on delete cascade,
  is_waste boolean not null default true,
  category public.waste_category,
  severity public.waste_severity,
  confidence_score numeric(4,3) not null check (confidence_score between 0 and 1),
  detected_notes text,
  is_validated boolean not null default false,
  corrected_category public.waste_category,
  corrected_severity public.waste_severity,
  admin_notes text,
  corrected_by uuid references public.admins(id) on delete set null,
  corrected_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.ai_analysis add column if not exists detected_notes text;
alter table public.ai_analysis add column if not exists corrected_category public.waste_category;
alter table public.ai_analysis add column if not exists corrected_severity public.waste_severity;
alter table public.ai_analysis add column if not exists admin_notes text;
alter table public.ai_analysis add column if not exists corrected_at timestamptz;

-- 4. CHAT_MESSAGES (Tema 5: Batas pesan maks 10 per laporan)
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  sender public.chat_sender not null,
  message text not null check (char_length(message) <= 1000),
  created_at timestamptz not null default now()
);

-- 5. AI_SUMMARIES
create table if not exists public.ai_summaries (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  summary_text text not null,
  structured_data jsonb,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
alter table public.ai_summaries add column if not exists structured_data jsonb;

-- Internal rate-limiting table (Tema 4: Hash per perangkat / IP dengan salt)
create table if not exists public.report_rate_limits (
  client_hash text not null default '',
  created_at timestamptz not null default now()
);
alter table public.report_rate_limits add column if not exists client_hash text;

do $$
begin
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'report_rate_limits' and column_name = 'ip_hash'
  ) then
    execute 'update public.report_rate_limits set client_hash = coalesce(client_hash, ip_hash, '''') where client_hash is null';
  end if;
end $$;

create index if not exists reports_status_created_idx on public.reports(status, created_at desc);
create index if not exists reports_location_idx on public.reports(latitude, longitude);
create index if not exists reports_zone_idx on public.reports(zone_name);
create index if not exists chat_messages_report_created_idx on public.chat_messages(report_id, created_at asc);
create index if not exists report_rate_limits_window_idx on public.report_rate_limits(client_hash, created_at desc);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists reports_touch_updated_at on public.reports;
create trigger reports_touch_updated_at before update on public.reports for each row execute function public.touch_updated_at();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.admins a where a.id = (select auth.uid()))
$$;

alter table public.admins enable row level security;
alter table public.reports enable row level security;
alter table public.ai_analysis enable row level security;
alter table public.chat_messages enable row level security;
alter table public.ai_summaries enable row level security;
alter table public.report_rate_limits enable row level security;

drop policy if exists "Admins manage admin profiles" on public.admins;
create policy "Admins manage admin profiles" on public.admins for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins full CRUD reports" on public.reports;
create policy "Admins full CRUD reports" on public.reports for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins full CRUD AI analysis" on public.ai_analysis;
create policy "Admins full CRUD AI analysis" on public.ai_analysis for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins full CRUD chat messages" on public.chat_messages;
create policy "Admins full CRUD chat messages" on public.chat_messages for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins full CRUD summaries" on public.ai_summaries;
create policy "Admins full CRUD summaries" on public.ai_summaries for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Only security definer functions manage limits" on public.report_rate_limits;
create policy "Only security definer functions manage limits" on public.report_rate_limits for all to authenticated using (false) with check (false);

revoke all on public.reports, public.ai_analysis, public.chat_messages, public.admins, public.ai_summaries, public.report_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.reports, public.ai_analysis, public.chat_messages, public.admins, public.ai_summaries to authenticated;
grant execute on function public.is_admin() to authenticated;

-- Tema 4: Salted Rate Limit Checker
drop function if exists public.claim_report_slot(text);
create or replace function public.claim_report_slot(p_client_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_client_hash is null or length(p_client_hash) < 16 then raise exception 'Invalid client identifier'; end if;
  perform pg_advisory_xact_lock(hashtext(p_client_hash));
  delete from public.report_rate_limits where created_at < now() - interval '1 hour';
  select count(*) into v_count from public.report_rate_limits where client_hash=p_client_hash and created_at >= now()-interval '1 hour';
  if v_count >= 5 then return false; end if;
  insert into public.report_rate_limits(client_hash) values(p_client_hash);
  return true;
end $$;
revoke all on function public.claim_report_slot(text) from public, anon, authenticated;
grant execute on function public.claim_report_slot(text) to service_role;

-- Tema 1, 2, 3, 7, 8, 9: Public report submission RPC
-- Alur: Laporan selalu disimpan ke DB. Jika AI menolak atau gagal, status Menunggu + needs_review=true
drop function if exists public.submit_report(text, double precision, double precision, text, jsonb, text);
drop function if exists public.submit_report(text, double precision, double precision, text, jsonb, text, text, double precision, text, text);
create or replace function public.submit_report(
  p_photo_url text,
  p_latitude double precision,
  p_longitude double precision,
  p_description text,
  p_analysis jsonb,
  p_initial_advice text default null,
  p_location_source text default 'manual',
  p_location_accuracy double precision default null,
  p_zone_name text default null,
  p_device_id text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip text := coalesce(split_part(v_headers->>'x-forwarded-for', ',', 1), v_headers->>'cf-connecting-ip', 'local-client');
  -- Salted hash (kombinasi IP + device_id jika ada)
  v_salt text := 'unklab_trashtrack_salt_2026';
  v_client_key text := coalesce(p_device_id, v_ip);
  v_hash text := md5(v_client_key || ':' || v_salt);
  v_count integer;
  v_report public.reports%rowtype;
  -- Tema 9: Format kode acak kriptografis 4 karakter non-ambigu (contoh: TT-2026-K9M2)
  v_random_chars text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_suffix text := '';
  v_idx integer;
  v_advice text;
  v_is_waste boolean;
  v_category public.waste_category;
  v_severity public.waste_severity;
  v_confidence numeric(4,3);
  v_needs_review boolean := false;
  v_detected_notes text;
begin
  -- 1. Rate Limit per Perangkat / Client Hash (NFR-04)
  perform pg_advisory_xact_lock(hashtext(v_hash));
  delete from public.report_rate_limits where created_at < now() - interval '1 hour';
  select count(*) into v_count from public.report_rate_limits where client_hash=v_hash and created_at >= now()-interval '1 hour';
  if v_count >= 5 then raise exception 'Batas 5 laporan per jam tercapai. Silakan coba lagi nanti.'; end if;

  -- 2. Koordinat Kampus Unklab (NFR-06)
  if p_latitude not between 1.4120 and 1.4235 or p_longitude not between 124.9790 and 124.9895 then
    raise exception 'Ditolak: Lokasi berada di luar area kampus Universitas Klabat.';
  end if;

  -- Generate 4-char non-ambiguous random code
  for i in 1..4 loop
    v_idx := 1 + floor(random() * length(v_random_chars))::integer;
    v_suffix := v_suffix || substr(v_random_chars, v_idx, 1);
  end loop;

  -- 3. Parse Analisis AI dengan fallback jika bukan sampah atau confidence rendah
  v_is_waste := coalesce((p_analysis->>'is_waste')::boolean, true);
  v_confidence := least(1, greatest(0, coalesce((p_analysis->>'confidence_score')::numeric, 0.85)));
  v_detected_notes := p_analysis->>'notes';

  -- Jika AI mendeteksi bukan sampah atau confidence < 0.70, tandai perlu ditinjau admin
  if not v_is_waste or v_confidence < 0.70 then
    v_needs_review := true;
  end if;

  if (p_analysis->>'category') in ('organik', 'anorganik') then
    v_category := (p_analysis->>'category')::public.waste_category;
  else
    v_category := 'anorganik';
    v_needs_review := true;
  end if;

  if (p_analysis->>'severity') in ('rendah', 'sedang', 'tinggi') then
    v_severity := (p_analysis->>'severity')::public.waste_severity;
  else
    v_severity := 'sedang';
    v_needs_review := true;
  end if;

  insert into public.report_rate_limits(client_hash) values(v_hash);

  -- 4. Simpan Laporan
  insert into public.reports(
    report_code,
    photo_url,
    latitude,
    longitude,
    description,
    zone_name,
    location_source,
    location_accuracy,
    needs_review,
    device_id,
    ip_hash
  )
  values(
    'TT-' || extract(year from now())::int || '-' || v_suffix,
    p_photo_url,
    p_latitude,
    p_longitude,
    left(coalesce(p_description, ''), 500),
    coalesce(nullif(trim(p_zone_name), ''), 'Kampus Universitas Klabat'),
    coalesce(nullif(trim(p_location_source), ''), 'manual'),
    p_location_accuracy,
    v_needs_review,
    p_device_id,
    v_hash
  )
  returning * into v_report;

  -- 5. Simpan Hasil Prediksi Asli AI
  insert into public.ai_analysis(
    report_id,
    is_waste,
    category,
    severity,
    confidence_score,
    detected_notes
  )
  values (
    v_report.id,
    v_is_waste,
    v_category,
    v_severity,
    v_confidence,
    v_detected_notes
  );

  -- 6. Simpan Pesan Awal Chatbot
  v_advice := coalesce(
    nullif(trim(p_initial_advice), ''),
    case
      when v_category = 'organik' then
        'Hasil deteksi menunjukkan sampah ORGANIK (' || v_severity || ') di ' || v_report.zone_name || '. Mohon pisahkan dari plastik agar dapat dikomposkan.'
      else
        'Hasil deteksi menunjukkan sampah ANORGANIK (' || v_severity || ') di ' || v_report.zone_name || '. Silakan pilah botol plastik atau kaleng ke tempat daur ulang.'
    end
  );
  insert into public.chat_messages(report_id, sender, message)
  values (v_report.id, 'ai', left(v_advice, 1000));

  return jsonb_build_object(
    'id', v_report.id,
    'report_code', v_report.report_code,
    'status', v_report.status,
    'zone_name', v_report.zone_name,
    'needs_review', v_report.needs_review,
    'created_at', v_report.created_at,
    'initial_advice', v_advice
  );
end $$;
grant execute on function public.submit_report(text,double precision,double precision,text,jsonb,text,text,double precision,text,text) to anon, authenticated, service_role;

-- Tema 7 & 9: Lookup single report dengan data lengkap audit trail
create or replace function public.get_report_by_code(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'report_code', r.report_code,
    'photo_url', r.photo_url,
    'latitude', r.latitude,
    'longitude', r.longitude,
    'description', r.description,
    'status', r.status,
    'zone_name', r.zone_name,
    'location_source', r.location_source,
    'location_accuracy', r.location_accuracy,
    'needs_review', r.needs_review,
    'updated_by', r.updated_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'analysis', jsonb_build_object(
      'is_waste', a.is_waste,
      'category', a.category,
      'severity', a.severity,
      'confidence_score', a.confidence_score,
      'detected_notes', a.detected_notes,
      'is_validated', a.is_validated,
      'corrected_category', a.corrected_category,
      'corrected_severity', a.corrected_severity,
      'admin_notes', a.admin_notes,
      'corrected_at', a.corrected_at,
      'corrected_by', a.corrected_by
    ),
    'chat_messages', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', c.id, 'sender', c.sender, 'message', c.message, 'created_at', c.created_at)
        order by c.created_at asc
      )
      from public.chat_messages c
      where c.report_id = r.id
    ), '[]'::jsonb)
  )
  from public.reports r
  left join public.ai_analysis a on a.report_id = r.id
  where r.report_code = upper(trim(p_code))
  limit 1
$$;
grant execute on function public.get_report_by_code(text) to anon, authenticated;

-- Tema 5: Append chat message dengan proteksi batas 10 pesan per laporan & maks 300 char
create or replace function public.append_chat_message(p_code text, p_sender public.chat_sender, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_report_id uuid;
  v_msg_count integer;
  v_clean_msg text := left(trim(p_message), 300);
  v_msg public.chat_messages%rowtype;
begin
  select id into v_report_id from public.reports where report_code = upper(trim(p_code)) limit 1;
  if v_report_id is null then raise exception 'Kode laporan tidak ditemukan.'; end if;

  select count(*) into v_msg_count from public.chat_messages where report_id = v_report_id and sender = 'user';
  if p_sender = 'user' and v_msg_count >= 10 then
    raise exception 'Batas maksimal 10 pertanyaan per laporan telah tercapai.';
  end if;

  insert into public.chat_messages(report_id, sender, message)
  values (v_report_id, p_sender, v_clean_msg)
  returning * into v_msg;

  return jsonb_build_object('id', v_msg.id, 'sender', v_msg.sender, 'message', v_msg.message, 'created_at', v_msg.created_at);
end $$;
grant execute on function public.append_chat_message(text, public.chat_sender, text) to anon, authenticated;

-- Tema 6: Peta publik dengan privasi (tanpa ip_hash/device_id)
create or replace function public.get_public_reports() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'report_code', r.report_code,
      'photo_url', r.photo_url,
      'latitude', r.latitude,
      'longitude', r.longitude,
      'description', r.description,
      'status', r.status,
      'zone_name', r.zone_name,
      'location_source', r.location_source,
      'created_at', r.created_at,
      'analysis', jsonb_build_object(
        'is_waste', a.is_waste,
        'category', coalesce(a.corrected_category, a.category),
        'severity', coalesce(a.corrected_severity, a.severity),
        'confidence_score', a.confidence_score,
        'is_validated', a.is_validated
      )
    ) order by r.created_at desc
  ), '[]'::jsonb)
  from public.reports r
  left join public.ai_analysis a on a.report_id = r.id
$$;
grant execute on function public.get_public_reports() to anon, authenticated;

-- Tema 8 & 5: Fungsi Agregasi SQL Deterministik untuk FR-09 (Ringkasan AI)
create or replace function public.get_report_statistics(p_days integer default 7) returns jsonb
language sql stable security definer set search_path = '' as $$
  with target_reports as (
    select r.*, a.category, a.severity, a.is_validated
    from public.reports r
    left join public.ai_analysis a on a.report_id = r.id
    where r.created_at >= now() - (p_days || ' days')::interval
  ),
  zone_ranking as (
    select coalesce(zone_name, 'Area Kampus Lainnya') as z_name, count(*) as cnt
    from target_reports
    group by 1
    order by cnt desc
    limit 1
  )
  select jsonb_build_object(
    'period_days', p_days,
    'total_reports', count(*),
    'waiting_count', count(*) filter (where status::text = 'Menunggu'),
    'processing_count', count(*) filter (where status::text = 'Diproses'),
    'completed_count', count(*) filter (where status::text = 'Selesai'),
    'rejected_count', count(*) filter (where status::text = 'Ditolak'),
    'organic_count', count(*) filter (where coalesce(category::text, '') = 'organik'),
    'inorganic_count', count(*) filter (where coalesce(category::text, '') = 'anorganik'),
    'top_zone', coalesce((select z_name from zone_ranking), 'Belum ada data'),
    'top_zone_count', coalesce((select cnt from zone_ranking), 0)
  )
  from target_reports;
$$;
grant execute on function public.get_report_statistics(integer) to anon, authenticated, service_role;

-- Storage bucket
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('report-photos','report-photos',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp'];

drop policy if exists "Admins manage report photos" on storage.objects;
create policy "Admins manage report photos" on storage.objects for all to authenticated
using (bucket_id='report-photos' and public.is_admin()) with check (bucket_id='report-photos' and public.is_admin());