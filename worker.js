/**
 * Task Capture Bot — Cloudflare Worker
 * Telegram (voice/text) -> Gemini (transcribe+classify+date) -> Notion (store) -> Telegram (confirm/edit/delete/date)
 *
 * Required secrets (set via `wrangler secret put <NAME>`):
 *   TELEGRAM_BOT_TOKEN
 *   GEMINI_API_KEY
 *   NOTION_SECRET
 *   NOTION_DATABASE_ID   (e.g. aa8527cefb854b6b8269339e98ad82df)
 *   NOTION_USERS_DB_ID   (web-app login credentials store)
 *   WEB_SESSION_SECRET   (random secret for signing web session cookies)
 */

import { handleApi, renderAppHtml, notionFindUser, notionUpsertUser, notionUpdateDisplayName, hashPassword, randomSalt, generate8DigitPassword } from "./webapp.js";

const WEBAPP_BASE_URL = "https://task-capture-bot.mytaskcapture.workers.dev";
const TZ = "Asia/Tehran";
export const CATEGORIES = ["Task", "Idea", "Follow-up", "Purchase", "Reminder"];
export const CATEGORY_CODE = { Task: "T", Idea: "I", "Follow-up": "F", Purchase: "P", Reminder: "R" };
export const CODE_CATEGORY = { T: "Task", I: "Idea", F: "Follow-up", P: "Purchase", R: "Reminder" };
export const CATEGORY_EMOJI = { Task: "✅", Idea: "💡", "Follow-up": "🔁", Purchase: "🛒", Reminder: "⏰" };
export const CATEGORY_LABEL_FA = { Task: "کار", Idea: "ایده", "Follow-up": "پیگیری", Purchase: "خرید", Reminder: "یادآوری" };
// Stored in Notion in English; only the Telegram display uses Persian labels.
export const STATUSES = ["todo", "reviewing", "in_progress", "done", "skipped"];
export const STATUS_CODE = { todo: "N", reviewing: "R", in_progress: "P", done: "D", skipped: "S" };
export const CODE_STATUS = { N: "todo", R: "reviewing", P: "in_progress", D: "done", S: "skipped" };
export const STATUS_LABEL_FA = { todo: "انجام نشده", reviewing: "در حال بررسی", in_progress: "در حال انجام", done: "انجام شده", skipped: "انجام نمی‌دم فعلا" };
export const STATUS_EMOJI = { todo: "🆕", reviewing: "🔍", in_progress: "🚧", done: "✅", skipped: "⏭️" };
export const DEFAULT_STATUS = "todo";
const WEEKDAY_FA = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const PERSISTENT_KEYBOARD = {
  keyboard: [
    [{ text: "📋 لیست" }, { text: "📅 فردا چی‌کارم؟" }],
    [{ text: "⏰ خلاصه روزانه" }, { text: "💬 فیدبک" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// ---------- Durable error log (Notion) ----------
// Every meaningful failure across the flow lands here, so it's reviewable from
// the Notion app even without this chat/session open.
export async function logError(context, err, env, chatId) {
  const message = err && err.stack ? err.stack : String(err);
  console.error(context, message);
  if (!env?.NOTION_SECRET || !env?.NOTION_ERROR_DB_ID) return;
  try {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_SECRET}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_ERROR_DB_ID },
        properties: {
          Name: { title: [{ text: { content: context.slice(0, 200) } }] },
          Context: { rich_text: [{ text: { content: context.slice(0, 2000) } }] },
          Message: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
          ...(chatId ? { ChatId: { number: chatId } } : {}),
        },
      }),
    });
  } catch (logErr) {
    console.error("failed to persist error log", logErr);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, url, env);
      } catch (err) {
        await logError(`webapp api ${url.pathname}`, err, env);
        return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
      return new Response(renderAppHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (request.method !== "POST") {
      return new Response("Task Capture Bot is running.", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Answer Telegram immediately — do the real work in the background via
    // waitUntil, so a slow Gemini/Notion call can never cause Telegram to time
    // out and kill the request mid-flight (which used to fail completely silently).
    ctx.waitUntil(
      (async () => {
        try {
          if (update.callback_query) {
            await handleCallback(update.callback_query, env);
          } else if (update.message) {
            await handleMessage(update.message, env);
          }
        } catch (err) {
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          await logError("top-level handler", err, env, chatId);
        }
      })()
    );

    return new Response("ok", { status: 200 });
  },

  // Fires on the cron schedule in wrangler.toml (fixed UTC times matching
  // 8/9/10 AM Tehran, since Iran no longer observes DST).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyDigest(event, env));
  },
};

async function handleMessage(message, env) {
  const chatId = message.chat.id;

  // A reply to our "type a date" prompt carries a hidden #ref:<pageId> tag — handle it
  // as a date-setting reply instead of a brand-new capture.
  const replyRef = message.reply_to_message?.text?.match(/#ref:([a-f0-9]{32})/);
  if (replyRef && message.text) {
    await handleTypedDateReply(chatId, replyRef[1], message.text, env);
    return;
  }

  // A reply to our "edit text" prompt carries a hidden #edittext:<pageId> tag.
  const editTextRef = message.reply_to_message?.text?.match(/#edittext:([a-f0-9]{32})/);
  if (editTextRef && message.text) {
    await handleEditTextReply(chatId, editTextRef[1], message.text, env);
    return;
  }

  // A reply to our "feedback" prompt carries a hidden #feedback tag.
  if (message.reply_to_message?.text?.includes("#feedback") && message.text) {
    await handleFeedbackReply(chatId, message, env);
    return;
  }

  let transcriptSource; // { kind: 'audio', base64, mimeType } or { kind: 'text', text }
  let isVoice = false;

  if (message.voice || message.audio) {
    isVoice = true;
  } else if (message.text) {
    const displayName = message.from?.first_name || message.from?.username || null;

    if (message.text.startsWith("/start")) {
      let credLine;
      const existingUser = await notionFindUser(chatId, env);
      if (existingUser) {
        await notionUpdateDisplayName(chatId, displayName, env);
        credLine = `🖥 برد وب: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\nرمزت رو قبلاً فرستادم؛ یادت رفته؟ بزن /resetpassword`;
      } else {
        const password = generate8DigitPassword();
        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        await notionUpsertUser(chatId, hash, salt, env, displayName);
        credLine = `🖥 یه برد وب هم برات ساختم که از دسکتاپ هم بتونی کاراتو جابه‌جا کنی:\nآدرس: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\nرمز: <code>${password}</code>\n(این رمز رو یه جا نگه دار، دیگه نشونش نمی‌دم. هر وقت خواستی عوضش کنی، بزن /resetpassword)`;
      }

      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `سلام${displayName ? " " + displayName : ""}! 👋 با این بات می‌تونی:\n\n` +
          "🎙 هر وویس یا متنی بفرستی، خودم تبدیل، دسته‌بندی، و (اگه تاریخی توش بود) زمان‌دارش می‌کنم.\n" +
          "📋 با دکمه‌ی «لیست» یا «فردا چی‌کارم؟» کارهاتو ببینی.\n" +
          "✏️ رو هر آیتم دسته/وضعیت/تاریخشو عوض کنی یا حذفش کنی (با امکان واگرد).\n\n" +
          credLine,
        reply_markup: PERSISTENT_KEYBOARD,
      });
      return;
    }
    if (message.text.startsWith("/list") || message.text === "📋 لیست") {
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: "کدوم دسته رو می‌خوای ببینی؟",
        reply_markup: buildListCategoryKeyboard(),
      });
      return;
    }
    if (message.text === "📅 فردا چی‌کارم؟") {
      const items = await notionQueryByCategoryAndDate(null, "TM", chatId, env);
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: formatListHeader(null, "TM", items.length),
      });
      await sendItemMessages(env, chatId, items);
      return;
    }
    if (message.text === "/webapp") {
      const existing = await notionFindUser(chatId, env);
      if (existing) {
        await notionUpdateDisplayName(chatId, displayName, env);
        await telegramCall(env, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `پنل وب: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\n\nرمزت رو قبلاً فرستادم؛ اگه یادت رفته /resetpassword رو بزن تا یه رمز جدید بسازم.`,
        });
      } else {
        const password = generate8DigitPassword();
        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        await notionUpsertUser(chatId, hash, salt, env, displayName);
        await telegramCall(env, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `پنل وب فعال شد ✅\nآدرس: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\nرمز: <code>${password}</code>\n\nاین رمز رو یه جا نگه دار، دیگه نشونش نمی‌دم.`,
        });
      }
      return;
    }
    if (message.text === "💬 فیدبک") {
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: "فیدبکت رو بنویس — مستقیم برای سازنده‌ی بات می‌ره، جای تسک‌هات ذخیره نمی‌شه.\n#feedback",
        reply_markup: { force_reply: true, input_field_placeholder: "فیدبکتو بنویس..." },
      });
      return;
    }
    if (message.text === "⏰ خلاصه روزانه") {
      const user = await notionFindUser(chatId, env);
      const enabled = !!user?.properties?.DigestEnabled?.checkbox;
      const hour = user?.properties?.DigestHour?.number || null;
      const statusText = enabled
        ? `⏰ خلاصه روزانه فعاله — هر روز ساعت ${hour} صبح (به‌وقت ایران) خلاصه‌ی کارای اون روزتو برات می‌فرستم.`
        : "⏰ خلاصه روزانه الان خاموشه. یه ساعت انتخاب کن تا هر روز صبح خلاصه‌ی کارای اون روزتو بفرستم:";
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: statusText,
        reply_markup: buildDigestKeyboard(enabled, hour),
      });
      return;
    }
    if (message.text === "/resetpassword") {
      const password = generate8DigitPassword();
      const salt = randomSalt();
      const hash = await hashPassword(password, salt);
      await notionUpsertUser(chatId, hash, salt, env, displayName);
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `رمز جدید ساخته شد ✅\nآدرس: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\nرمز: <code>${password}</code>`,
      });
      return;
    }
    if (message.text.startsWith("/")) {
      return; // unknown bot command — never feed it into the capture flow
    }
  } else {
    return; // ignore stickers, photos, etc. for now
  }

  // Create a placeholder row immediately so we have a short ID to show right away,
  // and so the user can keep sending more messages without waiting on Gemini.
  let page;
  try {
    page = await notionCreatePlaceholder(chatId, env);
  } catch (err) {
    await logError("notionCreatePlaceholder", err, env, chatId);
    await telegramCall(env, "sendMessage", { chat_id: chatId, text: "⚠️ نتونستم ثبت اولیه رو انجام بدم، دوباره امتحان کن." });
    return;
  }
  const shortId = formatShortId(page);
  const pageIdNoDash = page.id.replace(/-/g, "");

  const ack = await telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: `${isVoice ? "🎧 وویس" : "✍️ متن"} #${shortId} دریافت شد، در حال پردازش...`,
    reply_markup: PERSISTENT_KEYBOARD,
  });
  const ackMessageId = ack?.result?.message_id;

  try {
    if (isVoice) {
      const fileId = (message.voice || message.audio).file_id;
      const audio = await downloadTelegramFile(fileId, env);
      transcriptSource = { kind: "audio", base64: audio.base64, mimeType: audio.mimeType };
    } else {
      transcriptSource = { kind: "text", text: message.text };
    }

    const MAX_ATTEMPTS = 3;
    let items;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        items = await classifyWithGemini(transcriptSource, env);
        break;
      } catch (err) {
        lastErr = err;
        await logError(`classifyWithGemini attempt ${attempt}/${MAX_ATTEMPTS} (item #${shortId})`, err, env, chatId);
        if (attempt < MAX_ATTEMPTS && ackMessageId) {
          await editOrSend(env, {
            chat_id: chatId,
            message_id: ackMessageId,
            text: `🔁 اولین تلاش جواب نداد، دوباره امتحان می‌کنم (${attempt + 1} از ${MAX_ATTEMPTS})...`,
          });
        }
      }
    }
    if (!items) throw lastErr;
    const [first, ...rest] = items;

    await notionUpdatePageContent(page.id, first, env);
    const confirmation = formatConfirmationText(first, shortId);
    if (ackMessageId) {
      await editOrSend(env, {
        chat_id: chatId,
        message_id: ackMessageId,
        text: confirmation,
        reply_markup: buildKeyboard(pageIdNoDash),
      });
    } else {
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: confirmation,
        reply_markup: buildKeyboard(pageIdNoDash),
      });
    }

    // If Gemini split the input into several distinct items, the first reuses
    // the placeholder above; the rest get brand-new records + their own messages.
    for (const extra of rest) {
      const extraPage = await notionCreatePageFull(chatId, extra, env);
      const extraShortId = formatShortId(extraPage);
      await telegramCall(env, "sendMessage", {
        chat_id: chatId,
        text: formatConfirmationText(extra, extraShortId),
        reply_markup: buildKeyboard(extraPage.id.replace(/-/g, "")),
      });
    }
  } catch (err) {
    await logError(`handleMessage processing (item #${shortId})`, err, env, chatId);
    await notionSoftDelete(page.id, env); // don't leave a junk "⏳ در حال پردازش..." row behind
    const failText = `⚠️ متأسفیم، بعد از چند بار تلاش هم نشد پردازشش کنیم. #${shortId} پاک شد — لطفاً از اول دوباره بفرست.`;
    if (ackMessageId) {
      await editOrSend(env, { chat_id: chatId, message_id: ackMessageId, text: failText });
    } else {
      await telegramCall(env, "sendMessage", { chat_id: chatId, text: failText });
    }
  }
}

