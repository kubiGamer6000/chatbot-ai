import { Client, ThreadState } from "@langchain/langgraph-sdk";
import { FirestoreMessage } from "../types";
import { generateLLMContext } from "./chatbot";

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
  });

  return (response as any).messages[(response as any).messages.length - 1]
    .kwargs.content[0].text;
};
