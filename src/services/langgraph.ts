import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: "https://scandiai-16a992c23975590085c548e27f64788d.us.langgraph.app",
  apiKey: process.env.LANGSMITH_API_KEY,
});

// List all assistants
const assistants = await client.assistants.search({
  metadata: null,
  offset: 0,
  limit: 10,
});

// We auto-create an assistant for each graph you register in config.
const agent = assistants[0];

const createThread = async (assistantId: string) => {
  // Start a new thread
  const thread = await client.threads.create();
};

const streamThread = async (threadId: string, assistantId: string) => {
  // Start a streaming run
  const messages = [{ role: "human", content: "what's the weather in la" }];

  const streamResponse = client.runs.stream(threadId, assistantId, {
    input: { messages },
  });

  for await (const chunk of streamResponse) {
    console.log(chunk);
  }
};
