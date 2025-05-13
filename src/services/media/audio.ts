import { ElevenLabsClient } from "elevenlabs";
const ffmpeg = require("fluent-ffmpeg");
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import { sendTelegramError } from "../telegram.js";
import logger from "../../utils/logger.js";

// Set ffmpeg path
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
} else {
  logger.warn("ffmpeg-static path not found, using system ffmpeg if available");
}

/**
 * Convert audio file to MP3 format
 * @param inputPath Path to input audio file
 * @param outputPath Path for output MP3 file
 * @returns Promise<void>
 */
// async function convertToMp3(
//   inputPath: string,
//   outputPath: string
// ): Promise<void> {
//   return new Promise((resolve, reject) => {
//     ffmpeg(inputPath)
//       .toFormat("mp3")
//       .on("end", () => {
//         logger.debug({ inputPath, outputPath }, "Audio conversion completed");
//         resolve();
//       })
//       .on("error", (err: any) => {
//         logger.error({ err, inputPath, outputPath }, "Audio conversion failed");
//         reject(err);
//       })
//       .save(outputPath);
//   });
// }

/**
 * Transcribe MP3 audio file using OpenAI's Whisper API
 * @param audioPath Path to audio file
 * @param elevenLabsClient ElevenLabs instance
 * @returns Promise<string> Transcribed text
 */
async function transcribe(
  audioPath: string,
  elevenLabsClient: ElevenLabsClient
): Promise<string> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const transcription = await elevenLabsClient.speechToText.convert({
    file: fs.createReadStream(audioPath),
    model_id: "scribe_v1",
    tag_audio_events: true,
  });

  return transcription.text;
}

/**
 * Process voice message using OpenAI's Whisper API
 * @param filePath Path to the audio file
 * @returns Promise<string | null> Transcribed text or null if processing fails
 */
export async function processAudio(filePath: string): Promise<string | null> {
  const startTime = Date.now();

  try {
    if (!fs.existsSync(filePath)) {
      logger.error({ filePath }, "Audio file not found");
      return null;
    }

    if (!process.env.OPENAI_API_KEY) {
      logger.error("OpenAI API key not set, skipping audio transcription");
      return null;
    }

    const elevenLabsClient = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // Uncomment and use if MP3 conversion is needed
    // logger.debug({ filePath }, "Converting audio to MP3 format");
    // const mp3Path = `${filePath}.mp3`;
    // await convertToMp3(filePath, mp3Path);
    // logger.debug({ filePath: mp3Path }, "Transcribing MP3 audio");
    // const transcript = await transcribe(mp3Path, openai);

    logger.debug({ filePath }, "Transcribing audio");
    const transcript = await transcribe(filePath, elevenLabsClient);

    // Clean up the file
    try {
      fs.unlinkSync(filePath);
      logger.debug({ filePath }, "Temporary audio file deleted");
    } catch (cleanupError) {
      logger.warn(
        { err: cleanupError, filePath },
        "Failed to delete temporary audio file"
      );
    }

    const processingTime = Date.now() - startTime;
    logger.debug(
      { processingTime },
      "Audio transcription completed successfully"
    );

    return transcript;
  } catch (error) {
    const errorObj =
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : error;

    logger.error(
      { err: errorObj, filePath, processingTime: Date.now() - startTime },
      "Audio processing failed"
    );

    sendTelegramError(
      `Voice processing failed: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`
    );
    return null;
  }
}
