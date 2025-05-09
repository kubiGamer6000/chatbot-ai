# Content Currency Firestore WhatsApp Store

A private WhatsApp integration service that creates a sophisticated bridge between WhatsApp and external systems. This service captures, processes, analyzes, and stores WhatsApp messages and media with advanced AI capabilities, providing a complete system for message archiving, analysis, and integration with other platforms.

## Core Functionality

This service provides sophisticated WhatsApp message handling with the following key features:

### Connection & Authentication

- **Multi-device WhatsApp Connection**: Utilizes Baileys library for stable WhatsApp Web multi-device API connection
- **QR Code Authentication**: Generates and sends QR codes to Telegram for easy authentication
- **Auth State Management**: Maintains persistent authentication state across restarts using multi-file auth storage
- **Reconnection Logic**: Intelligent reconnection handling with distinction between intentional logout and connection errors

### Message Processing Pipeline

- **Advanced Message Queue**: Groups related messages to process them together for context-aware handling
- **Real-time Capture**: Intercepts all incoming WhatsApp messages in real-time
- **Persistent Storage**: Stores all messages and conversations in Firebase Firestore
- **Media Processing**: Downloads and processes various types of media attachments
- **Cloud Storage**: Uploads all media files to Firebase Storage with organized path structure
- **Webhook Integration**: Forwards processed messages to external webhook endpoints with authentication

### AI-Powered Media Analysis

- **Image Analysis**: Uses OpenAI's GPT-4o Vision API to analyze and describe image content
- **Voice Transcription**: Transcribes voice messages to text using OpenAI's Whisper API
- **Document Processing**: Extracts and processes information from document attachments

### Monitoring & Error Handling

- **Telegram Integration**: Sends notifications, errors, and status updates to Telegram
- **Dual Bot Support**: Configurable primary and secondary Telegram bots for different notification types
- **Error Tracking**: Comprehensive error logging and notification system

## Technical Implementation Details

### WhatsApp Integration

This service uses the WhatsApp Web multi-device API through the Baileys library. Key components include:

- Socket connection management with automatic reconnection
- Message event listener system
- Media downloading and processing
- Chat state synchronization
- Group metadata caching

### Data Storage Architecture

- **Firebase Firestore**: NoSQL document database storing:

  - Message history organized by chat/conversation
  - User and chat metadata
  - Processing results and analytics

- **Firebase Storage**: Blob storage for media files:
  - Organized by chat ID and message ID
  - Proper MIME type and metadata settings
  - Secure access controls

### Media Processing Subsystems

The service implements specialized processing for different media types:

- **Image Processing**:

  - Decodes and processes image data
  - Sends to GPT-4o for detailed content analysis
  - Returns AI-generated descriptions

- **Audio Processing**:

  - Handles voice messages and audio files
  - Optional conversion to MP3 format using FFmpeg
  - Transcription via OpenAI Whisper API

- **Document Processing**:
  - Handles PDF and other document formats
  - Extracts text and metadata

### Notification System

- Telegram integration for real-time notifications
- Support for multiple notification channels
- Customizable notification types and formats
- Error reporting with detailed context

## Installation & Setup

### Prerequisites

- Node.js (v16 or higher)
- pnpm package manager
- Firebase account with Firestore and Storage enabled
- Telegram Bot(s) for notifications
- WhatsApp account
- OpenAI API key for media processing

### Installation Steps

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/ace-whatsapp-store.git
   cd ace-whatsapp-store
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Set up environment variables:

   - Copy `.env.example` to `.env`
   - Configure the following required variables:

   **WhatsApp Configuration:**

   ```
   WHATSAPP_CLIENT_ID=ACE
   ```

   **Firebase Configuration:**

   ```
   FIREBASE_SERVICE_ACCOUNT=[base64 encoded service account JSON]
   FIREBASE_STORAGE_BUCKET=your-storage-bucket.firebasestorage.app
   FIRESTORE_CHAT_COLLECTION=chats_ace
   FIRESTORE_MESSAGE_COLLECTION=messages_ace
   ```

   **Telegram Configuration:**

   ```
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_BOT_TOKEN_SECONDARY=your-secondary-bot-token
   TELEGRAM_CHAT_ID=your-chat-id
   ```

   **API Integration:**

   ```
   OPENAI_API_KEY=your-openai-api-key
   WEBHOOK_URL=your-webhook-url
   WEBHOOK_AUTH_KEY=your-webhook-auth-key
   ```

   **Other Settings:**

   ```
   PORT=3002
   TEMP_DIR=.temp
   IMAGE_PROMPT="What's in this image? Describe it in a detailed manner."
   ```

## Usage

### Development Mode

```bash
# Build the TypeScript code
pnpm run build

# Start the application
pnpm run start
```

### Production Mode

```bash
# Build and start with PM2 for production
pnpm run pm2
```

### First-time Authentication

1. Start the service
2. Wait for a QR code to be sent to your configured Telegram chat
3. Scan the QR code with your WhatsApp
4. The service will establish and maintain the connection

### Message Flow

1. Messages are received from WhatsApp
2. Media is downloaded and processed if present
3. Messages are stored in Firestore
4. Media is uploaded to Firebase Storage
5. Processing results are stored with the message data
6. Webhook is triggered with the processed data
7. Notifications are sent to Telegram based on configuration

## Project Structure

```
src/
├── index.ts                 # Main application entry point
├── types.ts                 # TypeScript type definitions
├── services/
│   ├── messageProcessor.ts  # Core message handling logic
│   ├── firebase-admin.ts    # Firebase configuration and setup
│   ├── telegram.ts          # Telegram bot integration
│   ├── webhook.ts           # External webhook integration
│   └── media/               # Media processing modules
│       ├── image.ts         # Image processing with OpenAI
│       ├── audio.ts         # Audio processing with Whisper
│       └── document.ts      # Document processing
├── utils/
│   ├── env.ts               # Environment configuration
│   ├── logger.ts            # Logging utility
│   └── generateQrImage.ts   # QR code generation for auth
```

## Operational Notes

### Authentication Persistence

The service stores authentication data in the `.auth/[CLIENT_ID]` directory. This allows it to reconnect without requiring a new QR code scan each time.

### Error Handling

When errors occur:

1. They are logged to the console with detailed context
2. A notification is sent to the configured Telegram chat
3. The service attempts to continue operation if possible

### Media Storage

Media files are temporarily stored in the `.temp` directory before being uploaded to Firebase Storage. The files are automatically cleaned up after processing.

## Security Considerations

- **API Keys**: All API keys and tokens are stored in environment variables
- **Webhook Authentication**: Webhooks are secured with a Bearer token
- **Firebase Credentials**: Service account credentials are base64 encoded
- **No Exposed Endpoints**: By default, this service does not expose any HTTP endpoints

## TODOs and Future Improvements

- Exclude chats
- Video processing / storing

## License

ISC - Private use only. This software is not intended for distribution.