async function handleTypedDateReply(chatId, pageIdNoDash, typedText, env) {
  const pageId = toDashedUuid(pageIdNoDash);
  const today = todayInTehran();
  const resolved = await resolveDateWithGemini(typedText, today, env);

  if (!resolved) {
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      text: "متوجه تاریخ نشدم 🤔 یه بار دیگه واضح‌تر بنویس (مثلاً «یکشنبه» یا «2026-10-10»).",
    });
    return;
  }

  await notionUpdateDueDate(pageId, resolved, env);
  await telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: `📅 تاریخ ثبت شد: ${formatPersianDate(resolved)}`,
  });
}

async function handleEditTextReply(chatId, pageIdNoDash, newText, env) {
  const pageId = toDashedUuid(pageIdNoDash);
  const trimmed = newText.trim();
  if (!trimmed) {
    await telegramCall(env, "sendMessage", { chat_id: chatId, text: "متن خالی بود، چیزی تغییر نکرد." });
    return;
  }
  await notionUpdateContentText(pageId, trimmed, env);
  const page = await notionGetPage(pageId, env);
  const shortId = formatShortId(page);
  await telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: `📝 متن #${shortId} به‌روزرسانی شد:\n\n${trimmed}`,
    reply_markup: buildKeyboard(pageIdNoDash),
  });
}

