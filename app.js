"use strict";
const $ = (id) => document.getElementById(id);
const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
const MIME = { png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const natural = new Intl.Collator("id", { numeric: true, sensitivity: "base" }).compare;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------- reader settings ---------- */
const DEF = { mode: "page", dir: "ltr", tap: "both", fit: "auto", bar: "auto", autoRead: true, autoPos: true, bright: 100 };
let S;
try { S = { ...DEF, ...JSON.parse(pref.get("settings", "{}")) }; } catch { S = { ...DEF }; }
const saveS = () => pref.set("settings", JSON.stringify(S));

/* ---------- file-name parsing: "Batman (2025) #001 (of 12).cbz" -> series "Batman (2025)", num 1 ---------- */
function parseName(file) {
  let s = file.replace(/\.(cbz|zip)$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  let year = "";
  for (let m; (m = s.match(/\s*[[(]([^[\]()]*)[\])]\s*$/)); ) {
    if (!year && /^(19|20)\d\d$/.test(m[1])) year = m[1];
    s = s.slice(0, m.index).trim();
  }
  const m =
    s.match(/^(.*?)\s*#\s*(\d+(?:\.\d+)?)\s*(?:[-–:]\s*(.*))?$/) ||
    s.match(/^(.*?)[\s\-–:]+(?:vol(?:ume)?\.?|v|ch(?:apter)?\.?|issue|no\.?|ep(?:isode)?\.?)\s*(\d+(?:\.\d+)?)\s*(?:[-–:]\s*(.*))?$/i) ||
    s.match(/^(.*?)[\s\-–:]+(\d{1,4}(?:\.\d+)?)(?:\s+[-–:]\s+(.*))?$/);
  if (m && m[1].trim()) return { series: m[1].replace(/[\s\-–:]+$/, "").trim(), num: parseFloat(m[2]), name: (m[3] || "").trim(), year };
  return { series: s || file, num: null, name: "", year };
}
function comicInfo(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const g = (t) => doc.getElementsByTagName(t)[0]?.textContent.trim() || "";
  return { series: g("Series"), number: g("Number"), title: g("Title"), summary: g("Summary"), year: g("Year"), publisher: g("Publisher"), genre: g("Genre") };
}
const newSeries = (name, extra = {}) => ({ name, cat: "", desc: "", rating: 0, publisher: "", year: "", added: Date.now(), ...extra });

/* ---------- storage: meta (issues), pages (blobs per issue), series ---------- */
const db = new Promise((ok, fail) => {
  const r = indexedDB.open("komik", 3);
  r.onupgradeneeded = (e) => {
    const d = r.result, t = r.transaction;
    if (e.oldVersion < 2) {
      d.createObjectStore("meta", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("pages");
    }
    const ser = d.createObjectStore("series", { keyPath: "name" });
    if (e.oldVersion === 2) {
      const found = new Map();
      t.objectStore("meta").openCursor().onsuccess = (ev) => {
        const c = ev.target.result;
        if (!c) return found.forEach((s) => ser.put(s));
        const b = c.value, p = parseName(b.title);
        if (!found.has(p.series)) found.set(p.series, newSeries(p.series, { cat: b.cat || "", year: p.year }));
        Object.assign(b, { series: p.series, num: p.num, name: p.name, bookmarks: [] });
        delete b.cat;
        c.update(b);
        c.continue();
      };
    }
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
});
const req = async (store, mode, fn) => {
  const s = (await db).transaction(store, mode).objectStore(store);
  return new Promise((ok, fail) => { const q = fn(s); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
};
const done = (t) => new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });
const allMeta = () => req("meta", "readonly", (s) => s.getAll());
const allSeries = () => req("series", "readonly", (s) => s.getAll());
const putMeta = (b) => req("meta", "readwrite", (s) => s.put(b));
const putSeries = (x) => req("series", "readwrite", (s) => s.put(x));
const getPages = (id) => req("pages", "readonly", (s) => s.get(id));

async function addIssue(meta, pages, info) {
  const t = (await db).transaction(["meta", "pages", "series"], "readwrite");
  const ss = t.objectStore("series");
  ss.get(meta.series).onsuccess = (e) => {
    const cur = e.target.result;
    if (!cur) return ss.put(newSeries(meta.series, info));
    for (const k of ["desc", "publisher", "year", "cat"]) if (!cur[k] && info[k]) cur[k] = info[k];
    ss.put(cur);
  };
  const q = t.objectStore("meta").add(meta);
  q.onsuccess = () => t.objectStore("pages").put(pages, q.result);
  await done(t);
}
async function deleteIssues(ids, seriesName) {
  const t = (await db).transaction(["meta", "pages", "series"], "readwrite");
  for (const id of ids) { t.objectStore("meta").delete(id); t.objectStore("pages").delete(id); }
  if (seriesName) t.objectStore("series").delete(seriesName);
  await done(t);
}
async function renameSeries(rec, newName) {
  const t = (await db).transaction(["meta", "series"], "readwrite");
  const ss = t.objectStore("series");
  ss.get(newName).onsuccess = (e) => {
    const target = e.target.result;
    ss.delete(rec.name);
    ss.put(target ? { ...target, cat: target.cat || rec.cat, desc: target.desc || rec.desc } : { ...rec, name: newName });
  };
  for (const i of issues.filter((x) => x.series === rec.name)) t.objectStore("meta").put({ ...i, series: newName });
  await done(t);
}

/* ---------- minimal ZIP reader (no dependencies) ---------- */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readZip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), td = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("bukan file CBZ yang valid");
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const files = [];
  for (let i = 0; i < n; i++) {
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    files.push({
      name: td.decode(u8.subarray(p + 46, p + 46 + nl)),
      method: v.getUint16(p + 10, true), csize: v.getUint32(p + 20, true), off: v.getUint32(p + 42, true),
    });
    p += 46 + nl + xl + cl;
  }
  const read = (f) => {
    const h = f.off + 30 + v.getUint16(f.off + 26, true) + v.getUint16(f.off + 28, true);
    const raw = u8.subarray(h, h + f.csize);
    return f.method === 0 ? raw : inflate(raw);
  };
  return { files, read };
}
async function importFile(file) {
  const zip = await readZip(await file.arrayBuffer());
  const imgs = zip.files
    .filter((f) => IMG.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name))
    .sort((a, b) => natural(a.name, b.name));
  if (!imgs.length) throw new Error("tidak ada gambar di dalamnya");
  let info = {};
  const ci = zip.files.find((f) => /(^|\/)comicinfo\.xml$/i.test(f.name));
  if (ci) try { info = comicInfo(new TextDecoder().decode(await zip.read(ci))); } catch {}
  const pages = [];
  for (const f of imgs) {
    const ext = f.name.split(".").pop().toLowerCase();
    pages.push(new Blob([await zip.read(f)], { type: MIME[ext] || "image/jpeg" }));
  }
  const p = parseName(file.name);
  const n = parseFloat(info.number);
  await addIssue(
    {
      title: file.name.replace(/\.(cbz|zip)$/i, ""), series: info.series || p.series, num: Number.isFinite(n) ? n : p.num,
      name: info.title || p.name, cover: pages[0], count: pages.length, last: 0, done: false,
      added: Date.now(), readAt: 0, bookmarks: [],
    },
    pages,
    { desc: info.summary || "", publisher: info.publisher || "", year: info.year || p.year, cat: (info.genre || "").split(",")[0].trim() }
  );
}

/* ---------- shared helpers ---------- */
function toast(msg, ms = 2000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => (t.hidden = true), ms);
}
let issues = [], seriesMap = new Map();
const covers = new Map();
const coverUrl = (i) => {
  if (!covers.has(i.id)) covers.set(i.id, URL.createObjectURL(i.cover));
  return covers.get(i.id);
};
const status = (i) => (i.done ? "done" : i.readAt ? "reading" : "new");
const byNum = (a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || natural(a.title, b.title);
const label = (i) => (i.num != null ? `#${i.num}` : i.name || i.title);
const fullLabel = (i) => (i.num != null && i.name ? `#${i.num} · ${i.name}` : label(i));
const issuesOf = (name) => issues.filter((i) => i.series === name).sort(byNum);
function group(name) {
  const list = issuesOf(name);
  if (!list.length) return null;
  return {
    s: seriesMap.get(name) || newSeries(name), list, cover: list[0],
    done: list.filter((i) => i.done).length,
    readAt: Math.max(...list.map((i) => i.readAt || 0)),
    added: Math.max(...list.map((i) => i.added)),
  };
}
function nextUp(list) {
  const reading = list.filter((i) => status(i) === "reading").sort((a, b) => b.readAt - a.readAt)[0];
  if (reading) return { issue: reading, text: `Lanjutkan ${label(reading)} · hal ${reading.last + 1}` };
  const unread = list.find((i) => !i.done);
  if (unread) return { issue: unread, text: list.some((i) => i.done) ? `Baca ${label(unread)} berikutnya` : `Mulai baca ${label(unread)}` };
  return { issue: list[0], text: "Baca lagi dari awal", restart: true };
}

async function refresh() {
  const [m, s] = await Promise.all([allMeta(), allSeries()]);
  issues = m;
  seriesMap = new Map(s.map((x) => [x.name, x]));
  renderLib();
  if (!$("detail").hidden) renderDetail();
}

/* ============ LIBRARY ============ */
let filterCat = "", query = "", sortBy = pref.get("sort", "added");
function renderLib() {
  const names = [...new Set(issues.map((i) => i.series))];
  const groups = names.map(group).filter(Boolean);
  $("count").textContent = groups.length ? `${groups.length} seri · ${issues.length} issue` : "";

  const cats = [...new Set(groups.map((g) => g.s.cat).filter(Boolean))].sort(natural);
  if (filterCat && !cats.includes(filterCat)) filterCat = "";
  const chip = (lbl, val) => `<button class="chip${filterCat === val ? " on" : ""}" data-c="${esc(val)}">${esc(lbl)}</button>`;
  $("cats").innerHTML = cats.length ? chip("Semua", "") + cats.map((c) => chip(c, c)).join("") : "";

  const q = query.trim().toLowerCase();
  const sorter = {
    added: (a, b) => b.added - a.added,
    read: (a, b) => b.readAt - a.readAt || b.added - a.added,
    title: (a, b) => natural(a.s.name, b.s.name),
  }[sortBy];
  const list = groups
    .filter((g) => (!filterCat || g.s.cat === filterCat) &&
      (!q || g.s.name.toLowerCase().includes(q) || g.s.cat.toLowerCase().includes(q) || g.list.some((i) => (i.name || "").toLowerCase().includes(q))))
    .sort(sorter);

  const reading = issues.filter((i) => status(i) === "reading").sort((a, b) => b.readAt - a.readAt).slice(0, 12);
  $("continue").hidden = !reading.length || !!q || !!filterCat;
  $("cont-row").innerHTML = reading.map((i) => `
    <button class="cont" data-issue="${i.id}">
      <img src="${coverUrl(i)}" alt="">
      <div style="min-width:0;flex:1">
        <div class="t">${esc(i.series)} ${esc(label(i))}</div>
        <div class="m">Hal ${i.last + 1} dari ${i.count}</div>
        <div class="bar"><i style="width:${Math.round(((i.last + 1) / i.count) * 100)}%"></i></div>
      </div>
    </button>`).join("");

  $("grid-title").textContent = filterCat || (q ? "Hasil pencarian" : "Koleksi");
  $("grid-title").hidden = !groups.length;
  $("empty").hidden = groups.length > 0;
  $("nores").hidden = !groups.length || list.length > 0;
  $("grid").innerHTML = list.map((g) => {
    const n = g.list.length, started = g.list.some((i) => i.readAt);
    const badge = g.done === n ? '<span class="badge">SELESAI</span>' : !started ? '<span class="badge new">BARU</span>' : "";
    return `<div class="item" data-series="${esc(g.s.name)}" role="button" tabindex="0">
      <div class="stack${n > 1 ? " multi" : ""}"><img class="cover" src="${coverUrl(g.cover)}" alt="" loading="lazy"></div>
      ${badge}
      <button class="more" data-more="${esc(g.s.name)}" aria-label="Edit seri"><svg><use href="#i-more"/></svg></button>
      <div class="t">${esc(g.s.name)}</div>
      <div class="m">${n} issue${g.s.cat ? " · " + esc(g.s.cat) : ""}</div>
      ${started && g.done < n ? `<div class="bar"><i style="width:${Math.round((g.done / n) * 100)}%"></i></div>` : ""}
    </div>`;
  }).join("");
}

$("q").oninput = (e) => { query = e.target.value; $("q-clear").hidden = !query; renderLib(); };
$("q-clear").onclick = () => { $("q").value = query = ""; $("q-clear").hidden = true; renderLib(); $("q").focus(); };
$("cats").onclick = (e) => {
  const c = e.target.closest("[data-c]");
  if (c) { filterCat = c.getAttribute("data-c"); renderLib(); }
};
$("add").onclick = $("empty-add").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  const files = [...e.target.files].sort((a, b) => natural(a.name, b.name));
  e.target.value = "";
  let ok = 0;
  for (const [i, f] of files.entries()) {
    toast(files.length > 1 ? `Mengimpor ${i + 1}/${files.length}…` : "Mengimpor…", 0);
    try { await importFile(f); ok++; } catch (err) { alert(`Gagal mengimpor ${f.name}: ${err.message}`); }
  }
  toast(ok ? `${ok} issue ditambahkan` : "Tidak ada yang diimpor");
  refresh();
};
const SAMPLES = [
  "Bintang Jatuh #01 - Awal Mula", "Bintang Jatuh #02 - Kota di Atas Awan", "Bintang Jatuh #03 - Jatuhnya Bintang",
  "Kota Kabut 001 (2025) (Digital)", "Kota Kabut 002 (2025) (Digital)", "Laut Sunyi",
];
$("empty-sample").onclick = async () => {
  try {
    for (const [i, n] of SAMPLES.entries()) {
      toast(`Memuat sampel ${i + 1}/${SAMPLES.length}…`, 0);
      const r = await fetch(`samples/${encodeURIComponent(n)}.cbz`);
      if (!r.ok) throw new Error(r.statusText);
      await importFile(new File([await r.blob()], `${n}.cbz`));
    }
    toast("Sampel dimuat");
  } catch (err) {
    toast("Gagal memuat sampel");
  }
  refresh();
};
$("grid").onclick = (e) => {
  const more = e.target.closest("[data-more]");
  if (more) return openSeriesSheet(more.getAttribute("data-more"));
  const it = e.target.closest("[data-series]");
  if (it) openDetail(it.getAttribute("data-series"));
};
$("cont-row").onclick = (e) => {
  const it = e.target.closest("[data-issue]");
  if (it) openReader(+it.dataset.issue);
};
let pressT;
$("grid").addEventListener("touchstart", (e) => {
  const it = e.target.closest(".item");
  if (it) pressT = setTimeout(() => { pressT = null; navigator.vibrate?.(10); openSeriesSheet(it.getAttribute("data-series")); }, 500);
}, { passive: true });
["touchend", "touchmove"].forEach((ev) => $("grid").addEventListener(ev, (e) => {
  if (pressT === null && ev === "touchend") e.preventDefault();
  clearTimeout(pressT);
}));
$("sort").onclick = () => {
  for (const b of $("sortmenu").querySelectorAll("[data-s]")) b.classList.toggle("on", b.dataset.s === sortBy);
  $("sortmenu").hidden = false;
};
$("sortmenu").onclick = (e) => {
  const b = e.target.closest("[data-s]");
  if (b) { sortBy = b.dataset.s; pref.set("sort", sortBy); renderLib(); }
  if (b || e.target === $("sortmenu")) $("sortmenu").hidden = true;
};

/* ============ SERIES DETAIL ============ */
let detailName = null, libScroll = 0;
function openDetail(name) {
  libScroll = scrollY;
  detailName = name;
  $("lib-view").hidden = true;
  $("detail").hidden = false;
  $("d-desc").classList.add("clamp");
  renderDetail();
  scrollTo(0, 0);
}
function closeDetail() {
  detailName = null;
  $("detail").hidden = true;
  $("lib-view").hidden = false;
  renderLib();
  scrollTo(0, libScroll);
}
function issueRows(list, curId, withMore) {
  return list.map((i) => {
    const st = status(i);
    const m = st === "done" ? '<div class="m done">✓ Selesai</div>'
      : st === "reading" ? `<div class="m">Hal ${i.last + 1} dari ${i.count}</div><div class="bar"><i style="width:${Math.round(((i.last + 1) / i.count) * 100)}%"></i></div>`
      : `<div class="m">${i.count} halaman · belum dibaca</div>`;
    const bm = i.bookmarks?.length ? ` · ${i.bookmarks.length} bookmark` : "";
    return `<div class="irow${i.id === curId ? " cur" : ""}" data-issue="${i.id}" role="button" tabindex="0">
      <img src="${coverUrl(i)}" alt="" loading="lazy">
      <div class="ibody"><div class="t">${esc(fullLabel(i))}</div>${m.replace("</div>", bm + "</div>")}</div>
      ${withMore ? `<button class="icon more" data-more="${i.id}" aria-label="Opsi issue"><svg><use href="#i-more"/></svg></button>` : ""}
    </div>`;
  }).join("");
}
function renderDetail() {
  const g = group(detailName);
  if (!g) return closeDetail();
  const { s, list } = g;
  $("d-bartitle").textContent = s.name;
  $("d-cover").src = coverUrl(g.cover);
  $("d-title").textContent = s.name;
  $("d-meta").textContent = [s.publisher, s.year, `${list.length} issue`, g.done ? `${g.done} selesai` : ""].filter(Boolean).join(" · ");
  $("d-stars").innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button data-r="${n}" class="${n <= (s.rating || 0) ? "on" : ""}" aria-label="${n} bintang"><svg><use href="#i-star"/></svg></button>`).join("");
  const up = nextUp(list);
  $("d-read").innerHTML = `<svg><use href="#i-play"/></svg>${esc(up.text)}`;
  $("d-read").onclick = () => openReader(up.issue.id, up.restart ? 0 : undefined);
  $("d-tags").innerHTML = s.cat ? `<span class="tag">${esc(s.cat)}</span>` : "";
  $("d-desc").textContent = s.desc || "";
  checkDescMore();
  $("d-issues-title").textContent = `Issue (${list.length})`;
  $("d-issues").innerHTML = issueRows(list, up.issue.id, true);
}
function checkDescMore() {
  const el = $("d-desc");
  $("d-desc-more").hidden = !el.classList.contains("clamp") || el.scrollHeight <= el.clientHeight + 2;
}
$("d-back").onclick = closeDetail;
$("d-more").onclick = () => openSeriesSheet(detailName);
$("d-desc-more").onclick = () => { $("d-desc").classList.remove("clamp"); $("d-desc-more").hidden = true; };
$("d-stars").onclick = async (e) => {
  const b = e.target.closest("[data-r]");
  if (!b) return;
  const s = seriesMap.get(detailName) || newSeries(detailName);
  s.rating = s.rating === +b.dataset.r ? 0 : +b.dataset.r;
  await putSeries(s);
  refresh();
};
$("d-issues").onclick = (e) => {
  const more = e.target.closest("[data-more]");
  if (more) return openIssueSheet(+more.dataset.more);
  const r = e.target.closest("[data-issue]");
  if (r) openReader(+r.dataset.issue);
};
addEventListener("scroll", () => {
  if (!$("detail").hidden) $("detail").querySelector(".dbar").classList.toggle("scrolled", scrollY > 150);
}, { passive: true });

/* ---------- series sheet ---------- */
let editing = null;
function openSeriesSheet(name) {
  editing = seriesMap.get(name) || newSeries(name);
  $("sh-title").value = editing.name;
  $("sh-cat").value = editing.cat || "";
  $("sh-desc").value = editing.desc || "";
  const cats = [...new Set([...seriesMap.values()].map((x) => x.cat).filter(Boolean))].sort(natural);
  $("sh-chips").innerHTML = cats.map((c) => `<button class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $("sheet").hidden = false;
}
$("sheet").onclick = (e) => { if (e.target === $("sheet")) $("sheet").hidden = true; };
$("sh-chips").onclick = (e) => { const c = e.target.closest("[data-c]"); if (c) $("sh-cat").value = c.getAttribute("data-c"); };
$("sh-save").onclick = async () => {
  const newName = $("sh-title").value.trim() || editing.name;
  Object.assign(editing, { cat: $("sh-cat").value.trim(), desc: $("sh-desc").value.trim() });
  if (newName !== editing.name) {
    await renameSeries(editing, newName);
    if (detailName === editing.name) detailName = newName;
  } else await putSeries(editing);
  $("sheet").hidden = true;
  await refresh();
  toast("Tersimpan");
};
$("sh-del").onclick = async () => {
  const list = issuesOf(editing.name);
  if (!confirm(`Hapus seri “${editing.name}” beserta ${list.length} issue?`)) return;
  await deleteIssues(list.map((i) => i.id), editing.name);
  list.forEach((i) => { URL.revokeObjectURL(covers.get(i.id)); covers.delete(i.id); });
  $("sheet").hidden = true;
  if (detailName === editing.name) closeDetail();
  refresh();
  toast("Seri dihapus");
};

/* ---------- issue sheet ---------- */
let editIssue = null;
function openIssueSheet(id) {
  editIssue = issues.find((i) => i.id === id);
  $("is-title").textContent = `${editIssue.series} ${fullLabel(editIssue)}`;
  $("is-done").textContent = editIssue.done ? "Tandai belum dibaca" : "Tandai selesai";
  $("isheet").hidden = false;
}
$("isheet").onclick = (e) => { if (e.target === $("isheet")) $("isheet").hidden = true; };
$("is-done").onclick = async () => {
  Object.assign(editIssue, editIssue.done ? { done: false, last: 0, readAt: 0 } : { done: true, readAt: Date.now() });
  await putMeta(editIssue);
  $("isheet").hidden = true;
  refresh();
};
$("is-del").onclick = async () => {
  if (!confirm(`Hapus ${editIssue.series} ${label(editIssue)}?`)) return;
  const last = issuesOf(editIssue.series).length === 1;
  await deleteIssues([editIssue.id], last ? editIssue.series : null);
  URL.revokeObjectURL(covers.get(editIssue.id));
  covers.delete(editIssue.id);
  $("isheet").hidden = true;
  refresh();
  toast("Issue dihapus");
};

/* ============ READER ============ */
const R = { list: [], cur: null, idx: 0, shown: [0], urls: new Map(), saveT: 0 };
const Z = { s: 1, x: 0, y: 0 };
let hideT, io = null;

const effMode = () => (S.mode === "spread" && innerWidth <= innerHeight ? "page" : S.mode);
const paged = () => ["page", "spread"].includes(effMode());
const startIdx = (i) => (i.done || !S.autoPos ? 0 : clamp(i.last || 0, 0, i.count - 1));
async function urlsFor(id) {
  if (!R.urls.has(id)) R.urls.set(id, (await getPages(id)).map((p) => URL.createObjectURL(p)));
  return R.urls.get(id);
}

async function openReader(id, at) {
  const issue = issues.find((i) => i.id === id);
  if (!issue) return;
  R.list = issuesOf(issue.series);
  $("reader").hidden = false;
  document.body.style.overflow = "hidden";
  applyBright();
  await loadIssue(issue, at ?? startIdx(issue));
  chrome(true);
}
async function loadIssue(issue, idx) {
  if (R.cur && R.cur.id !== issue.id) await saveNow();
  R.cur = issue;
  R.idx = clamp(idx, 0, issue.count - 1);
  await urlsFor(issue.id);
  $("endcard").hidden = true;
  updateHeader();
  await build();
}
function updateHeader() {
  const k = R.list.indexOf(R.cur);
  $("r-series").textContent = R.cur.series;
  $("r-issue").textContent = fullLabel(R.cur);
  $("prev-iss").disabled = k <= 0;
  $("next-iss").disabled = k >= R.list.length - 1;
  $("slider").max = R.cur.count;
  $("readbtn").classList.toggle("on", !!R.cur.done);
  updateBm();
}
const updateBm = () => $("bm").classList.toggle("on", (R.cur.bookmarks || []).includes(R.idx));

async function build() {
  const box = $("pages"), m = effMode();
  if (io) { io.disconnect(); io = null; }
  box.className = `${m} fit-${S.fit} ${S.dir}`;
  resetZoom(false);
  if (paged()) {
    box.innerHTML = '<div class="stage"></div>';
    showPage(m === "spread" ? spreadOf(R.idx)[0] : R.idx);
    return;
  }
  box.innerHTML = "";
  await appendIssue(R.cur, false);
  if (m === "scroll") box.insertAdjacentHTML("beforeend", endCardHtml(R.cur));
  else {
    const sentinel = document.createElement("div");
    sentinel.id = "sentinel";
    box.append(sentinel);
    io = new IntersectionObserver(onSentinel, { root: box, rootMargin: "1500px 0px" });
    io.observe(sentinel);
  }
  const target = box.querySelector(`img[data-iid="${R.cur.id}"][data-i="${R.idx}"]`);
  const before = [...box.querySelectorAll(`img[data-iid="${R.cur.id}"]`)].slice(0, R.idx + 1);
  await Promise.all(before.map((im) => im.decode().catch(() => {})));
  if (target && R.idx > 0) box.scrollTop = target.offsetTop;
  else box.scrollTop = 0;
  updatePos(R.idx);
}
async function appendIssue(issue, withDivider) {
  const urls = await urlsFor(issue.id);
  const sec = document.createElement("div");
  sec.className = "iss";
  sec.dataset.iid = issue.id;
  sec.innerHTML = (withDivider ? `<div class="divider">Lanjut ke<b>${esc(issue.series)} ${esc(fullLabel(issue))}</b></div>` : "") +
    urls.map((u, i) => `<img data-iid="${issue.id}" data-i="${i}" decoding="async" src="${u}" alt="">`).join("");
  const sentinel = $("sentinel");
  sentinel ? $("pages").insertBefore(sec, sentinel) : $("pages").append(sec);
}
function endCardHtml(issue) {
  const nx = R.list[R.list.indexOf(issue) + 1];
  return `<div class="nextcard">Akhir dari ${esc(issue.series)} ${esc(label(issue))}<br>` +
    (nx ? `<button class="primary" data-goto="${nx.id}">Lanjut ke ${esc(label(nx))} ›</button>`
        : `<button class="primary" data-exit="1">Kembali ke seri</button>`) + "</div>";
}
async function onSentinel(entries) {
  if (!entries.some((e) => e.isIntersecting) || onSentinel.busy) return;
  const secs = $("pages").querySelectorAll(".iss");
  const lastId = +secs[secs.length - 1].dataset.iid;
  const nx = R.list[R.list.findIndex((i) => i.id === lastId) + 1];
  onSentinel.busy = true;
  if (nx) await appendIssue(nx, true);
  else { io.disconnect(); $("sentinel").outerHTML = endCardHtml(R.list[R.list.length - 1]); }
  onSentinel.busy = false;
}

/* ---------- paged modes ---------- */
function spreadOf(i) {
  if (i <= 0) return [0];
  const a = i % 2 === 1 ? i : i - 1;
  return a + 1 < R.cur.count ? [a, a + 1] : [a];
}
function showPage(i) {
  if (i >= R.cur.count) return showEnd();
  if (i < 0) return toast("Halaman pertama", 1000);
  $("endcard").hidden = true;
  const set = effMode() === "spread" ? spreadOf(i) : [i];
  const urls = R.urls.get(R.cur.id);
  R.idx = set[0];
  R.shown = set;
  resetZoom(false);
  const stage = $("pages").querySelector(".stage");
  stage.innerHTML = set.map((k) => `<img src="${urls[k]}" alt="">`).join("");
  $("pages").scrollTop = 0;
  const nx = set[set.length - 1] + 1;
  if (urls[nx]) new Image().src = urls[nx];
  if (urls[nx + 1]) new Image().src = urls[nx + 1];
  updatePos(set[set.length - 1]);
}
const goNext = () => showPage(R.shown[R.shown.length - 1] + 1);
const goPrev = () => showPage(effMode() === "spread" ? spreadOf(R.idx - 1)[0] : R.idx - 1);
function showEnd() {
  if (S.autoRead && !R.cur.done) { R.cur.done = true; saveNow(); $("readbtn").classList.add("on"); }
  const nx = R.list[R.list.indexOf(R.cur) + 1];
  $("end-title").textContent = `${label(R.cur)} selesai`;
  $("end-sub").textContent = R.cur.series;
  $("end-next").hidden = !nx;
  if (nx) $("end-next").textContent = `Lanjut ke ${label(nx)} ›`;
  $("endcard").hidden = false;
  chrome(false);
}
$("end-next").onclick = () => {
  const nx = R.list[R.list.indexOf(R.cur) + 1];
  if (nx) loadIssue(nx, startIdx(nx));
};
$("end-back").onclick = () => exitReader();
$("endcard").onclick = (e) => { if (e.target === $("endcard")) $("endcard").hidden = true; };

/* ---------- position & saving ---------- */
function updatePos(lastVisible) {
  if (!paged()) R.shown = [R.idx];
  const c = R.cur, set = R.shown;
  $("pos").textContent = paged() && set.length > 1 ? `${set[0] + 1}–${set[1] + 1}/${c.count}` : `${R.idx + 1} / ${c.count}`;
  $("slider").value = R.idx + 1;
  c.readAt = Date.now();
  if (S.autoPos) c.last = R.idx;
  if (S.autoRead && lastVisible === c.count - 1 && !c.done) { c.done = true; $("readbtn").classList.add("on"); }
  updateBm();
  clearTimeout(R.saveT);
  R.saveT = setTimeout(() => putMeta(c), 300);
}
function saveNow() {
  clearTimeout(R.saveT);
  return R.cur ? putMeta(R.cur) : Promise.resolve();
}

/* ---------- chrome (top/bottom bars) ---------- */
function chrome(show, autoHide = true) {
  $("reader").classList.toggle("chrome-off", !show);
  clearTimeout(hideT);
  if (show && autoHide) hideT = setTimeout(() => $("reader").classList.add("chrome-off"), 3000);
}
const chromeOff = () => $("reader").classList.contains("chrome-off");

/* ---------- zoom (paged modes): pinch + double tap ---------- */
function applyZoom(anim) {
  const st = $("pages").querySelector(".stage");
  if (!st) return;
  st.classList.toggle("anim", !!anim);
  st.style.transform = Z.s === 1 ? "" : `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`;
}
function clampZoom() {
  const st = $("pages").querySelector(".stage");
  const w = st.offsetWidth, h = st.offsetHeight;
  Z.x = clamp(Z.x, w * (1 - Z.s), 0);
  Z.y = clamp(Z.y, h * (1 - Z.s), 0);
}
function resetZoom(anim = true) { Z.s = 1; Z.x = Z.y = 0; applyZoom(anim); }
function toggleZoom(cx, cy) {
  if (Z.s > 1) return resetZoom();
  const r = $("pages").querySelector(".stage").getBoundingClientRect();
  Z.s = 2.5;
  Z.x = (cx - r.left) * (1 - Z.s);
  Z.y = (cy - r.top) * (1 - Z.s);
  clampZoom();
  applyZoom(true);
}

/* ---------- touch & tap handling ---------- */
const T = { sx: 0, sy: 0, x0: 0, y0: 0, d0: 0, s0: 1, mid: null, pinch: false, moved: false };
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
$("pages").addEventListener("touchstart", (e) => {
  const t = e.touches;
  T.moved = false;
  if (t.length === 2 && paged()) {
    T.pinch = true;
    T.d0 = dist(t[0], t[1]); T.s0 = Z.s; T.x0 = Z.x; T.y0 = Z.y;
    const r = $("pages").querySelector(".stage").getBoundingClientRect();
    T.mid = { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, left: r.left - Z.x, top: r.top - Z.y };
  } else if (t.length === 1) {
    T.sx = t[0].clientX; T.sy = t[0].clientY; T.x0 = Z.x; T.y0 = Z.y;
  }
}, { passive: true });
$("pages").addEventListener("touchmove", (e) => {
  if (!paged()) return;
  const t = e.touches;
  if (T.pinch && t.length === 2) {
    e.preventDefault();
    T.moved = true;
    const s = clamp(T.s0 * (dist(t[0], t[1]) / T.d0), 1, 4);
    const px = (T.mid.x - T.mid.left - T.x0) / T.s0, py = (T.mid.y - T.mid.top - T.y0) / T.s0;
    const mx = (t[0].clientX + t[1].clientX) / 2, my = (t[0].clientY + t[1].clientY) / 2;
    Z.s = s; Z.x = mx - T.mid.left - px * s; Z.y = my - T.mid.top - py * s;
    clampZoom(); applyZoom(false);
  } else if (Z.s > 1 && t.length === 1) {
    e.preventDefault();
    T.moved = true;
    Z.x = T.x0 + (t[0].clientX - T.sx); Z.y = T.y0 + (t[0].clientY - T.sy);
    clampZoom(); applyZoom(false);
  }
}, { passive: false });
$("pages").addEventListener("touchend", (e) => {
  if (e.touches.length) return;
  if (T.pinch) { T.pinch = false; T.moved = true; if (Z.s < 1.05) resetZoom(); return; }
  if (!paged() || Z.s > 1) return;
  const dx = e.changedTouches[0].clientX - T.sx, dy = e.changedTouches[0].clientY - T.sy;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) {
    T.moved = true;
    const fwd = (dx < 0) !== (S.dir === "rtl");
    fwd ? goNext() : goPrev();
  }
});
let lastTap = 0, tapT;
$("pages").addEventListener("click", (e) => {
  if (T.moved) { T.moved = false; return; }
  const goto = e.target.closest("[data-goto]");
  if (goto) { const nx = issues.find((i) => i.id === +goto.dataset.goto); return nx && loadIssue(nx, 0); }
  if (e.target.closest("[data-exit]")) return exitReader();
  const isPaged = paged();
  if (isPaged && Z.s === 1) {
    const x = e.clientX / innerWidth;
    const side = x < 0.28 ? "L" : x > 0.72 ? "R" : "";
    if (side) {
      if (S.tap === "forward") return goNext();
      return (side === "R") !== (S.dir === "rtl") ? goNext() : goPrev();
    }
  }
  const now = Date.now();
  if (isPaged && now - lastTap < 280) { clearTimeout(tapT); lastTap = 0; return toggleZoom(e.clientX, e.clientY); }
  lastTap = now;
  clearTimeout(tapT);
  tapT = setTimeout(() => chrome(chromeOff()), isPaged ? 280 : 0);
});

