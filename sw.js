/* Maestro #leads art — offline worker. Keeps the app, its libraries and attached files on the device. */
const VER = "maestro-20261117064904";
const SHELL = ["./", "index.html", "standalone.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
const LIBS = "maestro-libs", BLOBS = "maestro-blobs";
self.addEventListener("install", ev => { ev.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", ev => { ev.waitUntil((async () => { for (const k of await caches.keys()) if (/^maestro-\d/.test(k) && k !== VER) await caches.delete(k); await self.clients.claim(); })()); });
const isLib = u => /(^|\.)cdnjs\.cloudflare\.com$|^fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
/* the access token and the Drive file list are written by the page into IndexedDB */
function idbGet(store, key) { return new Promise(res => { const r = indexedDB.open("maestro-standalone", 1); r.onupgradeneeded = () => { const d = r.result; ["kv", "cache", "blobq"].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); }); };
  r.onerror = () => res(undefined); r.onsuccess = () => { try { const t = r.result.transaction(store, "readonly").objectStore(store).get(key); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); } catch (e) { res(undefined); } }; }); }
async function blobFromDrive(id, req) {
  const tok = await idbGet("kv", "tok"); const files = await idbGet("kv", "files"); if (!tok || !(tok.exp > Date.now()) || !files) return null;
  const f = files.find(x => x[0] === "_blob_" + id); if (!f) return null;
  try { const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f[1]}?alt=media`, { headers: { Authorization: "Bearer " + tok.t } }); if (!r.ok) return null;
    const c = await caches.open(BLOBS); await c.put(req, r.clone()); return r; } catch (e) { return null; } }
self.addEventListener("fetch", ev => {
  const req = ev.request; if (req.method !== "GET") return; const u = new URL(req.url);
  if (u.origin === location.origin && /\/_blob\/[0-9a-f]{32}$/.test(u.pathname)) {
    const id = u.pathname.split("/_blob/")[1];
    ev.respondWith((async () => { const c = await caches.open(BLOBS); const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; const r = await blobFromDrive(id, req); return r || new Response("not found", { status: 404 }); })());
    return; }
  if (isLib(u)) { ev.respondWith((async () => { const c = await caches.open(LIBS); const hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; })()); return; }
  if (u.origin === location.origin) {
    /* app files: answer from the device at once, and fetch the newer copy in the background (it is used from the next start) */
    ev.respondWith((async () => { const c = await caches.open(VER); const key = req.mode === "navigate" ? "index.html" : req;
      const hit = await c.match(key, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => null);
      if (hit) { ev.waitUntil(net); return hit; } const r = await net; return r || new Response(req.mode === "navigate" ? "<h1>Offline</h1>" : "", { status: 503, headers: { "Content-Type": "text/html" } }); })());
  }
});
self.addEventListener("message", ev => { if (ev.data === "skip") self.skipWaiting(); });