async function handleFeedbackReply(chatId, message, env) {
  const text = (message.text || "").trim();
  if (!text) return;
  const displayName = message.from?.first_name || message.from?.username || null;
  try {
    await notionCreateFeedback(chatId, displayName, text, env);
    await telegramCall(env, "sendMessage", { chat_id: chatId, text: "🙏 ممنون، فیدبکت ثبت شد." });
  } catch (err) {
    await logError("handleFeedbackReply", err, env, chatId);
    await telegramCall(env, "sendMessage", { chat_id: chatId, text: "⚠️ نشد ثبتش کنم، یه بار دیگه امتحان کن." });
  }
}

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data; // e.g. "ok:<id>" | "del:<id>" | "cat:<id>" | "setcat:<id>:<code>" | "date:<id>" | "setdate:<id>:<date>" | "cleardate:<id>" | "typedate:<id>" | "listcat:<code>" | "listdate:<catcode>:<rangecode>"
  const [action, rawId, extra] = data.split(":");
  const pageId = rawId && rawId !== "ALL" ? toDashedUuid(rawId) : null;

  try {
  if (action === "ok") {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } else if (action === "back") {
    // Cancel out of a submenu (category/status/date/delete-confirm) with no change.
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildKeyboard(rawId),
    });
  } else if (action === "del") {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildDeleteConfirmKeyboard(rawId),
    });
  } else if (action === "delok") {
    const oldPage = await notionGetPage(pageId, env);
    const oldStatus = oldPage.properties.Status?.select?.name || DEFAULT_STATUS;
    await notionSoftDelete(pageId, env);
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + "\n\n🗑 حذف شد.",
      reply_markup: { inline_keyboard: [[{ text: "↩️ برگردون", callback_data: `undodel:${rawId}:${STATUS_CODE[oldStatus] || "N"}` }]] },
    });
  } else if (action === "undodel") {
    const restoredStatus = CODE_STATUS[extra] || DEFAULT_STATUS;
    await notionUpdateStatus(pageId, restoredStatus, env);
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + "\n\n↩️ بازگردانده شد.",
      reply_markup: buildKeyboard(rawId),
    });
  } else if (action === "cat") {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildCategoryKeyboard(rawId),
    });
  } else if (action === "setcat") {
    const category = CODE_CATEGORY[extra];
    const oldPage = await notionGetPage(pageId, env);
    const oldCategory = oldPage.properties.Category?.select?.name;
    await notionUpdateCategory(pageId, category, env);
    const kb = buildKeyboard(rawId);
    if (oldCategory && oldCategory !== category) {
      kb.inline_keyboard.unshift([
        {
          text: `↩️ واگرد به ${CATEGORY_EMOJI[oldCategory]} ${CATEGORY_LABEL_FA[oldCategory]}`,
          callback_data: `setcat:${rawId}:${CATEGORY_CODE[oldCategory]}`,
        },
      ]);
    }
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + `\n\n✏️ دسته تغییر کرد به: ${CATEGORY_EMOJI[category]} ${CATEGORY_LABEL_FA[category]}`,
      reply_markup: kb,
    });
  } else if (action === "date") {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildDateKeyboard(rawId),
    });
  } else if (action === "setdate") {
    const oldPage = await notionGetPage(pageId, env);
    const oldDate = oldPage.properties["Due Date"]?.date?.start || null;
    await notionUpdateDueDate(pageId, extra, env);
    const kb = buildKeyboard(rawId);
    if (oldDate && oldDate !== extra) {
      kb.inline_keyboard.unshift([{ text: `↩️ واگرد به ${formatPersianDate(oldDate)}`, callback_data: `setdate:${rawId}:${oldDate}` }]);
    } else if (!oldDate) {
      kb.inline_keyboard.unshift([{ text: "↩️ واگرد (بدون تاریخ)", callback_data: `cleardate:${rawId}` }]);
    }
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + `\n\n📅 تاریخ ثبت شد: ${formatPersianDate(extra)}`,
      reply_markup: kb,
    });
  } else if (action === "cleardate") {
    const oldPage = await notionGetPage(pageId, env);
    const oldDate = oldPage.properties["Due Date"]?.date?.start || null;
    await notionUpdateDueDate(pageId, null, env);
    const kb = buildKeyboard(rawId);
    if (oldDate) {
      kb.inline_keyboard.unshift([{ text: `↩️ واگرد به ${formatPersianDate(oldDate)}`, callback_data: `setdate:${rawId}:${oldDate}` }]);
    }
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + "\n\n📅 تاریخ پاک شد.",
      reply_markup: kb,
    });
  } else if (action === "typedate") {
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      text: `تاریخ رو بنویس (مثلاً «یکشنبه»، «فردا»، «1404/7/20» یا «2026-10-10») و روی همین پیام ریپلای کن.\n#ref:${rawId}`,
    });
  } else if (action === "edittext") {
    const page = await notionGetPage(pageId, env);
    const currentText = (page.properties["Clean Text"]?.rich_text?.map((t) => t.plain_text).join("") || "").trim();
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        (currentText ? `متن فعلی (روش ضربه بزن تا کپی بشه):\n<code>${escapeHtml(currentText)}</code>\n\n` : "") +
        `حالا نسخه‌ی اصلاح‌شده رو بنویس و بفرست — جاش می‌شینه.\n#edittext:${rawId}`,
      // force_reply opens the input already targeting this message, so the user
      // doesn't need to manually long-press/tap "reply" before typing.
      reply_markup: { force_reply: true, input_field_placeholder: "متن اصلاح‌شده رو بنویس..." },
    });
  } else if (action === "st") {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildStatusKeyboard(rawId),
    });
  } else if (action === "setst") {
    const status = CODE_STATUS[extra];
    const oldPage = await notionGetPage(pageId, env);
    const oldStatus = oldPage.properties.Status?.select?.name;
    await notionUpdateStatus(pageId, status, env);
    const kb = buildKeyboard(rawId);
    if (oldStatus && oldStatus !== status && CODE_STATUS[STATUS_CODE[oldStatus]]) {
      kb.inline_keyboard.unshift([
        {
          text: `↩️ واگرد به ${STATUS_EMOJI[oldStatus]} ${STATUS_LABEL_FA[oldStatus]}`,
          callback_data: `setst:${rawId}:${STATUS_CODE[oldStatus]}`,
        },
      ]);
    }
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: cq.message.text + `\n\n🔄 وضعیت تغییر کرد به: ${STATUS_EMOJI[status]} ${STATUS_LABEL_FA[status]}`,
      reply_markup: kb,
    });
  } else if (action === "listcat") {
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: "چه بازه‌ای؟",
      reply_markup: buildListDateKeyboard(rawId),
    });
  } else if (action === "listdate") {
    const category = CODE_CATEGORY[rawId] || null; // null means "all"
    const items = await notionQueryByCategoryAndDate(category, extra, chatId, env);
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: formatListHeader(category, extra, items.length),
    });
    await sendItemMessages(env, chatId, items);
  } else if (action === "digeston") {
    const hour = Number(rawId);
    await notionSetDigestSettings(chatId, true, hour, env);
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: `⏰ خلاصه روزانه فعال شد — هر روز ساعت ${hour} صبح (به‌وقت ایران) خلاصه‌ی کارای اون روزتو برات می‌فرستم.`,
      reply_markup: buildDigestKeyboard(true, hour),
    });
  } else if (action === "digestoff") {
    await notionSetDigestSettings(chatId, false, null, env);
    await editOrSend(env, {
      chat_id: chatId,
      message_id: messageId,
      text: "🔕 خلاصه روزانه خاموش شد.",
      reply_markup: buildDigestKeyboard(false, null),
    });
  }
  } catch (err) {
    await logError(`handleCallback action=${action}`, err, env, chatId);
    await telegramCall(env, "sendMessage", { chat_id: chatId, text: "⚠️ این عملیات ناموفق بود، دوباره امتحان کن." });
  }

  await telegramCall(env, "answerCallbackQuery", { callback_query_id: cq.id });
}

