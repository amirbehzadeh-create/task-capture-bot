# Task Capture Bot

Voice/text-to-task capture over Telegram, plus a small web Kanban board — built as a single
Cloudflare Worker with no local server, no database of its own (Notion is the store).

## Architecture

```
Telegram (voice/text) ─┐
                        ├─> Cloudflare Worker (worker.js) ──> Gemini (classify + transcribe)
Web board (webapp.js) ──┘                                 └─> Notion (storage)
```

- **worker.js** — Telegram webhook handler: capture, classify/transcribe (Gemini, with retry +
  timeout), multi-item splitting, store (Notion), inline-keyboard actions (category/status/
  due-date/delete/edit-text, each with undo where it makes sense), `/list`, quick views, `/start`,
  `/webapp`, `/resetpassword`. Also the single entry point (`fetch`) that routes to the web app.
- **webapp.js** — the web Kanban board: login (chatId + password), session cookies (HMAC-signed),
  JSON API under `/api/*`, and the HTML/CSS/JS for the board itself (vanilla JS, drag-and-drop,
  no build step, no framework).
- Deployed with `wrangler` (Cloudflare's CLI) directly from this folder — no CI, no separate build.
- Multi-user: every item is tagged with the Telegram `ChatId` that created it, and every read/write
  path (bot and web) filters/checks on it server-side — not just hidden in the UI.
- Soft delete only: nothing is ever hard-deleted. A "delete" just sets `Status: deleted`, which is
  excluded from every list/query; the row stays in Notion and can be recovered there directly.

## Notion databases

All data lives in Notion, reachable from any Notion client independent of this bot:

| Database | Purpose |
|---|---|
| **Task Inbox** | The actual tasks (Name, Category, Status, Due Date, Raw Text, Clean Text, ChatId, auto `ID`) |
| **Bot Users** | Web-login credentials per Telegram chat id (ChatId, PasswordHash, Salt, DisplayName, DigestEnabled, DigestHour) |
| **Bot Error Log** | Every caught error across the whole flow, for debugging without a live session |
| **Bot Feedback** | Free-text feedback users send the creator (ChatId, DisplayName, Text) — kept separate from Task Inbox |
| **Task Updates** | Progress notes/comments logged against a task (TaskId, ChatId, Text), independent of its Status |

The Worker talks to Notion via a **Notion internal integration** named `TaskBotWorker`. Any new
Notion database this project needs must be manually shared with that integration from Notion's UI
(a database's `...` menu → `Connections` → `TaskBotWorker`) — this cannot be done via the API.

## Required secrets

Set via `wrangler secret put <NAME>` from this folder (never stored in a file):

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `GEMINI_API_KEY` — from Google AI Studio (free tier)
- `NOTION_SECRET` — the `TaskBotWorker` integration's internal secret
- `NOTION_DATABASE_ID` — Task Inbox database id
- `NOTION_ERROR_DB_ID` — Bot Error Log database id
- `NOTION_USERS_DB_ID` — Bot Users database id
- `NOTION_FEEDBACK_DB_ID` — Bot Feedback database id
- `NOTION_UPDATES_DB_ID` — Task Updates database id
- `WEB_SESSION_SECRET` — random secret for signing web session cookies

## Deploying

```bash
npx wrangler deploy
```

Deploys to `https://task-capture-bot.mytaskcapture.workers.dev` (the `workers.dev` subdomain is
already registered on the Cloudflare account). The Telegram webhook is set once via:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://task-capture-bot.mytaskcapture.workers.dev"
```

## Debugging

- Live logs: `npx wrangler tail --format pretty` (only while connected).
- Persistent logs: the **Bot Error Log** Notion database — every meaningful failure lands there
  with context, message, and chat id, independent of any terminal session.

## Resilience notes

- Telegram webhook responses return instantly; all real work (Gemini, Notion, Telegram sends)
  runs inside `ctx.waitUntil(...)` so a slow step can't make Telegram time out and kill the request.
- Gemini calls have a 20s timeout (`fetchWithTimeout`) and a 3-attempt retry with user-visible
  "در حال تلاش مجدد..." progress messages; after 3 failures the placeholder row is soft-deleted
  and the user is asked to resend, instead of leaving a stuck "⏳ در حال پردازش..." row.
- `editOrSend` falls back from `editMessageText` to a brand-new `sendMessage` whenever Telegram
  refuses the edit, so a card can never get stuck on a stale message.
- Dates respect the **Iranian week** (Saturday–Friday, not Monday–Sunday) everywhere — Gemini's
  date-resolution prompts, the `/list` "this week" filter, and the web board's date filter all use
  the same Saturday-start week math.

## Telegram commands

- Any voice/text → captured, transcribed/cleaned, classified, optionally date-tagged, split into
  multiple items if the message contains more than one distinct task/idea/purchase/etc.
- `/start` — onboarding + issues web-board credentials (chat id + password, tap-to-copy) if not
  already set.
- `/list` or the "📋 لیست" keyboard button — browse by category + date range (today/tomorrow/this
  week/all).
- "📅 فردا چی‌کارم؟" keyboard button — everything due today/tomorrow, all categories.
- `/webapp` — show the web board URL + credentials (or how to reset them).
- `/resetpassword` — issue a new web-board password (includes the web board URL).
- "💬 فیدبک" keyboard button — reply with free text; it's saved straight to the **Bot Feedback**
  database (not the Task Inbox), so it never shows up mixed in with the user's own tasks.
- "⏰ خلاصه روزانه" keyboard button — off by default; pick 8, 9 or 10 AM (Tehran time) and a
  scheduled Worker (`scheduled` export, cron in `wrangler.toml`) sends a short daily summary of
  that day's open items at the chosen hour. Toggling it on auto-creates the user's Bot Users row
  (with web credentials) if `/start` was never run, so it never silently no-ops.

### Per-item actions (inline buttons on every captured item)

- ✏️ دسته / 🔄 وضعیت — change category or status, each with a one-tap "↩️ واگرد" undo button.
- 📅 تاریخ — quick-pick a day, or "✏️ تایپ کن" to reply with a typed date (handled via a hidden
  `#ref:<id>` tag on the prompt message, so no extra storage is needed); also has undo.
- 📝 ویرایش متن — reply with corrected text to overwrite the item's title + clean description,
  e.g. when Gemini mis-transcribed a word from voice. Raw Text (the original transcript) is kept
  untouched as a record of what was actually heard.
- 🗑 حذف — asks for a yes/no confirmation first; soft-deletes on confirm, with an "↩️ برگردون" undo.
- 🗒 آپدیت‌ها — shows the last 5 progress notes and lets you add a new one (force_reply), stored in
  the **Task Updates** database, independent of Status — a way to log what moved forward on a task
  without changing its column.

## Web board

`https://task-capture-bot.mytaskcapture.workers.dev` — log in with your Telegram chat id and the
password the bot gave you. Each user only ever sees/edits their own tasks (enforced server-side,
not just hidden in the UI). Due dates are shown in Jalali (`دوشنبه 1405/07/13`), with an optional
custom from/to date-range filter alongside the quick today/tomorrow/this-week ones.

Creating a new task (typed text or a recorded voice note) is a two-step flow, mirroring the
Telegram confirmation message: `POST /api/tasks/preview` classifies with Gemini and returns the
proposed item(s) *without writing anything to Notion yet*; the UI shows an editable review card
(title, category, due date, description) per item, and only on confirm does `POST /api/tasks`
(now accepting a pre-built `items` array) actually create the Notion page(s). Every task card's
edit modal also has a progress-updates timeline, backed by the **Task Updates** database, with an
add box — separate from the drag-and-drop status column, so you can log what progressed without
touching Status.

Other board features: drag-and-drop between status columns, click-to-edit, and filters by
category and date range.
