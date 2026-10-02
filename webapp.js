/**
 * Web board: login (chatId + 8-digit password) + Trello-style Kanban over the
 * same Notion "Task Inbox" database the Telegram bot uses. Served by the same
 * Worker at GET "/", with a small JSON API under "/api/*".
 */
import {
  CATEGORIES,
  CATEGORY_EMOJI,
  CATEGORY_LABEL_FA,
  STATUSES,
  STATUS_LABEL_FA,
  DEFAULT_STATUS,
  logError,
  formatPersianDate,
  toDashedUuid,
  notionGetPage,
  notionPatch,
  notionSoftDelete,
  notionUpdateCategory,
  notionUpdateStatus,
  notionUpdateDueDate,
  notionQueryByCategoryAndDate,
  classifyWithGemini,
  notionCreatePageFull,
  formatShortId,
} from "./worker.js";

// ---------- crypto helpers ----------

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return bufToHex(buf);
}

export async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

export function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

export function generate8DigitPassword() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 100000000).padStart(8, "0");
}

function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufToHex(sig);
}

async function createSessionToken(chatId, env) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  const payload = base64url(JSON.stringify({ chatId, exp }));
  const sig = await hmacSign(payload, env.WEB_SESSION_SECRET);
  return `${payload}.${sig}`;
}

async function verifySessionToken(token, env) {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmacSign(payload, env.WEB_SESSION_SECRET);
  if (sig !== expected) return null;
  let data;
  try {
    data = JSON.parse(base64urlDecode(payload));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Date.now()) return null;
  return data.chatId;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function getSessionChatId(request, env) {
  const cookies = parseCookies(request);
  return verifySessionToken(cookies.session, env);
}

function sessionCookieHeader(token) {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

// ---------- Notion: Bot Users ----------

export async function notionFindUser(chatId, env) {
  const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_USERS_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ filter: { property: "ChatId", number: { equals: chatId } }, page_size: 1 }),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionFindUser", new Error(JSON.stringify(json)), env, chatId);
    throw new Error("notion query failed");
  }
  return json.results[0] || null;
}

export async function notionUpsertUser(chatId, passwordHash, salt, env, displayName) {
  const existing = await notionFindUser(chatId, env);
  const properties = {
    Name: { title: [{ text: { content: String(chatId) } }] },
    ChatId: { number: chatId },
    PasswordHash: { rich_text: [{ text: { content: passwordHash } }] },
    Salt: { rich_text: [{ text: { content: salt } }] },
  };
  if (displayName) {
    properties.DisplayName = { rich_text: [{ text: { content: displayName } }] };
  }
  const headers = {
    Authorization: `Bearer ${env.NOTION_SECRET}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
  if (existing) {
    await fetch(`https://api.notion.com/v1/pages/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ properties }) });
  } else {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers,
      body: JSON.stringify({ parent: { database_id: env.NOTION_USERS_DB_ID }, properties }),
    });
  }
}

// Lightweight refresh of just the human-readable name, independent of the password flow.
export async function notionUpdateDisplayName(chatId, displayName, env) {
  if (!displayName) return;
  const existing = await notionFindUser(chatId, env);
  if (!existing) return;
  await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ properties: { DisplayName: { rich_text: [{ text: { content: displayName } }] } } }),
  });
}

