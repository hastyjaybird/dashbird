/**
 * Minimal early boot: wire web search before the main app bundle finishes loading.
 */
import { enhanceWebSearch, focusWebSearchInput } from './panels/web-search.js';

const root = document.getElementById('mount-web-search');
if (root && root.dataset.searchEnhanced !== '1') {
  enhanceWebSearch(root);
  root.dataset.searchEnhanced = '1';
  focusWebSearchInput(root);
}
