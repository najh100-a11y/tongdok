// passage: 현대인의 성경(Korean Living Bible, Biblica) 본문 중계 함수
//
// 지키는 조건 (Biblica Fast-Track Bible License v1, YouVersion Platform Terms)
// - App Key는 서버(Edge Function secret YVP_APP_KEY)에만 둔다. 응답과 로그에 싣지 않는다.
// - 한 번에 한 장만 내려 준다. 역본은 86(KLB)으로 고정한다.
// - 본문을 디스크나 DB에 저장하지 않고, 응답을 캐시하지 않는다(요청 1회 = API 호출 1회).
// - 본문은 받은 그대로(소제목, 각주 포함) 전달하고 저작권 표시를 함께 보낸다.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BIBLE_ID = 86;
const API = "https://api.youversion.com/v1";
const PUBLISHER_URL = "https://www.biblica.com/";

const BOOKS = new Set([
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI",
  "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER",
  "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP",
  "HAG", "ZEC", "MAL", "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL",
  "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE",
  "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

// 앱의 공개 키(publishable 또는 기존 anon)를 확인한다.
// 출시 전에 교인 로그인(사용자 JWT) 확인으로 바꿀 자리다.
function callerAllowed(req: Request): boolean {
  const keys = new Set<string>();
  const named = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (named) {
    try {
      for (const v of Object.values(JSON.parse(named))) {
        if (typeof v === "string" && v) keys.add(v);
      }
    } catch (_) { /* 형식이 다르면 아래 단일 키만 본다 */ }
  }
  for (const name of ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]) {
    const v = Deno.env.get(name);
    if (v) keys.add(v);
  }
  if (keys.size === 0) return false;
  const apikey = req.headers.get("apikey") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return keys.has(apikey) || keys.has(bearer);
}

type Meta = { copyright: string; title: string; abbreviation: string; publisher: string; at: number };
let meta: Meta | null = null; // 역본 정보(저작권 표시)만 메모리에 잠시 둔다. 본문은 두지 않는다.
const META_TTL_MS = 6 * 60 * 60 * 1000;

async function upstream(path: string, key: string): Promise<Response> {
  return await fetch(`${API}${path}`, {
    headers: { "X-YVP-App-Key": key, "Accept": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
}

async function bibleMeta(key: string): Promise<Meta | null> {
  if (meta && Date.now() - meta.at < META_TTL_MS) return meta;
  const r = await upstream(`/bibles/${BIBLE_ID}`, key);
  if (!r.ok) return meta; // 실패하면 직전 값이라도 쓴다
  const b = await r.json();
  meta = {
    copyright: String(b.copyright || b.promotional_content || ""),
    title: String(b.localized_title || b.title || ""),
    abbreviation: String(b.localized_abbreviation || b.abbreviation || ""),
    publisher: String(b.publisher_name || "Biblica, Inc."),
    at: Date.now(),
  };
  return meta;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ code: "method_not_allowed" }, 405, { Allow: "GET, OPTIONS" });
  if (!callerAllowed(req)) return json({ code: "unauthorized" }, 401);

  const key = (Deno.env.get("YVP_APP_KEY") ?? "").trim();
  if (!key) return json({ code: "not_configured", message: "YVP_APP_KEY가 아직 설정되지 않았습니다." }, 503);

  const ref = (new URL(req.url).searchParams.get("ref") ?? "").toUpperCase();
  const m = /^([1-3]?[A-Z]{2,3})\.(\d{1,3})$/.exec(ref);
  if (!m || !BOOKS.has(m[1]) || Number(m[2]) < 1) {
    return json({ code: "bad_ref", message: "ref는 MRK.1처럼 책 약어와 장 번호 하나여야 합니다." }, 400);
  }
  const passageId = `${m[1]}.${Number(m[2])}`;

  try {
    const [p, info] = await Promise.all([
      upstream(`/bibles/${BIBLE_ID}/passages/${passageId}?format=html&include_headings=true&include_notes=true`, key),
      bibleMeta(key),
    ]);

    if (p.status === 404) return json({ code: "not_found", ref: passageId }, 404);
    if (p.status === 429) {
      const retry = p.headers.get("Retry-After");
      return json({ code: "rate_limited" }, 429, retry ? { "Retry-After": retry } : {});
    }
    if (p.status === 401 || p.status === 403) {
      // 키 값은 남기지 않고 길이만 남긴다(붙여넣기 실수 진단용).
      const raw = Deno.env.get("YVP_APP_KEY") ?? "";
      console.error(`upstream auth ${p.status} for ${passageId}; key length ${raw.length}, trimmed ${key.length}`);
      return json({ code: "upstream_auth", upstream: p.status }, 502);
    }
    if (!p.ok) {
      console.error(`upstream ${p.status} for ${passageId}`);
      return json({ code: "upstream_error" }, 502);
    }

    const body = await p.json();
    return json({
      ref: body.id ?? passageId,
      reference: body.reference ?? "",
      html: body.content ?? "",
      bible: {
        id: BIBLE_ID,
        abbreviation: info?.abbreviation ?? "KLB",
        title: info?.title ?? "현대인의 성경",
      },
      copyright: info?.copyright ?? "",
      publisher: { name: info?.publisher ?? "Biblica, Inc.", url: PUBLISHER_URL },
    });
  } catch (e) {
    console.error(`upstream failure for ${passageId}: ${e instanceof Error ? e.name : "error"}`);
    return json({ code: "upstream_unreachable" }, 502);
  }
});
