# Agent setup prompt — Task Capture Bot

> Paste this whole file as the first message to an AI coding agent (Claude Code or
> similar) that has access to this repository, a terminal, and can talk back and
> forth with the human operator. It is written as a self-contained instruction set:
> follow it top to bottom, stop and ask the human for anything marked **ASK**, and
> never invent a credential, ID, or secret value yourself.

## What you're deploying

A Telegram bot that turns a voice note or text message into a classified, organized
task — plus a small web Kanban board over the same data. Everything runs as a single
Cloudflare Worker (no server to manage, no database of its own). The full flow:

```
Telegram (voice/text) ─┐
                        ├─> Cloudflare Worker (worker.js) ──> Gemini (classify + transcribe)
Web board (webapp.js) ──┘                                 └─> Notion (storage)
```

- `worker.js` — Telegram webhook handler, the daily-digest cron handler, and all the
  shared Notion/Gemini helper functions.
- `webapp.js` — the web board: login, JSON API under `/api/*`, and the HTML/CSS/JS
  for the board itself (plain JS, no framework, no build step).
- `wrangler.toml` — Cloudflare Worker config, including the cron triggers for the
  daily digest.
- All persistent data lives in **Notion** (five databases, schemas below). There is
  no KV, D1, or other storage.
- The only paid-adjacent dependency is Google Gemini, used on its **free tier** —
  this project is designed to run at zero cost.

Read `README.md` in this repo too — it documents the shipped feature set in detail.
This file is about *standing the system up from nothing*, not about what it does.

## Before you start: what you need from the human operator

Tell the human up front that they'll need accounts on four free services, and that
you'll walk them through each one. Nothing here costs money at the scale one person
would use it.

1. A **Telegram account** (to create the bot via @BotFather).
2. A **Google account** (for a free Gemini API key via Google AI Studio).
3. A **Notion account** (free plan is fine) — this is where all data lives.
4. A **Cloudflare account** (free plan) — this is where the bot actually runs.

You (the agent) will need: `npx` available, a terminal, and — once the human
authenticates `wrangler` — the ability to run `wrangler` commands and set secrets.

**ASK** the human to confirm they have (or are willing to create) all four accounts
before proceeding. Do each step below one at a time; don't batch credential requests.

## Step 1 — Telegram bot

1. Tell the human to open a chat with **@BotFather** in Telegram, send `/newbot`,
   and follow the prompts (pick a name and a username ending in `bot`).
2. BotFather replies with a token that looks like `123456789:AA...`. **ASK** the
   human to paste it to you. This is `TELEGRAM_BOT_TOKEN`. Treat it as a secret —
   don't print it back in full once you have it.

## Step 2 — Gemini API key

1. Tell the human to go to Google AI Studio (aistudio.google.com), sign in, and
   create an API key. The free tier is sufficient for personal use.
2. **ASK** for the key. This is `GEMINI_API_KEY`.
3. Note for later: this codebase only ever calls Gemini via `-latest` model aliases
   (e.g. `gemini-flash-latest`), never a dated/versioned model name — dated names get
   deprecated by Google without warning, which broke this bot more than once during
   development. If you ever touch the model name in `worker.js` (`geminiGenerate`),
   keep that convention.

## Step 3 — Notion integration + five databases

### 3a. Create the integration

