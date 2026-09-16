// Minimal PNG generator for PWA icons
// Run: node scripts/generate-icons.js
const fs = require('fs');
const path = require('path');

function createMinimalPNG(size) {
  // Create a minimal valid PNG with a solid black background and blue CW text
  // This is a minimal PNG structure
  const width = size;
  const height = size;

  // Build a minimal PNG manually
  const { createCanvas } = (() => {
    try {
      return require('canvas');
    } catch {
      return null;
    }
  })();

  if (!createCanvas) {
    console.log('canvas module not available. Skipping icon generation.');
    console.log('To generate icons, run: npm install canvas');
    return;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // Rounded rectangle for background
  const r = size * 0.2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(width - r, 0);
  ctx.quadraticCurveTo(width, 0, width, r);
  ctx.lineTo(width, height - r);
  ctx.quadraticCurveTo(width, height, width - r, height);
  ctx.lineTo(r, height);
  ctx.quadraticCurveTo(0, height, 0, height - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = '#000000';
  ctx.fill();

  // Text "CW"
  ctx.fillStyle = '#007AFF';
  ctx.font = `bold ${size * 0.5}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CW', width / 2, height / 2 + size * 0.05);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons', `icon-${size}.png`), buffer);
  console.log(`Generated icon-${size}.png`);
}

// Try to generate icons
try {
  createMinimalPNG(192);
  createMinimalPNG(512);
} catch (e) {
  console.log('Could not generate icons:', e.message);
}
