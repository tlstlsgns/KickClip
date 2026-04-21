#ifndef WINDOW_MONITOR_H
#define WINDOW_MONITOR_H

#include <napi.h>

// Forward declarations - only include Objective-C headers in .mm file
#ifdef __OBJC__
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#else
// C++ compatibility - forward declare what we need
typedef void* AXUIElementRef;
#endif

// Function declarations
Napi::Boolean StartMonitoring(const Napi::CallbackInfo& info);
Napi::Boolean StopMonitoring(const Napi::CallbackInfo& info);
Napi::Boolean IsAccessibilityEnabled(const Napi::CallbackInfo& info);

#endif

