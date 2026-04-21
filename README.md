# Blink

A desktop application for saving URLs and images from your browser using keyboard shortcuts.

## Overview

This application consists of:

- **Server**: Node.js/Express API that stores saved URLs
- **Electron Client**: Desktop app running in the background with a global shortcut
- **Browser Extension**: Handles saving when browsing (supports image hover detection)

## Setup

### Environment Variables

#### Electron Client Firebase Configuration

Create a `.env` file in the `client/` directory with the following Firebase configuration:

```env
# Firebase Configuration for Electron Client
FIREBASE_API_KEY=AIzaSyA9X_FEi9cgvFmDdEmeEvJW0msXSIrP6p0
FIREBASE_AUTH_DOMAIN=saveurl-a8593.firebaseapp.com
FIREBASE_PROJECT_ID=saveurl-a8593
FIREBASE_STORAGE_BUCKET=saveurl-a8593.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=658386350246
FIREBASE_APP_ID=1:658386350246:web:ee80b8dcae26d2e4298467
FIREBASE_MEASUREMENT_ID=G-3CWFLRKTVR

# Google OAuth Desktop App Client ID
# Get this from: Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client IDs > Desktop app
GOOGLE_CLIENT_ID=708660683174-dk1maoouohahc4s15d953vq4mgtb4ovn.apps.googleusercontent.com
# Google OAuth Desktop App Client Secret (required even with PKCE)
# Get this from the same OAuth client page in Google Cloud Console
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE

# Instagram/Facebook OAuth Configuration
# Facebook App ID (Instagram uses Facebook OAuth)
FACEBOOK_APP_ID=854337097429320
# Facebook App Secret (required for Instagram OAuth token exchange)
FACEBOOK_APP_SECRET=b6cacdb98de2bf45bcf20f3d1ee57f9f
```

**Note on Environment Variables in Electron:**

- **Development**: The `.env` file is automatically loaded via `dotenv` at the start of the main process. If environment variables are not set, the application falls back to hardcoded values (for convenience during development).

- **Production (Packaged)**: 
  - Environment variables from `.env` are NOT automatically available in packaged Electron apps.
  - Options for production:
    1. **Hardcode values** (not recommended for sensitive data): The current implementation includes fallback values, but this is only suitable for development.
    2. **Use Electron's `process.env`**: Set environment variables when launching the packaged app.
    3. **Use a config file**: Store configuration in a JSON file that's loaded at runtime (outside of version control).
    4. **Use system environment variables**: Set environment variables at the system level before launching the app.

**Security Note**: Firebase API keys and configuration are safe to expose in client-side code (they're designed for public use), but you should still use environment variables to:
- Keep configuration separate from code
- Allow different configurations for different environments
- Make it easier to update configuration without code changes

To get Firebase configuration values:

1. Go to the [Firebase Console](https://console.firebase.google.com/)
2. Select your project (or create a new one)
3. Go to Project Settings (gear icon) → General tab
4. Scroll down to "Your apps" section
5. Click on the web app icon (`</>`) to add a web app (if you haven't already)
6. Copy the config values from the Firebase configuration object

### Install Dependencies

```bash
# Install server dependencies
cd server
npm install

# Install client dependencies (in a new terminal)
cd client
npm install
```

## Usage

See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for detailed usage instructions.

## Quick Start

1. **Start the Server**:
   ```bash
   cd server
   npm run dev
   ```

2. **Start the Electron Client** (in a new terminal):
   ```bash
   cd client
   npm run dev
   ```

3. **Install the Browser Extension** (see [USAGE_GUIDE.md](./USAGE_GUIDE.md) for details)

4. Press `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux) to save URLs and images!

## Firebase

This project uses Firebase Web v9 modular SDK for authentication and Firestore database in the Electron client.

### Firebase Files

**Client (Electron)**:
- `client/src/lib/firebase.ts` - Firebase initialization (app, auth, db)
  - Uses `getApps()` to ensure single initialization
  - Safe for Electron environment
  - Falls back to hardcoded values if env vars are missing (development only)
- `client/src/lib/firestore.ts` - Typed Firestore helper functions
  - `addData(userId, data)` - Add new data
  - `updateData(dataId, userId, data)` - Update existing data
  - `deleteData(dataId, userId)` - Delete data
  - `watchDatasByUser(userId, callback)` - Real-time listener (returns unsubscribe function)
  - `getDatasByUser(userId, limit?)` - One-time fetch

### Firebase Initialization

Firebase is initialized in `client/src/lib/firebase.ts`:
- Checks for existing apps using `getApps()` before initializing
- Prevents multiple initialization errors
- Exports `app`, `auth`, and `db` for use throughout the application

### Security Considerations

- Firebase operations should be accessed via IPC from the renderer process (main process mediates access)
- The renderer process should not directly import Firebase config unless explicitly allowed
- All Firestore operations require a `userId` to ensure data isolation per user

