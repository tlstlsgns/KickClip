const path = require('path');
const binding = require(`./build/Release/window_monitor.node`);

module.exports = {
  startMonitoring: () => {
    try {
      return binding.startMonitoring();
    } catch (error) {
      console.error('Failed to start window monitoring:', error);
      return false;
    }
  },
  
  stopMonitoring: () => {
    try {
      return binding.stopMonitoring();
    } catch (error) {
      console.error('Failed to stop window monitoring:', error);
      return false;
    }
  },
  
  isAccessibilityEnabled: () => {
    try {
      return binding.isAccessibilityEnabled();
    } catch (error) {
      console.error('Failed to check accessibility permissions:', error);
      return false;
    }
  }
};

