// Explicit observed display settings only: unknown values do not become defaults.
const fields = new Set([
  'designWidth',
  'designHeight',
  'scaleToFit',
  'lockAspectRatio',
  'lockOrientation',
  'orientation',
]);
function validateCanvasPolicy(name, policy, label) {
  if (
    !name.trim() ||
    name.length > 200 ||
    ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase()) ||
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    !Object.keys(policy).length ||
    Object.keys(policy).some((key) => !fields.has(key))
  )
    throw new Error(`${label} requires app names and known display fields`);
  for (const [key, item] of Object.entries(policy)) {
    if (['designWidth', 'designHeight'].includes(key) && (!Number.isInteger(item) || item < 1 || item > 8192))
      throw new Error(`${label}.${name}.${key} must be an integer from 1 to 8192`);
    if (['scaleToFit', 'lockAspectRatio', 'lockOrientation'].includes(key) && typeof item !== 'boolean')
      throw new Error(`${label}.${name}.${key} must be a boolean`);
    if (key === 'orientation' && !['Portrait', 'Landscape'].includes(item))
      throw new Error(`${label}.${name}.orientation must be Portrait or Landscape`);
  }
}
export function validateCanvasDisplay(value, label = 'observed.canvasDisplay') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000)
    throw new Error(`${label} must map at most 1000 app names to display observations`);
  const entries = [];
  for (const [name, policy] of Object.entries(value)) {
    validateCanvasPolicy(name, policy, label);
    entries.push([name, { ...policy }]);
  }
  return Object.fromEntries(entries);
}
function logicalCanvasSize(policy, width, height, scaling, locked, swap) {
  if (scaling) {
    const swapDesign =
      locked &&
      (policy.orientation === 'Landscape'
        ? policy.designWidth < policy.designHeight
        : policy.designWidth > policy.designHeight);
    return swapDesign
      ? { logicalWidth: policy.designHeight, logicalHeight: policy.designWidth }
      : { logicalWidth: policy.designWidth, logicalHeight: policy.designHeight };
  }
  if (swap) return { logicalWidth: height, logicalHeight: width };
  return { logicalWidth: width, logicalHeight: height };
}
/** Compute viewport, scale and offsets without inferring absent source settings. */
export function canvasDisplayGeometry(policy, width, height) {
  const p = policy ?? {};
  const locked = p.lockOrientation === true && ['Portrait', 'Landscape'].includes(p.orientation);
  const swap = locked && (p.orientation === 'Landscape' ? width < height : width > height);
  const scaling = p.scaleToFit === true && Number.isInteger(p.designWidth) && Number.isInteger(p.designHeight);
  const { logicalWidth, logicalHeight } = logicalCanvasSize(p, width, height, scaling, locked, swap);
  let scaleX = 1,
    scaleY = 1;
  if (scaling) {
    scaleX = width / logicalWidth;
    scaleY = height / logicalHeight;
    if (p.lockAspectRatio === true) scaleX = scaleY = Math.min(scaleX, scaleY);
  }
  return {
    logicalWidth,
    logicalHeight,
    scaleX,
    scaleY,
    offsetX: scaling ? (width - logicalWidth * scaleX) / 2 : 0,
    offsetY: scaling ? (height - logicalHeight * scaleY) / 2 : 0,
    scaling,
    orientationLocked: locked,
    incomplete: p.scaleToFit === true && !scaling,
  };
}
