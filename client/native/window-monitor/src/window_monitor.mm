#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <napi.h>

// Dock width constant (should match DOCK_WIDTH in main.ts)
#define DOCK_WIDTH 250

// Global state
static bool g_monitoring = false;
static CFRunLoopTimerRef g_timer = NULL;

// Check if Accessibility permissions are enabled
bool CheckAccessibilityPermissions() {
  // Request accessibility permissions (this will show a prompt if not enabled)
  NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
  BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  NSLog(@"Accessibility permissions check: %@", trusted ? @"granted" : @"not granted");
  return trusted;
}

// Get window bounds
bool GetWindowBounds(AXUIElementRef windowElement, double *x, double *y, double *width, double *height) {
  CFTypeRef positionRef, sizeRef;
  CGPoint position;
  CGSize size;
  
  // Get position
  AXError error = AXUIElementCopyAttributeValue(windowElement, kAXPositionAttribute, &positionRef);
  if (error == kAXErrorSuccess && positionRef) {
    if (AXValueGetValue((AXValueRef)positionRef, (AXValueType)kAXValueCGPointType, &position)) {
      *x = position.x;
      *y = position.y;
    }
    CFRelease(positionRef);
  } else {
    return false;
  }
  
  // Get size
  error = AXUIElementCopyAttributeValue(windowElement, kAXSizeAttribute, &sizeRef);
  if (error == kAXErrorSuccess && sizeRef) {
    if (AXValueGetValue((AXValueRef)sizeRef, (AXValueType)kAXValueCGSizeType, &size)) {
      *width = size.width;
      *height = size.height;
      CFRelease(sizeRef);
      return true;
    }
    CFRelease(sizeRef);
  }
  
  return false;
}

// Set window bounds
bool SetWindowBounds(AXUIElementRef windowElement, double x, double y, double width, double height) {
  CGPoint position = CGPointMake(x, y);
  CGSize size = CGSizeMake(width, height);
  
  AXValueRef positionValue = AXValueCreate((AXValueType)kAXValueCGPointType, &position);
  AXValueRef sizeValue = AXValueCreate((AXValueType)kAXValueCGSizeType, &size);
  
  bool success = false;
  
  if (positionValue && sizeValue) {
    AXError posError = AXUIElementSetAttributeValue(windowElement, kAXPositionAttribute, positionValue);
    AXError sizeError = AXUIElementSetAttributeValue(windowElement, kAXSizeAttribute, sizeValue);
    success = (posError == kAXErrorSuccess && sizeError == kAXErrorSuccess);
    
    CFRelease(positionValue);
    CFRelease(sizeValue);
  }
  
  return success;
}

// Check if window is maximized (covers full screen minus dock area)
bool IsWindowMaximized(AXUIElementRef windowElement, int pid) {
  double x, y, width, height;
  if (!GetWindowBounds(windowElement, &x, &y, &width, &height)) {
    return false;
  }
  
  // Get screen dimensions
  NSScreen *mainScreen = [NSScreen mainScreen];
  NSRect screenFrame = [mainScreen frame];
  double screenWidth = screenFrame.size.width;
  double screenHeight = screenFrame.size.height;
  
  // Check if window covers almost the entire screen (accounting for dock area)
  // If window starts at x=0 and width >= screenWidth - DOCK_WIDTH, it might be maximized
  // But we also check if it's covering the dock area (x < DOCK_WIDTH)
  bool coversFullHeight = (height >= screenHeight * 0.95);
  bool startsAtLeftEdge = (x < 10); // Small tolerance
  bool wideEnough = (width >= screenWidth - DOCK_WIDTH - 50); // Account for some margin
  
  (void)screenHeight; // Suppress unused variable warning (used in coversFullHeight calculation)
  return coversFullHeight && startsAtLeftEdge && wideEnough;
}