/* ---------- scroll modes: track page & show bar on scroll-up ---------- */
let lastSt = 0, scrollRaf = 0;
$("pages").addEventListener("scroll", () => {
  if (paged() || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const box = $("pages"), st = box.scrollTop;
    if (S.bar === "auto") {
      if (st < lastSt - 12) chrome(true, false);
      else if (st > lastSt + 12) chrome(false);
    }
    lastSt = st;
    const mid = st + box.clientHeight / 2;
    let hit = null;
    for (const im of box.querySelectorAll("img")) if (im.offsetTop + im.offsetHeight > mid) { hit = im; break; }
    if (!hit) return;
    const iid = +hit.dataset.iid, i = +hit.dataset.i;
    if (iid !== R.cur.id) {
      saveNow();
      R.cur = R.list.find((x) => x.id === iid);
      R.idx = i;
      updateHeader();
      updatePos(i);
    } else if (i !== R.idx) {
      R.idx = i;
      updatePos(i);
    }
  });
}, { passive: true });

/* ---------- reader controls ---------- */
function gotoPage(i) {
  if (paged()) return showPage(effMode() === "spread" ? spreadOf(i)[0] : i);
  const im = $("pages").querySelector(`img[data-iid="${R.cur.id}"][data-i="${i}"]`);
  if (im) $("pages").scrollTop = im.offsetTop;
}
$("slider").oninput = (e) => { chrome(true); gotoPage(+e.target.value - 1); };
$("back").onclick = () => exitReader();
async function exitReader() {
  await saveNow();
  if (io) { io.disconnect(); io = null; }
  R.urls.forEach((list) => list.forEach(URL.revokeObjectURL));
  R.urls.clear();
  $("reader").hidden = true;
  $("pages").innerHTML = "";
  document.body.style.overflow = "";
  R.cur = null;
  refresh();
}
function goIssue(delta) {
  const nx = R.list[R.list.indexOf(R.cur) + delta];
  if (nx) loadIssue(nx, startIdx(nx)).then(() => chrome(true));
}
$("prev-iss").onclick = () => goIssue(-1);
$("next-iss").onclick = () => goIssue(1);
$("bm").onclick = () => {
  const b = (R.cur.bookmarks ||= []);
  const k = b.indexOf(R.idx);
  k >= 0 ? b.splice(k, 1) : b.push(R.idx);
  b.sort((x, y) => x - y);
  saveNow();
  updateBm();
  chrome(true);
  toast(k >= 0 ? "Bookmark dihapus" : `Halaman ${R.idx + 1} di-bookmark`, 1200);
};
$("readbtn").onclick = () => {
  R.cur.done = !R.cur.done;
  saveNow();
  $("readbtn").classList.toggle("on", R.cur.done);
  chrome(true);
  toast(R.cur.done ? `${label(R.cur)} ditandai selesai` : "Ditandai belum selesai", 1200);
};

