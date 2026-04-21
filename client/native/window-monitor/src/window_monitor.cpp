#include <napi.h>

// Forward declarations from window_monitor.mm (implemented in Objective-C++)
// These functions are implemented in window_monitor.mm
extern Napi::Boolean StartMonitoring(const Napi::CallbackInfo& info);
extern Napi::Boolean StopMonitoring(const Napi::CallbackInfo& info);
extern Napi::Boolean IsAccessibilityEnabled(const Napi::CallbackInfo& info);

// Initialize the module
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  try {
    exports.Set(
      Napi::String::New(env, "startMonitoring"),
      Napi::Function::New(env, StartMonitoring)
    );
    
    exports.Set(
      Napi::String::New(env, "stopMonitoring"),
      Napi::Function::New(env, StopMonitoring)
    );
    
    exports.Set(
      Napi::String::New(env, "isAccessibilityEnabled"),
      Napi::Function::New(env, IsAccessibilityEnabled)
    );
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  
  return exports;
}

NODE_API_MODULE(window_monitor, Init)