async function sendItemMessages(env, chatId, items) {
  for (const it of items) {
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      text: formatItemText(it),
      reply_markup: buildKeyboard(it.id.replace(/-/g, "")),
    });
  }
}

function formatListHeader(category, rangeCode, count) {
  const title = category ? `${CATEGORY_EMOJI[category]} ${CATEGORY_LABEL_FA[category]}` : "📋 همه";
  const rangeLabel = { T: "امروز", M: "فردا", TM: "امروز و فردا", W: "این هفته", A: "همه" }[rangeCode] || "";
  const header = `${title} — ${rangeLabel} (${count})`;
  return count === 0 ? `${header}\n\nچیزی پیدا نشد.` : header;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatItemText(it) {
  const emoji = CATEGORY_EMOJI[it.category] || "📌";
  const categoryLabel = CATEGORY_LABEL_FA[it.category] || it.category;
  const statusEmoji = STATUS_EMOJI[it.status] || "";
  const statusLabel = STATUS_LABEL_FA[it.status] || it.status;
  const dateLine = it.dueDate ? `\n📅 ${formatPersianDate(it.dueDate)}` : "";
  return `#${it.shortId} ${emoji} ${categoryLabel} ${statusEmoji} ${statusLabel}${dateLine}\n\n*${it.name}*\n\n${it.cleanText}`;
}

function formatConfirmationText(parsed, shortId) {
  const emoji = CATEGORY_EMOJI[parsed.category] || "📌";
  const categoryLabel = CATEGORY_LABEL_FA[parsed.category] || parsed.category;
  const dateLine = parsed.due_date ? `\n📅 ${formatPersianDate(parsed.due_date)}` : "";
  return `#${shortId} ${emoji} ${categoryLabel} ${STATUS_EMOJI[DEFAULT_STATUS]} ${STATUS_LABEL_FA[DEFAULT_STATUS]}${dateLine}\n\n*${parsed.name}*\n\n📝 ${parsed.clean_text}\n\n💬 متن اصلی: ${parsed.raw_text}`;
}

export function formatShortId(page) {
  const idProp = page.properties?.ID;
  if (idProp?.type === "unique_id" && idProp.unique_id) {
    const { prefix, number } = idProp.unique_id;
    return `${prefix || ""}${number}`;
  }
  return "?";
}

function buildKeyboard(pageIdNoDash) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ دسته", callback_data: `cat:${pageIdNoDash}` },
        { text: "🔄 وضعیت", callback_data: `st:${pageIdNoDash}` },
      ],
      [
        { text: "📅 تاریخ", callback_data: `date:${pageIdNoDash}` },
        { text: "🗑 حذف", callback_data: `del:${pageIdNoDash}` },
      ],
      [{ text: "📝 ویرایش متن", callback_data: `edittext:${pageIdNoDash}` }],
      [{ text: "✅ بستن", callback_data: `ok:${pageIdNoDash}` }],
    ],
  };
}

