import { OpenAI } from "openai";
import fs from "fs";
import { sendTelegramError } from "../telegram";
import logger from "../../utils/logger";

/**
 * Process an image using OpenAI's GPT-4o Vision API
 * @param filePath Path to the image file
 * @param prompt Custom prompt for image description (optional, defaults to process.env.IMAGE_PROMPT)
 * @returns Promise<string | null> Description of the image or null if processing fails
 */
export async function processImage(
  filePath: string,
  prompt: string = process.env.IMAGE_PROMPT
): Promise<string | null> {
  // Track time for performance monitoring
  const startTime = Date.now();

  try {
    if (!fs.existsSync(filePath)) {
      logger.error({ filePath }, "Image file not found");
      return null;
    }

    if (!process.env.OPENAI_API_KEY) {
      logger.error("OpenAI API key not set, skipping image processing");
      return null;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const base64Image = fs.readFileSync(filePath, "base64");

    logger.debug({ filePath }, "Sending image to GPT-4.1 for analysis");
    const response = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_tokens: 2000,
    });

    const processingTime = Date.now() - startTime;
    logger.debug({ processingTime }, "Image processed successfully");

    return response.choices[0]?.message?.content ?? null;
  } catch (error) {
    const errorObj =
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : error;

    logger.error(
      { err: errorObj, filePath, processingTime: Date.now() - startTime },
      "Image processing failed"
    );

    sendTelegramError(
      `Image processing failed: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`
    );
    return null;
  }
}
