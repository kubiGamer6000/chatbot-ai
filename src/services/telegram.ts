import TelegramBot from "node-telegram-bot-api";
import logger from "../utils/logger";
import fs from "fs";

// Bot instances and configuration
let primaryBot: TelegramBot | null = null;
let secondaryBot: TelegramBot | null = null;
let primaryChatId: string | null = null;
let secondaryChatId: string | null = null;

// Initialize telegram bots if config is available
try {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set, Telegram notifications disabled");
  } else if (!process.env.TELEGRAM_CHAT_ID) {
    logger.warn("TELEGRAM_CHAT_ID not set, Telegram notifications disabled");
  } else {
    primaryBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
      polling: false,
    });
    primaryChatId = process.env.TELEGRAM_CHAT_ID;

    // Optional secondary bot
    if (process.env.TELEGRAM_BOT_TOKEN_SECONDARY) {
      secondaryBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN_SECONDARY, {
        polling: false,
      });
      secondaryChatId = process.env.TELEGRAM_CHAT_ID;
    }
  }
} catch (error) {
  logger.error({ err: error }, "Failed to initialize Telegram bots");
}

/**
 * Add client ID prefix to messages
 * @param text The text to prefix
 * @returns Prefixed text
 */
function addClientIdPrefix(text: string): string {
  const clientId = process.env.WHATSAPP_CLIENT_ID || "UNKNOWN";
  return `[${clientId}] ${text}`;
}

/**
 * Send a text message to Telegram
 * @param message Message text to send
 * @param useSecondary Whether to use secondary bot (if available)
 * @returns Promise<boolean> Success status
 */
export async function sendTelegramMessage(
  message: string,
  useSecondary: boolean = false
): Promise<boolean> {
  // Add client ID prefix to message
  message = addClientIdPrefix(message);

  if (message.length > 4096) {
    logger.warn(
      { messageLength: message.length },
      "Telegram message too long, truncating"
    );
    message = message.substring(0, 4093) + "...";
  }

  try {
    if (useSecondary && secondaryBot && secondaryChatId) {
      await secondaryBot.sendMessage(secondaryChatId, message);
      return true;
    } else if (primaryBot && primaryChatId) {
      await primaryBot.sendMessage(primaryChatId, message);
      return true;
    } else {
      logger.debug("Telegram notification skipped: bots not initialized");
      return false;
    }
  } catch (error) {
    logger.error(
      { err: error, messageLength: message.length },
      "Failed to send Telegram message"
    );
    return false;
  }
}

/**
 * Send a photo to Telegram
 * @param photoPath Path to photo file
 * @param caption Optional caption for the photo
 * @param useSecondary Whether to use secondary bot (if available)
 * @returns Promise<boolean> Success status
 */
export async function sendTelegramPhoto(
  photoPath: string,
  caption?: string,
  useSecondary: boolean = false
): Promise<boolean> {
  try {
    if (!fs.existsSync(photoPath)) {
      logger.error({ photoPath }, "Photo file not found");
      return false;
    }

    // Add client ID prefix to caption if it exists
    const prefixedCaption = caption ? addClientIdPrefix(caption) : undefined;

    const photo = fs.createReadStream(photoPath);
    if (useSecondary && secondaryBot && secondaryChatId) {
      await secondaryBot.sendPhoto(secondaryChatId, photo, {
        caption: prefixedCaption,
      });
      return true;
    } else if (primaryBot && primaryChatId) {
      await primaryBot.sendPhoto(primaryChatId, photo, {
        caption: prefixedCaption,
      });
      return true;
    } else {
      logger.debug("Telegram photo notification skipped: bots not initialized");
      return false;
    }
  } catch (error) {
    logger.error({ err: error, photoPath }, "Failed to send Telegram photo");
    return false;
  }
}

/**
 * Send an error message to Telegram
 * @param error Error message
 * @param useSecondary Whether to use secondary bot (if available)
 * @returns Promise<boolean> Success status
 */
export async function sendTelegramError(
  error: string,
  useSecondary: boolean = false
): Promise<boolean> {
  return sendTelegramMessage(`❌ ERROR: ${error}`, useSecondary);
}
