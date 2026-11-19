'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validPosition(p) {
  return p && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y);
}

function loadPosition(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validPosition(p) ? { x: p.x, y: p.y } : null;
  } catch { return null; }
}

function savePosition(file, p) {
  if (!validPosition(p)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ x: p.x, y: p.y }), 'utf8');
    return true;
  } catch { return false; }
}

// Fit the centered expanded island width and the full canvas height: HUD and
// urgent controls can occupy variable heights and have no geometry IPC. This
// reserves 500 scaled pixels vertically but excludes horizontal glow margins.
// If the work area is smaller, anchor the required rectangle at its top-left.
function visiblePosition(p, width, height, displays) {
  if (!validPosition(p) || !Array.isArray(displays) || !displays.length) return null;
  const coreWidth = Math.max(1, Math.round(width * 436 / 484));
  const coreHeight = height;
  const left = Math.round((width - coreWidth) / 2);
  let best = null;
  for (const display of displays) {
    const a = display.workArea;
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)
        || !(a.width > 0) || !(a.height > 0)) continue;
    const x = Math.round(Math.max(a.x - left, Math.min(p.x, a.x + Math.max(0, a.width - coreWidth) - left)));
    const y = Math.round(Math.max(a.y, Math.min(p.y, a.y + Math.max(0, a.height - coreHeight))));
    const distance = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (!best || distance < best.distance) best = { x, y, distance };
  }
  return best ? { x: best.x, y: best.y } : null;
}

module.exports = { validPosition, loadPosition, savePosition, visiblePosition };
