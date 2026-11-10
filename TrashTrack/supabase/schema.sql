-- TrashTrack Universitas Klabat (Unklab): run in Supabase SQL Editor (idempotent / safe to re-run).
-- Matches the CogITo Journal ERD (Gambar 3), Flowchart (Gambar 4), and Sequence Diagram (Gambar 5).

create extension if not exists pgcrypto with schema extensions;

do $$ begin create type public.report_status as enum ('Menunggu', 'Diproses', 'Selesai'); exception when duplicate_object then null; end $$;
do $$ begin create type public.waste_category as enum ('organik', 'anorganik'); exception when duplicate_object then null; end $$;
do $$ begin create type public.waste_severity as enum ('rendah', 'sedang', 'tinggi'); exception when duplicate_object then null; end $$;
do $$ begin create type public.chat_sender as enum ('user', 'ai'); exception when duplicate_object then null; end $$;

-- 1. ADMINS (Gambar 3 ERD: id, name, email, password_hash, created_at)
create table if not exists public.admins (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  password_hash text default 'managed_by_supabase_auth_bcrypt',
  created_at timestamptz not null default now()
);
alter table public.admins add column if not exists password_hash text default 'managed_by_supabase_auth_bcrypt';

-- 2. REPORTS (Gambar 3 ERD: id, report_code, photo_url, latitude, longitude, description, status, ip_hash, updated_by, created_at, updated_at)
-- Coordinates restricted to Universitas Klabat (Unklab) campus area, Airmadidi (NFR-06).
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  report_code text not null unique,
  photo_url text,
  latitude double precision not null,
  longitude double precision not null,
  description text,
  status public.report_status not null default 'Menunggu',
  ip_hash text,
  updated_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.reports add column if not exists updated_by uuid references public.admins(id) on delete set null;
alter table public.reports drop constraint if exists reports_latitude_check;
alter table public.reports drop constraint if exists reports_longitude_check;
alter table public.reports add constraint reports_latitude_check check (latitude between 1.4120 and 1.4235);
alter table public.reports add constraint reports_longitude_check check (longitude between 124.9790 and 124.9895);

-- 3. AI_ANALYSIS (Gambar 3 ERD: id, report_id, is_waste, category, severity, confidence_score, is_validated, corrected_by, created_at)
create table if not exists public.ai_analysis (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports(id) on delete cascade,
  is_waste boolean not null,
  category public.waste_category,
  severity public.waste_severity,
  confidence_score numeric(4,3) not null check (confidence_score between 0 and 1),
  is_validated boolean not null default false,
  corrected_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 4. CHAT_MESSAGES (Gambar 3 ERD: id, report_id, sender, message, created_at)
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  sender public.chat_sender not null,
  message text not null check (char_length(message) <= 2000),
  created_at timestamptz not null default now()
);

