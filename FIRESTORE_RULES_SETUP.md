# Firestore Security Rules Setup Guide

## Problem
If you're getting `PERMISSION_DENIED` errors when creating directories, it means your Firestore Security Rules don't allow writes to the `users/{userId}/directories` path.

## Solution: Update Firestore Security Rules

### Step 1: Access Firebase Console
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Firestore Database** in the left sidebar
4. Click on the **Rules** tab

### Step 2: Update the Rules
Replace your existing rules with the following:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Items rule - allow authenticated users to manage their own items
    match /users/{userId}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    
    // Directories rule - allow authenticated users to manage their own directories
    match /users/{userId}/directories/{dirId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    
    // Instagram session rule - allow authenticated users to manage their own Instagram sessions
    match /users/{userId}/instagramSession/{sessionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### Step 3: Publish the Rules
1. Click the **Publish** button
2. Wait for the confirmation message
3. Rules are now active

## What These Rules Do

- **`request.auth != null`**: Ensures the user is authenticated
- **`request.auth.uid == userId`**: Ensures users can only access their own data
- **`allow read, write`**: Allows both reading and writing (create, update, delete)

## Verification

After updating the rules:
1. Try creating a directory in the app
2. Check the browser console for debug logs:
   - `[Directory Debug] Attempting to create directory`
   - `[Directory Debug] Current user UID: <uid>`
   - `[Directory] Created: <name>`
3. Check Firestore Console to see the new directory document under `users/{uid}/directories`

## Troubleshooting

### Still Getting PERMISSION_DENIED?

1. **Verify User Authentication**:
   - Check console logs for `[Directory Debug] Current user UID`
   - Ensure the user is signed in
   - Verify the UID matches in Firestore

2. **Check Rule Syntax**:
   - Ensure `rules_version = '2';` is at the top
   - Check for typos in the rule paths
   - Verify the rules were published successfully

3. **Check User ID Match**:
   - The `userId` in the path must exactly match `request.auth.uid`
   - Check the debug logs to see what path is being used

4. **Test Rules**:
   - Use Firebase Console's Rules Playground to test your rules
   - Simulate a write operation with your user's UID

## Alternative: Using Firebase CLI

If you prefer using the Firebase CLI:

1. Install Firebase CLI (if not already installed):
   ```bash
   npm install -g firebase-tools
   ```

2. Login to Firebase:
   ```bash
   firebase login
   ```

3. Initialize Firebase in your project (if not already done):
   ```bash
   firebase init firestore
   ```

4. Copy the rules file:
   ```bash
   cp firestore.rules firestore.rules
   ```

5. Deploy the rules:
   ```bash
   firebase deploy --only firestore:rules
   ```

## Security Note

These rules ensure that:
- Only authenticated users can access data
- Users can only access their own data (based on UID match)
- No user can access another user's directories or items

This is a secure setup for a multi-user application.