/* issue picker */
$("r-titlebtn").onclick = () => {
  $("pk-title").textContent = R.cur.series;
  $("pk-list").innerHTML = issueRows(R.list, R.cur.id, false);
  $("picker").hidden = false;
  $("pk-list").querySelector(".cur")?.scrollIntoView({ block: "center" });
};
$("pk-close").onclick = () => ($("picker").hidden = true);
$("picker").onclick = (e) => {
  if (e.target === $("picker")) return ($("picker").hidden = true);
  const r = e.target.closest("[data-issue]");
  if (!r) return;
  $("picker").hidden = true;
  const nx = R.list.find((i) => i.id === +r.dataset.issue);
  if (nx && nx !== R.cur) loadIssue(nx, startIdx(nx));
};

/* page thumbnails */
let thumbFilter = "all";
function renderThumbs() {
  const urls = R.urls.get(R.cur.id), bms = R.cur.bookmarks || [];
  const idxs = thumbFilter === "bm" ? bms : urls.map((_, i) => i);
  $("th-title").textContent = `${label(R.cur)} · ${R.cur.count} hal`;
  $("tgrid").innerHTML = idxs.length
    ? idxs.map((i) => `<button data-i="${i}" class="${R.shown.includes(i) || i === R.idx ? "on" : ""}">
        <img src="${urls[i]}" alt="" loading="lazy">${bms.includes(i) ? '<i class="bmk"></i>' : ""}<span>${i + 1}</span></button>`).join("")
    : '<div class="none">Belum ada bookmark di issue ini.<br>Ketuk ikon bookmark saat membaca.</div>';
  for (const b of $("thumbs").querySelectorAll("[data-f]")) b.classList.toggle("on", b.dataset.f === thumbFilter);
}
$("thumbs-btn").onclick = () => {
  renderThumbs();
  $("thumbs").hidden = false;
  $("tgrid").querySelector(".on")?.scrollIntoView({ block: "center" });
};
$("thumbs").onclick = (e) => {
  if (e.target === $("thumbs")) return ($("thumbs").hidden = true);
  const f = e.target.closest("[data-f]");
  if (f) { thumbFilter = f.dataset.f; return renderThumbs(); }
  const b = e.target.closest("[data-i]");
  if (b) { $("thumbs").hidden = true; gotoPage(+b.dataset.i); }
};

