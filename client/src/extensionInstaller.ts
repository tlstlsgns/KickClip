import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const EXTENSIONS_DIR = path.resolve(__dirname, '../../browser-extension');
const CHROMIUM_EXT_DIR = path.join(EXTENSIONS_DIR, 'chromium');
const FIREFOX_EXT_DIR = path.join(EXTENSIONS_DIR, 'firefox');

/**
 * Gets the Chrome/Arc/Edge extensions directory based on OS
 */
function getChromiumExtensionsPath(): string[] {
  const homeDir = app.getPath('home');
  const paths: string[] = [];

  if (process.platform === 'darwin') {
    // macOS
    paths.push(
      path.join(homeDir, 'Library/Application Support/Google/Chrome/Default/Extensions'),
      path.join(homeDir, 'Library/Application Support/Arc/User Data/Default/Extensions'),
      path.join(homeDir, 'Library/Application Support/Microsoft Edge/Default/Extensions'),
    );
  } else if (process.platform === 'win32') {
    // Windows
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    paths.push(
      path.join(localAppData, 'Google/Chrome/User Data/Default/Extensions'),
      path.join(localAppData, 'Microsoft/Edge/User Data/Default/Extensions'),
      // Arc on Windows uses similar path
      path.join(localAppData, 'Arc/User Data/Default/Extensions'),
    );
  } else {
    // Linux
    paths.push(
      path.join(homeDir, '.config/google-chrome/Default/Extensions'),
      path.join(homeDir, '.config/microsoft-edge/Default/Extensions'),
      path.join(homeDir, '.config/Arc/User Data/Default/Extensions'),
    );
  }

  return paths;
}

/**
 * Gets the Firefox extensions directory based on OS
 */
function getFirefoxProfilePath(): string[] {
  const homeDir = app.getPath('home');
  const paths: string[] = [];

  if (process.platform === 'darwin') {
    paths.push(path.join(homeDir, 'Library/Application Support/Firefox/Profiles'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    paths.push(path.join(appData, 'Mozilla/Firefox/Profiles'));
  } else {
    paths.push(path.join(homeDir, '.mozilla/firefox'));
  }

  return paths;
}

/**
 * Installs extension to Chrome/Arc/Edge using External Extensions method
 * This method allows automatic installation with one-time user approval
 */
async function installChromiumExtension(browserName: string, extensionsPath: string): Promise<boolean> {
  try {
    // Check if extensions directory exists
    const parentDir = path.dirname(extensionsPath);
    await fs.access(parentDir);

    // Get browser-specific external extensions path
    let externalExtPath: string;
    if (extensionsPath.includes('Chrome')) {
      externalExtPath = path.join(parentDir, 'External Extensions');
    } else if (extensionsPath.includes('Arc')) {
      externalExtPath = path.join(parentDir, 'External Extensions');
    } else if (extensionsPath.includes('Edge')) {
      externalExtPath = path.join(parentDir, 'External Extensions');
    } else {
      externalExtPath = path.join(parentDir, 'External Extensions');
    }

    // Create External Extensions directory if it doesn't exist
    await fs.mkdir(externalExtPath, { recursive: true });

    // Use a fixed extension ID for consistency
    const extensionId = 'abcdefghijklmnopqrstuvwxyz123456';
    const externalExtFile = path.join(externalExtPath, `${extensionId}.json`);

    // Create external extension preference file
    const extensionPrefs = {
      external_update_url: 'https://clients2.google.com/service/update2/crx'
    };

    // Alternative: Use a local path (requires extension to be in a fixed location)
    // For better UX, we'll copy to a shared location and reference it
    const sharedExtPath = path.join(app.getPath('userData'), 'browser-extension', 'chromium');
    await fs.mkdir(sharedExtPath, { recursive: true });
    await copyDirectory(CHROMIUM_EXT_DIR, sharedExtPath);

    // Create preference file pointing to the local extension
    const localPrefs = {
      external_crx: sharedExtPath,
      external_version: '1.0.0'
    };

    // Note: External Extensions method requires browser restart and user approval
    // For simpler approach, we'll use the "Load unpacked" method with instructions
    console.log(`📦 Extension files prepared for ${browserName}`);
    console.log(`   Location: ${sharedExtPath}`);
    console.log(`   To enable: Open ${browserName === 'Edge' ? 'edge://extensions' : browserName === 'Arc' ? 'arc://extensions' : 'chrome://extensions'}, enable Developer mode, click "Load unpacked", and select: ${sharedExtPath}`);
    
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log(`⚠️  ${browserName} directory not found. Browser may not be installed.`);
      return false;
    }
    console.error(`❌ Failed to prepare extension for ${browserName}:`, error);
    return false;
  }
}

/**
 * Installs extension to Firefox
 */
async function installFirefoxExtension(profilePath: string): Promise<boolean> {
  try {
    // Find default profile
    const profiles = await fs.readdir(profilePath);
    const defaultProfile = profiles.find(p => p.includes('default') || p.endsWith('.default-release')) || profiles[0];

    if (!defaultProfile) {
      console.log('⚠️  No Firefox profile found');
      return false;
    }

    const extensionsDir = path.join(profilePath, defaultProfile, 'extensions');
    await fs.mkdir(extensionsDir, { recursive: true });

    // Firefox uses extension ID as directory name
    const extensionId = 'urlsaver@urlsaver.app';
    const targetDir = path.join(extensionsDir, extensionId);

    // Copy extension files
    await fs.mkdir(targetDir, { recursive: true });
    await copyDirectory(FIREFOX_EXT_DIR, targetDir);

    console.log(`✅ Extension installed to Firefox at ${targetDir}`);
    console.log(`   Please enable the extension in Firefox at about:addons`);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log('⚠️  Firefox profile directory not found. Firefox may not be installed.');
      return false;
    }
    console.error('❌ Failed to install extension to Firefox:', error);
    return false;
  }
}

