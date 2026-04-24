// picker.js — runs in a dedicated extension popup window, invokes showDirectoryPicker,
// persists handle to IndexedDB, notifies side panel, and closes itself.

import { setPrimaryHandle, setDestination } from './uploadStorage.js';

const btn = document.getElementById('pick');
const driveBtn = document.getElementById('pick-drive');
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

/**
 * Drive button handler (Phase U3.3c).
 * Skips Google Picker (incompatible with MV3 CSP) and directly creates/
 * reuses kickclip_files in user's My Drive root. Picker API reintroduction
 * (folder selection UI) is deferred to Phase U4 with a custom tree view.
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

    setStatus('내 드라이브에 kickclip_files 폴더 준비 중...', '');
    const ensureResp = await chrome.runtime.sendMessage({
      action: 'drive-ensure-folder',
      parentFolderId: 'root',
      parentFolderName: '내 드라이브',
    });
    if (!ensureResp?.ok) {
      setStatus(`폴더 설정 실패: ${ensureResp?.message || 'Unknown'}`, 'error');
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
      `✓ 내 드라이브의 "kickclip_files" 폴더가 설정되었습니다. 창을 닫습니다...`,
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
  if (driveBtn) driveBtn.disabled = true;
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
      if (driveBtn) driveBtn.disabled = false;
      return;
    }
    console.log('[KICKCLIP-LOG] picker showDirectoryPicker error:', e);
    setStatus(`오류: ${e?.message || e}`, 'error');
    btn.disabled = false;
    if (driveBtn) driveBtn.disabled = false;
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
        if (driveBtn) driveBtn.disabled = false;
        return;
      }
    }
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker permission error:', e);
    setStatus(`권한 확인 실패: ${e?.message || e}`, 'error');
    btn.disabled = false;
    if (driveBtn) driveBtn.disabled = false;
    return;
  }

  // Persist
  try {
    await setPrimaryHandle(handle);
  } catch (e) {
    console.log('[KICKCLIP-LOG] picker setPrimaryHandle error:', e);
    setStatus(`저장 실패: ${e?.message || e}`, 'error');
    btn.disabled = false;
    if (driveBtn) driveBtn.disabled = false;
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

// Wire Google Drive button (Phase U3.3b)
if (driveBtn) {
  driveBtn.addEventListener('click', async () => {
    btn.disabled = true;
    driveBtn.disabled = true;
    try {
      await handleDriveButtonClick();
    } finally {
      btn.disabled = false;
      driveBtn.disabled = false;
    }
  });
}