1. Tell the human to go to notion.so/my-integrations, create a new **internal
   integration** (any name — `TaskBotWorker` is what this project's own deployment
   uses, but any name works as long as you're consistent), and copy its "Internal
   Integration Secret". **ASK** for it — this is `NOTION_SECRET`.

### 3b. Create the five databases

If you have Notion MCP tools available in this session, create these directly. If
not, give the human these exact schemas to build by hand in the Notion UI (a
database per table, in whatever page of their workspace they like).

| Database | Properties (name — type) |
|---|---|
| **Task Inbox** | `Name` — title · `Category` — select (`Task`, `Idea`, `Follow-up`, `Purchase`, `Reminder`) · `Status` — select (`todo`, `reviewing`, `in_progress`, `done`, `skipped`, `deleted`) · `Due Date` — date · `Raw Text` — rich text · `Clean Text` — rich text · `ChatId` — number · `ID` — unique ID (any prefix, e.g. `T`) |
| **Bot Users** | `Name` — title · `ChatId` — number · `PasswordHash` — rich text · `Salt` — rich text · `DisplayName` — rich text · `DigestEnabled` — checkbox · `DigestHour` — number |
| **Bot Error Log** | `Name` — title · `Context` — rich text · `Message` — rich text · `ChatId` — number |
| **Bot Feedback** | `Name` — title · `ChatId` — number · `DisplayName` — rich text · `Text` — rich text · `Created` — created time |
| **Task Updates** | `Name` — title · `TaskId` — rich text · `ChatId` — number · `Text` — rich text · `Created` — created time |

Property names and types must match exactly (case-sensitive) — the code reads and
writes them by name via the raw Notion REST API, not a generic sync.

### 3c. Share every database with the integration — do not skip this

This is the single most common point of silent failure in this project's history.
Creating a database (even via the Notion API/MCP) does **not** automatically share
it with your integration. For **each of the five databases**, the human must:

1. Open the database in Notion.
2. Click the `...` menu → **Connections** → search for the integration's name →
   connect it.

If this step is skipped for any one database, that feature fails with a 404 from
Notion, often silently (e.g. error logging itself not working because Bot Error Log
wasn't shared). **ASK** the human to confirm, out loud, that they did this for all
five before you move on — don't just assume it from them saying "done."

### 3d. Get each database's ID

For each of the five databases, the ID is the 32-character hex string in its Notion
URL (no dashes needed), e.g. `notion.so/myworkspace/9f191136a8ed4d009844d66b12239d38`
→ id is `9f191136a8ed4d009844d66b12239d38`. Collect all five ids before Step 5.

## Step 4 — Cloudflare

1. **ASK** the human to confirm they have a Cloudflare account (free plan is fine),
   then run `npx wrangler login` from this repo's directory and have them complete
   the browser auth flow.
2. If this is the account's first Worker, it needs a `workers.dev` subdomain
   registered once from the Cloudflare dashboard (Workers & Pages → set up a
   subdomain) before the first deploy — otherwise the deployed URL returns a
   TLS/SSL error. Check for this if the first deploy's URL doesn't load.

## Step 5 — Secrets

Generate one more value yourself: a random secret for signing web session cookies.
Don't ask the human to invent one — generate it, e.g.:

```bash
openssl rand -hex 32
```

Then set all nine secrets, one at a time, from this repo's root directory. Use
`printf '%s' '<value>' | npx wrangler secret put <NAME>` (not `echo`, which can add
a trailing newline into the secret):

```bash
printf '%s' '<telegram bot token>'        | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' '<gemini api key>'            | npx wrangler secret put GEMINI_API_KEY
printf '%s' '<notion integration secret>' | npx wrangler secret put NOTION_SECRET
printf '%s' '<task inbox db id>'          | npx wrangler secret put NOTION_DATABASE_ID
printf '%s' '<bot error log db id>'       | npx wrangler secret put NOTION_ERROR_DB_ID
printf '%s' '<bot users db id>'           | npx wrangler secret put NOTION_USERS_DB_ID
printf '%s' '<bot feedback db id>'        | npx wrangler secret put NOTION_FEEDBACK_DB_ID
printf '%s' '<task updates db id>'        | npx wrangler secret put NOTION_UPDATES_DB_ID
printf '%s' '<generated hex secret>'      | npx wrangler secret put WEB_SESSION_SECRET
```

Wrangler secrets are write-only — there is no way to read a secret's value back
later, from you or from the human. If one is ever wrong, just `put` it again.

## Step 6 — Deploy

```bash
npx wrangler deploy
```

This uploads the Worker **and** registers the three cron triggers already declared
in `wrangler.toml` (the daily-digest schedule — see `README.md` for what it does).
The command's output prints the deployed URL, something like
`https://<worker-name>.<account-subdomain>.workers.dev`.

## Step 7 — Point Telegram at the deployed Worker

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<deployed worker url>"
```

Substitute the real token and URL. This only needs to be run once (and again any
time the deployed URL changes, which it normally won't).

## Step 8 — End-to-end verification

Walk through this with the human, in Telegram and the browser:

1. Send `/start` to the bot. It should reply with an onboarding message and issue a
   web-board chat id + password.
2. Send a plain-text message like "فردا باید با علی تماس بگیرم" (or anything in the
   human's own language — Gemini handles the input language). It should reply with
   a placeholder, then a classified confirmation with inline buttons.
3. Open the deployed URL in a browser, log in with the chat id + password from
   step 1, and confirm the task from step 2 shows up on the board.
4. Tap through a couple of the inline buttons in Telegram (category, status, date)
   to confirm they update and show the undo option.
5. If anything fails silently, check the **Bot Error Log** Notion database first —
   every meaningful failure in this codebase is written there with context, even
   when nothing error-like appears in the terminal.

If any step fails, the most likely cause (in order of frequency during this
project's own development) is: (a) a database not shared with the integration
(Step 3c), (b) a secret set with a trailing newline or typo, (c) the `workers.dev`
subdomain not yet registered (Step 4.2).

## Operating notes worth knowing before you touch the code

- Everything in `worker.js`'s Telegram handler runs inside `ctx.waitUntil(...)`,
  so the webhook response returns instantly and a slow Gemini/Notion call can't
  make Telegram kill the request mid-flight.
- Gemini calls have a 20s timeout and a 3-attempt retry baked in
  (`fetchWithTimeout`, `geminiGenerate`) — a hang becomes a catchable, retryable
  error instead of a silent platform kill.
- Soft delete only: nothing is ever hard-deleted. A "delete" sets
  `Status: deleted`, excluded from every query; the Notion row stays recoverable.
- Dates respect the **Iranian week** (Saturday–Friday), not the Western
  Monday-start week, everywhere — Gemini's date-resolution prompts, the `/list`
  "this week" filter, and the web board's date filter all share the same math
  (`iranianWeekBounds` in `worker.js`, `iranianWeekEnd` in `webapp.js`).
- The bot's own user-facing text (Telegram messages, the web board's UI) is
  hardcoded in Persian throughout the code, regardless of what language you used to
  do this setup. That's intentional — don't translate it unless the human asks.

## If you are doing this setup unattended / for someone else

- Never fabricate a token, API key, secret, or database ID. Every value in Step 5
  must come from either the human (Steps 1–3) or a value you generated yourself in
  front of them (the `WEB_SESSION_SECRET` in Step 5).
- Confirm Step 3c (database sharing) explicitly before deploying — it's silent and
  easy to skip, and the rest of this guide can't detect it for you.
- After deploying, actually run Step 8 rather than declaring success from the
  deploy command's exit code alone. A clean deploy says nothing about whether the
  Notion databases are wired up correctly.