// Check and adjust a single window (internal function)
bool CheckAndAdjustWindowInternal(AXUIElementRef windowElement, int pid) {
  // Skip our own application windows (Electron app)
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!app) return false;
  
  NSString *bundleId = [app bundleIdentifier];
  NSString *appName = [app localizedName];
  
  // Skip system apps and our own app
  if ([bundleId containsString:@"com.apple."] || 
      [bundleId containsString:@"electron"] || 
      [bundleId containsString:@"Blink"] ||
      [appName containsString:@"Blink"]) {
    return false;
  }
  
  double x, y, width, height;
  if (!GetWindowBounds(windowElement, &x, &y, &width, &height)) {
    return false;
  }
  
  // Get screen dimensions
  NSScreen *mainScreen = [NSScreen mainScreen];
  NSRect screenFrame = [mainScreen frame];
  double screenWidth = screenFrame.size.width;
  
  // Check if window is overlapping the dock area (x < DOCK_WIDTH)
  // and if it's maximized (covers most of screen height)
  bool isMaximized = IsWindowMaximized(windowElement, pid);
  bool overlapsDock = (x < DOCK_WIDTH) && (width > DOCK_WIDTH - x);
  
  if (isMaximized && overlapsDock) {
    // Adjust window to start after dock
    double newX = DOCK_WIDTH;
    double newWidth = screenWidth - DOCK_WIDTH;
    
    bool success = SetWindowBounds(windowElement, newX, y, newWidth, height);
    if (success) {
      NSLog(@"Adjusted window bounds for app (pid: %d) to avoid dock area", pid);
    }
    return success;
  }
  
  return false;
}

// Monitor all windows
void MonitorWindows() {
  if (!CheckAccessibilityPermissions()) {
    return;
  }
  
  // Get all running applications
  NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
  NSArray *runningApps = [workspace runningApplications];
  
  for (NSRunningApplication *app in runningApps) {
    int pid = [app processIdentifier];
    
    // Create accessibility element for the application
    AXUIElementRef appElement = AXUIElementCreateApplication(pid);
    if (!appElement) continue;
    
    // Get windows
    CFArrayRef windows;
    AXError error = AXUIElementCopyAttributeValues(appElement, kAXWindowsAttribute, 0, 100, &windows);
    
    if (error == kAXErrorSuccess && windows) {
      CFIndex windowCount = CFArrayGetCount(windows);
      
      for (CFIndex i = 0; i < windowCount; i++) {
        AXUIElementRef windowElement = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        
        // Check if window is main/minimized
        CFTypeRef minimizedRef;
        bool isMinimized = false;
        if (AXUIElementCopyAttributeValue(windowElement, kAXMinimizedAttribute, &minimizedRef) == kAXErrorSuccess) {
          isMinimized = CFBooleanGetValue((CFBooleanRef)minimizedRef);
          if (minimizedRef) CFRelease(minimizedRef);
        }
        
        if (!isMinimized) {
          CheckAndAdjustWindowInternal(windowElement, pid);
        }
      }
      
      CFRelease(windows);
    }
    
    CFRelease(appElement);
  }
}

// Timer callback for periodic monitoring
void TimerCallback(CFRunLoopTimerRef timer, void *info) {
  if (g_monitoring) {
    MonitorWindows();
  }
}

// Start monitoring
Napi::Boolean StartMonitoring(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (g_monitoring) {
    return Napi::Boolean::New(env, false);
  }
  
  if (!CheckAccessibilityPermissions()) {
    return Napi::Boolean::New(env, false);
  }
  
  g_monitoring = true;
  
  // Create a timer to check windows periodically (every 500ms)
  // Use main run loop to ensure it runs on the main thread
  CFRunLoopRef runLoop = CFRunLoopGetMain();
  CFRunLoopTimerContext context = {0, NULL, NULL, NULL, NULL};
  g_timer = CFRunLoopTimerCreate(
    kCFAllocatorDefault,
    CFAbsoluteTimeGetCurrent() + 0.5, // Start after 0.5 seconds
    0.5, // Repeat every 0.5 seconds
    0,
    0,
    TimerCallback,
    &context
  );
  
  if (g_timer) {
    CFRunLoopAddTimer(runLoop, g_timer, kCFRunLoopCommonModes);
    return Napi::Boolean::New(env, true);
  }
  
  g_monitoring = false;
  return Napi::Boolean::New(env, false);
}

// Stop monitoring
Napi::Boolean StopMonitoring(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  g_monitoring = false;
  
  if (g_timer) {
    CFRunLoopTimerInvalidate(g_timer);
    CFRelease(g_timer);
    g_timer = NULL;
  }
  
  return Napi::Boolean::New(env, true);
}

// Check if Accessibility is enabled
Napi::Boolean IsAccessibilityEnabled(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::Boolean::New(env, CheckAccessibilityPermissions());
}

