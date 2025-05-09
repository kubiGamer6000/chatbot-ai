import pino from "pino";

const level = process.env.NODE_ENV === "production" ? "info" : "debug";

const logger = pino({
  timestamp: () => `,"time":"${new Date().toJSON()}"`,
  transport: {
    targets: [
      // Firestore transport
      {
        target: "./firestore-transport",
        options: {
          collection: "logs",
          batchSize: 1,
        },
        level,
      },
      // Console transport
      {
        target: "pino/file",
        options: {
          destination: 1, // stdout
          colorize: true,
          translateTime: "SYS:standard",
        },
        level,
      },
    ],
  },
  level,
});

export default logger;
