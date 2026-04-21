/**
 * Login Page - Sign-In logic only
 * This page is shown when no user is authenticated.
 * On successful sign-in, main process will reload to dashboard.
 */
(function () {
  const signinBtn = document.getElementById('signin-btn');
  if (!signinBtn) return;

  // Brand injection
  try {
    const BRAND = window.BRAND || { NAME: 'Blink' };
    const brandNameEls = document.querySelectorAll('[data-brand-name]');
    brandNameEls.forEach(el => { el.textContent = el.textContent.replace('Blink', BRAND.NAME); });
    const initialEl = document.querySelector('[data-brand-initial]');
    if (initialEl && BRAND.NAME) initialEl.textContent = BRAND.NAME.charAt(0).toUpperCase();
  } catch (e) {}

  signinBtn.addEventListener('click', async () => {
    if (!checkElectronAPI()) return;
    signinBtn.disabled = true;
    signinBtn.classList.add('loading');
    signinBtn.textContent = 'Signing in...';

    try {
      const result = await window.electronAPI.auth.signInWithGoogle();
      if (!result.success) {
        console.error('Sign in error:', result.error);
        signinBtn.disabled = false;
        signinBtn.classList.remove('loading');
        signinBtn.textContent = 'Sign in with Google';
      }
      // On success, auth:stateChanged fires in main process and will reload to dashboard
    } catch (error) {
      console.error('Sign in error:', error);
      signinBtn.disabled = false;
      signinBtn.classList.remove('loading');
      signinBtn.textContent = 'Sign in with Google';
    }
  });
})();
