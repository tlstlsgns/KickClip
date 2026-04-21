/**
 * Blink Brand Config (Electron Renderer)
 * Exposes a global BRAND object for non-module renderer scripts and HTML.
 */
(function () {
  const BRAND = {
    NAME: 'Blink',
    VERSION: '1.0.0',
    KEY_COLOR: 'purple',
    KEY_COLOR_HEX: '#BC13FE',
    LOG_PREFIX: '[BLINK-LOG]',
  };

  const hexToRgb = (hex) => {
    try {
      const h = (hex || '').trim().replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      if (full.length !== 6) return null;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b };
    } catch (e) {
      return null;
    }
  };

  const applyBrandCssVars = () => {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.style.setProperty('--blink-accent', BRAND.KEY_COLOR_HEX);
      const rgb = hexToRgb(BRAND.KEY_COLOR_HEX);
      if (rgb) root.style.setProperty('--blink-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      // Back-compat: many styles use --border-active as “accent”
      root.style.setProperty('--border-active', `var(--blink-accent)`);
    } catch (e) {}
  };

  // Expose globally
  try {
    window.BRAND = BRAND;
  } catch (e) {}

  // Optional placeholder for production readiness (renderer does not initialize Firebase directly).
  try {
    window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
      apiKey: '',
      authDomain: '',
      projectId: '',
      storageBucket: '',
      messagingSenderId: '',
      appId: '',
      measurementId: '',
    };
  } catch (e) {}

  // Apply CSS variables as early as possible, and again after DOM ready.
  try { applyBrandCssVars(); } catch (e) {}
  try {
    window.addEventListener('DOMContentLoaded', () => {
      try { applyBrandCssVars(); } catch (e) {}
    });
  } catch (e) {}
})();