function buildStatusKeyboard(pageIdNoDash) {
  const buttons = STATUSES.map((s) => ({
    text: `${STATUS_EMOJI[s]} ${STATUS_LABEL_FA[s]}`,
    callback_data: `setst:${pageIdNoDash}:${STATUS_CODE[s]}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ برگشت", callback_data: `back:${pageIdNoDash}` }]);
  return { inline_keyboard: rows };
}

function buildCategoryKeyboard(pageIdNoDash) {
  const buttons = CATEGORIES.map((c) => ({
    text: `${CATEGORY_EMOJI[c]} ${CATEGORY_LABEL_FA[c]}`,
    callback_data: `setcat:${pageIdNoDash}:${CATEGORY_CODE[c]}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ برگشت", callback_data: `back:${pageIdNoDash}` }]);
  return { inline_keyboard: rows };
}

function buildDeleteConfirmKeyboard(pageIdNoDash) {
  return {
    inline_keyboard: [
      [
        { text: "✅ بله، حذف شود", callback_data: `delok:${pageIdNoDash}` },
        { text: "❌ انصراف", callback_data: `back:${pageIdNoDash}` },
      ],
    ],
  };
}

function buildDateKeyboard(pageIdNoDash) {
  const today = todayInTehran();
  const quick = [
    { label: "امروز", date: today },
    { label: "فردا", date: addDays(today, 1) },
    { label: WEEKDAY_FA[new Date(addDays(today, 2) + "T00:00:00Z").getUTCDay()], date: addDays(today, 2) },
    { label: WEEKDAY_FA[new Date(addDays(today, 3) + "T00:00:00Z").getUTCDay()], date: addDays(today, 3) },
  ];
  const rows = [];
  for (let i = 0; i < quick.length; i += 2) {
    rows.push(
      quick.slice(i, i + 2).map((q) => ({ text: q.label, callback_data: `setdate:${pageIdNoDash}:${q.date}` }))
    );
  }
  rows.push([
    { text: "✏️ تایپ کن", callback_data: `typedate:${pageIdNoDash}` },
    { text: "🚫 پاک کردن تاریخ", callback_data: `cleardate:${pageIdNoDash}` },
  ]);
  rows.push([{ text: "⬅️ برگشت", callback_data: `back:${pageIdNoDash}` }]);
  return { inline_keyboard: rows };
}

function buildDigestKeyboard(enabled, currentHour) {
  const hours = [8, 9, 10];
  const row = hours.map((h) => ({
    text: `${enabled && currentHour === h ? "✅ " : ""}ساعت ${h} صبح`,
    callback_data: `digeston:${h}`,
  }));
  const rows = [row];
  if (enabled) {
    rows.push([{ text: "🔕 خاموش کردن", callback_data: "digestoff" }]);
  }
  return { inline_keyboard: rows };
}

function buildListCategoryKeyboard() {
  const buttons = CATEGORIES.map((c) => ({
    text: `${CATEGORY_EMOJI[c]} ${CATEGORY_LABEL_FA[c]}`,
    callback_data: `listcat:${CATEGORY_CODE[c]}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "📋 همه", callback_data: "listcat:ALL" }]);
  return { inline_keyboard: rows };
}

function buildListDateKeyboard(catCode) {
  return {
    inline_keyboard: [
      [
        { text: "امروز", callback_data: `listdate:${catCode}:T` },
        { text: "فردا", callback_data: `listdate:${catCode}:M` },
      ],
      [
        { text: "این هفته", callback_data: `listdate:${catCode}:W` },
        { text: "همه", callback_data: `listdate:${catCode}:A` },
      ],
    ],
  };
}

export function toDashedUuid(noDash) {
  return `${noDash.slice(0, 8)}-${noDash.slice(8, 12)}-${noDash.slice(12, 16)}-${noDash.slice(16, 20)}-${noDash.slice(20)}`;
}

// ---------- Date helpers (Asia/Tehran, no library) ----------

export function todayInTehran() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}

export function addDays(isoDate, n) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Iranian week: starts Saturday, ends Friday (not the Western Monday-start week).
// Returns this week's and next week's Sat..Fri bounds given today's ISO date.
export function iranianWeekBounds(isoDate) {
  const dow = new Date(isoDate + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  const daysSinceSaturday = (dow - 6 + 7) % 7;
  const thisStart = addDays(isoDate, -daysSinceSaturday);
  const thisEnd = addDays(thisStart, 6);
  const nextStart = addDays(thisStart, 7);
  const nextEnd = addDays(thisStart, 13);
  return { thisStart, thisEnd, nextStart, nextEnd };
}

// ---------- Gregorian -> Jalali (Persian/Shamsi) conversion ----------
// Standard jalaali-js algorithm (public domain / MIT-style, widely reused).

function jdiv(a, b) {
  return ~~(a / b);
}
function jmod(a, b) {
  return a - ~~(a / b) * b;
}

function jalCal(jy) {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + jdiv(jump, 33) * 8 + jdiv(jmod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + jdiv(n, 33) * 8 + jdiv(jmod(n, 33) + 3, 4);
  if (jmod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = jdiv(gy, 4) - jdiv((jdiv(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + jdiv(jump + 4, 33) * 33;
  let leap = jmod(jmod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = jdiv((gy + jdiv(gm - 8, 6) + 100100) * 1461, 4) + jdiv(153 * jmod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - jdiv(jdiv(gy + 100100 + jdiv(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + jdiv(jdiv(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = jdiv(jmod(j, 1461), 4) * 5 + 308;
  const gd = jdiv(jmod(i, 153), 5) + 1;
  const gm = jmod(jdiv(i, 153), 12) + 1;
  const gy = jdiv(j, 1461) - 100100 + jdiv(8 - gm, 6);
  return { gy, gm, gd };
}

function toJalaali(gy, gm, gd) {
  const jdn = g2d(gy, gm, gd);
  const gy2 = d2g(jdn).gy;
  let jy = gy2 - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy2, 3, r.march);
  let k = jdn - jdn1f;
  let jm, jd;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + jdiv(k, 31);
      jd = jmod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + jdiv(k, 30);
  jd = jmod(k, 30) + 1;
  return { jy, jm, jd };
}

export function formatPersianDate(isoDate) {
  const [gy, gm, gd] = isoDate.split("-").map(Number);
  const { jy, jm, jd } = toJalaali(gy, gm, gd);
  const weekday = WEEKDAY_FA[new Date(isoDate + "T00:00:00Z").getUTCDay()];
  return `${weekday} ${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
}

// ---------- Telegram helpers ----------

async function telegramCall(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    await logError(`telegram ${method}`, new Error(JSON.stringify(json)), env, payload?.chat_id);
  }
  return json;
}

// Telegram occasionally refuses to edit a message ("message can't be edited") for
// reasons outside our control. Rather than silently stranding the user on a stale
// "در حال پردازش..." message, fall back to sending a brand-new message instead.
async function editOrSend(env, payload) {
  const res = await telegramCall(env, "editMessageText", payload);
  if (!res || res.ok === false) {
    const { message_id, ...rest } = payload;
    return await telegramCall(env, "sendMessage", rest);
  }
  return res;
}

async function downloadTelegramFile(fileId, env) {
  const metaRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const meta = await metaRes.json();
  const filePath = meta.result.file_path;
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
  );
  const buf = await fileRes.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const mimeType = filePath.endsWith(".oga") || filePath.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg";
  return { base64, mimeType };
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------- Gemini ----------

// A hung Gemini request (no response, no error) would otherwise block the
// Worker's background execution indefinitely with nothing to catch — this
// forces a real, catchable failure after GEMINI_TIMEOUT_MS.
const GEMINI_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function geminiGenerate(parts, env) {
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json" },
  });

  // Use "-latest" aliases only — Google retires dated model names quickly, aliases auto-track what's current.
  const models = ["gemini-flash-latest", "gemini-flash-lite-latest"];
  let json, res, lastErr;
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body },
          GEMINI_TIMEOUT_MS
        );
      } catch (err) {
        // Network error or our own timeout abort — treat as retryable, same as a 503.
        lastErr = err;
        console.error(`gemini fetch failed (model=${model}, attempt=${attempt})`, err.name, err.message);
        res = null;
        if (attempt === 0) {
          continue;
        }
        break;
      }
      json = await res.json();
      if (res.ok) break outer;
      console.error(`gemini error (model=${model}, attempt=${attempt})`, JSON.stringify(json));
      if (res.status === 503 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break; // non-retryable error, try next model
    }
  }

  if (!res || !res.ok) {
    await logError("geminiGenerate exhausted all models", lastErr || new Error(JSON.stringify(json)), env);
    throw new Error("gemini request failed");
  }
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

export async function classifyWithGemini(source, env) {
  const today = todayInTehran();
  const todayWeekday = WEEKDAY_FA[new Date(today + "T00:00:00Z").getUTCDay()];
  const wb = iranianWeekBounds(today);
  const instructions = `You are an inbox triage assistant. The user sends a quick voice note or text — often casual/colloquial spoken language — with one or more thoughts, tasks, ideas, or things someone told them.
Today's date is ${today} (Asia/Tehran, Iran), which is a ${todayWeekday}.

Return ONLY a JSON object (no markdown fences) with exactly this shape:
{
  "items": [
    {
      "name": "short title, max 8 words, same language as input",
      "category": one of ${JSON.stringify(CATEGORIES)},
      "raw_text": "the portion of the original transcript this item is about, same language, verbatim-ish",
      "clean_text": "a short, well-written, non-colloquial restatement of raw_text, same language, suitable to paste as a task description — keep all concrete details (who/what/deadline), just tidy the phrasing",
      "due_date": "an absolute Gregorian ISO date YYYY-MM-DD if this item mentions a date/relative day/weekday/Jalali date, otherwise null"
    }
  ]
}

Splitting guide:
- Default to ONE item for the whole input.
- Split into multiple items whenever the input names two or more separately actionable things, even if they share the same day, are mentioned in one breath, or are joined by "and"/"also"/"همچنین"/"و" — sharing a date or being spoken together is NOT a reason to merge them.
- The strongest signal for a split is that the parts would naturally get DIFFERENT categories (e.g. one part is a Task/Follow-up and another is a Purchase/Reminder) or involve different people/subjects — in that case, always split.
  Example that MUST split into 2 items: "فردا باید جلسه با مشتری رو ست کنم، همچنین واسه خونه آب معدنی بخرم" → item 1 (Task: setting up the meeting), item 2 (Purchase: buying water) — do not merge these just because both say "فردا".
- Only keep ONE item when the input is really a single coherent action/thought, even if long.
- Do not split a single idea/sentence just because it's long.

Category guide:
- Task: something the user needs to do themselves
- Idea: a thought/idea to consider or plan later, not an immediate action
- Follow-up: something someone else told them, asked them to do, or a commitment involving another person
- Purchase: something to buy
- Reminder: a time-bound thing to remember

Date guide:
- Resolve relative expressions ("today", "tomorrow", "Sunday", "in 3 days") against today's date above.
- Convert Persian/Jalali calendar dates to Gregorian.
- IMPORTANT — Iranian week convention (this is NOT the Western Monday-start week): the week runs Saturday (شنبه) through Friday (جمعه).
  - "این هفته" (this week) = ${wb.thisStart} through ${wb.thisEnd}.
  - "هفته دیگه" / "هفته بعد" / "هفته آینده" (next week) = ${wb.nextStart} through ${wb.nextEnd}.
  - So e.g. "دوشنبه هفته دیگه" (Monday of next week) must fall inside ${wb.nextStart}..${wb.nextEnd}, not two weeks out.
- If genuinely no date is mentioned for an item, use null.

If audio is provided, transcribe it first (it is likely Iranian colloquial Persian/Farsi, possibly with background noise or a casual driving/walking tone), then classify based on the transcript.
Transcription guide:
- This is everyday spoken Persian, so expect common loanwords/informal terms used in Iran for errands and places, e.g. کارواش (car wash), سوپرمارکت, کافی‌شاپ, پارکینگ, آژانس, شارژ, اپلیکیشن, دکتر, قسط, فاکتور — transcribe these as the real word, not a phonetically-similar but nonsensical alternative.
- If a word is unclear, prefer the most common, everyday reading that fits the sentence's meaning over a rare or nonsensical one.
- Never invent content that was not said; if a short phrase is truly unintelligible, transcribe the surrounding words you are confident about and leave the unclear part out rather than guessing wildly.`;

  const parts = [{ text: instructions }];
  if (source.kind === "audio") {
    parts.push({ inline_data: { mime_type: source.mimeType, data: source.base64 } });
  } else {
    parts.push({ text: `User input: ${source.text}` });
  }

  const text = await geminiGenerate(parts, env);
  let items;
  try {
    const obj = JSON.parse(text);
    items = Array.isArray(obj.items) ? obj.items : Array.isArray(obj) ? obj : [obj];
  } catch (err) {
    await logError("classifyWithGemini: unparseable response", new Error(text.slice(0, 500)), env);
    throw new Error("gemini returned unparseable response");
  }
  if (items.length === 0) {
    throw new Error("gemini returned zero items");
  }
  for (const parsed of items) {
    if (!CATEGORIES.includes(parsed.category)) parsed.category = "Idea";
    if (!parsed.raw_text) parsed.raw_text = "";
    if (!parsed.clean_text) parsed.clean_text = parsed.raw_text;
    if (!parsed.name) parsed.name = parsed.clean_text?.slice(0, 40) || "Untitled";
    if (!parsed.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)) parsed.due_date = null;
  }
  return items;
}