/**
 * Helper function to copy directory recursively
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Alternative method: Show instructions for manual installation
 */
async function installChromiumViaDevMode(): Promise<void> {
  const sharedExtPath = path.join(app.getPath('userData'), 'browser-extension', 'chromium');
  await fs.mkdir(sharedExtPath, { recursive: true });
  await copyDirectory(CHROMIUM_EXT_DIR, sharedExtPath);
  
  console.log(`
📋 To enable the extension in Chrome/Arc/Edge:

1. Open your browser and go to:
   - Chrome: chrome://extensions/
   - Arc: arc://extensions/
   - Edge: edge://extensions/

2. Enable "Developer mode" (toggle in top right)

3. Click "Load unpacked"

4. Select this folder: ${sharedExtPath}

5. The extension should now appear and be enabled

💡 This is a one-time setup. After enabling, the extension will work automatically.
  `);
}

/**
 * Alternative method for Firefox
 */
async function installFirefoxViaDevMode(): Promise<void> {
  console.log(`
📋 To enable the extension in Firefox:

1. Open Firefox and go to: about:debugging#/runtime/this-firefox

2. Click "Load Temporary Add-on..."

3. Navigate to: ${FIREFOX_EXT_DIR}

4. Select the manifest.json file

5. The extension should now appear and be enabled
  `);
}

/**
 * Main installation function
 */
export async function installExtensions(): Promise<void> {
  console.log('🚀 Starting browser extension installation...\n');

  // Try to install to Chromium-based browsers
  const chromiumPaths = getChromiumExtensionsPath();
  let chromiumInstalled = false;

  for (const extPath of chromiumPaths) {
    const browserName = extPath.includes('Chrome') ? 'Chrome' :
                       extPath.includes('Arc') ? 'Arc' :
                       extPath.includes('Edge') ? 'Edge' : 'Chromium';
    
    const installed = await installChromiumExtension(browserName, extPath);
    if (installed) {
      chromiumInstalled = true;
    }
  }

  if (!chromiumInstalled) {
    await installChromiumViaDevMode();
  }

  // Try to install to Firefox
  const firefoxPaths = getFirefoxProfilePath();
  let firefoxInstalled = false;

  for (const profilePath of firefoxPaths) {
    const installed = await installFirefoxExtension(profilePath);
    if (installed) {
      firefoxInstalled = true;
      break;
    }
  }

  if (!firefoxInstalled) {
    await installFirefoxViaDevMode();
  }

  console.log('\n✅ Extension installation process completed!');
  console.log('⚠️  Please follow the instructions above to enable the extensions in your browsers.\n');
}