/* settings */
const OPTS = [
  ["mode", "Mode baca", [["page", "Halaman"], ["spread", "Dua hal."], ["scroll", "Scroll"], ["infinite", "Tanpa henti"]],
    { spread: "Dua halaman tampil saat HP dimiringkan.", infinite: "Scroll terus, issue berikutnya otomatis menyambung." }],
  ["dir", "Arah baca", [["ltr", "Kiri → kanan"], ["rtl", "Kanan → kiri (manga)"]]],
  ["tap", "Ketuk tepi gambar", [["both", "Maju & mundur"], ["forward", "Maju saja"]]],
  ["fit", "Ukuran gambar", [["auto", "Otomatis"], ["width", "Pas lebar"], ["height", "Pas tinggi"]]],
  ["bar", "Bar atas & bawah", [["auto", "Muncul saat scroll naik"], ["tap", "Hanya saat diketuk"]]],
  ["autoRead", "Tandai selesai otomatis", [[true, "Ya"], [false, "Tidak"]]],
  ["autoPos", "Ingat posisi baca", [[true, "Ya"], [false, "Tidak"]]],
];
function renderSettings() {
  $("set-body").innerHTML = OPTS.map(([k, lbl, vals, hints]) =>
    `<div class="opt-l">${lbl}</div><div class="seg">${vals.map(([v, t]) =>
      `<button data-k="${k}" data-v='${JSON.stringify(v)}' class="${S[k] === v ? "on" : ""}">${t}</button>`).join("")}</div>` +
    (hints?.[S[k]] ? `<p class="opt-hint">${hints[S[k]]}</p>` : "")).join("");
  $("bright").value = S.bright;
  $("bright-val").textContent = `${S.bright}%`;
}
$("gear").onclick = () => { renderSettings(); $("settings").hidden = false; chrome(true, false); };
$("set-done").onclick = () => { $("settings").hidden = true; chrome(true); };
$("settings").onclick = async (e) => {
  if (e.target === $("settings")) { $("settings").hidden = true; return chrome(true); }
  const b = e.target.closest("[data-k]");
  if (!b) return;
  const k = b.dataset.k, v = JSON.parse(b.dataset.v);
  if (S[k] === v) return;
  S[k] = v;
  saveS();
  renderSettings();
  if (["mode", "fit", "dir"].includes(k)) await build();
};
function applyBright() { $("dim").style.opacity = ((100 - S.bright) / 100) * 0.85; }
$("bright").oninput = (e) => { S.bright = +e.target.value; $("bright-val").textContent = `${S.bright}%`; applyBright(); saveS(); };

addEventListener("resize", () => {
  if (!$("detail").hidden) checkDescMore();
  if (!$("reader").hidden && S.mode === "spread") build();
});
addEventListener("keydown", (e) => {
  if ($("reader").hidden || e.target.tagName === "INPUT") return;
  if (e.key === "Escape") return exitReader();
  if (!paged()) return;
  const fwd = S.dir === "rtl" ? "ArrowLeft" : "ArrowRight", back = S.dir === "rtl" ? "ArrowRight" : "ArrowLeft";
  if (e.key === fwd || e.key === " ") goNext();
  if (e.key === back) goPrev();
});

/* ---------- boot ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navigator.storage?.persist?.();
refresh();
