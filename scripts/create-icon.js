/**
 * Icon Creation Helper Script
 *
 * This script helps convert the SVG icon to ICO format for Windows distribution.
 *
 * Prerequisites:
 * npm install --save-dev sharp png-to-ico
 *
 * Usage:
 * node scripts/create-icon.js
 *
 * Alternative (Online tools):
 * 1. Open assets/icon.svg in a browser
 * 2. Take a screenshot at 512x512 or use an SVG to PNG converter
 * 3. Go to https://icoconvert.com/ or https://convertico.com/
 * 4. Upload the PNG and convert to ICO with sizes: 16, 32, 48, 64, 128, 256
 * 5. Save as assets/icon.ico
 */

const fs = require('fs');
const path = require('path');

async function createIcon() {
    try {
        // Check if sharp is available
        const sharp = require('sharp');
        const pngToIco = require('png-to-ico');

        const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
        const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');
        const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');

        console.log('Converting SVG to PNG...');

        // Convert SVG to PNG at various sizes
        const sizes = [16, 32, 48, 64, 128, 256];
        const pngBuffers = [];

        for (const size of sizes) {
            const buffer = await sharp(svgPath)
                .resize(size, size)
                .png()
                .toBuffer();
            pngBuffers.push(buffer);
            console.log(`  Created ${size}x${size} PNG`);
        }

        // Also create a 256px PNG for reference
        await sharp(svgPath)
            .resize(256, 256)
            .png()
            .toFile(pngPath);

        console.log('Converting PNGs to ICO...');

        // Convert to ICO
        const icoBuffer = await pngToIco(pngBuffers);
        fs.writeFileSync(icoPath, icoBuffer);

        console.log(`\nIcon created successfully at: ${icoPath}`);
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            console.log('Required packages not installed.\n');
            console.log('To create the icon automatically, install these packages:');
            console.log('  npm install --save-dev sharp png-to-ico\n');
            console.log('Then run: node scripts/create-icon.js\n');
            console.log('Alternatively, use an online converter:');
            console.log('  1. Convert assets/icon.svg to PNG (512x512)');
            console.log('  2. Go to https://icoconvert.com/');
            console.log('  3. Upload PNG, select sizes: 16, 32, 48, 64, 128, 256');
            console.log('  4. Download and save as assets/icon.ico');
        } else {
            console.error('Error creating icon:', error.message);
        }
    }
}

createIcon();
