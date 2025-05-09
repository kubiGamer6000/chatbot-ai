import axios from "axios";
import { sendTelegramError } from "./telegram";
import logger from "../utils/logger";

export async function sendWebhook(data: any) {
  try {
    await axios.post(process.env.WEBHOOK_URL, data, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WEBHOOK_AUTH_KEY}`,
      },
    });
  } catch (error: any) {
    logger.error("Failed to send webhook:", error);
    await sendTelegramError(`Failed to send webhook: ${JSON.stringify(error)}`);
  }
}
