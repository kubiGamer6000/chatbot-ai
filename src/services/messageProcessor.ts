import { bucket, db } from "./firebase-admin.js";
import type {
  WAMessage,
  Chat,
  makeWASocket,
  MessageType,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import {
  downloadMediaMessage,
  getContentType,
  isJidGroup,
} from "@whiskeysockets/baileys";
import { proto, toNumber } from "@whiskeysockets/baileys";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

import { Timestamp } from "firebase-admin/firestore";
import { writeFile, unlink, mkdir } from "fs/promises";
import path from "path";
import { processImage } from "./media/image.js";
import { processAudio } from "./media/audio.js";

import mime from "mime-types";

import logger from "../utils/logger.js";
import { processDocument } from "./media/document.js";

import type { FirestoreMessage } from "../types.js";

import { processVideo } from "./media/video.js";
import { sendWebhook } from "./webhook.js";

const serializeToPlainObject = (obj: any) => {
  return JSON.parse(JSON.stringify(obj));
};

const convertToFirestoreTimestamp = (unixTimestamp: number) => {
  // Convert to milliseconds if needed (Baileys sometimes uses seconds)
  const milliseconds = unixTimestamp * 1000;
  return Timestamp.fromMillis(milliseconds);
};
// Collection references
const chatsRef = db.collection(process.env.FIRESTORE_CHAT_COLLECTION!);
const messagesRef = db.collection(process.env.FIRESTORE_MESSAGE_COLLECTION!);
const userConfigRef = db.collection("userConfig");

export const loadMessages = async (jid: string, limit: number = 50) => {
  try {
    const messages = await messagesRef
      .where("chatId", "==", jid)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    return messages.docs.map((doc) => doc.data() as FirestoreMessage).reverse();
  } catch (error) {
    console.log(error);
    logger.error(error, "Failed to load messages");
    return [];
  }
};

export const loadMessage = async (id: string) => {
  try {
    const doc = await messagesRef.doc(id).get();
    return doc.exists ? (doc.data() as FirestoreMessage) : undefined;
  } catch (error) {
    logger.error("Failed to load message", error);
    return undefined;
  }
};

export const loadChat = async (jid: string) => {
  try {
    const doc = await chatsRef.doc(jid).get();
    return doc.exists ? (doc.data() as Chat) : undefined;
  } catch (error) {
    logger.error("Failed to load chat", error);
    return undefined;
  }
};

export const bind = (sock: ReturnType<typeof makeWASocket>) => {
  /**
   * Binds to Baileys events and updates Firestore
   */
  sock.ev.on("messages.upsert", async ({ messages: newMessages, type }) => {
    if (type !== "append" && type !== "notify") return;

    logger.debug({ count: newMessages.length, type }, "Messages received");

    //  INITIAL PROCESSING ON NEW MESSAGE EVENT
    for (const msg of newMessages) {
      try {
        // FIND WHICH IF MESSAGE ISN'T FROM BOT, AND IF SO MARK IT AS READ
        const newMessagesFromOther = newMessages.filter(
          (msg) => !msg.key.fromMe
        );
        const newMessagesKeys = newMessagesFromOther.map((msg) => msg.key);
        await sock.readMessages(newMessagesKeys);

        //  PROCESS MESSAGE
        if (type !== "append" && type !== "notify") return;
        await handleNewMessage(msg, type, sock);
      } catch (error) {
        logger.error(
          {
            err: error,
            messageId: msg.key.id,
            remoteJid: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
          },
          "Failed to process message"
        );
      }
    }
  });

  // Handle chat updates
  sock.ev.on("chats.upsert", async (newChats) => {
    if (!newChats.length) return;

    logger.debug({ count: newChats.length }, "Upserting chats");
    const batch = db.batch();

    for (const chat of newChats) {
      const chatRef = chatsRef.doc(chat.id);
      batch.set(chatRef, chat, { merge: true });
    }

    try {
      await batch.commit();
      logger.debug({ count: newChats.length }, "Chat upsert completed");
    } catch (error) {
      logger.error(
        { err: error, count: newChats.length },
        "Failed to upsert chats"
      );
    }
  });

  // Add messaging history sync handler
};

//* MESAGE QUEUE - simple fix for double-texting//
const messageQueues = new Map<
  string,
  {
    messages: WAMessage[];
    timeout: NodeJS.Timeout;
  }
>();
let MESSAGE_QUEUE_DELAY = 10000; // 10 seconds in milliseconds
let CONTEXT_LENGTH = 25;

const runMessageQueue = async (
  msg: WAMessage,
  sock: ReturnType<typeof makeWASocket>
) => {
  if (msg.key.fromMe) return;

  const chatId = msg.key.remoteJid!;
  const queue = messageQueues.get(chatId);
  if (queue) {
    clearTimeout(queue.timeout);
    queue.messages.push(msg);
  } else {
    messageQueues.set(chatId, {
      messages: [msg],
      timeout: null!,
    });
  }
  const timeout = setTimeout(async () => {
    const { messages } = messageQueues.get(chatId)!;
    // await sock.sendPresenceUpdate("composing", chatId);
    processMessages(messages, chatId);
    messageQueues.delete(chatId);
  }, MESSAGE_QUEUE_DELAY);
  messageQueues.get(chatId)!.timeout = timeout;
};

/**
 * Processes a single new message, handling commands, media, and storage
 */
async function handleNewMessage(
  msg: WAMessage,
  type: "append" | "notify",
  sock: ReturnType<typeof makeWASocket>
) {
  if (!msg.message) {
    logger.debug({ messageId: msg.key.id }, "Skipping message with no content");
    return;
  }
  // check if message id is already in the database
  const messageRef = messagesRef.doc(msg.key.id!);
  const messageDoc = await messageRef.get();
  if (messageDoc.exists) {
    logger.debug(
      { messageId: msg.key.id },
      "Skipping message that already exists"
    );
    return;
  }

  const jid = jidNormalizedUser(msg.key.remoteJid!);
  const messageId = msg.key.id!;
  const startTime = Date.now();

  // Handle commands
  if (msg.message.conversation === "CLEAR_HISTORY") {
    await clearChatHistory(jid);
    await sock.sendMessage(jid, { text: "✅ History cleared" });
    return;
  }

  if (msg.message.conversation?.startsWith("SET_RESPONSE_TIME")) {
    // Validate command
    const responseTime = parseInt(msg.message.conversation.split(" ")[1]);
    if (isNaN(responseTime)) {
      await sock.sendMessage(jid, { text: "❌ Invalid syntax" });
      return;
    }

    await userConfigRef.doc(jid).set({ responseTime }, { merge: true });
    await sock.sendMessage(jid, {
      text: "✅ Response time set to " + responseTime + "ms",
    });
    return;
  }

  // get user config
  const userConfig = await userConfigRef.doc(jid).get();
  if (userConfig.exists) {
    MESSAGE_QUEUE_DELAY = userConfig.data()?.responseTime ?? 10000;
  }

  try {
    // Log basic message info but avoid full content for privacy
    logger.info(
      {
        jid,
        messageId,
        fromMe: msg.key.fromMe,
        pushName: msg.pushName,
        timestamp: msg.messageTimestamp,
        rawMsg: msg,
      },
      "Processing message"
    );

    const messageType = getContentType(msg.message);
    const isMedia = [
      "imageMessage",
      "audioMessage",
      "documentMessage",
      "videoMessage",
    ].includes(messageType ?? "");

    // Handle media processing if needed
    let processResult = null;
    let mimeType = null;

    if (isMedia) {
      logger.debug({ messageId, messageType }, "Processing media message");
      const result = await processMediaMessage(
        msg,
        messageType,
        messageId,
        sock
      );
      processResult = result.processResult;
      mimeType = result.mimeType;
    }

    // Store message in Firestore
    logger.debug({ messageId, messageType }, "Storing message in firestore");
    const messageData = await storeMessage(msg, {
      jid,
      messageId,
      type,
      processResult,
      isMedia,
      messageType,
      mimeType,
    });

    logger.debug({ messageData }, "Message data stored");

    // Ensure chat document exists
    await upsertChat(jid, msg, sock);

    const duration = Date.now() - startTime;
    logger.debug(
      { messageId, duration },
      "Message processing completed. Sending to queue"
    );

    // Queue message for further processing
    if (!msg.key.fromMe) {
      await runMessageQueue(msg, sock);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      {
        err: error,
        jid,
        messageId,
        duration,
      },
      "Error in message processing pipeline"
    );
  }
}

/**
 * Processes media messages (images, audio, documents)
 */

async function processMediaMessage(
  msg: WAMessage,
  messageType: MessageType | undefined,
  messageId: string,
  sock: ReturnType<typeof makeWASocket>
): Promise<{ processResult: string | null; mimeType: string | null }> {
  const startTime = Date.now();
  let tempFilePath: string | null = null;

  try {
    // Download the media
    logger.debug({ messageId, messageType }, "Downloading media");
    const mediaBuffer = await downloadMediaMessage(
      messageType === "documentWithCaptionMessage"
        ? (msg.message?.documentWithCaptionMessage?.message as any)
        : msg,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: logger as any,
      }
    );

    const getMimeType = () => {
      switch (messageType) {
        case "imageMessage":
          return msg.message?.imageMessage?.mimetype;
        case "audioMessage":
          return msg.message?.audioMessage?.mimetype;
        case "documentMessage":
          return msg.message?.documentMessage?.mimetype;
        case "videoMessage":
          return msg.message?.videoMessage?.mimetype;
        case "documentWithCaptionMessage":
          return msg.message?.documentWithCaptionMessage?.message
            ?.documentMessage?.mimetype;
        default:
          return null;
      }
    };

    // Determine mime type
    const mimeType = getMimeType() ?? null;
    const extension = mimeType
      ? `.${mime.extension(mimeType) || "bin"}`
      : ".bin";

    // Upload to Firebase Storage
    tempFilePath = path.join(
      __dirname,
      "..",
      process.env.TEMP_DIR || ".temp",
      `${messageId}${extension}`
    );

    // Ensure temp directory exists
    try {
      await mkdir(path.join(__dirname, "..", process.env.TEMP_DIR || ".temp"), {
        recursive: true,
      });
    } catch (mkdirError) {
      logger.error(
        { err: mkdirError, dir: process.env.TEMP_DIR },
        "Failed to create temp directory"
      );
    }

    // Write media to temp file
    await writeFile(
      tempFilePath,
      mediaBuffer,
      messageType === "imageMessage" ? "base64" : undefined
    );

    logger.debug({ messageId, tempFilePath }, "Media saved to temp file");

    // Upload to Firebase Storage
    if (bucket !== undefined) {
      try {
        const bucketFilename = `${msg.key.remoteJid}/${messageId}${extension}`;

        await bucket.upload(tempFilePath, {
          destination: bucketFilename,
          metadata: {
            contentType: mimeType || "application/octet-stream",
          },
        });

        logger.debug(
          { messageId, bucketFilename },
          "Media uploaded to storage"
        );
      } catch (uploadError) {
        logger.error(
          { err: uploadError, messageId },
          "Failed to upload media to storage"
        );
      }
    } else {
      logger.warn(
        { messageId },
        "Storage bucket not available, skipping upload"
      );
    }

    // Process based on media type
    let processResult: string | null = null;

    switch (messageType) {
      case "imageMessage":
        logger.debug({ messageId }, "Processing image with AI");
        processResult = await processImage(tempFilePath);
        break;
      case "audioMessage":
        logger.debug({ messageId }, "Processing audio with AI");
        processResult = await processAudio(tempFilePath);
        break;
      case "videoMessage":
        logger.debug({ messageId }, "Processing video with AI");
        processResult = await processVideo(
          tempFilePath,
          mimeType ?? "video/mp4"
        );
        break;
      case "documentMessage":
      case "documentWithCaptionMessage":
        logger.debug({ messageId }, "Processing document");
        processResult = await processDocument(tempFilePath, mimeType);
        break;

      default:
        // No processing for other types
        break;
    }

    const duration = Date.now() - startTime;
    logger.debug(
      { messageId, messageType, duration },
      "Media processing completed"
    );

    return { processResult, mimeType };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      {
        err: error,
        messageId,
        messageType,
        duration,
      },
      "Media processing failed"
    );

    // Attempt to clean up temp file if it exists
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError, tempFilePath },
          "Failed to clean up temp file"
        );
      }
    }

    return { processResult: null, mimeType: null };
  }
}

