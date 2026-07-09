/**
 * Gate native wild-food rows: only list plants explicitly marked human-edible.
 * @param {{ humanEdible?: boolean, label?: string }} plant
 * @returns {boolean}
 */
export function isHumanEdiblePlant(plant) {
  return plant?.humanEdible === true;
}

/**
 * Curated ZIP-local fruit trees (cultivated / commonly eaten).
 * @param {{ label?: string }} tree
 * @returns {boolean}
 */
export function isHumanEdibleFruitTree(tree) {
  return typeof tree?.label === 'string' && tree.label.trim().length > 0;
}