-- 5. AI_SUMMARIES (Gambar 3 ERD: id, admin_id, period_start, period_end, summary_text, created_at)
create table if not exists public.ai_summaries (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  summary_text text not null,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

-- Internal rate-limiting table for NFR-04 (max 5 reports per hour per IP hash)
create table if not exists public.report_rate_limits (
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists reports_status_created_idx on public.reports(status, created_at desc);
create index if not exists reports_location_idx on public.reports(latitude, longitude);
create index if not exists chat_messages_report_created_idx on public.chat_messages(report_id, created_at asc);
create index if not exists report_rate_limits_window_idx on public.report_rate_limits(ip_hash, created_at desc);

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

-- Atomic 5-per-hour claim used by the server-side Edge Function (Gambar 4 & Gambar 5 Step 2).
create or replace function public.claim_report_slot(p_ip_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_ip_hash is null or length(p_ip_hash) <> 64 then raise exception 'Invalid client hash'; end if;
  perform pg_advisory_xact_lock(hashtext(p_ip_hash));
  delete from public.report_rate_limits where created_at < now() - interval '1 hour';
  select count(*) into v_count from public.report_rate_limits where ip_hash=p_ip_hash and created_at >= now()-interval '1 hour';
  if v_count >= 5 then return false; end if;
  insert into public.report_rate_limits(ip_hash) values(p_ip_hash);
  return true;
end $$;
revoke all on function public.claim_report_slot(text) from public, anon, authenticated;
grant execute on function public.claim_report_slot(text) to service_role;

-- Public report submission RPC (Gambar 4 & Gambar 5: rate limit -> coordinate & schema check -> insert report, AI analysis, and initial chat message).
create or replace function public.submit_report(
  p_photo_url text,
  p_latitude double precision,
  p_longitude double precision,
  p_description text,
  p_analysis jsonb,
  p_initial_advice text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip text := coalesce(split_part(v_headers->>'x-forwarded-for', ',', 1), v_headers->>'cf-connecting-ip', 'local-client');
  v_hash text := encode(extensions.digest(trim(v_ip), 'sha256'), 'hex');
  v_count integer;
  v_report public.reports%rowtype;
  v_code text := 'TT-' || extract(year from now())::int || '-' || upper(substr(encode(extensions.gen_random_bytes(5),'hex'),1,8));
  v_advice text;
begin
  -- Step 1: Check 5 reports/hour per IP rate limit first (NFR-04 & Gambar 4)
  perform pg_advisory_xact_lock(hashtext(v_hash));
  delete from public.report_rate_limits where created_at < now() - interval '1 hour';
  select count(*) into v_count from public.report_rate_limits where ip_hash=v_hash and created_at >= now()-interval '1 hour';
  if v_count >= 5 then raise exception 'Batas 5 laporan per jam tercapai. Silakan coba lagi nanti.'; end if;

  -- Step 2: Check Universitas Klabat campus coordinates (NFR-06)
  if p_latitude not between 1.4120 and 1.4235 or p_longitude not between 124.9790 and 124.9895 then
    raise exception 'Ditolak: Lokasi berada di luar area kampus Universitas Klabat.';
  end if;

  -- Step 3: Validate AI JSON schema (Tabel 2)
  if coalesce((p_analysis->>'is_waste')::boolean, false) is not true then
    raise exception 'Laporan ditolak: Foto tidak terdeteksi berisi sampah.';
  end if;
  if (p_analysis->>'category') not in ('organik','anorganik') or (p_analysis->>'severity') not in ('rendah','sedang','tinggi') then
    raise exception 'Skema keluaran AI tidak valid.';
  end if;

  insert into public.report_rate_limits(ip_hash) values(v_hash);

  -- Step 4: Save Report & AI_Analysis (Gambar 5 Step 8)
  insert into public.reports(report_code,photo_url,latitude,longitude,description,ip_hash)
  values(v_code,p_photo_url,p_latitude,p_longitude,left(coalesce(p_description, ''),1000),v_hash)
  returning * into v_report;

  insert into public.ai_analysis(report_id,is_waste,category,severity,confidence_score)
  values(
    v_report.id,
    true,
    (p_analysis->>'category')::public.waste_category,
    (p_analysis->>'severity')::public.waste_severity,
    least(1,greatest(0,coalesce((p_analysis->>'confidence_score')::numeric, 0.9)))
  );

  -- Step 5: Save initial Chatbot advice to Chat_Messages (Gambar 5 Step 11)
  v_advice := coalesce(
    nullif(trim(p_initial_advice), ''),
    case
      when (p_analysis->>'category') = 'organik' then
        'Hasil deteksi menunjukkan sampah ORGANIK dengan tingkat keparahan ' || (p_analysis->>'severity') || ' di lingkungan Universitas Klabat. Pisahkan dari plastik/kemasan agar dapat diolah menjadi kompos kampus, dan jangan dibakar.'
      else
        'Hasil deteksi menunjukkan sampah ANORGANIK dengan tingkat keparahan ' || (p_analysis->>'severity') || ' di lingkungan Universitas Klabat. Pilah botol plastik, kertas, atau kaleng ke tempat sampah daur ulang kampus.'
    end
  );
  insert into public.chat_messages(report_id, sender, message)
  values (v_report.id, 'ai', left(v_advice, 2000));

  return jsonb_build_object(
    'id', v_report.id,
    'report_code', v_report.report_code,
    'status', v_report.status,
    'created_at', v_report.created_at,
    'initial_advice', v_advice
  );
end $$;
grant execute on function public.submit_report(text,double precision,double precision,text,jsonb,text) to anon, authenticated, service_role;

-- Lookup single report by unique report_code including AI_Analysis and Chat_Messages history (FR-03 & FR-04).
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
    'updated_by', r.updated_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'analysis', jsonb_build_object(
      'is_waste', a.is_waste,
      'category', a.category,
      'severity', a.severity,
      'confidence_score', a.confidence_score,
      'is_validated', a.is_validated,
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

-- Save a chat message (user question or AI response) tied to a report_code (FR-04 & Gambar 5).
create or replace function public.append_chat_message(p_code text, p_sender public.chat_sender, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_report_id uuid;
  v_msg public.chat_messages%rowtype;
begin
  select id into v_report_id from public.reports where report_code = upper(trim(p_code)) limit 1;
  if v_report_id is null then raise exception 'Kode laporan tidak ditemukan'; end if;
  insert into public.chat_messages(report_id, sender, message)
  values (v_report_id, p_sender, left(trim(p_message), 2000))
  returning * into v_msg;
  return jsonb_build_object('id', v_msg.id, 'sender', v_msg.sender, 'message', v_msg.message, 'created_at', v_msg.created_at);
end $$;
grant execute on function public.append_chat_message(text, public.chat_sender, text) to anon, authenticated;

-- Public map markers for FR-05 (Pelapor & Admin can view map distribution without exposing ip_hash).
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
      'updated_by', r.updated_by,
      'created_at', r.created_at,
      'updated_at', r.updated_at,
      'analysis', jsonb_build_object(
        'is_waste', a.is_waste,
        'category', a.category,
        'severity', a.severity,
        'confidence_score', a.confidence_score,
        'is_validated', a.is_validated,
        'corrected_by', a.corrected_by
      )
    ) order by r.created_at desc
  ), '[]'::jsonb)
  from public.reports r
  left join public.ai_analysis a on a.report_id = r.id
$$;
grant execute on function public.get_public_reports() to anon, authenticated;

-- Storage bucket for report photos.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('report-photos','report-photos',false,5242880,array['image/jpeg','image/png'])
on conflict (id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png'];

drop policy if exists "Admins manage report photos" on storage.objects;
create policy "Admins manage report photos" on storage.objects for all to authenticated
using (bucket_id='report-photos' and public.is_admin()) with check (bucket_id='report-photos' and public.is_admin());

-- ============================================================================
-- SEED BASIS DATA AKUN ADMIN KELOMPOK (Sesuai Subbab 2.1, NFR-03 bcrypt, & Subbab 3.5)
-- Password default untuk seluruh akun admin kelompok: UnklabAdmin2026!
-- ============================================================================
do $$
declare
  v_admin record;
  v_uid uuid;
begin
  for v_admin in
    select * from (values
      ('admin@unklab.ac.id', 'Admin Kebersihan Unklab'),
      ('12410120@student.unklab.ac.id', 'Edwardo Emiliano Wagey Waturandang'),
      ('12410264@student.unklab.ac.id', 'Darell Jonathan Watak'),
      ('s22310379@student.unklab.ac.id', 'Dave Kevin Bertran Kalangi'),
      ('s22310411@student.unklab.ac.id', 'Julyanno S.F William Tumbal')
    ) as t(email, name)
  loop
    select id into v_uid from auth.users where email = v_admin.email limit 1;

    if v_uid is null then
      v_uid := extensions.gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000',
        v_uid,
        'authenticated',
        'authenticated',
        v_admin.email,
        extensions.crypt('UnklabAdmin2026!', extensions.gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('name', v_admin.name, 'email_verified', true),
        now(),
        now()
      );
    else
      update auth.users
      set encrypted_password = extensions.crypt('UnklabAdmin2026!', extensions.gen_salt('bf')),
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          updated_at = now()
      where id = v_uid;
    end if;

    insert into public.admins (id, name, email, password_hash)
    values (
      v_uid,
      v_admin.name,
      v_admin.email,
      extensions.crypt('UnklabAdmin2026!', extensions.gen_salt('bf'))
    )
    on conflict (email) do update
    set name = excluded.name,
        password_hash = excluded.password_hash;
  end loop;
end $$;

