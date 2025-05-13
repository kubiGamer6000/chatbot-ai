// Check if the environment variables are set
// If not, throw an error
import * as dotenv from "dotenv";
import findConfig from "find-config";
import path from "path";

dotenv.config({
  path: findConfig(".env") || path.resolve(process.cwd(), "../../.env"),
});

import { z, TypeOf } from "zod";
const zodEnv = z.object({
  // Telegram configs
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_TOKEN_SECONDARY: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().min(1),

  // WhatsApp config
  WHATSAPP_CLIENT_ID: z.string().min(1),
  WHATSAPP_PHONE_NUMBER: z.string().min(1),

  // Firebase configs
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  FIRESTORE_CHAT_COLLECTION: z.string().min(1),
  FIRESTORE_MESSAGE_COLLECTION: z.string().min(1),
  FIRESTORE_TASK_COLLECTION: z.string().min(1),

  // AI API keys
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLAMA_CLOUD_API_KEY: z.string().min(1),
  GOOGLE_API_KEY: z.string().min(1),
  LANGSMITH_API_KEY: z.string().min(1),

  // Webhook URL
  WEBHOOK_URL: z.string().min(1),
  WEBHOOK_AUTH_KEY: z.string().min(1),

  // Image processing
  IMAGE_PROMPT: z.string().min(1),

  // port
  PORT: z.string().optional().default("3001"), //either string or number

  // File system
  TEMP_DIR: z.string().optional().default(".temp"),
});

declare global {
  namespace NodeJS {
    interface ProcessEnv extends TypeOf<typeof zodEnv> {}
  }
}

try {
  zodEnv.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    const { fieldErrors } = err.flatten();
    const errorMessage = Object.entries(fieldErrors)
      .map(([field, errors]) =>
        errors ? `${field}: ${errors.join(", ")}` : field
      )
      .join("\n  ");
    throw new Error(`Missing environment variables:\n  ${errorMessage}`);
    process.exit(1);
  }
}