// ---------- API ----------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export async function handleApi(request, url, env) {
  const path = url.pathname;

  if (path === "/api/login" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const chatId = Number(body.chatId);
    const password = String(body.password || "");
    if (!chatId || !password) return json({ error: "missing fields" }, 400);

    const user = await notionFindUser(chatId, env);
    if (!user) return json({ error: "invalid credentials" }, 401);
    const salt = user.properties.Salt?.rich_text?.[0]?.plain_text || "";
    const storedHash = user.properties.PasswordHash?.rich_text?.[0]?.plain_text || "";
    const givenHash = await hashPassword(password, salt);
    if (givenHash !== storedHash) return json({ error: "invalid credentials" }, 401);

    const token = await createSessionToken(chatId, env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookieHeader(token) });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  const chatId = await getSessionChatId(request, env);

  if (path === "/api/me" && request.method === "GET") {
    if (!chatId) return json({ error: "unauthorized" }, 401);
    const user = await notionFindUser(chatId, env);
    const displayName = user?.properties?.DisplayName?.rich_text?.[0]?.plain_text || null;
    return json({ chatId, displayName });
  }

  if (!chatId) return json({ error: "unauthorized" }, 401);

  if (path === "/api/meta" && request.method === "GET") {
    return json({
      categories: CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL_FA[c], emoji: CATEGORY_EMOJI[c] })),
      statuses: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL_FA[s] })),
    });
  }

  if (path === "/api/tasks" && request.method === "GET") {
    const items = await notionQueryByCategoryAndDate(null, "A", chatId, env);
    const tasks = items.map((it) => ({
      id: it.id.replace(/-/g, ""),
      shortId: it.shortId,
      name: it.name,
      category: it.category,
      status: it.status,
      dueDate: it.dueDate,
      cleanText: it.cleanText,
      rawText: it.rawText,
    }));
    return json({ tasks });
  }

  if (path === "/api/tasks" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400);
    }
    let source;
    if (body.audioBase64) {
      source = { kind: "audio", base64: body.audioBase64, mimeType: body.mimeType || "audio/webm" };
    } else if (body.text && body.text.trim()) {
      source = { kind: "text", text: body.text.trim() };
    } else {
      return json({ error: "متن یا صدایی ارسال نشد" }, 400);
    }

    const items = await classifyWithGemini(source, env);
    const created = [];
    for (const item of items) {
      const page = await notionCreatePageFull(chatId, item, env);
      created.push({
        id: page.id.replace(/-/g, ""),
        shortId: formatShortId(page),
        name: item.name,
        category: item.category,
        status: DEFAULT_STATUS,
        dueDate: item.due_date,
        cleanText: item.clean_text,
        rawText: item.raw_text,
      });
    }
    return json({ tasks: created });
  }

  const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9]{32})(\/restore)?$/);
  if (taskMatch) {
    const pageId = toDashedUuid(taskMatch[1]);
    const isRestore = !!taskMatch[2];

    // Always verify the task actually belongs to this session's chatId before mutating.
    const page = await notionGetPage(pageId, env);
    const ownerChatId = page.properties.ChatId?.number;
    if (ownerChatId !== chatId) return json({ error: "forbidden" }, 403);

    if (isRestore && request.method === "POST") {
      await notionUpdateStatus(pageId, DEFAULT_STATUS, env);
      return json({ ok: true });
    }

    if (request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad request" }, 400);
      }
      if (body.status !== undefined) await notionUpdateStatus(pageId, body.status, env);
      if (body.category !== undefined) await notionUpdateCategory(pageId, body.category, env);
      if (body.dueDate !== undefined) await notionUpdateDueDate(pageId, body.dueDate || null, env);
      if (body.name !== undefined || body.cleanText !== undefined) {
        const properties = {};
        if (body.name !== undefined) properties.Name = { title: [{ text: { content: body.name } }] };
        if (body.cleanText !== undefined) properties["Clean Text"] = { rich_text: [{ text: { content: body.cleanText } }] };
        await notionPatch(pageId, { properties }, `webapp update (${pageId})`, env);
      }
      return json({ ok: true });
    }

    if (request.method === "DELETE") {
      await notionSoftDelete(pageId, env);
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

// ---------- Frontend ----------

export function renderAppHtml() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>تسک‌های من</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f6fa;
    --card-bg: #ffffff;
    --border: #e4e6ee;
    --text: #1f2430;
    --text-muted: #6b7280;
    --accent: #4f46e5;
    --accent-dark: #4338ca;
    --success: #16a34a;
    --success-dark: #15803d;
    --danger: #e11d48;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Vazirmatn', sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  #app { min-height: 100vh; display: flex; flex-direction: column; }

  /* ---- Login ---- */
  .login-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .login-box {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 32px; width: 100%; max-width: 360px; box-shadow: 0 10px 30px rgba(20,20,40,0.06);
  }
  .login-box h1 { font-size: 20px; margin: 0 0 24px; text-align: center; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    font-family: inherit; font-size: 14px; background: #fff; color: var(--text);
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 16px; border-radius: 8px; border: none; font-family: inherit;
    font-size: 14px; cursor: pointer; transition: background .15s;
  }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; }
  .btn-primary:hover { background: var(--accent-dark); }
  .btn-ghost { background: transparent; color: var(--text-muted); }
  .btn-ghost:hover { background: #eef0f6; }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-success {
    background: var(--success); color: #fff; font-weight: 600; padding: 10px 18px 10px 16px;
    border-radius: 999px; box-shadow: 0 2px 8px rgba(22,163,74,0.35);
  }
  .btn-success:hover { background: var(--success-dark); box-shadow: 0 4px 12px rgba(22,163,74,0.45); transform: translateY(-1px); }
  .btn-success svg { width: 18px; height: 18px; flex-shrink: 0; }
  .error-msg { color: var(--danger); font-size: 13px; margin-top: 10px; min-height: 16px; }

  /* ---- Top bar ---- */
  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 20px; background: #fff; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 10;
  }
  .topbar h1 { font-size: 17px; margin: 0; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 20px; background: #fff; border-bottom: 1px solid var(--border); }
  .chip {
    padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: #fff;
    font-size: 13px; cursor: pointer; user-select: none; color: var(--text-muted);
  }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .filters select {
    padding: 6px 10px; border-radius: 999px; border: 1px solid var(--border); font-family: inherit; font-size: 13px;
  }

  /* ---- Board ---- */
  .board { flex: 1; display: flex; gap: 16px; padding: 20px; overflow-x: auto; align-items: flex-start; }
  .column { background: #eef0f6; border-radius: var(--radius); min-width: 260px; max-width: 280px; flex: 1 0 260px; display: flex; flex-direction: column; max-height: calc(100vh - 160px); }
  .column-header { padding: 12px 14px; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
  .column-count { font-size: 12px; color: var(--text-muted); background: #fff; border-radius: 999px; padding: 2px 8px; }
  .column-body { padding: 0 10px 10px; overflow-y: auto; flex: 1; min-height: 60px; }
  .column-body.drag-over { background: #e0e3ef; border-radius: 8px; }

  .card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; margin-bottom: 8px; cursor: grab; box-shadow: 0 1px 3px rgba(20,20,40,0.04);
  }
  .card:active { cursor: grabbing; }
  .card.dragging { opacity: 0.4; }
  .card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .card-id { font-size: 11px; color: var(--text-muted); }
  .card-cat { font-size: 11px; background: #f1f2f8; border-radius: 6px; padding: 2px 6px; }
  .card-title { font-size: 14px; font-weight: 500; margin-bottom: 4px; line-height: 1.5; }
  .card-date { font-size: 11px; color: var(--text-muted); }
  .card-date.soon { color: #b45309; font-weight: 600; }

  /* ---- Modal ---- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(20,20,40,0.35); display: flex;
    align-items: center; justify-content: center; padding: 16px; z-index: 50;
  }
  .modal {
    background: #fff; border-radius: var(--radius); padding: 24px; width: 100%; max-width: 440px;
    max-height: 90vh; overflow-y: auto;
  }
  .modal h2 { font-size: 16px; margin: 0 0 18px; }
  .modal-actions { display: flex; justify-content: space-between; margin-top: 20px; gap: 8px; }
  .hidden { display: none !important; }
  .empty-msg { color: var(--text-muted); font-size: 13px; padding: 20px 8px; text-align: center; }
</style>
</head>
<body>
<div id="app">
  <div id="login-wrap" class="login-wrap hidden">
    <div class="login-box">
      <h1>📋 ورود به تسک‌های من</h1>
      <div class="field">
        <label>شناسه (Chat ID تلگرام)</label>
        <input id="login-chatid" type="number" inputmode="numeric" placeholder="مثلاً 89528966" />
      </div>
      <div class="field">
        <label>رمز ۸ رقمی</label>
        <input id="login-password" type="password" inputmode="numeric" placeholder="********" />
      </div>
      <button class="btn btn-primary" id="login-btn">ورود</button>
      <div class="error-msg" id="login-error"></div>
    </div>
  </div>

  <div id="board-wrap" class="hidden">
    <div class="topbar">
      <h1>📋 تسک‌های <span id="greet-name">من</span></h1>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-success" id="new-task-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          تسک جدید
        </button>
        <button class="btn btn-ghost" id="logout-btn">خروج</button>
      </div>
    </div>
    <div class="filters" id="filters"></div>
    <div class="board" id="board"></div>
  </div>
</div>

<div class="modal-overlay hidden" id="new-task-overlay">
  <div class="modal">
    <h2>➕ تسک جدید</h2>
    <div class="field">
      <label>متن</label>
      <textarea id="nt-text" rows="4" placeholder="مثلاً: فردا باید با مسعود تماس بگیرم..."></textarea>
    </div>
    <div class="field" style="text-align:center;">
      <button class="btn btn-ghost" id="nt-record">🎙 ضبط صدا</button>
      <div id="nt-record-status" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
    </div>
    <div class="error-msg" id="nt-error"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="nt-cancel">انصراف</button>
      <button class="btn btn-primary" id="nt-submit">ثبت</button>
    </div>
  </div>
</div>

<div class="modal-overlay hidden" id="modal-overlay">
  <div class="modal">
    <h2>ویرایش تسک <span id="modal-id"></span></h2>
    <div class="field">
      <label>عنوان</label>
      <input id="m-name" type="text" />
    </div>
    <div class="field">
      <label>دسته</label>
      <select id="m-category"></select>
    </div>
    <div class="field">
      <label>وضعیت</label>
      <select id="m-status"></select>
    </div>
    <div class="field">
      <label>تاریخ سررسید</label>
      <input id="m-date" type="date" />
    </div>
    <div class="field">
      <label>توضیح (متن تمیزشده)</label>
      <textarea id="m-clean" rows="4"></textarea>
    </div>
    <div class="field">
      <label>متن اصلی (فقط نمایش)</label>
      <textarea id="m-raw" rows="3" readonly style="background:#f7f7fa;color:#888;"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="m-delete">🗑 حذف</button>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-ghost" id="m-cancel">انصراف</button>
        <button class="btn btn-primary" id="m-save">ذخیره</button>
      </div>
    </div>
  </div>
</div>

<script>
let META = null;
let TASKS = [];
let activeCategoryFilter = new Set();
let activeDateFilter = "A";
let editingTaskId = null;

async function api(path, opts) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts && opts.headers) } });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return res;
}

function showLogin() {
  document.getElementById("login-wrap").classList.remove("hidden");
  document.getElementById("board-wrap").classList.add("hidden");
}
function showBoard() {
  document.getElementById("login-wrap").classList.add("hidden");
  document.getElementById("board-wrap").classList.remove("hidden");
}

async function init() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) { showLogin(); return; }
    const me = await res.json();
    document.getElementById("greet-name").textContent = me.displayName || "من";
  } catch { showLogin(); return; }
  await loadMeta();
  await loadTasks();
  showBoard();
}

document.getElementById("login-btn").addEventListener("click", async () => {
  const chatId = document.getElementById("login-chatid").value.trim();
  const password = document.getElementById("login-password").value.trim();
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!chatId || !password) { errEl.textContent = "شناسه و رمز رو وارد کن."; return; }
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: Number(chatId), password }) });
  if (!res.ok) { errEl.textContent = "شناسه یا رمز اشتباهه."; return; }
  await loadMeta();
  await loadTasks();
  showBoard();
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
});

async function loadMeta() {
  const res = await api("/api/meta");
  META = await res.json();
  activeCategoryFilter = new Set(META.categories.map((c) => c.value));
  renderFilters();
}

async function loadTasks() {
  const res = await api("/api/tasks");
  const data = await res.json();
  TASKS = data.tasks;
  renderBoard();
}

function renderFilters() {
  const el = document.getElementById("filters");
  el.innerHTML = "";
  META.categories.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "chip" + (activeCategoryFilter.has(c.value) ? " active" : "");
    chip.textContent = c.emoji + " " + c.label;
    chip.onclick = () => {
      if (activeCategoryFilter.has(c.value)) activeCategoryFilter.delete(c.value);
      else activeCategoryFilter.add(c.value);
      renderFilters();
      renderBoard();
    };
    el.appendChild(chip);
  });
  const select = document.createElement("select");
  [["A", "همه تاریخ‌ها"], ["T", "امروز"], ["M", "فردا"], ["W", "این هفته"], ["NONE", "بدون تاریخ"]].forEach(([v, label]) => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = label;
    if (v === activeDateFilter) opt.selected = true;
    select.appendChild(opt);
  });
  select.onchange = (e) => { activeDateFilter = e.target.value; renderBoard(); };
  el.appendChild(select);
}

function todayIso() {
  return new Date().toLocaleDateString("en-CA");
}
function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Iranian week: Saturday..Friday (not the Western Monday-start week).
function iranianWeekEnd(today) {
  const dow = new Date(today + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  const daysSinceSaturday = (dow - 6 + 7) % 7;
  const thisStart = addDaysIso(today, -daysSinceSaturday);
  return addDaysIso(thisStart, 6);
}

function passesDateFilter(task) {
  if (activeDateFilter === "A") return true;
  if (activeDateFilter === "NONE") return !task.dueDate;
  if (!task.dueDate) return false;
  const today = todayIso();
  if (activeDateFilter === "T") return task.dueDate === today;
  if (activeDateFilter === "M") return task.dueDate === addDaysIso(today, 1);
  if (activeDateFilter === "W") return task.dueDate >= today && task.dueDate <= iranianWeekEnd(today);
  return true;
}

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  const visible = TASKS.filter((t) => activeCategoryFilter.has(t.category) && passesDateFilter(t));

  META.statuses.forEach((s) => {
    const col = document.createElement("div");
    col.className = "column";
    const items = visible.filter((t) => t.status === s.value);

    const header = document.createElement("div");
    header.className = "column-header";
    header.innerHTML = '<span>' + s.label + '</span><span class="column-count">' + items.length + '</span>';
    col.appendChild(header);

    const body = document.createElement("div");
    body.className = "column-body";
    body.dataset.status = s.value;

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-msg";
      empty.textContent = "چیزی نیست";
      body.appendChild(empty);
    }

    items.forEach((t) => body.appendChild(renderCard(t)));

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const taskId = e.dataTransfer.getData("text/plain");
      const newStatus = body.dataset.status;
      const task = TASKS.find((t) => t.id === taskId);
      if (!task || task.status === newStatus) return;
      task.status = newStatus;
      renderBoard();
      await api("/api/tasks/" + taskId, { method: "PATCH", body: JSON.stringify({ status: newStatus }) });
    });

    col.appendChild(body);
    board.appendChild(col);
  });
}

function categoryMeta(value) {
  return (META.categories.find((c) => c.value === value)) || { emoji: "📌", label: value };
}

function renderCard(t) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = t.id;

  const cat = categoryMeta(t.category);
  const today = todayIso();
  let dateHtml = "";
  if (t.dueDate) {
    const soon = t.dueDate === today || t.dueDate === addDaysIso(today, 1);
    dateHtml = '<div class="card-date' + (soon ? " soon" : "") + '">📅 ' + t.dueDate + "</div>";
  }

  card.innerHTML =
    '<div class="card-top"><span class="card-id">#' + t.shortId + '</span><span class="card-cat">' + cat.emoji + " " + cat.label + "</span></div>" +
    '<div class="card-title">' + escapeHtml(t.name) + "</div>" +
    dateHtml;

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openModal(t.id));

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function openModal(taskId) {
  const t = TASKS.find((x) => x.id === taskId);
  if (!t) return;
  editingTaskId = taskId;
  document.getElementById("modal-id").textContent = "#" + t.shortId;
  document.getElementById("m-name").value = t.name || "";
  document.getElementById("m-clean").value = t.cleanText || "";
  document.getElementById("m-raw").value = t.rawText || "";
  document.getElementById("m-date").value = t.dueDate || "";

  const catSel = document.getElementById("m-category");
  catSel.innerHTML = "";
  META.categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.value; opt.textContent = c.emoji + " " + c.label;
    if (c.value === t.category) opt.selected = true;
    catSel.appendChild(opt);
  });

  const stSel = document.getElementById("m-status");
  stSel.innerHTML = "";
  META.statuses.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.value; opt.textContent = s.label;
    if (s.value === t.status) opt.selected = true;
    stSel.appendChild(opt);
  });

  document.getElementById("modal-overlay").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  editingTaskId = null;
}

document.getElementById("m-cancel").addEventListener("click", closeModal);
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

document.getElementById("m-save").addEventListener("click", async () => {
  if (!editingTaskId) return;
  const body = {
    name: document.getElementById("m-name").value,
    category: document.getElementById("m-category").value,
    status: document.getElementById("m-status").value,
    dueDate: document.getElementById("m-date").value || null,
    cleanText: document.getElementById("m-clean").value,
  };
  await api("/api/tasks/" + editingTaskId, { method: "PATCH", body: JSON.stringify(body) });
  closeModal();
  await loadTasks();
});

document.getElementById("m-delete").addEventListener("click", async () => {
  if (!editingTaskId) return;
  if (!confirm("این تسک حذف (مخفی) بشه؟")) return;
  await api("/api/tasks/" + editingTaskId, { method: "DELETE" });
  closeModal();
  await loadTasks();
});

// ---- New task (text or voice) ----
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;

function openNewTaskModal() {
  document.getElementById("nt-text").value = "";
  document.getElementById("nt-error").textContent = "";
  document.getElementById("nt-record-status").textContent = "";
  recordedBlob = null;
  document.getElementById("nt-record").textContent = "🎙 ضبط صدا";
  document.getElementById("new-task-overlay").classList.remove("hidden");
}
function closeNewTaskModal() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  document.getElementById("new-task-overlay").classList.add("hidden");
}

document.getElementById("new-task-btn").addEventListener("click", openNewTaskModal);
document.getElementById("nt-cancel").addEventListener("click", closeNewTaskModal);
document.getElementById("new-task-overlay").addEventListener("click", (e) => {
  if (e.target.id === "new-task-overlay") closeNewTaskModal();
});

document.getElementById("nt-record").addEventListener("click", async () => {
  const btn = document.getElementById("nt-record");
  const statusEl = document.getElementById("nt-record-status");
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      btn.textContent = "🎙 ضبط صدا";
      statusEl.textContent = "✅ صدا ضبط شد (" + Math.round(recordedBlob.size / 1024) + " کیلوبایت)";
    };
    mediaRecorder.start();
    btn.textContent = "⏹ توقف ضبط";
    statusEl.textContent = "در حال ضبط...";
  } catch (err) {
    statusEl.textContent = "دسترسی به میکروفون داده نشد.";
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

document.getElementById("nt-submit").addEventListener("click", async () => {
  const errEl = document.getElementById("nt-error");
  errEl.textContent = "";
  const text = document.getElementById("nt-text").value.trim();
  const submitBtn = document.getElementById("nt-submit");

  if (!text && !recordedBlob) { errEl.textContent = "یا متن بنویس یا صدا ضبط کن."; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = "در حال پردازش...";
  try {
    let body;
    if (recordedBlob) {
      const base64 = await blobToBase64(recordedBlob);
      body = { audioBase64: base64, mimeType: recordedBlob.type };
    } else {
      body = { text };
    }
    const res = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "ثبت نشد، دوباره امتحان کن.";
      return;
    }
    closeNewTaskModal();
    await loadTasks();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "ثبت";
  }
});

init();
</script>
</body>
</html>`;
}
