import { bucket, db } from "./services/firebase-admin.js";
import type {
  makeWASocket,
  WAMessage,
  Chat,
  MessageType,
} from "@whiskeysockets/baileys";
import {
  downloadMediaMessage,
  extensionForMediaMessage,
  extractMessageContent,
  getContentType,
  isJidGroup,
} from "@whiskeysockets/baileys";
import { proto, toNumber } from "@whiskeysockets/baileys";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

import { Timestamp } from "firebase-admin/firestore";
import { writeFile, unlink, mkdir } from "fs/promises";
import path from "path";
import { processImage } from "./services/media/image.js";
import { processAudio } from "./services/media/audio.js";

import { processMessages } from "./services/chatbot.js";

import logger from "./utils/logger.js";
import { processDocument } from "./services/media/document.js";

import type { FirestoreMessage } from "./types.js";

import { processVideo } from "./services/media/video.js";
import { sendWebhook } from "./services/webhook.js";
import { Boom } from "@hapi/boom";
import { createThread, runAgentThread } from "./services/langgraph.js";

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
const threadsRef = db.collection("threads");
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

// * MESSAGE PROCESSOR - Processes a single new message, handling commands, media, and storage

async function handleNewMessage(
  msg: WAMessage,
  type: "append" | "notify",
  sock: ReturnType<typeof makeWASocket>
) {
  const msgContent = extractMessageContent(msg.message);

  if (!msgContent) {
    logger.debug({ messageId: msg.key.id }, "Skipping message with no content");
    return;
  }

  // check if message id is already in the database
  const msgRef = messagesRef.doc(msg.key.id!);
  const msgDoc = await msgRef.get();
  if (msgDoc.exists) {
    logger.debug(
      { messageId: msg.key.id },
      "Skipping message that already exists"
    );
    return;
  }

  const msgType = getContentType(msgContent);
  const jid = jidNormalizedUser(msg.key.remoteJid!);
  const msgId = msg.key.id!;

  const startTime = Date.now();

  // * QUEUE COMMAND HANDLER - simple commands for managing history and response time
  // TODO: clean implementation, separate into file/function

  // Get user's config
  const userConfig = await userConfigRef.doc(jid).get();
  if (userConfig.exists) {
    MESSAGE_QUEUE_DELAY = userConfig.data()?.responseTime ?? 10000;
  }

  if (msgContent.conversation === "CLEAR_HISTORY") {
    await clearChatHistory(jid);
    await sock.sendMessage(jid, { text: "✅ History cleared" });
    return;
  }

  if (msgContent.conversation?.startsWith("SET_RESPONSE_TIME")) {
    // Validate command
    const responseTime = parseInt(msgContent.conversation.split(" ")[1]);
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

  try {
    // Log basic message info but avoid full content for privacy
    logger.info(
      {
        jid,
        msgId,
        fromMe: msg.key.fromMe,
        pushName: msg.pushName,
        timestamp: msg.messageTimestamp,
        rawMsg: msg,
      },
      "Processing message"
    );

    // * process media

    let processResult: string | null = null;

    const mediaContent = assertMediaContent(msgContent);

    if (mediaContent) {
      processResult = await processMediaMessage(msg, sock);
    }

    // Store message in Firestore
    logger.debug({ msgId, msgType }, "Storing message in firestore");
    const messageData = await storeMessage(msg, {
      jid,
      messageId: msgId,
      type,
      processResult,
      isMedia: mediaContent ? true : false,
      messageType: msgType,
      mimeType: mediaContent?.mimetype ?? null,
    });

    logger.debug({ messageData }, "Message data stored");

    // Ensure chat document exists
    await upsertChat(jid, msg, sock);

    const duration = Date.now() - startTime;
    logger.debug(
      { msgId, duration },
      "Message processing completed. Sending to queue"
    );

    // Queue message for further processing
    if (!msg.key.fromMe) {
      // check if the chat alreadt has a thread in firestore

      const threadRef = threadsRef.doc(jid);
      const threadDoc = await threadRef.get();
      if (!threadDoc.exists) {
        // create a new thread with user's jid as the
        const { agent, thread } = await createThread();
        await threadRef.set({
          assistantId: agent.assistant_id,
          threadId: thread.thread_id,
        });
      }

      sock.sendPresenceUpdate("composing", jid);
      const response = await runAgentThread(
        threadDoc.data()?.threadId,
        threadDoc.data()?.assistantId,
        {
          jid,
          messageId: msgId,
          type,
          processResult,
          isMedia: mediaContent ? true : false,
          messageType: msgType,
          mimeType: mediaContent?.mimetype ?? null,
        } as any
      );

      sock.sendMessage(jid, { text: response as any });

      // await runMessageQueue(msg, sock);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      {
        err: error,
        jid,
        msgId,
        duration,
      },
      "Error in message processing pipeline"
    );
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

/**
 * Process and store a message with media
 *
 * This function handles incoming messages, processes them based on type,
 * stores them in Firestore, and queues them for further processing.
 *
 * @param msg - The WhatsApp message object
 * @param type - Whether the message is being appended or is a notification
 * @param sock - The WhatsApp socket connection
 */

const processMediaMessage = async (
  msg: WAMessage,
  sock: ReturnType<typeof makeWASocket>
) => {
  const msgContent = extractMessageContent(msg.message);

  if (!msgContent) {
    throw new Boom("No message present", { statusCode: 400, data: msg });
  }

  const mediaContent = assertMediaContent(msgContent);
  if (!mediaContent) {
    throw new Boom("No media content present", {
      statusCode: 400,
      data: msg,
    });
  }
  const msgId = msg.key.id!;
  const msgType = getContentType(msgContent);
  const startTime = Date.now();

  // Download media

  const mediaBuffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: logger as any,
    }
  );

  const mimeType = mediaContent.mimetype ?? null;
  const extension = extensionForMediaMessage(msgContent);

  // * Store media to temp file
  const tempDir = process.env.TEMP_DIR || ".temp";
  const tempFilePath = path.join(
    __dirname,
    "..",
    tempDir,
    `${msgId}${extension}`
  );

  // Ensure temp directory exists
  try {
    await mkdir(path.join(__dirname, "..", tempDir), {
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
    msgType === "imageMessage" ? "base64" : undefined // base64 for images - easier passing to llm
  );

  logger.debug({ msgId, tempFilePath }, "Media saved to temp file");

  // * Upload to Firebase Storage
  if (bucket) {
    try {
      const bucketFilename = `${msg.key.remoteJid}/${msgId}${extension}`;

      await bucket.upload(tempFilePath, {
        destination: bucketFilename,
        metadata: {
          contentType: mimeType || "application/octet-stream",
        },
      });

      logger.debug({ msgId, bucketFilename }, "Media uploaded to storage");
    } catch (uploadError) {
      logger.error(
        { err: uploadError, msgId },
        "Failed to upload media to storage"
      );
    }
  } else {
    logger.warn({ msgId }, "Storage bucket not available, skipping upload");
  }

  let processResult: string | null = null;
  // * Process media with AI
  try {
    // Process based on media type

    switch (msgType) {
      case "imageMessage":
        logger.debug({ msgId }, "Processing image with AI");
        processResult = await processImage(tempFilePath);
        break;
      case "audioMessage":
        logger.debug({ msgId }, "Processing audio with AI");
        processResult = await processAudio(tempFilePath);
        break;
      case "videoMessage":
        logger.debug({ msgId }, "Processing video with AI");
        processResult = await processVideo(
          tempFilePath,
          mimeType ?? "video/mp4"
        );
        break;
      case "documentMessage":
        logger.debug({ msgId }, "Processing document");
        processResult = await processDocument(tempFilePath, mimeType);
        break;
      case "stickerMessage":
        logger.debug({ msgId }, "Processing sticker");
        processResult = await processImage(tempFilePath);
        break;
      default:
        logger.debug(
          { msgId },
          "Generic media type - trying to process as document"
        );
        processResult = await processDocument(tempFilePath, mimeType);
        break;
    }

    const duration = Date.now() - startTime;
    logger.debug({ msgId, msgType, duration }, "Media processing completed");
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      {
        err: error,
        msgId,
        msgType,
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
  }

  return processResult;
};

/**
 * Clears all messages for a given chat
 */
async function clearChatHistory(chatId: string) {
  const messages = await messagesRef.where("chatId", "==", chatId).get();
  const batch = db.batch();
  messages.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

export const assertMediaContent = (
  content: proto.IMessage | null | undefined
) => {
  content = extractMessageContent(content);
  const mediaContent =
    content?.documentMessage ||
    content?.imageMessage ||
    content?.videoMessage ||
    content?.audioMessage ||
    content?.stickerMessage;
  if (!mediaContent) {
    return null;
  }

  return mediaContent;
};

export default function makeMessageProcessor() {
  return {
    loadMessages,
    loadMessage,
    loadChat,
    bind,
  };
}
