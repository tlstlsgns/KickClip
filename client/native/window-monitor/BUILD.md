# Building the Window Monitor Native Module

## Prerequisites

- macOS 10.13 or later
- Xcode Command Line Tools installed:
  ```bash
  xcode-select --install
  ```
- Node.js and npm
- node-gyp (installed automatically via npm)

## Building

1. Install dependencies:
   ```bash
   cd client/native/window-monitor
   npm install
   ```

2. Build the native module:
   ```bash
   npm run build
   ```

   This will compile the native code and create `build/Release/window_monitor.node`

## Using with Electron

The module will be automatically built when you run:
```bash
cd client
npm run build
```

Or manually:
```bash
cd client/native/window-monitor
npm run build
```

## Troubleshooting

### Build Errors

If you get compilation errors, make sure:
1. Xcode Command Line Tools are installed
2. You're on macOS
3. node-gyp is installed: `npm install -g node-gyp`

### Module Not Found

If you get "Cannot find module" errors:
1. Make sure the module is built: `npm run build` in the window-monitor directory
2. Check that `build/Release/window_monitor.node` exists
3. Verify the path in `index.js` matches your build output

### Accessibility Permissions

The module requires Accessibility permissions. When you first use it, macOS will prompt you. If you need to enable it manually:

1. System Settings → Privacy & Security → Accessibility
2. Find your app and enable it
3. Restart the application

