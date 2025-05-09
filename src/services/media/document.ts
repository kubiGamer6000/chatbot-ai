import { LlamaParseReader } from "llamaindex";
import logger from "../../utils/logger";
import { sendTelegramError } from "../telegram";
import { processVideo } from "./video";
import { processImage } from "./image";
import { processAudio } from "./audio";

/**
 * Process a document using LlamaParse
 * @param filePath Path to the document file
 * @returns Promise<string | null> Markdown content of the document or null if processing fails
 */
export async function processDocument(
  filePath: string,
  mimeType: string | null
): Promise<string | null> {
  try {
    // Check if file is an image, video or audio - if so, process it as such by calling the appropriate function
    if (mimeType?.startsWith("image/")) {
      logger.info(`Document is an image: ${filePath}`);
      return processImage(filePath);
    } else if (mimeType?.startsWith("video/")) {
      logger.info(`Document is a video: ${filePath}`);
      return processVideo(filePath);
    } else if (mimeType?.startsWith("audio/")) {
      logger.info(`Document is an audio: ${filePath}`);
      return processAudio(filePath);
    }

    logger.info(`Processing other document (LlamaParse): ${filePath}`);

    // Set up the LlamaParse reader with markdown output
    const reader = new LlamaParseReader({ resultType: "markdown" });

    // Parse the document
    const documents = await reader.loadData(filePath);

    // If no documents were parsed, return null
    if (!documents || documents.length === 0) {
      logger.warn("No content extracted from document");
      return null;
    }

    // Combine all documents into a single markdown string
    // Each document represents a different section/page of the input file
    const markdownContent = documents
      .map((doc) => doc.text)
      .filter(Boolean) /* Remove falsey values */
      .join("\n\n");

    logger.info("Document successfully processed");
    return markdownContent;
  } catch (error) {
    logger.error("Document processing failed", error);
    sendTelegramError(`Document processing failed: ${JSON.stringify(error)}`);
    return null;
  }
}
