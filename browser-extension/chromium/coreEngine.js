/**
 * Core Engine Facade / Orchestrator
 * Re-exports APIs from itemDetector, dataExtractor, and uiManager
 * so existing coreEntry imports continue working unchanged.
 */

// Item cluster/item map logic
export {
  detectItemMaps,
  getItemMapFingerprint,
  findClusterContainerFromTarget,
  findItemByImage,
  getItemMapEvidenceType,
  ensureClusterCacheFromState,
  getElementSignature,
  findItemsOnPage,
  buildItemMap,
  findOptimalCluster,
  calculateSimilarity,
  getItemMapEntryByElement,
  EVIDENCE_TYPE_IMAGE_ANCHOR,
} from './itemDetector.js';

// ItemMap debug overlay: Type D uses outline #FFA500 (see uiManager renderItemMapCandidates).

// Metadata extraction logic
export {
  resolveAnchorUrl,
  isVisuallySignificant,
  isValidAnchor,
  isValidImageAnchor,
  extractTitleFromCoreItem,
  extractImageFromCoreItem,
  extractMetadataForCoreItem,
  resolveCoreItemFromImageAnchor,
  extractShortcode,
  mountInstagramShortcodeObserver,
  getCurrentPlatform,
  getVisibleTextContent,
  normalizeShortcodeExtractionResult,
  hasCustomImageLogic,
  hasCustomTitleLogic,
  detectItemCategory,
} from './dataExtractor.js';

// UI highlight/tooltip DOM logic
export {
  renderItemMapCandidates,
  showGreenCandidateOutline,
  showCoreHighlight,
  markCoreHighlightClipped,
  hideCoreHighlight,
  showMetadataTooltip,
  hideMetadataTooltip,
  positionMetadataTooltip,
  showCoreStatusBadge,
  setCoreBadgeTexts,
  setCoreStatusBadgeText,
  hideCoreStatusBadge,
  clearCoreSelection,
  setAiTooltipContent,
  clearAiTooltipContent,
} from './uiManager.js';

// Backward-compatible aliases for pre-refactor naming
export { renderItemMapCandidates as renderGreenCandidates } from './uiManager.js';
export { detectItemMaps as preScanCandidates } from './itemDetector.js';
export { clearCoreSelection as clearFinalSelection } from './uiManager.js';
