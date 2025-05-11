// src/services/meetingWebhookHandler.ts
import logger from "../utils/logger";
import type makeWASocket from "@whiskeysockets/baileys";

type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Handles MeetingBaas webhook events and sends notifications via WhatsApp
 * @param event The webhook event data from MeetingBaas
 * @param sock WhatsApp socket client
 */
export const handleMeetingWebhook = async (event: any, sock: WASocket) => {
  // Extract JID from event data
  const jid = event.data?.extra?.jid;

  if (!jid) {
    logger.error("No JID provided in webhook event");
    return { success: false, error: "No JID provided" };
  }

  try {
    // Handle bot status change events
    if (event.event === "bot.status_change") {
      const statusCode = event.data?.status?.code;

      switch (statusCode) {
        case "joining_call":
          await sock.sendMessage(jid, { text: "🔄 Joining meeting..." });
          break;
        case "in_waiting_room":
          await sock.sendMessage(jid, {
            text: "⏳ Bot is in the waiting room",
          });
          break;
        case "in_call_recording":
          await sock.sendMessage(jid, { text: "🔴 Recording started" });
          break;
        case "call_ended":
          await sock.sendMessage(jid, { text: "🏁 Meeting ended" });
          break;
        // Other status cases...
        default:
          await sock.sendMessage(jid, {
            text: `📢 Status update: ${statusCode}`,
          });
      }
    }
    // Handle final meeting data events
    else if (event.event === "complete") {
      await sock.sendMessage(jid, {
        text: "✅ Meeting recorded successfully!",
      });
    } else if (event.event === "failed") {
      const error = event.data?.error || "Unknown error";
      await sock.sendMessage(jid, { text: `❌ Meeting failed: ${error}` });
    }
    // Other event types...

    return { success: true };
  } catch (error) {
    logger.error("Error processing webhook event", error);
    return { success: false, error: "Error processing event" };
  }
};
