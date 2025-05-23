import {
  isJidGroup,
  toNumber,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import logger from "../utils/logger";
import { loadMessages } from "../messageProcessor";
import { sendWebhook } from "./webhook";
import { Client, ThreadState } from "@langchain/langgraph-sdk";
import { FirestoreMessage } from "../types";
import { db } from "./firebase-admin.js";
const threadsRef = db.collection("threads");

export const sendToAgent = async (
  message: WAMessage,
  messageData: FirestoreMessage,
  jid: string
) => {
  // logger.info(`Processing ${messages.length} messages for ${jid}`);
  // const messageHistory = await loadMessages(jid, 25);

  // console.log(messageHistory);
  // const { context, contextMessages } = generateLLMContext(
  //   messageHistory,
  //   jid,
  //   Date.now()
  // );

  // logger.info("sending webhook");
  // await sendWebhook({
  //   conversationContext: context,
  //   contextMessages,
  //   rawData: messageHistory,
  //   jid,
  // });
  const threadRef = threadsRef.doc(jid);
  const threadDoc = await threadRef.get();

  let assistantId, threadId;

  if (!threadDoc.exists) {
    // create a new thread with user's jid as the ID
    const { agent, thread } = await createThread();
    assistantId = agent.assistant_id;
    threadId = thread.thread_id;

    await threadRef.set({
      assistantId,
      threadId,
    });
  } else {
    // Use existing thread data
    assistantId = threadDoc.data()?.assistantId;
    threadId = threadDoc.data()?.threadId;
  }

  const response = await runAgentThread(
    threadId,
    assistantId,
    messageData as FirestoreMessage
  );

  return response;

  // TODO: Queue to resend if webhook fails
};

type ContextMessage = {
  key: WAMessageKey;
  message: string;
};

const client = new Client({
  apiUrl: "https://scandiai-16a992c23975590085c548e27f64788d.us.langgraph.app",
  apiKey: process.env.LANGSMITH_API_KEY,
});

export const createThread = async (threadId?: string) => {
  // Start a new thread
  const assistants = await client.assistants.search({
    metadata: null,
    graphId: "agent",
    offset: 0,
    limit: 10,
  });

  // We auto-create an assistant for each graph you register in config.
  const agent = assistants[0];

  const thread = await client.threads.create();

  return { agent, thread };
};

export const runAgentThread = async (
  threadId: string,
  assistantId: string,
  message: FirestoreMessage
) => {
  // Start a streaming run
  const { contextMessages } = generateLLMContext(
    [message],
    threadId,
    Date.now()
  );

  // contextMessages { key}

  const response = await client.runs.wait(threadId, assistantId, {
    input: {
      messages: [{ role: "human", content: contextMessages[0].message }],
    },
    multitaskStrategy: "interrupt",
  });

  return (response as any).messages[(response as any).messages.length - 1]
    .content[0].text;
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
        case "pollCreationMessageV3":
          messageContent = `[POLL CREATED]\nName: ${
            msg.message?.pollCreationMessageV3?.name
          }\nOptions: ${JSON.stringify(
            msg.message?.pollCreationMessageV3?.options
          )}`;
          break;
        case "pollUpdateMessage":
          messageContent = `[VOTE UPDATED]`;
          // TODO: Add better poll tracking
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
    // add jid and message id to the message content (in beginning, in  [ )
    const messageKeyData = `remoteJid: ${msg.key.remoteJid}, msgId: ${msg.key.id}, fromMe: ${msg.key.fromMe}`;

    // context += `[MSG ID: ${msg.key.id}] [${timestamp}] ${sender}: ${messageContent}\n`;
    contextMessages.push({
      key: msg.key ?? { id: "unknown", remoteJid: "unknown", fromMe: false },
      message: `// ${messageKeyData} // [${timestamp}] ${sender}: ${messageContent}\n`,
    });
  });

  return { context, contextMessages };
}
