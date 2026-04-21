# Window Monitor Native Module

Native macOS module to monitor and adjust window positions to avoid the dock area.

## Building

```bash
cd native/window-monitor
npm install
npm run build
```

## Requirements

- macOS 10.13+
- Xcode Command Line Tools
- Accessibility permissions (user must grant)

## Usage

```javascript
const windowMonitor = require('./native/window-monitor');

// Check if accessibility is enabled
if (windowMonitor.isAccessibilityEnabled()) {
  // Start monitoring windows
  windowMonitor.startMonitoring();
} else {
  console.log('Accessibility permissions required');
}

// Stop monitoring
windowMonitor.stopMonitoring();
```

