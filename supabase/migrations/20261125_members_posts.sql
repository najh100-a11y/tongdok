-- 진실한숲 통독: 교인 등록, 나눔과 질문, 읽음 기록
-- 로그인은 카카오(Supabase Auth). 교인 등록은 처음 한 번 교회 코드와 이름으로 한다.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 교회 코드(해시만 저장)와 등록 시도 기록. API로 노출되지 않는 스키마.
create table private.settings (
  id int primary key default 1 check (id = 1),
  join_code_hash text not null,
  updated_at timestamptz not null default now()
);

create table private.join_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index join_attempts_user_at on private.join_attempts (user_id, at);

-- 교인
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 20),
  role text not null default 'member' check (role in ('member', 'admin')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  joined_at timestamptz not null default now()
);

-- 한 줄 나눔(share)과 질문(question)
create table public.posts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('share', 'question')),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index posts_day_created on public.posts (day, created_at);
create index posts_user on public.posts (user_id);

-- 나눔과 질문에 다는 답글
create table public.replies (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index replies_post on public.replies (post_id);
create index replies_user on public.replies (user_id);

-- 읽음 기록. 다른 사람의 기록은 보지 못하고 날마다 몇 명이 읽었는지만 본다.
create table public.reads (
  user_id uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- 도우미 함수
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members m where m.user_id = auth.uid() and m.status = 'active');
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members m where m.user_id = auth.uid() and m.status = 'active' and m.role = 'admin');
$$;

-- 지금 로그인한 사람의 교인 상태
create or replace function public.me()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('member', m.status = 'active', 'status', m.status, 'name', m.name, 'role', m.role)
       from public.members m where m.user_id = auth.uid()),
    jsonb_build_object('member', false, 'status', null, 'name', null, 'role', null));
$$;

-- 처음 한 번: 교회 코드와 이름으로 교인 등록 (이미 교인이면 이름만 바꾼다)
create or replace function public.join_church(p_code text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  nm text := btrim(coalesce(p_name, ''));
  cur public.members%rowtype;
  h text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_signed_in'); end if;
  if char_length(nm) < 1 or char_length(nm) > 20 then return jsonb_build_object('ok', false, 'error', 'bad_name'); end if;
  select * into cur from public.members where user_id = uid;
  if found and cur.status = 'blocked' then return jsonb_build_object('ok', false, 'error', 'blocked'); end if;
  if found then
    update public.members set name = nm where user_id = uid;
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from private.join_attempts a where a.user_id = uid and a.at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  select s.join_code_hash into h from private.settings s where s.id = 1;
  if h is null or h <> extensions.crypt(lower(btrim(coalesce(p_code, ''))), h) then
    insert into private.join_attempts (user_id) values (uid);
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;
  insert into public.members (user_id, name) values (uid, nm);
  return jsonb_build_object('ok', true);
end;
$$;

-- 내 이름 바꾸기
create or replace function public.set_my_name(p_name text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare nm text := btrim(coalesce(p_name, ''));
begin
  if not public.is_member() then return jsonb_build_object('ok', false, 'error', 'not_member'); end if;
  if char_length(nm) < 1 or char_length(nm) > 20 then return jsonb_build_object('ok', false, 'error', 'bad_name'); end if;
  update public.members set name = nm where user_id = auth.uid();
  return jsonb_build_object('ok', true);
end;
$$;

-- 탈퇴: 내 교인 정보, 글, 답글, 읽음 기록, 로그인 계정까지 지운다
create or replace function public.leave_church()
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_signed_in'); end if;
  delete from private.join_attempts where user_id = uid;
  delete from auth.users where id = uid;  -- members, posts, replies, reads는 연쇄 삭제
  return jsonb_build_object('ok', true);
end;
$$;

-- 날마다 읽은 사람 수
create or replace function public.read_count(p_day date)
returns integer language sql stable security definer set search_path = ''
as $$
  select case when public.is_member()
    then (select count(*)::int from public.reads r join public.members m on m.user_id = r.user_id
          where r.day = p_day and m.status = 'active')
    else null end;
$$;

-- 관리자: 교회 코드 바꾸기
create or replace function public.admin_set_join_code(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare c text := lower(btrim(coalesce(p_code, '')));
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if char_length(c) < 4 or char_length(c) > 30 then return jsonb_build_object('ok', false, 'error', 'bad_code'); end if;
  insert into private.settings (id, join_code_hash) values (1, extensions.crypt(c, extensions.gen_salt('bf')))
  on conflict (id) do update set join_code_hash = excluded.join_code_hash, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- 관리자: 교인 상태(active/blocked)와 역할(member/admin) 바꾸기
create or replace function public.admin_update_member(p_user uuid, p_status text default null, p_role text default null)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_user = auth.uid() then return jsonb_build_object('ok', false, 'error', 'self'); end if;
  if p_status is not null and p_status not in ('active', 'blocked') then return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
  if p_role is not null and p_role not in ('member', 'admin') then return jsonb_build_object('ok', false, 'error', 'bad_role'); end if;
  update public.members
     set status = coalesce(p_status, status), role = coalesce(p_role, role)
   where user_id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 권한: 익명(anon)은 아무것도 못 한다. 로그인한 사람도 정해진 일만 한다.
revoke all on public.members, public.posts, public.replies, public.reads from anon, authenticated;
grant select on public.members to authenticated;
grant select, insert, delete on public.posts to authenticated;
grant update (body, edited_at) on public.posts to authenticated;
grant select, insert, delete on public.replies to authenticated;
grant select, insert, delete on public.reads to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_member(), public.is_admin(), public.me(), public.join_church(text, text),
  public.set_my_name(text), public.leave_church(), public.read_count(date),
  public.admin_set_join_code(text), public.admin_update_member(uuid, text, text) to authenticated;

alter table public.members enable row level security;
alter table public.posts enable row level security;
alter table public.replies enable row level security;
alter table public.reads enable row level security;

create policy members_select on public.members for select to authenticated
  using ((select public.is_member()) and (status = 'active' or (select public.is_admin()) or user_id = (select auth.uid())));

create policy posts_select on public.posts for select to authenticated using ((select public.is_member()));
create policy posts_insert on public.posts for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));
create policy posts_update on public.posts for update to authenticated
  using ((select public.is_member()) and user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy posts_delete on public.posts for delete to authenticated
  using ((select public.is_member()) and (user_id = (select auth.uid()) or (select public.is_admin())));

create policy replies_select on public.replies for select to authenticated using ((select public.is_member()));
create policy replies_insert on public.replies for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));
create policy replies_delete on public.replies for delete to authenticated
  using ((select public.is_member()) and (user_id = (select auth.uid()) or (select public.is_admin())));

create policy reads_select on public.reads for select to authenticated
  using ((select public.is_member()) and user_id = (select auth.uid()));
create policy reads_insert on public.reads for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));
create policy reads_delete on public.reads for delete to authenticated
  using ((select public.is_member()) and user_id = (select auth.uid()));
