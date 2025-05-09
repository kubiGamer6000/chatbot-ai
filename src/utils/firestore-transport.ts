import build from "pino-abstract-transport";
import { db } from "../services/firebase-admin";
import type { WriteBatch } from "firebase-admin/firestore";

interface LogEntry {
  level: number;
  time?: string;
  msg: string;
  [key: string]: any;
}

interface FirestoreTransportOptions {
  collection?: string;
  batchSize?: number;
  sanitize?: (log: LogEntry) => Record<string, any>;
}

export default async function (options: FirestoreTransportOptions = {}) {
  // Default options
  const opts = {
    collection: options.collection || "logs",
    batchSize: options.batchSize || 1,
    sanitize: options.sanitize,
  };

  // Log counter for batching
  let batchCount = 0;
  let batch: WriteBatch = db.batch();
  let isBatchCommitting = false;

  // Create transport
  return build(
    async function (source) {
      for await (const log of source) {
        try {
          // Wait if a batch commit is in progress
          while (isBatchCommitting) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }

          // Create a document reference with auto-generated ID
          const docRef = db.collection(opts.collection).doc();

          // Extract timestamp, or use current time
          const timestamp = log.time ? new Date(log.time) : new Date();

          // Prepare the log data
          const logData = {
            timestamp,
            level: log.level,
            levelName: getLogLevelName(log.level),
            message: log.msg,
            // Add any additional properties from the log
            data: sanitizeLog(log),
          };

          // Add to batch
          batch.set(docRef, logData);
          batchCount++;

          // If batch size reached, commit the batch
          if (batchCount >= opts.batchSize) {
            isBatchCommitting = true;
            try {
              await batch.commit();
            } finally {
              batch = db.batch(); // Create a new batch
              batchCount = 0;
              isBatchCommitting = false;
            }
          }
        } catch (error) {
          console.error("Error writing log to Firestore:", error);
        }
      }
    },
    {
      // Close handler to ensure any remaining logs are flushed
      close(err: Error, cb: Function) {
        const handleClose = () => {
          if (batchCount > 0 && !isBatchCommitting) {
            isBatchCommitting = true;
            batch
              .commit()
              .then(() => {
                batch = db.batch();
                batchCount = 0;
                isBatchCommitting = false;
                cb();
              })
              .catch((commitError) => {
                console.error("Error committing final log batch:", commitError);
                batch = db.batch();
                batchCount = 0;
                isBatchCommitting = false;
                cb(commitError);
              });
          } else if (isBatchCommitting) {
            // If a commit is in progress, wait a bit and try again
            setTimeout(handleClose, 50);
          } else {
            cb();
          }
        };

        handleClose();
      },
    }
  );
}

// Helper function to get human-readable log level name
function getLogLevelName(level: number): string {
  switch (level) {
    case 10:
      return "trace";
    case 20:
      return "debug";
    case 30:
      return "info";
    case 40:
      return "warn";
    case 50:
      return "error";
    case 60:
      return "fatal";
    default:
      return "unknown";
  }
}

// Helper function to sanitize the log object for Firestore
// Removes functions, circular references, and other non-serializable data
function sanitizeLog(log: LogEntry): Record<string, any> {
  const sanitized: Record<string, any> = {};

  // Copy properties we want to keep, excluding standard pino properties already handled
  const excludeProps = ["level", "time", "msg", "pid", "hostname", "v"];

  for (const key in log) {
    if (!excludeProps.includes(key)) {
      try {
        // Try to serialize to catch circular references
        const serialized = JSON.stringify({ [key]: log[key] });
        sanitized[key] = JSON.parse(serialized)[key];
      } catch (e) {
        // Skip properties that can't be serialized
        sanitized[key] = "[Unserializable data]";
      }
    }
  }

  return sanitized;
}