async function resolveDateWithGemini(typedText, today, env) {
  const todayWeekday = WEEKDAY_FA[new Date(today + "T00:00:00Z").getUTCDay()];
  const wb = iranianWeekBounds(today);
  const instructions = `Today's date is ${today} (Asia/Tehran, Iran), which is a ${todayWeekday}. The user typed a date or relative day expression, possibly in Persian, possibly a Jalali calendar date: "${typedText}".
Iranian week convention (NOT Western Monday-start): week runs Saturday through Friday. "این هفته" (this week) = ${wb.thisStart}..${wb.thisEnd}. "هفته دیگه/بعد" (next week) = ${wb.nextStart}..${wb.nextEnd}.
Resolve it to an absolute Gregorian ISO date. Return ONLY a JSON object (no markdown fences): {"date": "YYYY-MM-DD"} or {"date": null} if it cannot be resolved as a date.`;
  const text = await geminiGenerate([{ text: instructions }], env);
  try {
    const parsed = JSON.parse(text);
    if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return parsed.date;
  } catch {
    // fall through
  }
  return null;
}

// ---------- Notion ----------

async function notionCreatePlaceholder(chatId, env) {
  const properties = {
    Name: { title: [{ text: { content: "⏳ در حال پردازش..." } }] },
    Category: { select: { name: "Idea" } },
    Status: { select: { name: DEFAULT_STATUS } },
    ChatId: { number: chatId },
  };
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ parent: { database_id: env.NOTION_DATABASE_ID }, properties }),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionCreatePlaceholder", new Error(JSON.stringify(json)), env, chatId);
    throw new Error("notion create failed");
  }
  return json;
}

