# Quick Start - Firebase Setup

This is a condensed version for experienced developers. For detailed steps, see `FIREBASE_SETUP_STEP_BY_STEP.md`.

## 1. Firebase Console Setup

1. Go to https://console.firebase.google.com/
2. Create project → Enable Email/Password auth → Create Firestore DB
3. Project Settings (gear icon) → Your apps → Add Web app
4. Copy config values

## 2. Configure .env

```bash
cd client
cp .env.example .env
# Edit .env and fill in Firebase config values
```

`.env` should contain:
```env
VITE_FIREBASE_API_KEY=your_actual_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

## 3. Deploy Firestore Rules

**Option A - Firebase CLI:**
```bash
npm install -g firebase-tools
firebase login
firebase init firestore  # Select your project, use client/firestore.rules
firebase deploy --only firestore:rules
```

**Option B - Firebase Console:**
- Firestore Database → Rules tab
- Copy contents of `client/firestore.rules`
- Paste and click "Publish"

## 4. Build & Run

```bash
cd client
npm run build
npm run dev
```

Check console for "Firebase initialized successfully"

## Done! ✅

Your Firebase setup is complete. Now you can use authentication in your app code.