async function processLinkMessage(
  msg: WAMessage,
  messageId: string,
  sock: ReturnType<typeof makeWASocket>
) {
  const link = msg.message?.conversation;
  if (!link) {
    logger.debug({ messageId }, "Skipping message with no link");
    return;
  }
}

/**
 * Stores message data in Firestore
 */
async function storeMessage(
  msg: WAMessage,
  {
    jid,
    messageId,
    type,
    processResult,
    isMedia,
    messageType,
    mimeType,
  }: {
    jid: string;
    messageId: string;
    type: string;
    processResult: string | null;
    isMedia: boolean;
    messageType: MessageType | undefined;
    mimeType: string | null;
  }
) {
  if (messageType === "reactionMessage") {
    logger.debug({ messageId, messageType }, "Storing reaction message");
    const reaction = msg.message?.reactionMessage;
    if (reaction) {
      const originalMessageRef = messagesRef.doc(reaction.key?.id!);
      // check if original message exists
      const originalMessage = await originalMessageRef.get();
      if (!originalMessage.exists) {
        logger.error(
          `Original message not found for reaction ${reaction.text}`
        );
        return;
      }

      // only one reaction per person so lets have an object with from ids as keys. also store timestamp of reaction. also if reaction.text is empty, that means to remove the reaction.
      const reactions = originalMessage.data()?.reactions || {};
      if (reaction.text === "") {
        delete reactions[msg.key.remoteJid!];
        await originalMessageRef.update({
          reactions,
        });
        logger.debug({ messageId, reaction }, "Reaction removed");
      }

      reactions[msg.key.remoteJid!] = {
        reaction: reaction.text,
        timestamp: convertToFirestoreTimestamp(toNumber(msg.messageTimestamp)),
      };
      await originalMessageRef.update({
        reactions,
      });
      logger.debug({ messageId, reaction }, "Reaction stored");
    }
    return;
  }
  const messageData = {
    ...serializeToPlainObject(msg),
    chatId: jid,
    timestamp: convertToFirestoreTimestamp(toNumber(msg.messageTimestamp)),
    upsertType: type,
    processResult: processResult || undefined,
    isMedia,
    messageType,
    mimeType: mimeType || undefined,
  };

  await messagesRef.doc(messageId).set(messageData);

  return messageData as FirestoreMessage;
}