function buildContentProperties(parsed) {
  const properties = {
    Name: { title: [{ text: { content: parsed.name } }] },
    Category: { select: { name: parsed.category } },
    "Raw Text": { rich_text: [{ text: { content: parsed.raw_text.slice(0, 2000) } }] },
    "Clean Text": { rich_text: [{ text: { content: (parsed.clean_text || "").slice(0, 2000) } }] },
  };
  if (parsed.due_date) {
    properties["Due Date"] = { date: { start: parsed.due_date } };
  }
  return properties;
}

export async function notionCreatePageFull(chatId, parsed, env) {
  const properties = {
    ...buildContentProperties(parsed),
    Status: { select: { name: DEFAULT_STATUS } },
    ChatId: { number: chatId },
  };
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ parent: { database_id: env.NOTION_DATABASE_ID }, properties }),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionCreatePageFull", new Error(JSON.stringify(json)), env, chatId);
    throw new Error("notion create failed");
  }
  return json;
}

async function notionUpdatePageContent(pageId, parsed, env) {
  const properties = buildContentProperties(parsed);
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    await logError("notionUpdatePageContent", new Error(JSON.stringify(await res.json())), env);
    throw new Error("notion update failed");
  }
}

export async function notionGetPage(pageId, env) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Notion-Version": "2022-06-28",
    },
  });
  const json = await res.json();
  if (!res.ok) {
    await logError(`notionGetPage(${pageId})`, new Error(JSON.stringify(json)), env);
    throw new Error("notion get failed");
  }
  return json;
}

export async function notionPatch(pageId, body, context, env) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await logError(context, new Error(JSON.stringify(await res.json().catch(() => ({})))), env);
  }
}

// Soft delete: mark as "deleted" so it's hidden from /list and quick-view but
// stays in the database (not Notion's own trash) in case it's needed later.
export async function notionSoftDelete(pageId, env) {
  await notionPatch(pageId, { properties: { Status: { select: { name: "deleted" } } } }, `notionSoftDelete(${pageId})`, env);
}

export async function notionUpdateCategory(pageId, category, env) {
  await notionPatch(pageId, { properties: { Category: { select: { name: category } } } }, `notionUpdateCategory(${pageId})`, env);
}

export async function notionUpdateStatus(pageId, status, env) {
  await notionPatch(pageId, { properties: { Status: { select: { name: status } } } }, `notionUpdateStatus(${pageId})`, env);
}

// User-driven correction of a mis-transcribed/mis-heard item: overwrites the
// title and the clean description with the user's own retyped text. Raw Text
// is left untouched as a record of what Gemini originally heard.
export async function notionUpdateContentText(pageId, newText, env) {
  await notionPatch(
    pageId,
    {
      properties: {
        Name: { title: [{ text: { content: newText.slice(0, 2000) } }] },
        "Clean Text": { rich_text: [{ text: { content: newText.slice(0, 2000) } }] },
      },
    },
    `notionUpdateContentText(${pageId})`,
    env
  );
}

