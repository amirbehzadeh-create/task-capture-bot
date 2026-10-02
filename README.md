# Task Capture Bot

Voice/text-to-task capture over Telegram, plus a small web Kanban board — built as a single
Cloudflare Worker with no local server, no database of its own (Notion is the store).

## Architecture

```
Telegram (voice/text) ─┐
                        ├─> Cloudflare Worker (worker.js) ──> Gemini (classify + transcribe)
Web board (webapp.js) ──┘                                 └─> Notion (storage)
```

- **worker.js** — Telegram webhook handler: capture, classify (Gemini), store (Notion), inline-keyboard
  actions (category/status/due-date/delete, each with undo), `/list`, quick views, `/start`,
  `/webapp`, `/resetpassword`. Also the single entry point (`fetch`) that routes to the web app.
- **webapp.js** — the web Kanban board: login (chatId + password), session cookies (HMAC-signed),
  JSON API under `/api/*`, and the HTML/CSS/JS for the board itself (vanilla JS, drag-and-drop,
  no build step, no framework).
- Deployed with `wrangler` (Cloudflare's CLI) directly from this folder — no CI, no separate build.

## Notion databases

All data lives in Notion, reachable from any Notion client independent of this bot:

| Database | Purpose |
|---|---|
| **Task Inbox** | The actual tasks (Name, Category, Status, Due Date, Raw Text, Clean Text, ChatId, auto `ID`) |
| **Bot Users** | Web-login credentials per Telegram chat id (ChatId, PasswordHash, Salt) |
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

## Telegram commands

- Any voice/text → captured, transcribed/cleaned, classified, optionally date-tagged.
- `/start` — onboarding + issues web-board credentials (chat id + password) if not already set.
- `/list` or the "📋 لیست" keyboard button — browse by category + date range.
- "📅 فردا چی‌کارم؟" keyboard button — everything due today/tomorrow, all categories.
- `/webapp` — show the web board URL + credentials (or how to reset them).
- `/resetpassword` — issue a new web-board password.

## Web board

`https://task-capture-bot.mytaskcapture.workers.dev` — log in with your Telegram chat id and the
password the bot gave you. Each user only ever sees/edits their own tasks (enforced server-side,
not just hidden in the UI).
