{
  "targets": [
    {
      "target_name": "window_monitor",
      "sources": [
        "src/window_monitor.cpp",
        "src/window_monitor.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(module_root_dir)/src"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.13",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-stdlib=libc++"]
      },
      "conditions": [
        ["OS=='mac'", {
          "frameworks": [
            "AppKit",
            "ApplicationServices",
            "CoreFoundation"
          ]
        }]
      ]
    }
  ]
}

