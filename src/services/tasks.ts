import { WAMessage } from "@whiskeysockets/baileys";
import { db } from "./firebase-admin.js";
import { FirestoreMessage } from "../types.js";
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { Timestamp } from "firebase-admin/firestore";
import { renderMessages } from "../utils/renderMessages.js";
import logger from "../utils/logger.js";

const actionSchema = z.object({
  action: z.enum(["calendar", "email", "whatsapp_message"]),
  description: z.string().describe("A short description of the action"),
});

const taskSchema = z.object({
  title: z.string().describe("The title of the task"),
  description: z.string().describe("A short description of the task"),
  urgency: z
    .number()
    .min(0)
    .max(5)
    .describe(
      "The urgency level of the task, 1 being the least urgent and 5 being the most urgent"
    ),
  dueDate: z.string().describe("The due date of the task").optional(),
  contactName: z
    .string()
    .describe("The name of the contact that the task is about"),
  actions: z.array(actionSchema).optional(),
});

interface FirestoreTask extends z.infer<typeof taskSchema> {
  status: "pending" | "completed" | "cancelled";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  contactId: string;
}

export const createTask = async (msg: FirestoreMessage) => {
  const messageId = msg.key.id || "unknown";
  const contactId = msg.key.remoteJid || "unknown";

  try {
    logger.info({ messageId, contactId }, "Starting task creation process");

    // Validate environment variables
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }

    if (!process.env.FIRESTORE_TASK_COLLECTION) {
      throw new Error(
        "FIRESTORE_TASK_COLLECTION environment variable is not set"
      );
    }

    // Get chat context
    let chatContext;
    try {
      chatContext = await getChatContext(msg);
      logger.debug(
        {
          messageId,
          contactId,
          contextSize: chatContext.length,
        },
        "Retrieved chat context for task creation"
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          messageId,
          contactId,
        },
        "Failed to retrieve chat context for task creation"
      );
      throw error;
    }

    // Get knowledge for contact (if available
    const contactDoc = await db
      .collection(process.env.FIRESTORE_CHAT_COLLECTION)
      .doc(contactId)
      .get();
    const contactDescription =
      contactDoc.data()?.knowledge?.shortDescription || undefined;

    const MAIN_PERSON = "Ace Blond";
    const prompt = `
    You are a task creator for ${MAIN_PERSON}, an entrepreneur based in Marbella, Spain. 
    You will receive a message that ${MAIN_PERSON} marked as a task - meaning that he wants to create a task from it.
    Now this can be a message from any one of his contacts, and the goal with these tasks is to help him get things done and remember to follow up on things.
    You will also receive the most recent messages from the chat to help you understand the context of the task.
    You will also receive a description of the contact for context if there is one.
    Use that context to create a task according to the provided schema.

    You will need to determine the urgency of the task based on the context, 1 being the least urgent and 5 being the most urgent.
    Also, if the task requires sending a message to somebody, emailing somebody, or adding something to the calendar, you will need to add that to the actions array
    If there is no need for any of these actions, you dont need to specify anything.

    If nothing in the chat indicates that urgency is high dont make it high!

    ${
      contactDescription
        ? `Here is a short description of the contact for context: ${contactDescription}`
        : ""
    }
    
    Here is the message that Ace marked as a task:
    ${renderMessages([msg])}

    Here is the ${chatContext.length} most recent messages from the chat:
    ${renderMessages(chatContext)}

    `;

    logger.debug(
      { messageId, contactId },
      "Calling Anthropic API for task creation"
    );

    const startTime = Date.now();
    const anthropic = new ChatAnthropic({
      model: "claude-3-7-sonnet-20250219",
      apiKey: process.env.ANTHROPIC_API_KEY,
      temperature: 1,
    });

    const model = anthropic.withStructuredOutput(taskSchema);

    let response;
    try {
      response = await model.invoke(prompt);
      const duration = Date.now() - startTime;
      logger.debug(
        {
          messageId,
          contactId,
          duration,
          taskTitle: response.title,
        },
        "Successfully extracted task structure from AI"
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        {
          err: error,
          messageId,
          contactId,
          duration,
        },
        "Failed to extract task structure from AI"
      );
      throw error;
    }

    const task: FirestoreTask = {
      ...response,
      status: "pending",
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      contactId: contactId,
    };

    try {
      const docRef = await db
        .collection(process.env.FIRESTORE_TASK_COLLECTION)
        .add(task);
      logger.info(
        {
          messageId,
          contactId,
          taskId: docRef.id,
          taskTitle: task.title,
          urgency: task.urgency,
        },
        "Successfully created new task"
      );
      return docRef.id;
    } catch (error) {
      logger.error(
        {
          err: error,
          messageId,
          contactId,
          taskTitle: task.title,
        },
        "Failed to save task to Firestore"
      );
      throw error;
    }
  } catch (error) {
    logger.error(
      {
        err: error,
        messageId,
        contactId,
      },
      "Task creation process failed"
    );
    throw error; // Re-throw to allow caller to handle the error
  }
};

const getChatContext = async (
  msg: FirestoreMessage,
  limit: number = 30
): Promise<FirestoreMessage[]> => {
  const contactId = msg.chatId;

  try {
    if (!process.env.FIRESTORE_MESSAGE_COLLECTION) {
      throw new Error(
        "FIRESTORE_MESSAGE_COLLECTION environment variable is not set"
      );
    }

    const messagesDocs = await db
      .collection(process.env.FIRESTORE_MESSAGE_COLLECTION)
      .where("chatId", "==", contactId)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const messages = messagesDocs.docs.map((doc) => doc.data());
    logger.debug(
      {
        contactId,
        messageCount: messages.length,
      },
      "Retrieved chat context messages"
    );

    return messages as FirestoreMessage[];
  } catch (error) {
    logger.error(
      {
        err: error,
        contactId,
      },
      "Failed to retrieve chat context from Firestore"
    );
    throw error;
  }
};
