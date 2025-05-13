import { isJidGroup } from "@whiskeysockets/baileys";
import { FirestoreMessage } from "../types.js";

export function renderMessages(messages: FirestoreMessage[]): string {
  const renderedMessages: string[] = [];

  // Helper function to format the common parts of a message
  const formatMessagePrefix = (message: FirestoreMessage): string => {
    return `[${message.timestamp.toDate().toLocaleString()}] ${
      message.pushName
    } ${isJidGroup(message.chatId) ? `(${message.key.remoteJid})` : ""}`;
  };

  messages.forEach((message) => {
    const prefix = formatMessagePrefix(message);

    if (message.isMedia) {
      const mediaObject = message?.message?.[
        message.messageType as keyof typeof message.message
      ] as any;
      renderedMessages.push(
        `${prefix} (This ${message.messageType} was converted to text)
        ${message.processResult} ${
          mediaObject?.caption
            ? `\n[Media Caption] ${mediaObject?.caption}`
            : ""
        }`
      );
      return;
    }

    switch (message.messageType) {
      case "conversation":
        renderedMessages.push(`${prefix}: ${message.message?.conversation}`);
        return;
      case "extendedTextMessage":
        renderedMessages.push(
          `${prefix}: ${message.message?.extendedTextMessage?.text}`
        );
        return;
      case "videoMessage":
        renderedMessages.push(
          `${prefix}:[Video Message] ${message.message?.videoMessage?.caption}`
        );
      case "stickerMessage":
        renderedMessages.push(`${prefix}: [Sticker]`);
        return;
    }
    renderedMessages.push(JSON.stringify(message));
  });

  return renderedMessages.join("\n");
}
