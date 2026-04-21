/**
 * Core Engine Facade / Orchestrator
 * Re-exports APIs from itemDetector, dataExtractor, and uiManager
 * so existing coreEntry imports continue working unchanged.
 */

// Item cluster/item map logic
export {
  detectItemMaps,
  detectTypeCItemMaps,
  getItemMapFingerprint,
  findClusterContainerFromTarget,
  getItemMapEvidenceType,
  ensureClusterCacheFromState,
  getElementSignature,
  findItemsOnPage,
  buildItemMap,
  findOptimalCluster,
  calculateSimilarity,
  getItemMapEntryByElement,
  EVIDENCE_TYPE_C,
} from './itemDetector.js';

// Metadata extraction logic
export {
  resolveAnchorUrl,
  isVisuallySignificant,
  isValidAnchor,
  isValidTypeAAnchor,
  extractTitleFromCoreItem,
  extractImageFromCoreItem,
  extractMetadataForCoreItem,
  resolveTypeACoreItem,
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
  updateCoreHighlightClass,
  hideCoreHighlight,
  showFullPageHighlight,
  updateFullPageHighlightClass,
  hideFullPageHighlight,
  resetFullPageHideTimer,
  showMetadataTooltip,
  hideMetadataTooltip,
  positionMetadataTooltip,
  showPageStatusBadge,
  showPageStatusBadgeText,
  hidePageStatusBadge,
  showCoreStatusBadge,
  hideCoreStatusBadge,
  positionCoreStatusBadge,
  clearCoreSelection,
  triggerShutterEffect,
  setAiTooltipContent,
  clearAiTooltipContent,
} from './uiManager.js';

// Backward-compatible aliases for pre-refactor naming
export { renderItemMapCandidates as renderGreenCandidates } from './uiManager.js';
export { detectItemMaps as preScanCandidates } from './itemDetector.js';
export { clearCoreSelection as clearFinalSelection } from './uiManager.js';
