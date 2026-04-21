# Electron + Firebase Architecture

## Overview

This document describes the architecture of the Electron application with Firebase Authentication and Firestore integration.

## Security Architecture

### Three-Layer Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                         │
│  (Browser-like environment, no Node.js access)             │
│                                                             │
│  window.electronAPI.auth.signUp(...)                       │
│  window.electronAPI.firestore.getUserDocument(...)         │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC (via contextBridge)
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                    Preload Script                           │
│  (Has Node.js access, creates secure bridge)               │
│                                                             │
│  contextBridge.exposeInMainWorld('electronAPI', {...})     │
│  ipcRenderer.invoke('auth:signUp', {...})                  │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC (secure channel)
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                    Main Process                             │
│  (Full Node.js access, initializes Firebase)               │
│                                                             │
│  Firebase Auth & Firestore                                 │
│  ipcMain.handle('auth:signUp', async (event, data) => {})  │
└─────────────────────────────────────────────────────────────┘
```

### Key Security Features

1. **Context Isolation**: Renderer cannot access Node.js APIs directly
2. **No Node Integration**: Renderer runs in a sandboxed environment
3. **Preload Bridge**: Only exposes safe, defined APIs
4. **IPC Communication**: All sensitive operations happen in main process

## Data Flow

### Authentication Flow

```
User Action (Renderer)
    │
    ├─► authService.signUp(email, password)
    │       │
    │       └─► window.electronAPI.auth.signUp(email, password)
    │               │
    │               └─► ipcRenderer.invoke('auth:signUp', {email, password})
    │                       │
    │                       ▼
    │               Main Process
    │                       │
    │                       ├─► Firebase Auth: createUserWithEmailAndPassword()
    │                       │
    │                       ├─► Firestore: Create user document
    │                       │
    │                       └─► onAuthStateChanged() fires
    │                               │
    │                               └─► Broadcast to all windows
    │                                       │
    │                                       ▼
    │                               Renderer receives update
    │                                       │
    │                                       └─► authService.onAuthStateChanged() callbacks fire
```

### Firestore Operations Flow

```
User Action (Renderer)
    │
    ├─► firestoreService.setUserDocument(userData)
    │       │
    │       └─► window.electronAPI.firestore.setUserDocument(userData)
    │               │
    │               └─► ipcRenderer.invoke('firestore:setUserDocument', userData)
    │                       │
    │                       ▼
    │               Main Process
    │                       │
    │                       └─► Firestore: setDoc(doc(firestore, 'users', uid), userData)
    │                               │
    │                               └─► Returns success/error via IPC
```

## File Organization

### Main Process (`src/main/`)

- **main.ts**: Application entry point, window management, IPC setup
- **services/firebase.service.ts**: Firebase initialization, Auth & Firestore IPC handlers

### Preload (`src/preload/`)

- **preload.ts**: Secure IPC bridge, exposes APIs via `contextBridge`

### Renderer (`src/renderer/`)

- **services/auth.service.ts**: High-level auth API for renderer
- **services/firestore.service.ts**: High-level Firestore API for renderer
- **stores/**: (Future) State management (e.g., Zustand, MobX)
- **ui/**: (Future) UI components

## Firebase Configuration

### Configuration Loading

1. Environment variables loaded via `dotenv` in `main.ts`
2. Config values passed to Firebase initialization
3. No sensitive credentials exposed to renderer

### Firebase Services

- **Authentication**: Email/password, Google OAuth (future)
- **Firestore**: User documents, saved URLs (future), subscriptions (future)

## State Management

### Auth State

- Managed in main process (Firebase Auth)
- Broadcasted to renderer via IPC events
- Cached in renderer (`authService.currentUser`)

### User Data

- Stored in Firestore `users` collection
- Real-time listeners available via IPC
- Cached in renderer for performance

## Error Handling

### Authentication Errors

- Caught in main process IPC handlers
- Returned to renderer as `{success: false, error: string}`
- Displayed to user via UI

### Network Errors

- Handled gracefully (offline mode support future)
- User feedback for connectivity issues
- Automatic retry logic (future)

## Scalability Considerations

### Multi-User Support

- Each user has isolated data via Firestore rules
- User documents keyed by `uid`
- Collections scoped by user ID

### Subscription System

- User document includes subscription data
- Rules can check subscription status
- Billing integration via Firebase Extensions (future)

### Performance

- Firestore queries optimized with indexes
- Real-time listeners only when needed
- Caching in renderer to reduce IPC calls

## Testing Strategy

### Unit Tests

- Test services in isolation
- Mock Firebase SDK
- Test IPC handlers

### Integration Tests

- Test full auth flow
- Test Firestore operations
- Test error scenarios

### E2E Tests

- Use Firebase Emulator
- Test with real Electron windows
- Test cross-process communication

## Future Enhancements

1. **Google OAuth**: Implement OAuth flow for Electron
2. **Offline Support**: Implement offline-first architecture
3. **Real-time Sync**: Add real-time listeners for saved URLs
4. **File Storage**: Add Firebase Storage for images/files
5. **Analytics**: Add Firebase Analytics
6. **Push Notifications**: Add Firebase Cloud Messaging