export async function notionUpdateDueDate(pageId, isoDateOrNull, env) {
  await notionPatch(
    pageId,
    { properties: { "Due Date": { date: isoDateOrNull ? { start: isoDateOrNull } : null } } },
    `notionUpdateDueDate(${pageId})`,
    env
  );
}

export async function notionQueryByCategoryAndDate(category, rangeCode, chatId, env) {
  const filters = [
    { property: "ChatId", number: { equals: chatId } },
    { property: "Status", select: { does_not_equal: "deleted" } },
  ];
  if (category) {
    filters.push({ property: "Category", select: { equals: category } });
  }
  if (rangeCode && rangeCode !== "A") {
    const today = todayInTehran();
    if (rangeCode === "T") {
      filters.push({ property: "Due Date", date: { equals: today } });
    } else if (rangeCode === "M") {
      filters.push({ property: "Due Date", date: { equals: addDays(today, 1) } });
    } else if (rangeCode === "TM") {
      filters.push({ property: "Due Date", date: { on_or_after: today } });
      filters.push({ property: "Due Date", date: { on_or_before: addDays(today, 1) } });
    } else if (rangeCode === "W") {
      // Rest of the Iranian week (Sat..Fri), not a rolling 7-day window.
      const wb = iranianWeekBounds(today);
      filters.push({ property: "Due Date", date: { on_or_after: today } });
      filters.push({ property: "Due Date", date: { on_or_before: wb.thisEnd } });
    }
  }

  const body = { page_size: 30, sorts: [{ property: "Due Date", direction: "ascending" }] };
  if (filters.length === 1) body.filter = filters[0];
  else if (filters.length > 1) body.filter = { and: filters };

  const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionQueryByCategoryAndDate", new Error(JSON.stringify(json)), env, chatId);
    throw new Error("notion query failed");
  }
  return json.results.map((page) => {
    const props = page.properties;
    const name = props.Name?.title?.[0]?.plain_text || "(بدون عنوان)";
    const cleanTextFull = props["Clean Text"]?.rich_text?.map((t) => t.plain_text).join("") || "";
    const cleanText = cleanTextFull.length > 300 ? cleanTextFull.slice(0, 300) + "…" : cleanTextFull;
    const rawText = props["Raw Text"]?.rich_text?.map((t) => t.plain_text).join("") || "";
    const status = props.Status?.select?.name || "";
    const categoryName = props.Category?.select?.name || "";
    const dueDate = props["Due Date"]?.date?.start || null;
    const shortId = formatShortId(page);
    return { id: page.id, name, cleanText, rawText, status, category: categoryName, dueDate, shortId };
  });
}

// ---------- Feedback (separate database, never mixed with the task inbox) ----------

async function notionCreateFeedback(chatId, displayName, text, env) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_FEEDBACK_DB_ID },
      properties: {
        Name: { title: [{ text: { content: text.slice(0, 100) } }] },
        ChatId: { number: chatId },
        ...(displayName ? { DisplayName: { rich_text: [{ text: { content: displayName } }] } } : {}),
        Text: { rich_text: [{ text: { content: text.slice(0, 2000) } }] },
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionCreateFeedback", new Error(JSON.stringify(json)), env, chatId);
    throw new Error("notion create failed");
  }
  return json;
}

// ---------- Daily digest (per-user opt-in summary, sent by the cron trigger) ----------

async function notionSetDigestSettings(chatId, enabled, hour, env) {
  let user = await notionFindUser(chatId, env);
  if (!user) {
    // Toggling the digest before ever running /start or /webapp: create the
    // Bot Users row now (same credentials flow /webapp uses) so the setting
    // actually persists instead of silently doing nothing.
    const password = generate8DigitPassword();
    const salt = randomSalt();
    const hash = await hashPassword(password, salt);
    await notionUpsertUser(chatId, hash, salt, env, null);
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `راستی، یه برد وب هم برات ساختم: ${WEBAPP_BASE_URL}\nشناسه ورود: <code>${chatId}</code>\nرمز: <code>${password}</code>`,
    });
    user = await notionFindUser(chatId, env);
    if (!user) return;
  }
  await notionPatch(
    user.id,
    { properties: { DigestEnabled: { checkbox: enabled }, DigestHour: { number: hour } } },
    `notionSetDigestSettings(${chatId})`,
    env
  );
}

async function notionQueryDigestUsers(hour, env) {
  const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_USERS_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: "DigestEnabled", checkbox: { equals: true } },
          { property: "DigestHour", number: { equals: hour } },
        ],
      },
      page_size: 100,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    await logError("notionQueryDigestUsers", new Error(JSON.stringify(json)), env);
    return [];
  }
  return json.results;
}

function formatDigestText(items) {
  if (items.length === 0) {
    return "☀️ صبح بخیر! امروز هیچ کار زمان‌داری نداری — یه روز آرومه 🙂";
  }
  const lines = items.map((it) => `• ${CATEGORY_EMOJI[it.category] || "📌"} ${it.name}`);
  return `☀️ خلاصه امروزت (${items.length} مورد):\n${lines.join("\n")}`;
}

// wrangler.toml's cron trigger fires at fixed UTC times picked to match
// 8/9/10 AM Tehran (Iran dropped DST, so the UTC+3:30 offset never shifts).
const DIGEST_CRON_HOUR = { "30 4 * * *": 8, "30 5 * * *": 9, "30 6 * * *": 10 };

async function runDailyDigest(event, env) {
  const hour = DIGEST_CRON_HOUR[event.cron];
  if (!hour) return;
  const users = await notionQueryDigestUsers(hour, env);
  for (const user of users) {
    const chatId = user.properties?.ChatId?.number;
    if (!chatId) continue;
    try {
      const items = (await notionQueryByCategoryAndDate(null, "T", chatId, env)).filter(
        (it) => it.status !== "done" && it.status !== "skipped"
      );
      await telegramCall(env, "sendMessage", { chat_id: chatId, text: formatDigestText(items) });
    } catch (err) {
      await logError(`runDailyDigest chatId=${chatId}`, err, env, chatId);
    }
  }
}
