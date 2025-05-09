import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

function getServiceAccount() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    const buff = Buffer.from(serviceAccount, "base64");
    return JSON.parse(buff.toString("utf-8"));
  } catch (error) {
    console.error("Error parsing service account:", error);
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT format");
  }
}

admin.initializeApp({
  credential: admin.credential.cert(getServiceAccount()),
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const storage = admin.storage();
const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);

export { admin, db, bucket };
