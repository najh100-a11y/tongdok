// 진실한숲 통독 서비스 워커
// 이 사이트(같은 출처)의 화면 파일만 저장해 둔다: 화면, 글꼴, 아이콘, 가이드 자료.
// 성경 본문(Supabase 함수)과 로그인, 나눔 요청은 다른 출처라 손대지 않고 그대로 통과시킨다.
// 그래서 현대인의 성경 본문은 기기에 저장되지 않는다.

const CACHE = 'tongdok-shell-v3';
const SHELL = [
  './',
  'manifest.webmanifest',
  'vendor/supabase-2.119.2.js',
  'fonts/RIDIBatang.woff2',
  'fonts/Pretendard-Regular.subset.woff2',
  'fonts/Pretendard-Medium.subset.woff2',
  'fonts/Pretendard-SemiBold.subset.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 화면(index.html)과 가이드 자료(.json)는 늘 새로 받아 보고, 연결이 없을 때만 저장본을 쓴다.
function networkFirst(request, key) {
  return fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key || request, copy));
    }
    return res;
  }).catch(() => caches.match(key || request, { ignoreSearch: true }));
}

// 글꼴, 아이콘, 라이브러리는 바뀌지 않으므로 저장본을 먼저 쓴다.
function cacheFirst(request) {
  return caches.match(request).then((hit) => hit || fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 본문, 로그인, 나눔 요청은 건드리지 않는다
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, './'));
    return;
  }
  if (url.pathname.endsWith('.json') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

// 새 질문 알림(웹 푸시). push 함수가 보낸 제목, 내용, 열 주소를 그대로 보여 준다.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || '진실한숲 통독', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' }
  }));
});

// 알림을 누르면: 열려 있는 앱이 있으면 그 화면에서 질문을 열고, 없으면 새로 연다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => c.url.startsWith(self.registration.scope));
      if (win) {
        win.postMessage({ type: 'open', url });
        return win.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
