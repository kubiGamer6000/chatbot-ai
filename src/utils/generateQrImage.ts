import qrImage from "qr-image";
import fs from "fs";
import path from "path";

export async function generateQRImage(qrString: string) {
  // Ensure temp directory exists
  const tempDir = process.env.TEMP_DIR || ".temp";
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const qrImageData = qrImage.image(qrString, { type: "png" });
  const randomId = Math.random().toString(36).substring(2, 15);
  const filePath = path.join(tempDir, `qr_code_${randomId}.png`);

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    qrImageData.pipe(writeStream);
    writeStream.on("finish", () => resolve(undefined));
    writeStream.on("error", reject);
  });

  return filePath;
}
