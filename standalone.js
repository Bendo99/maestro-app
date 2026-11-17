/* Maestro #leads art — standalone runtime (installed app on Windows / Android).
   Outside claude.ai there is no window.claude, so this file supplies the same small API the app already uses:
     db        → documents saved as JSON files in one Google Drive folder of the signed-in user (scope drive.file)
     user      → the signed-in Google account (owner of its own data)
     assets    → files kept on the device (Cache Storage) and copied to the same Drive folder
     downloads → a normal browser download
     permissions → always granted (it is the user's own app)
   Everything else (sample, mcp, comments, room, files) is absent (null), and the app already hides those features.
   The app keeps working with no network: edits stay on the device and the app's own merge sync uploads them when
   Google is reachable again. */
(function () {
  "use strict";
  if (window.claude && typeof window.claude.use === "function") return;   // inside claude.ai: nothing to do
  const LS = {
    get(k, d) { let v = null; try { v = localStorage.getItem(k); } catch (e) { return d; } if (v == null) return d; try { return JSON.parse(v); } catch (e) { return v; } },
    set(k, v) { try { if (v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const CFG = Object.assign({ clientId: "", folder: "Maestro #leads art — data" }, window.MAESTRO_CFG || {});
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3";
  const ar = () => { try { return (localStorage.getItem("es_lang") || "ar") !== "en"; } catch (e) { return true; } };
  const T = (a, e) => ar() ? a : e;

  /* ---------------- tiny IndexedDB key/value store (Drive cache + blob upload queue) */
  const IDB = (() => { let p = null;
    const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open("maestro-standalone", 1);
      r.onupgradeneeded = () => { const d = r.result; ["kv", "cache", "blobq"].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = (st, mode, fn) => open().then(d => new Promise((res, rej) => { const t = d.transaction(st, mode); const s = t.objectStore(st); const q = fn(s); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
    return { get: (st, k) => tx(st, "readonly", s => s.get(k)), put: (st, k, v) => tx(st, "readwrite", s => s.put(v, k)), del: (st, k) => tx(st, "readwrite", s => s.delete(k)),
      keys: st => tx(st, "readonly", s => s.getAllKeys()), all: st => tx(st, "readonly", s => s.getAll()) }; })();

  /* ---------------- Google sign-in (Google Identity Services token model) */
  const G = { token: LS.get("gd_tok", null), email: LS.get("gd_email", ""), uid: LS.get("gd_uid", ""), folderId: LS.get("gd_folder", ""), state: "", err: "", waiters: [], client: null, gisP: null, lastSync: LS.get("gd_last", "") };
  G.clientId = () => String(LS.get("gd_cid", "") || CFG.clientId || "").trim();
  G.valid = () => !!(G.token && G.token.exp > Date.now() + 60000);
  G.loadGis = () => G.gisP || (G.gisP = new Promise((res, rej) => { if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = () => res(); s.onerror = () => { G.gisP = null; rej(new Error("gis")); }; document.head.appendChild(s); }));
  G.request = (prompt) => new Promise(async (res, rej) => {
    if (!G.clientId()) return rej(new Error(T("لسه مفيش Client ID", "No Client ID yet")));
    try { await G.loadGis(); } catch (e) { return rej(new Error(T("مفيش نت — هتتربط لما النت يرجع", "Offline — will connect when back online"))); }
    const c = google.accounts.oauth2.initTokenClient({ client_id: G.clientId(), scope: SCOPE, prompt: prompt == null ? "" : prompt, hint: G.email || undefined,
      callback: r => { if (r && r.access_token) { G.token = { t: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 }; LS.set("gd_tok", G.token); IDB.put("kv", "tok", G.token).catch(() => {}); res(G.token); } else rej(new Error((r && r.error) || "auth")); },
      error_callback: e => rej(new Error((e && (e.message || e.type)) || "auth")) });
    c.requestAccessToken(); });
  G.ensure = async (interactive) => { if (G.valid()) return G.token.t; if (!interactive) throw { code: "auth", message: T("محتاج تدوس «اربط جوجل»", "Tap “Connect Google”") }; await G.request(G.email ? "" : "consent"); return G.token.t; };
  async function api(method, url, body, headers, raw) {
    const tok = await G.ensure(false); const h = Object.assign({ Authorization: "Bearer " + tok }, headers || {});
    let r; try { r = await fetch(url, { method, headers: h, body, cache: "no-store" }); } catch (e) { throw { code: "offline", message: T("مفيش نت", "Offline") }; }
    if (r.status === 401) { G.token = null; LS.set("gd_tok", undefined); ui(); throw { code: "auth", message: T("الربط بجوجل خلص — دوس في أي حتة يتجدد", "Google session ended — tap anywhere to renew") }; }
    if (!r.ok) { let m = r.status + ""; try { const j = await r.json(); m = (j.error && j.error.message) || m; } catch (e) {} throw { code: "drive_" + r.status, message: m }; }
    if (raw) return r; const ct = r.headers.get("content-type") || ""; return ct.includes("json") ? r.json() : r.text(); }
  const q = s => encodeURIComponent(s);
  async function folder() {
    if (G.folderId) return G.folderId;
    const L = await api("GET", `${API}/files?q=${q(`name='${CFG.folder.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)&spaces=drive`);
    let id = L.files && L.files[0] && L.files[0].id;
    if (!id) { const f = await api("POST", `${API}/files?fields=id`, JSON.stringify({ name: CFG.folder, mimeType: "application/vnd.google-apps.folder", description: "Maestro #leads art — your data. Don't rename or move the files inside." }), { "Content-Type": "application/json" }); id = f.id; }
    G.folderId = id; LS.set("gd_folder", id); return id; }
  async function listAll() { const F = await folder(); const out = []; let pt = "";
    do { const L = await api("GET", `${API}/files?q=${q(`'${F}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,version,size,mimeType,createdTime)&pageSize=1000${pt ? "&pageToken=" + q(pt) : ""}`); (L.files || []).forEach(f => out.push(f)); pt = L.nextPageToken || ""; } while (pt);
    IDB.put("kv", "files", out.map(f => [f.name, f.id])).catch(() => {}); return out; }
  async function upload(name, blob, fileId) {
    const F = await folder(); const meta = fileId ? {} : { name, parents: [F] };
    const bd = "mst" + Math.random().toString(36).slice(2); const body = new Blob([`--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bd}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${bd}--`]);
    return api(fileId ? "PATCH" : "POST", `${UP}/files${fileId ? "/" + fileId : ""}?uploadType=multipart&fields=id,name,version,size`, body, { "Content-Type": "multipart/related; boundary=" + bd }); }
  const trash = id => api("PATCH", `${API}/files/${id}?fields=id`, JSON.stringify({ trashed: true }), { "Content-Type": "application/json" });

  /* ---------------- db: the same calls the app makes (collection(path).get(), doc(path).get/set/delete) */
  const DOC_RX = /\.json$/;
  let FILES = null;                                  // name → {id, version}, refreshed by every collection read
  const relOf = path => { const p = String(path).replace(/^\/+|\/+$/g, ""); const m = /^data\/users\/[^/]+\/?(.*)$/.exec(p); return m ? m[1] : p; };
  const nameOf = rel => encodeURIComponent(rel) + ".json";
  const relFromName = n => { try { return decodeURIComponent(n.replace(DOC_RX, "")); } catch (e) { return null; } };
  async function refresh() { const L = await listAll(); FILES = new Map(); L.forEach(f => { if (DOC_RX.test(f.name)) FILES.set(f.name, { id: f.id, version: f.version }); }); return FILES; }
  async function readFile(name, meta) { const c = await IDB.get("cache", name).catch(() => null); if (c && c.version === meta.version && c.data !== undefined) return c.data;
    const r = await api("GET", `${API}/files/${meta.id}?alt=media`, undefined, undefined, true); const txt = await r.text(); let v; try { v = JSON.parse(txt); } catch (e) { v = null; }
    IDB.put("cache", name, { version: meta.version, data: v }).catch(() => {}); return v; }
  const snapDoc = (id, v) => ({ id, exists: v != null, data: () => v == null ? undefined : JSON.parse(JSON.stringify(v)) });
  function docRef(path) { const rel = relOf(path), name = nameOf(rel), id = rel.split("/").pop();
    return {
      id, path,
      async get() { const M = FILES || await refresh(); let meta = M.get(name); if (!meta) { await refresh(); meta = FILES.get(name); } if (!meta) return snapDoc(id, null); return snapDoc(id, await readFile(name, meta)); },
      async set(obj) { const M = FILES || await refresh(); const meta = M.get(name); const txt = JSON.stringify(obj);
        const r = await upload(name, new Blob([txt], { type: "application/json" }), meta && meta.id); FILES.set(name, { id: r.id, version: r.version }); IDB.put("cache", name, { version: r.version, data: obj }).catch(() => {}); stamp(); return { ok: true }; },
      async update(patch) { const s = await this.get(); const cur = s.exists ? s.data() : {}; return this.set(Object.assign(cur, patch)); },
      async delete() { const M = FILES || await refresh(); const meta = M.get(name); if (meta) { await trash(meta.id); FILES.delete(name); IDB.del("cache", name).catch(() => {}); } stamp(); return { ok: true }; },
      collection(sub) { return colRef(path + "/" + sub); },
      /* a short lease so two devices never read-merge-write at the same moment (Drive itself is last-writer-wins) */
      async acquire(o) { const me = String((o && o.holder) || "x"), ttl = Math.max(500, Number(o && o.ttlMs) || 6000);
        const read = async () => { await refresh(); const meta = FILES.get(name); if (!meta) return null; const r = await api("GET", `${API}/files/${meta.id}?alt=media`, undefined, undefined, true); try { return JSON.parse(await r.text()); } catch (e) { return null; } };
        const cur = await read(); if (cur && cur.holder !== me && Number(cur.until) > Date.now()) return { acquired: false };
        await this.set({ holder: me, until: Date.now() + ttl });
        await new Promise(r => setTimeout(r, 400)); const chk = await read(); return { acquired: !!(chk && chk.holder === me) }; }
    }; }
  function colRef(path) { const rel = relOf(path);
    return {
      path,
      doc(id) { return docRef(path + "/" + id); },
      async get() { const M = await refresh(); const docs = [];
        for (const [name, meta] of M) { const r = relFromName(name); if (r == null) continue; const pre = rel ? rel + "/" : ""; if (pre && !r.startsWith(pre)) continue; const id = r.slice(pre.length); if (!id || id.includes("/")) continue;
          docs.push(snapDoc(id, await readFile(name, meta))); }
        stamp(); return { docs, size: docs.length, empty: !docs.length }; }
    }; }
  function stamp() { G.lastSync = new Date().toISOString(); LS.set("gd_last", G.lastSync); ui(); }
  const DB = { collection: colRef, doc: docRef };

  const SYf = () => (window.__ES && window.__ES.SY) || null;
  /* ---------------- connect: db/user resolve once Google is reachable */
  let dbReady = null, dbResolve = null; const dbP = new Promise(r => { dbResolve = r; });
  async function connect(interactive) {
    if (!G.clientId()) { G.state = "noid"; ui(); return false; }
    if (!navigator.onLine && !G.valid()) { G.state = "offline"; ui(); return false; }
    try { G.state = "busy"; ui(); await G.ensure(interactive);
      if (!G.uid) { const a = await api("GET", `${API}/about?fields=user(permissionId,emailAddress,displayName)`); G.uid = "g" + a.user.permissionId; G.email = a.user.emailAddress || ""; LS.set("gd_uid", G.uid); LS.set("gd_email", G.email); }
      await folder(); G.state = "on"; G.err = ""; ui(); if (!dbReady) { dbReady = DB; dbResolve(DB); } else { const Y = SYf(); if (Y) Y.sync(); } flushBlobs(); return true;
    } catch (e) { G.state = navigator.onLine ? "off" : "offline"; G.err = (e && e.message) || String(e); ui(); return false; } }

  /* ---------------- assets: kept on the device at once, copied to Drive in the background */
  const BLOB_CACHE = "maestro-blobs";
  const blobUrl = id => new URL("_blob/" + id, document.baseURI).href;
  const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
  async function putLocalBlob(id, blob, type) { const c = await caches.open(BLOB_CACHE); await c.put(blobUrl(id), new Response(blob, { headers: { "Content-Type": type || blob.type || "application/octet-stream", "Content-Length": String(blob.size) } })); }
  async function flushBlobs() { if (!G.valid() || !navigator.onLine) return; let ks = []; try { ks = await IDB.keys("blobq"); } catch (e) { return; }
    for (const id of ks) { try { const it = await IDB.get("blobq", id); if (!it) continue;
      if (it.del) { const M = FILES || await refresh(); const L = await listAll(); const f = L.find(x => x.name === "_blob_" + id); if (f) await trash(f.id); }
      else { const c = await caches.open(BLOB_CACHE); const r = await c.match(blobUrl(id)); if (r) { const b = await r.blob(); await upload("_blob_" + id, new Blob([b], { type: it.type || b.type })); } }
      await IDB.del("blobq", id); } catch (e) { if (e && e.code === "auth") return; } } }
  const ASSETS = {
    async upload(blob, opts) { const type = (opts && opts.type) || blob.type || "application/octet-stream"; const id = hex(); await putLocalBlob(id, blob, type); await IDB.put("blobq", id, { type, at: Date.now() }); flushBlobs(); return { id, url: "_blob/" + id, sizeBytes: blob.size, contentType: type }; },
    async list() { const out = []; try { const c = await caches.open(BLOB_CACHE); for (const r of await c.keys()) { const id = r.url.split("/_blob/")[1]; if (id) out.push({ id, url: "_blob/" + id, contentType: "", sizeBytes: 0, createdAt: "" }); } } catch (e) {}
      try { if (G.valid()) (await listAll()).filter(f => /^_blob_/.test(f.name)).forEach(f => { const id = f.name.slice(6); if (!out.some(a => a.id === id)) out.push({ id, url: "_blob/" + id, contentType: f.mimeType, sizeBytes: +f.size || 0, createdAt: f.createdTime }); }); } catch (e) {}
      return { assets: out, usage: { files: out.length, bytes: out.reduce((s, a) => s + a.sizeBytes, 0), maxFiles: 5000, maxBytes: 15 * 1024 ** 3 } }; },
    async delete(id) { try { const c = await caches.open(BLOB_CACHE); await c.delete(blobUrl(id)); } catch (e) {} await IDB.put("blobq", id, { del: true }); flushBlobs(); return { deleted: true }; }
  };
  /* ---------------- downloads: a normal browser download */
  const DOWNLOADS = { async save(r) { const d = r && r.data; const b = d instanceof Blob ? d : new Blob([d], { type: "application/octet-stream" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = (r && r.filename) || "download"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); return { status: "saved" }; } };
  const USER = { async isOwner() { return true; }, async canEdit() { return true; }, async can() { return true; }, async id() { return G.uid || "local"; },
    async me() { return { id: G.uid || "local", name: G.email || "", guest: false }; }, async profiles(ids) { const o = {}; (ids || []).forEach(i => o[i] = { id: i, name: i === G.uid ? G.email : "", guest: false }); return o; }, async search() { return []; } };
  const PERMS = { async state(n) { return n ? "granted" : {}; }, async request(ns) { const o = {}; (ns || ["db", "user"]).forEach(n => o[n] = "granted"); return o; } };
  window.claude = Object.freeze({ use: async name => {
    if (name === "db") return dbP;
    if (name === "user") return USER;
    if (name === "assets") return ASSETS;
    if (name === "downloads") return DOWNLOADS;
    if (name === "permissions") return PERMS;
    return null; } });
  window.MAESTRO_STANDALONE = { G, connect, flushBlobs, IDB, nameOf, relOf };

  /* ---------------- the small Google chip (bottom corner) */
  let chip = null;
  function ui() { if (!document.body) return; if (!chip) { chip = document.createElement("div"); chip.id = "gdchip"; document.body.appendChild(chip);
      chip.addEventListener("click", ev => { const b = ev.target.closest("[data-gd]"); if (!b) { chip.classList.toggle("open"); return; } const a = b.dataset.gd; ev.stopPropagation();
        if (a === "on") connect(true); else if (a === "sync") { const Y = SYf(); if (Y) Y.sync(true); } else if (a === "exp") exportAll(); else if (a === "imp") chip.querySelector("#gdimp").click(); else if (a === "cid") { const v = chip.querySelector("#gdcid").value.trim(); LS.set("gd_cid", v); connect(true); }
        else if (a === "out") { G.token = null; G.uid = ""; G.email = ""; G.folderId = ""; ["gd_tok", "gd_uid", "gd_email", "gd_folder"].forEach(k => LS.set(k, undefined)); try { google.accounts.oauth2.revoke && G.token && google.accounts.oauth2.revoke(G.token.t); } catch (e) {} location.reload(); } }); }
    const st = !navigator.onLine ? "offline" : G.state; const dot = st === "on" ? "#2e7d32" : st === "busy" ? "#f9a825" : st === "offline" ? "#757575" : "#c62828";
    const label = st === "on" ? T("متزامن مع جوجل", "Synced with Google") : st === "busy" ? T("بيتربط…", "Connecting…") : st === "offline" ? T("من غير نت — شغال على الجهاز", "Offline — working on this device") : st === "noid" ? T("جوجل مش متظبط", "Google not set up") : T("مش مربوط بجوجل", "Not connected to Google");
    chip.innerHTML = `<button type="button" class="gdb" aria-label="${label}"><span class="gddot" style="background:${dot}"></span><span class="gdl">${label}</span></button>
      <div class="gdp">${G.email ? `<div>${T("الحساب", "Account")}: <b dir="ltr">${esc(G.email)}</b></div>` : ""}
      ${G.lastSync ? `<div class="gdm">${T("آخر تزامن", "Last sync")}: <span dir="ltr">${esc(new Date(G.lastSync).toLocaleString())}</span></div>` : ""}
      ${G.err && st !== "on" ? `<div class="gdm" style="color:#c62828">${esc(G.err)}</div>` : ""}
      ${!G.clientId() ? `<label class="gdm">${T("الصق الـ Client ID اللي عملته في جوجل", "Paste the Client ID you made in Google")}<input id="gdcid" dir="ltr" placeholder="xxxx.apps.googleusercontent.com"></label><button type="button" data-gd="cid">${T("احفظ واربط", "Save & connect")}</button>`
        : st === "on" ? `<button type="button" data-gd="sync">${T("اتزامن دلوقتي", "Sync now")}</button> <button type="button" data-gd="out">${T("اخرج من الحساب", "Sign out")}</button>`
        : `<button type="button" data-gd="on">${T("اربط جوجل", "Connect Google")}</button>`}
      <div class="gdm" style="border-top:1px solid #ddd;padding-top:6px">${T("نسخة كاملة من الداتا (للنقل أو الاحتياط)", "Full copy of the data (to move or keep safe)")}</div>
      <div><button type="button" data-gd="exp">${T("نزّل نسخة", "Download a copy")}</button> <button type="button" data-gd="imp">${T("حمّل نسخة", "Load a copy")}</button><input type="file" id="gdimp" accept=".json,application/json" hidden></div></div>`;
    const fi = chip.querySelector("#gdimp"); if (fi) fi.onchange = () => { const f = fi.files && fi.files[0]; if (f) importAll(f); }; }
  /* ---------------- full copy: every document + every attached file in one JSON (used to move from the claude.ai version) */
  const b64 = async blob => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function exportAll() { const Y = SYf(); if (!Y) return; const docs = Y.locals(); const blobs = {};
    try { const c = await caches.open(BLOB_CACHE); for (const r of await c.keys()) { const id = r.url.split("/_blob/")[1]; const res = await c.match(r); if (id && res) { const b = await res.blob(); blobs[id] = { type: b.type, b64: await b64(b) }; } } } catch (e) {}
    const name = "Maestro_full_copy_" + new Date().toISOString().slice(0, 10) + ".json"; await DOWNLOADS.save({ filename: name, data: new Blob([JSON.stringify({ maestro: 1, at: new Date().toISOString(), docs, blobs })], { type: "application/json" }) }); }
  async function importAll(file) { const Y = SYf(); if (!Y) return; let j; try { j = JSON.parse(await file.text()); } catch (e) { alert(T("الملف مش نسخة من البرنامج", "This file is not a Maestro copy")); return; }
    const docs = j.docs || {}; const ids = Object.keys(docs); const nb = Object.keys(j.blobs || {}).length;
    if (!confirm(T(`هحمّل ${ids.length} دوكيومنت و ${nb} ملف مرفق. أي داتا بنفس الاسم على الجهاز ده هتتبدّل. أكمّل؟`, `Load ${ids.length} documents and ${nb} attached files? Data with the same name on this device will be replaced.`))) return;
    let n = 0; for (const id of ids) { const v = docs[id]; const k = Y.kind(id, v); if (!k) continue; Y.setLocal(id, v, k); n++; }
    for (const [id, o] of Object.entries(j.blobs || {})) { try { const bin = atob(o.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await putLocalBlob(id, new Blob([u], { type: o.type }), o.type); await IDB.put("blobq", id, { type: o.type, at: Date.now() }); } catch (e) {} }
    alert(T(`اتحمّل ${n} دوكيومنت و ${nb} ملف. البرنامج هيفتح من جديد.`, `Loaded ${n} documents and ${nb} files. The app will reload.`)); location.reload(); }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = document.createElement("style"); css.textContent = `#gdchip{position:fixed;z-index:2147483000;inset-inline-end:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));font:13px system-ui,Segoe UI,Tahoma,sans-serif}
    #gdchip .gdb{display:flex;align-items:center;gap:6px;border:1px solid #bbb;background:#fff;color:#222;border-radius:999px;padding:5px 10px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15)}
    #gdchip .gddot{width:9px;height:9px;border-radius:50%;display:inline-block}#gdchip:not(.open) .gdp{display:none}
    #gdchip .gdp{margin-top:6px;background:#fff;color:#222;border:1px solid #bbb;border-radius:10px;padding:10px;max-width:300px;display:grid;gap:6px;box-shadow:0 2px 10px rgba(0,0,0,.2)}
    #gdchip .gdp button{border:1px solid #333;background:#222;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer}#gdchip .gdm{font-size:12px;color:#555;display:grid;gap:4px}
    #gdchip input{font:inherit;padding:4px 6px;border:1px solid #bbb;border-radius:6px}@media (max-width:640px){#gdchip:not(.open) .gdl{display:none}}
    @media print{#gdchip{display:none}}`;
  document.head.appendChild(css);
  /* the Google session lasts one hour: when it runs out, the next tap anywhere renews it (a browser only allows the Google window on a tap) */
  document.addEventListener("pointerdown", () => { if (G.clientId() && G.email && !G.valid() && navigator.onLine && G.state !== "busy") connect(true); }, true);
  window.addEventListener("online", () => { if (G.valid()) connect(false); else { G.state = "off"; ui(); } });
  window.addEventListener("offline", () => ui());
  document.addEventListener("DOMContentLoaded", () => { ui(); if (G.valid()) connect(false); else G.state = !G.clientId() ? "noid" : navigator.onLine ? "off" : "offline"; ui(); });
  /* offline install: register the service worker next to the page */
  if ("serviceWorker" in navigator && location.protocol !== "file:") window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
})();
