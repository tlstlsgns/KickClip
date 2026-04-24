// picker.js — runs in a dedicated extension popup window, invokes showDirectoryPicker,
// persists handle to IndexedDB, notifies side panel, and closes itself.

import { setPrimaryHandle, setDestination } from './uploadStorage.js';

const btn = document.getElementById('pick');
const statusEl = document.getElementById('status');

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || '';
}

async function closeSelfTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.windowId) {
      await chrome.windows.remove(tab.windowId);
      return;
    }
    if (tab?.id) {
      await chrome.tabs.remove(tab.id);
    }
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker closeSelfTab error:', e);
  }
}

/** Helper to notify side panel of busy state; safe if side panel is closed */
function notifyBusy(isBusy) {
  try {
    chrome.runtime.sendMessage({
      action: 'kc-picker-busy',
      busy: Boolean(isBusy),
    });
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker notifyBusy error:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// Google Drive flow (Phase U3.3)
// Loads local gapi.js (vendor-bundled Google API loader), initializes
// Picker, lets user select a parent folder, then tells background to
// ensure kickclip_files subfolder. On success, stores destination in
// chrome.storage.local and notifies sidepanel.
// ─────────────────────────────────────────────────────────────

let _gapiLoadPromise = null;

/**
 * Load vendor/gapi.js once per picker window lifetime.
 * Uses dynamic <script> tag; safe under MV3 CSP (script-src 'self')
 * because the source is extension-local.
 */
async function ensureGapiLoaded() {
  if (_gapiLoadPromise) return _gapiLoadPromise;
  _gapiLoadPromise = new Promise((resolve, reject) => {
    if (typeof window.gapi !== 'undefined') {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('vendor/gapi.js');
    script.onload = () => resolve();
    script.onerror = () => {
      _gapiLoadPromise = null;
      reject(new Error('Failed to load vendor/gapi.js'));
    };
    document.head.appendChild(script);
  });
  return _gapiLoadPromise;
}

/**
 * Load the 'picker' gapi module. Must be called after ensureGapiLoaded().
 */
async function ensurePickerModuleLoaded() {
  return new Promise((resolve, reject) => {
    if (typeof window.google !== 'undefined' && window.google.picker) {
      resolve();
      return;
    }
    try {
      window.gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => reject(new Error('gapi.load(picker) failed')),
        timeout: 15000,
        ontimeout: () => reject(new Error('gapi.load(picker) timeout')),
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Open Google Drive Picker for folder selection. Returns the selected
 * folder metadata or null if cancelled.
 *
 * @param {string} oauthToken
 * @returns {Promise<{id:string, name:string}|null>}
 */
function showDrivePicker(oauthToken) {
  return new Promise((resolve, reject) => {
    try {
      const view = new window.google.picker.DocsView(
        window.google.picker.ViewId.FOLDERS
      )
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder')
        .setIncludeFolders(true)
        .setParent('root');

      const picker = new window.google.picker.PickerBuilder()
        .setAppId(KC_PICKER_APP_ID)
        .setOAuthToken(oauthToken)
        .setDeveloperKey(KC_PICKER_API_KEY)
        .addView(view)
        .setTitle('KickClip 저장 위치 선택')
        .setCallback((data) => {
          const action = data[window.google.picker.Response.ACTION];
          if (action === window.google.picker.Action.PICKED) {
            const docs = data[window.google.picker.Response.DOCUMENTS] || [];
            if (docs.length > 0) {
              const folder = docs[0];
              resolve({ id: folder.id, name: folder.name });
            } else {
              resolve(null);
            }
          } else if (action === window.google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Main entry: Drive button handler. Orchestrates OAuth token -> gapi load
 * -> Picker -> background ensure-folder -> destination save -> sidepanel notify.
 */
async function handleDriveButtonClick() {
  setStatus('Google Drive에 연결 중...', '');
  notifyBusy(true);

  try {
    const tokenResp = await chrome.runtime.sendMessage({
      action: 'get-google-oauth-token',
      scopes: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });
    if (!tokenResp?.token) {
      setStatus('Google 인증에 실패했습니다. 다시 시도해주세요.', 'error');
      notifyBusy(false);
      return;
    }

    setStatus('Google Picker 로딩 중...', '');
    await ensureGapiLoaded();
    await ensurePickerModuleLoaded();

    setStatus('폴더를 선택해주세요.', '');
    const selected = await showDrivePicker(tokenResp.token);
    if (!selected) {
      setStatus('취소되었습니다. 다시 시도하려면 버튼을 누르세요.', '');
      notifyBusy(false);
      return;
    }

    setStatus(`"${selected.name}/kickclip_files" 준비 중...`, '');
    const ensureResp = await chrome.runtime.sendMessage({
      action: 'drive-ensure-folder',
      parentFolderId: selected.id,
      parentFolderName: selected.name,
    });
    if (!ensureResp?.ok) {
      setStatus(`폴더 생성 실패: ${ensureResp?.message || 'Unknown'}`, 'error');
      notifyBusy(false);
      return;
    }

    const saved = await setDestination({
      type: 'drive',
      driveFolderId: ensureResp.folderId,
      driveFolderName: ensureResp.folderName,
      driveParentFolderId: ensureResp.parentFolderId,
      driveParentFolderName: ensureResp.parentFolderName,
    });
    if (!saved) {
      setStatus('저장 실패. 다시 시도해주세요.', 'error');
      notifyBusy(false);
      return;
    }

    notifyBusy(false);
    setStatus(
      `✓ "${selected.name}/kickclip_files" 폴더가 설정되었습니다. 창을 닫습니다...`,
      'success'
    );
    try {
      chrome.runtime.sendMessage({
        action: 'kc-picker-drive-ready',
        destination: {
          type: 'drive',
          driveFolderId: ensureResp.folderId,
          driveFolderName: ensureResp.folderName,
          driveParentFolderId: ensureResp.parentFolderId,
          driveParentFolderName: ensureResp.parentFolderName,
        },
      });
    } catch (e) {
      console.log('[KICKCLIP-LOG] picker drive-ready sendMessage error:', e);
    }
    setTimeout(closeSelfTab, 1200);
  } catch (e) {
    console.log('[KICKCLIP-LOG] handleDriveButtonClick error:', e);
    setStatus(`오류: ${e?.message || String(e)}`, 'error');
    notifyBusy(false);
  }
}

// Export for Phase U3.3b wiring
window.handleDriveButtonClick = handleDriveButtonClick;

btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('폴더 선택 대화상자를 여는 중...', '');

  // Tell side panel we're opening the system dialog — suppress auto-close
  notifyBusy(true);

  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    notifyBusy(false);
    if (e && (e.name === 'AbortError' || e.code === 20)) {
      setStatus('취소되었습니다. 다시 시도하려면 버튼을 누르세요.', '');
      btn.disabled = false;
      return;
    }
    console.log('[KICKCLIP-LOG] picker showDirectoryPicker error:', e);
    setStatus(`오류: ${e?.message || e}`, 'error');
    btn.disabled = false;
    return;
  }

  // Dialog closed (user selected). Re-enable auto-close.
  notifyBusy(false);

  // Verify readwrite permission
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await handle.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') {
        setStatus('폴더 쓰기 권한이 거부되었습니다.', 'error');
        btn.disabled = false;
        return;
      }
    }
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker permission error:', e);
    setStatus(`권한 확인 실패: ${e?.message || e}`, 'error');
    btn.disabled = false;
    return;
  }

  // Persist
  try {
    await setPrimaryHandle(handle);
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker setPrimaryHandle error:', e);
    setStatus(`저장 실패: ${e?.message || e}`, 'error');
    btn.disabled = false;
    return;
  }

  setStatus(`✓ "${handle.name}" 폴더가 설정되었습니다. 창을 닫습니다...`, 'success');

  try {
    chrome.runtime.sendMessage({
      action: 'kc-picker-handle-ready',
      folderName: handle.name,
    });
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker sendMessage error:', e);
  }

  setTimeout(closeSelfTab, 800);
});
