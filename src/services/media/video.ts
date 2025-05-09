import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";
import fs from "fs";
import { sendTelegramError } from "../telegram";
import logger from "../../utils/logger";

/**
 * Process a video using Google's Gemini 2.5 Pro model
 * @param filePath Path to the video file
 * @param prompt Custom prompt for video description (optional, defaults to process.env.VIDEO_PROMPT)
 * @returns Promise<string | null> Description of the video or null if processing fails
 */
export async function processVideo(
  filePath: string,
  mimeType: string = "video/mp4",
  prompt: string = process.env.VIDEO_PROMPT ||
    "Outline this video content in full detail. Give a general concise summary and then a full chronological breakdown of different scenes/parts/events."
): Promise<string | null> {
  // Track time for performance monitoring
  const startTime = Date.now();

  try {
    if (!fs.existsSync(filePath)) {
      logger.error({ filePath }, "Video file not found");
      return null;
    }

    if (!process.env.GOOGLE_API_KEY) {
      logger.error("Google API key not set, skipping video processing");
      return null;
    }

    // Initialize Google GenAI client
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

    logger.debug({ filePath }, "Uploading video to Gemini API");
    // Upload the video file
    const videoFile = await ai.files.upload({
      file: filePath,
      config: { mimeType: mimeType },
    });

    // Poll for file ready status
    logger.debug(
      { fileId: videoFile.name },
      "Waiting for video to be processed by Gemini"
    );
    const maxAttempts = 60; // 1 minute max wait time (60 * 10 seconds = 10 minutes)
    let attempts = 0;
    let fileReady = false;

    while (!fileReady && attempts < maxAttempts) {
      if (!videoFile.name) {
        logger.error({ fileId: videoFile.name }, "Video file name not found");
        throw new Error("Video file name not found");
      }
      const fetchedFile = await ai.files.get({ name: videoFile.name });
      if (fetchedFile.state === "ACTIVE") {
        fileReady = true;
        logger.debug(
          { fileId: videoFile.name },
          "Video file is now active and ready for processing"
        );
      } else {
        attempts++;
        logger.debug(
          {
            fileId: videoFile.name,
            state: fetchedFile.state,
            attempt: attempts,
          },
          "Video file not ready yet, waiting 5 seconds"
        );
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }

    if (!fileReady) {
      logger.error(
        { fileId: videoFile.name },
        "Video file did not become active within the timeout period"
      );
      throw new Error("Timeout waiting for video file to become active");
    }

    // Process the video with Gemini
    logger.debug({ filePath }, "Sending video to Gemini 2.5 Pro for analysis");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro-preview-03-25",
      contents: createUserContent([
        createPartFromUri(videoFile.uri || "", videoFile.mimeType || ""),
        prompt,
      ]),
    });

    const processingTime = Date.now() - startTime;
    logger.debug({ processingTime }, "Video processed successfully");

    return response.text || null;
  } catch (error) {
    const errorObj =
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : error;

    logger.error(
      { err: errorObj, filePath, processingTime: Date.now() - startTime },
      "Video processing failed"
    );

    sendTelegramError(
      `Video processing failed: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`
    );
    return null;
  }
}
