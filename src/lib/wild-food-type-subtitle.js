/**
 * One-line “type of food” for Earth strip foraging subtitles (no distance, site, or phenology).
 * @param {string} label
 * @returns {string}
 */
export function wildFoodTypeSubtitleFromLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s.trim()) return 'Wild food';

  if (/(mushroom|fungus|truffle|bolete|chanterelle)/.test(s)) return 'Mushrooms';
  if (/(walnut|acorn|chestnut|hickory|hazelnut|pecan)\b/.test(s) || /\bnut\b/.test(s)) return 'Nuts';
  if (/(prickly pear|cactus|saguaro|opuntia)/.test(s)) return 'Cactus fruit';
  if (/(sea grape|cocoplum|beach plum)/.test(s)) return 'Coastal fruit';
  if (/(grape|muscadine|vitis)/.test(s) && !/(oregon grape|mahonia)/.test(s)) return 'Grapes';
  if (
    /(blackberry|raspberry|berry\b|huckleberry|blueberry|elder|salal|toyon|coffeeberry|manzanita|serviceberry|juneberry|dewberry|strawberry|wineberry|currant|gooseberry|lingon|cranberry|hackberry|oregon grape|mahonia)/.test(
      s,
    )
  ) {
    return 'Berries';
  }
  if (/(apple|pear|plum|cherry|peach|apricot|fig\b|loquat|persimmon|pawpaw|jujube|quince|mulberry|citru|orange|lemon|lime)/.test(s)) {
    return 'Tree fruit';
  }
  if (/(miner|lettuce|chickweed|ramp|leek|green\b|spinach|kale|chard|purslane)/.test(s)) return 'Leafy greens';
  if (/(sagebrush|herb\b|mint\b|basil|bay laurel|rosemary|thyme|sage\b|fennel)/.test(s)) return 'Herbs';
  if (/(honey|maple syrup|sap)/.test(s)) return 'Sweeteners';
  if (/(palm|date)/.test(s)) return 'Palm fruit';

  return 'Wild food';
}