/**
 * Creates or updates chat document in Firestore
 */
async function upsertChat(
  jid: string,
  msg: WAMessage,
  sock: ReturnType<typeof makeWASocket>
) {
  const chatDoc = await chatsRef.doc(jid).get();
  const isGroup = isJidGroup(jid);
  const groupMetadata = isGroup ? await sock.groupMetadata(jid) : undefined;
  const name = isGroup
    ? groupMetadata?.subject
    : msg.key.fromMe
    ? undefined
    : msg.pushName;

  logger.debug(
    { name, isGroup, groupMetadata },
    `Chat is ${isGroup ? "group" : "not group"}. Upserting in chats collection`
  );

  await chatsRef.doc(jid).set(
    {
      id: jid,
      isGroup,
      name,
      participants: isGroup ? groupMetadata?.participants : undefined,
      desc: isGroup ? groupMetadata?.desc : undefined,
      creation: isGroup ? groupMetadata?.creation : undefined,
      lastActivityTimestamp: convertToFirestoreTimestamp(
        toNumber(msg.messageTimestamp)
      ),
    },
    { merge: true }
  );
}

const processMessages = async (messages: WAMessage[], jid: string) => {
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

function generateLLMContext(
  messages: FirestoreMessage[],
  currentChatId: string,
  currentTime: number
): { context: string; contextMessages: ContextMessage[] } {
  let context = `-- CHAT ID: ${currentChatId} --\n`;
  context += `- Current time: ${new Date(currentTime).toLocaleString()}\n`;
  let contextMessages: ContextMessage[] = [];

  // Calculate time since last message from me
  const lastMessageFromMe = messages.findLast((msg) => msg.key.fromMe);

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
    const sender = msg.key.fromMe ? "ME" : msg.pushName;

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
      key: msg.key,
      message: `[${timestamp}] ${sender}: ${messageContent}\n`,
    });
  });

  return { context, contextMessages };
}

/**
 * Clears all messages for a given chat
 */
async function clearChatHistory(chatId: string) {
  const messages = await messagesRef.where("chatId", "==", chatId).get();
  const batch = db.batch();
  messages.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

export default function makeMessageProcessor() {
  return {
    loadMessages,
    loadMessage,
    loadChat,
    bind,
  };
}
