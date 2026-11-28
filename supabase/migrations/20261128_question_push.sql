-- 진실한숲 통독: 새 질문 알림(웹 푸시)
-- 교인이 질문을 남기면 관리자 기기로 알림을 보낸다. 비용이 들지 않는 표준 웹 푸시를 쓴다.
-- 구독 정보와 서버 키는 API로 노출되지 않는 private 스키마에 두고,
-- 관리자 화면과 알림 함수(push)는 아래 함수들로만 다룬다.

create extension if not exists pg_net with schema extensions;

-- 관리자 기기의 푸시 구독
create table private.push_subs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- 서버 키(VAPID). push 함수가 처음 쓸 때 만들어 한 번만 저장한다.
create table private.push_keys (
  id int primary key default 1 check (id = 1),
  keys jsonb not null,
  created_at timestamptz not null default now()
);

-- 같은 질문으로 알림이 두 번 가지 않게 남기는 기록
create table private.push_log (
  post_id bigint primary key,
  sent_at timestamptz not null default now()
);

-- 관리자 화면: 이 기기를 알림 받을 기기로 등록
create or replace function public.admin_save_push(p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 40 and 200 or coalesce(length(p_auth), 0) not between 10 and 100 then
    return jsonb_build_object('ok', false, 'error', 'bad_sub');
  end if;
  insert into private.push_subs (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
  return jsonb_build_object('ok', true);
end;
$$;

-- 관리자 화면: 이 기기의 알림 끄기
create or replace function public.delete_my_push(p_endpoint text)
returns jsonb language sql volatile security definer set search_path = ''
as $$
  with d as (delete from private.push_subs where endpoint = p_endpoint and user_id = auth.uid() returning 1)
  select jsonb_build_object('ok', true, 'deleted', (select count(*) from d));
$$;

-- 관리자 화면: 이 기기가 등록돼 있는지
create or replace function public.my_push_on(p_endpoint text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.push_subs where endpoint = p_endpoint and user_id = auth.uid());
$$;

-- push 함수 전용(service_role): 서버 키 읽기와 처음 한 번 저장
create or replace function public.push_keys_get()
returns jsonb language sql stable security definer set search_path = ''
as $$ select keys from private.push_keys where id = 1; $$;

create or replace function public.push_keys_init(p_keys jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  insert into private.push_keys (id, keys) values (1, p_keys) on conflict (id) do nothing;
  return (select keys from private.push_keys where id = 1);
end;
$$;

-- push 함수 전용(service_role): 갓 올라온 질문이면 한 번만 보낼 대상과 내용을 돌려준다.
-- 10분이 지났거나 이미 보낸 질문, 질문이 아닌 글이면 null.
create or replace function public.push_question_targets(p_post bigint)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare p record; n int;
begin
  select po.id, po.day, po.body, po.user_id, coalesce(m.name, '교인') as name into p
  from public.posts po left join public.members m on m.user_id = po.user_id
  where po.id = p_post and po.kind = 'question' and po.created_at > now() - interval '10 minutes';
  if not found then return null; end if;
  insert into private.push_log (post_id) values (p.id) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return null; end if;
  return jsonb_build_object(
    'post', jsonb_build_object('id', p.id, 'day', p.day, 'body', p.body, 'name', p.name),
    'subs', coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
      from private.push_subs s join public.members a on a.user_id = s.user_id
      where a.role = 'admin' and a.status = 'active' and s.user_id <> p.user_id), '[]'::jsonb));
end;
$$;

-- push 함수 전용(service_role): 시험 알림을 받을 한 사람의 기기들(관리자만)
create or replace function public.push_subs_of_admin(p_user uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth))), '[]'::jsonb)
  from private.push_subs s join public.members a on a.user_id = s.user_id
  where s.user_id = p_user and a.role = 'admin' and a.status = 'active';
$$;

-- push 함수 전용(service_role): 사라진 구독 지우기
create or replace function public.push_drop_sub(p_endpoint text)
returns void language sql volatile security definer set search_path = ''
as $$ delete from private.push_subs where endpoint = p_endpoint; $$;

-- 질문이 올라오면 push 함수를 부른다(pg_net, 비동기). 함수는 글 번호만 받고 나머지는 DB에서 다시 확인한다.
create or replace function private.on_question_insert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.kind = 'question' then
    perform net.http_post(
      url := 'https://khxwbstnhiimwcdchtjy.supabase.co/functions/v1/push',
      body := jsonb_build_object('post_id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 10000);
  end if;
  return new;
end;
$$;

create trigger posts_question_push after insert on public.posts
for each row execute function private.on_question_insert();

revoke execute on function public.admin_save_push(text, text, text), public.delete_my_push(text), public.my_push_on(text),
  public.push_keys_get(), public.push_keys_init(jsonb), public.push_question_targets(bigint),
  public.push_subs_of_admin(uuid), public.push_drop_sub(text) from public, anon, authenticated;
grant execute on function public.admin_save_push(text, text, text), public.delete_my_push(text), public.my_push_on(text)
  to authenticated;
grant execute on function public.push_keys_get(), public.push_keys_init(jsonb), public.push_question_targets(bigint),
  public.push_subs_of_admin(uuid), public.push_drop_sub(text) to service_role;
