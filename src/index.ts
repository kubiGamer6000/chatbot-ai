// ENV SETUP //

import "./utils/env.js";
import makeMessageProcessor from "./messageProcessor.js";

// SERVICES //
import { sendTelegramMessage, sendTelegramPhoto } from "./services/telegram.js";

import { generateQRImage } from "./utils/generateQrImage.js";

import * as fs from "fs";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  AnyMessageContent,
} from "@whiskeysockets/baileys";
import NodeCache from "node-cache";

import logger from "./utils/logger.js";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { z } from "zod";

const processor = makeMessageProcessor();

// ensure logger exists
if (!logger) {
  throw new Error("Logger is not defined");
}

let sock: ReturnType<typeof makeWASocket>;

async function connectToWhatsApp() {
  try {
    const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

    const { state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, ".auth", process.env.WHATSAPP_CLIENT_ID)
    );

    sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS("Desktop"),
      cachedGroupMetadata: async (jid) => groupCache.get(jid),
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        const msg = await processor.loadMessage(key.id!);

        return msg?.message || undefined;
      },
      logger: logger as Logger,
    });

    processor.bind(sock);

    sock.ev.on("chats.upsert", () => {});

    sock.ev.on("messages.upsert", async ({ messages }) => {});

    sock.ev.on("contacts.upsert", () => {});

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (update.qr) {
        const filePath = await generateQRImage(update.qr);
        await sendTelegramPhoto(filePath, "New WhatsApp QR Code");
        fs.unlinkSync(filePath);
      }
      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;
        console.log(
          "connection closed due to ",
          lastDisconnect?.error,
          ", reconnecting ",
          shouldReconnect
        );
        // reconnect if not logged out
        if (shouldReconnect) {
          connectToWhatsApp();
        }
      } else if (connection === "open") {
        logger.info("opened connection");
        sendTelegramMessage("🟢 Bot WhatsApp connection opened");
      }
    });

    sock.ev.on("groups.update", async ([event]) => {
      if (!event?.id) return;
      const metadata = await sock.groupMetadata(event.id);
      groupCache.set(event.id, metadata);
    });

    sock.ev.on("group-participants.update", async (event) => {
      if (!event.id) return;
      const metadata = await sock.groupMetadata(event.id);
      groupCache.set(event.id, metadata);
    });
    sock.ev.on("creds.update", saveCreds);
  } catch (error) {
    logger.error("Error connecting to WhatsApp", error);
    throw error;
  }
}

const SendMessageSchema = z.object({
  body: z.object({
    jid: z.string().min(1),
    messages: z.array(z.custom<AnyMessageContent>()).min(1),
  }),
});

// type SendMessageRequest = z.infer<typeof SendMessageSchema>;

// create and do prod config of express server
const app = express();
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Middleware to authenticate requests using an API key passed in the Authorization header.
 * Expected header format: "Authorization: apiKey your-secret-key"
 */
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    // If the authorization header is missing, forward an error
    return next(new Error("No API key provided"));
  }

  // check if Bearer process.env.WEBHOOK_AUTH_KEY
  if (authHeader !== `Bearer ${process.env.WEBHOOK_AUTH_KEY}`) {
    return next(new Error("Invalid API key"));
  }

  // API key is valid; proceed to the next middleware/route handler
  next();
}

// Error handling middleware
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    logger.error(
      {
        err, // This properly serializes the entire error object
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      },
      "Express error"
    );

    res.status(500).json({ error: "Internal server error. See server logs." });
  }
);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

//listen for post requests
app.post("/sendMessage", apiKeyAuth, async (req: any, res: any) => {
  logger.info(`Received request to send messages to ${req.body.jid}`);
  try {
    const validatedReq = SendMessageSchema.parse(req);

    logger.info(`Sending messages to ${validatedReq.body.jid}`);

    // Send each message in the array
    if (!sock) return;
    for (const message of validatedReq.body.messages) {
      await sock.sendMessage(validatedReq.body.jid, message);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Invalid request format",
        details: error.errors,
      });
    } else {
      logger.error("Error sending message", error);
      res.status(500).json({
        success: false,
        error: "Failed to send message",
      });
    }
  }
});

app.listen(PORT, () => {
  logger.info(`Express server running on port ${PORT}`);

  connectToWhatsApp();
});
