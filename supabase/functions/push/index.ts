// push: 새 질문 알림(웹 푸시, 무료 표준 방식)
//
// - GET              : 관리자 화면이 구독할 때 쓰는 공개 서버 키(applicationServerKey)를 돌려준다.
// - POST {post_id}   : 질문이 올라오면 DB 트리거(pg_net)가 부른다. 글 번호만 받고, 갓 올라온 질문인지와
//                      이미 보냈는지는 DB 함수(push_question_targets)가 다시 확인한다.
// - POST {test:true} : 로그인한 관리자가 자기 기기로 시험 알림을 보낸다(Authorization 헤더 필요).
//
// 서버 키(VAPID)는 처음 쓸 때 이 함수가 만들어 private 스키마에 한 번만 저장한다.
// 구독 주소와 키는 로그에 남기지 않는다.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const SITE = "https://najh100-a11y.github.io/tongdok/";
const ALG = { name: "ECDSA", namedCurve: "P-256" };

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return all.default ?? Object.values(all)[0] ?? "";
  } catch {
    return "";
  }
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Server = { app: webpush.ApplicationServer; publicKey: string };
let serverP: Promise<Server> | null = null;

async function loadServer(): Promise<Server> {
  const got = await db.rpc("push_keys_get");
  if (got.error) throw new Error("keys_get");
  let keys = got.data;
  if (!keys) {
    const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const init = await db.rpc("push_keys_init", { p_keys: { publicKey: pub, privateKey: priv } });
    if (init.error || !init.data) throw new Error("keys_init");
    keys = init.data;
  }
  const publicKey = await crypto.subtle.importKey("jwk", keys.publicKey, ALG, true, ["verify"]);
  const privateKey = await crypto.subtle.importKey("jwk", keys.privateKey, ALG, true, ["sign"]);
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  const app = await webpush.ApplicationServer.new({ contactInformation: SITE, vapidKeys: { publicKey, privateKey } });
  return { app, publicKey: b64url(raw) };
}

function server(): Promise<Server> {
  if (!serverP) serverP = loadServer().catch((e) => { serverP = null; throw e; });
  return serverP;
}

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type Payload = { title: string; body: string; url: string; tag: string };

async function send(subs: Sub[], payload: Payload) {
  const { app } = await server();
  let sent = 0, gone = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await app.subscribe(s).pushTextMessage(JSON.stringify(payload), { ttl: 86400 });
      sent++;
    } catch (e) {
      if (e instanceof webpush.PushMessageError && e.isGone()) {
        gone++;
        await db.rpc("push_drop_sub", { p_endpoint: s.endpoint });
      } else {
        failed++;
        console.error("push failed:", e instanceof webpush.PushMessageError ? e.response.status : String(e).slice(0, 160));
      }
    }
  }));
  return { sent, gone, failed };
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === "GET") {
      const { publicKey } = await server();
      return json({ publicKey });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const input = await req.json().catch(() => ({}));

    if (input && input.test === true) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const u = token ? await db.auth.getUser(token) : null;
      const uid = u && !u.error ? u.data.user?.id : null;
      if (!uid) return json({ ok: false, error: "auth" }, 401);
      const r = await db.rpc("push_subs_of_admin", { p_user: uid });
      if (r.error) return json({ ok: false, error: "db" }, 500);
      const subs = (r.data ?? []) as Sub[];
      if (!subs.length) return json({ ok: false, error: "no_subs" });
      const res = await send(subs, {
        title: "알림 시험",
        body: "이 기기로 새 질문 알림이 옵니다.",
        url: "./",
        tag: "tongdok-test",
      });
      return json({ ok: res.sent > 0, ...res });
    }

    const postId = Number(input?.post_id);
    if (!Number.isInteger(postId) || postId <= 0) return json({ ok: false, error: "input" }, 400);
    const r = await db.rpc("push_question_targets", { p_post: postId });
    if (r.error) return json({ ok: false, error: "db" }, 500);
    if (!r.data) return json({ ok: true, skipped: true });
    const { post, subs } = r.data as { post: { id: number; day: string; body: string; name: string }; subs: Sub[] };
    if (!subs.length) return json({ ok: true, sent: 0 });
    const text = post.body.replace(/\s+/g, " ").trim();
    const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
    const res = await send(subs, {
      title: "새 질문",
      body: `${dayLabel(post.day)} 본문 · ${post.name}: ${short}`,
      url: `./?q=${post.id}#d-${post.day.slice(5, 7)}${post.day.slice(8, 10)}`,
      tag: `q-${post.id}`,
    });
    return json({ ok: true, ...res });
  } catch (e) {
    console.error("push error:", String(e).slice(0, 200));
    return json({ ok: false, error: "server" }, 500);
  }
});
