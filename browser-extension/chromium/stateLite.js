export const state = {
  activeHoverUrl: null,
  activeCoreItem: null,
  // === PHASE_OVERLAY_ON_IMAGE ===
  // For Type D: the element whose rect determines the visual overlay.
  // May differ from activeCoreItem when the overlay should outline the
  // dominantImg or its image-wrapping anchor rather than the full card.
  // Always equals activeCoreItem for non-Type-D evidence types.
  // === END PHASE_OVERLAY_ON_IMAGE ===
  activeOverlayElement: null,
  lastExtractedMetadata: null,
  itemMap: [],
  // === PHASE_IFRAME_HOVER_PROPAGATION ===
  // Set on top frame when an iframe content script broadcasts hover info
  // via KC_IFRAME_HOVER postMessage. Used to bridge top-frame keydown
  // to iframe-internal image clip when iframe Permissions Policy blocks
  // navigator.clipboard.write inside iframe. Cleared on KC_IFRAME_HOVER_END
  // matching the same sourceWindow. Shape:
  //   { url, imageUrl, category, confirmedType, title, platform, pageUrl, sourceWindow }
  iframeHoverInfo: null,
  // === END PHASE_IFRAME_HOVER_PROPAGATION ===
};
