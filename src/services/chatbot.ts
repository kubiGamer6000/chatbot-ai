import {
  isJidGroup,
  toNumber,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import logger from "../utils/logger";
import { loadMessages } from "../messageProcessor";
import { FirestoreMessage } from "../types";
import { sendWebhook } from "./webhook";

export const processMessages = async (messages: WAMessage[], jid: string) => {
  if (isJidGroup(jid)) {
    let shouldProcess = false;
    for (const message of messages) {
      if (
        message.message?.conversation?.startsWith("heyai") ||
        message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(
          process.env.WHATSAPP_PHONE_NUMBER + "@s.whatsapp.net"
        ) ||
        message.message?.imageMessage?.caption?.includes("heyai") ||
        message.message?.imageMessage?.caption?.includes(
          "@" + process.env.WHATSAPP_PHONE_NUMBER
        ) ||
        message.message?.documentMessage?.caption?.includes(
          "@" + process.env.WHATSAPP_PHONE_NUMBER
        ) ||
        message.message?.extendedTextMessage?.text?.includes("heyai") ||
        message.message?.extendedTextMessage?.text?.includes(
          "@" + process.env.WHATSAPP_PHONE_NUMBER
        ) ||
        message.message?.videoMessage?.caption?.includes(
          "@" + process.env.WHATSAPP_PHONE_NUMBER
        ) ||
        message.message?.videoMessage?.caption?.includes("heyai")
      ) {
        shouldProcess = true;
        break;
      }
    }
    if (!shouldProcess) return;
  }
  logger.info(`Processing ${messages.length} messages for ${jid}`);
  const messageHistory = await loadMessages(jid, 25);

  console.log(messageHistory);
  const { context, contextMessages } = generateLLMContext(
    messageHistory,
    jid,
    Date.now()
  );

  logger.info("sending webhook");
  await sendWebhook({
    conversationContext: context,
    contextMessages,
    rawData: messageHistory,
    jid,
  });

  // TODO: Queue to resend if webhook fails
};

type ContextMessage = {
  key: WAMessageKey;
  message: string;
};

export function generateLLMContext(
  messages: FirestoreMessage[],
  currentChatId: string,
  currentTime: number
): { context: string; contextMessages: ContextMessage[] } {
  let context = `-- CHAT ID: ${currentChatId} --\n`;
  context += `- Current time: ${new Date(currentTime).toLocaleString()}\n`;
  let contextMessages: ContextMessage[] = [];

  // Calculate time since last message from me
  const lastMessageFromMe = messages.findLast((msg) => msg?.key?.fromMe);

  if (lastMessageFromMe?.messageTimestamp) {
    const timeSince =
      currentTime - toNumber(lastMessageFromMe.messageTimestamp) * 1000;
    const minutes = Math.floor(timeSince / (1000 * 60));
    context += `- Time since last message from me: ${minutes} minutes\n\n`;
  }

  // Process messages
  messages.forEach((msg) => {
    const timestamp = new Date(
      toNumber(msg.messageTimestamp) * 1000
    ).toLocaleString();
    const sender = msg.key?.fromMe ? "ME" : msg.pushName;

    let messageContent = "";

    if (msg.isMedia) {
      switch (msg.messageType) {
        case "imageMessage":
          messageContent = `[IMAGE MESSAGE]\n${
            msg.processResult
              ? `Description of image: "${msg.processResult}"`
              : ""
          }`;
          const imageCaption = msg.message?.imageMessage?.caption;
          if (imageCaption)
            messageContent += `\nCaption from sender: "${imageCaption}"`;
          break;

        case "audioMessage":
          messageContent = `[VOICE MESSAGE]\n${
            msg.processResult ? `Transcription: "${msg.processResult}"` : ""
          }`;
          break;
        case "videoMessage":
          messageContent = `[VIDEO MESSAGE]\n${
            msg.processResult
              ? `Full video description: "${msg.processResult}" \n Video Caption from sender: "${msg.message?.videoMessage?.caption}"`
              : ""
          }`;
          break;

        case "documentMessage":
          messageContent = `[DOCUMENT MESSAGE]\n${
            msg.processResult ? `Document contents: "${msg.processResult}"` : ""
          }`;
          const docCaption = msg.message?.documentMessage?.caption;
          if (docCaption)
            messageContent += `\nCaption from sender: "${docCaption}"`;
          break;
        case "documentWithCaptionMessage":
          messageContent = `[DOCUMENT MESSAGE WITH CAPTION]\n${
            msg.processResult ? `Document contents: "${msg.processResult}"` : ""
          }`;
          const docWithCaptionCaption =
            msg.message?.documentWithCaptionMessage?.message?.documentMessage
              ?.caption;
          if (docWithCaptionCaption)
            messageContent += `\nCaption from sender: "${docWithCaptionCaption}"`;
          break;
        case "stickerMessage":
          messageContent = `[STICKER MESSAGE]\n${
            msg.processResult
              ? `Sticker description: "${msg.processResult}"`
              : ""
          }`;
          break;
        default:
          messageContent = `Uncommon message type [${
            msg.messageType
          }]. Full message object ${JSON.stringify(msg.message)}`;
          break;
      }
    } else {
      messageContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        JSON.stringify(msg.message) ||
        "";
    }

    // context += `[MSG ID: ${msg.key.id}] [${timestamp}] ${sender}: ${messageContent}\n`;
    contextMessages.push({
      key: msg.key ?? "1",
      message: `[${timestamp}] ${sender}: ${messageContent}\n`,
    });
  });

  return { context, contextMessages };
}
