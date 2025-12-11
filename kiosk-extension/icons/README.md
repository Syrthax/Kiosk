# Extension Icons

Chrome extensions require icons in multiple sizes for different contexts.

## Required Sizes

- **icon16.png** - 16x16px - Extension menu, context menu
- **icon48.png** - 48x48px - Extensions management page
- **icon128.png** - 128x128px - Chrome Web Store, installation dialog

## Design Guidelines

### Style
- Match Kiosk's glassmorphism aesthetic
- Use PDF document icon or "K" logo
- Blue accent color (#2196f3) or custom brand color
- Transparent background or subtle gradient
- Clean, minimal design

### Technical Requirements
- Format: PNG with transparency
- Color space: sRGB
- Compression: Optimized for web
- No text in icon (won't scale well)

## Creating Icons

### Option 1: Design Tool (Figma, Adobe XD)
1. Create 128x128 artboard
2. Design icon with 20px padding
3. Export as PNG at 1x, 2x, 3x for crisp rendering
4. Resize exports to 16px, 48px, 128px

### Option 2: Online Tools
- [Favicon Generator](https://realfavicongenerator.net/)
- [Icon Generator](https://romannurik.github.io/AndroidAssetStudio/)
- [Figma Icon Templates](https://www.figma.com/community/file/786681933803895038)

### Option 3: Quick Placeholder
Generate simple placeholder icons using HTML Canvas or SVG:

```html
<!-- icon-generator.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Icon Generator</title>
  <style>
    canvas { border: 1px solid #ccc; margin: 10px; }
  </style>
</head>
<body>
  <h1>Kiosk Extension Icon Generator</h1>
  <canvas id="icon16" width="16" height="16"></canvas>
  <canvas id="icon48" width="48" height="48"></canvas>
  <canvas id="icon128" width="128" height="128"></canvas>
  
  <script>
    function drawIcon(canvasId, size) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      
      // Background gradient
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, '#2196f3');
      gradient.addColorStop(1, '#1976d2');
      
      // Rounded rectangle
      const radius = size * 0.2;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(size - radius, 0);
      ctx.quadraticCurveTo(size, 0, size, radius);
      ctx.lineTo(size, size - radius);
      ctx.quadraticCurveTo(size, size, size - radius, size);
      ctx.lineTo(radius, size);
      ctx.quadraticCurveTo(0, size, 0, size - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.fill();
      
      // PDF icon (simplified)
      ctx.fillStyle = 'white';
      ctx.font = `bold ${size * 0.4}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('K', size / 2, size / 2);
    }
    
    drawIcon('icon16', 16);
    drawIcon('icon48', 48);
    drawIcon('icon128', 128);
    
    // Download links
    ['icon16', 'icon48', 'icon128'].forEach(id => {
      const canvas = document.getElementById(id);
      const link = document.createElement('a');
      link.download = `${id}.png`;
      link.textContent = `Download ${id}`;
      link.href = canvas.toDataURL('image/png');
      canvas.parentNode.insertBefore(link, canvas.nextSibling);
      canvas.parentNode.insertBefore(document.createElement('br'), canvas.nextSibling);
    });
  </script>
</body>
</html>
```

## Example Design

```
┌─────────────────┐
│                 │
│   ┌───┐         │
│   │📄 │         │  Blue gradient background
│   └───┘         │  White PDF icon or "K"
│                 │  Rounded corners
│                 │
└─────────────────┘
```

## Color Palette

Match Kiosk's theme:
- **Primary**: #2196f3 (Blue)
- **Primary Dark**: #1976d2
- **Accent**: #03a9f4
- **White**: #ffffff (icon foreground)

## Current Status

⚠️ **Placeholder icons needed** - The manifest.json references these files, but they don't exist yet.

To use the extension:
1. Create icons using the methods above
2. Save as `icon16.png`, `icon48.png`, `icon128.png` in this directory
3. Reload extension in chrome://extensions

**Temporary workaround**: Extension will work without icons, but Chrome will show a default puzzle piece icon.

---

**Note**: If you have access to design tools, create production-quality icons. Otherwise, the HTML generator above creates acceptable placeholders.
