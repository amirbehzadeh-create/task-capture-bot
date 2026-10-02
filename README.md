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
| **Bot Users** | Web-login credentials per Telegram chat id (ChatId, PasswordHash, Salt, DisplayName) |
| **Bot Error Log** | Every caught error across the whole flow, for debugging without a live session |

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

### Per-item actions (inline buttons on every captured item)

- ✏️ دسته / 🔄 وضعیت — change category or status, each with a one-tap "↩️ واگرد" undo button.
- 📅 تاریخ — quick-pick a day, or "✏️ تایپ کن" to reply with a typed date (handled via a hidden
  `#ref:<id>` tag on the prompt message, so no extra storage is needed); also has undo.
- 📝 ویرایش متن — reply with corrected text to overwrite the item's title + clean description,
  e.g. when Gemini mis-transcribed a word from voice. Raw Text (the original transcript) is kept
  untouched as a record of what was actually heard.
- 🗑 حذف — asks for a yes/no confirmation first; soft-deletes on confirm, with an "↩️ برگردون" undo.

## Web board

`https://task-capture-bot.mytaskcapture.workers.dev` — log in with your Telegram chat id and the
password the bot gave you. Each user only ever sees/edits their own tasks (enforced server-side,
not just hidden in the UI). Supports creating new tasks from the browser too (typed text or a
recorded voice note), drag-and-drop between status columns, click-to-edit, and filters by category
and date range.
