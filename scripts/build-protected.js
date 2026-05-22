/**
 * Protected Build Script
 *
 * This script prepares the application for distribution by:
 * 1. Copying files to a build directory
 * 2. Compiling critical JavaScript files to V8 bytecode (very hard to reverse)
 * 3. Obfuscating remaining JavaScript files
 *
 * The result is a protected version of the app that is difficult to reverse engineer.
 *
 * Usage: node scripts/build-protected.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build-temp');

// DISABLED: Bytecode compilation causes compatibility issues across different machines
// The compiled bytecode is tied to specific V8/Electron versions
const FILES_TO_COMPILE = [];

// Files to obfuscate (all critical files - more compatible than bytecode)
const FILES_TO_OBFUSCATE = [
    'main.js',
    'preload.js',
    'main/hotkeys.js',
    'services/license-service.js',
    'services/openai.js',
    'services/token-utils.js',
    'services/rag-utils.js',
    'services/document-processor.js'
];

// Directories and files to exclude from copy
const EXCLUDE_PATTERNS = [
    'node_modules',
    '.git',
    '.env',
    '.env.example',
    'dist',
    'build-temp',
    'build-assets',
    'unitTest',
    'tests',
    'docs',
    '*.md',
    '.eslintrc*',
    'tsconfig.json',
    'temp_chunk_*.wav',
    'scripts/generate-keys.js',
    'scripts/build-protected.js',
    'scripts/create-icon.js'
];

// JavaScript obfuscator options
const obfuscatorOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.7,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: true,
    debugProtectionInterval: 2000,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    unicodeEscapeSequence: false
};

/**
 * Copy directory recursively, excluding specified patterns
 */
function copyDir(src, dest, exclude = []) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        const relativePath = path.relative(PROJECT_ROOT, srcPath);

        // Check if should be excluded
        const shouldExclude = exclude.some(pattern => {
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                return regex.test(entry.name) || regex.test(relativePath);
            }
            return entry.name === pattern || relativePath === pattern || relativePath.startsWith(pattern + path.sep);
        });

        if (shouldExclude) {
            continue;
        }

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Main build function
 */
async function build() {
    console.log('='.repeat(60));
    console.log(' Interview Assistant - Protected Build');
    console.log('='.repeat(60));
    console.log('');

    // Check for required packages
    let bytenodeAvailable = false;
    let obfuscatorAvailable = false;

    try {
        require('bytenode');
        bytenodeAvailable = true;
    } catch {
        console.log('Note: bytenode not installed - bytecode compilation will be skipped');
    }

    try {
        require('javascript-obfuscator');
        obfuscatorAvailable = true;
    } catch {
        console.log('Note: javascript-obfuscator not installed - obfuscation will be skipped');
    }

    console.log('');

    // Step 1: Clean and create build directory
    console.log('Step 1: Preparing build directory...');
    if (fs.existsSync(BUILD_DIR)) {
        fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    console.log('  Build directory created: build-temp/');

    // Step 2: Copy project files
    console.log('\nStep 2: Copying project files...');
    copyDir(PROJECT_ROOT, BUILD_DIR, EXCLUDE_PATTERNS);
    console.log('  Files copied successfully');

    // Step 3: Install production dependencies in build directory
    console.log('\nStep 3: Installing production dependencies...');
    try {
        execSync('npm install --omit=dev', {
            cwd: BUILD_DIR,
            stdio: 'inherit'
        });
        console.log('  Dependencies installed');
    } catch (error) {
        console.error('  Warning: Failed to install dependencies:', error.message);
    }

    // Step 4: Compile to bytecode (if bytenode is available)
    if (bytenodeAvailable) {
        console.log('\nStep 4: Compiling to V8 bytecode...');
        const bytenode = require('bytenode');

        for (const file of FILES_TO_COMPILE) {
            const srcPath = path.join(BUILD_DIR, file);
            if (fs.existsSync(srcPath)) {
                try {
                    console.log(`  Compiling: ${file}`);
                    const jscPath = srcPath.replace('.js', '.jsc');

                    // Compile to bytecode
                    await bytenode.compileFile({
                        filename: srcPath,
                        output: jscPath,
                        electron: true
                    });

                    // Create loader that requires the bytecode
                    const loaderContent = `require('bytenode');module.exports=require('./${path.basename(jscPath)}');`;
                    fs.writeFileSync(srcPath, loaderContent);

                    console.log(`    Created: ${path.basename(jscPath)}`);
                } catch (error) {
                    console.error(`    Error compiling ${file}:`, error.message);
                }
            }
        }
    } else {
        console.log('\nStep 4: Skipping bytecode compilation (bytenode not installed)');
    }

    // Step 5: Obfuscate remaining files (if obfuscator is available)
    if (obfuscatorAvailable) {
        console.log('\nStep 5: Obfuscating JavaScript files...');
        const JavaScriptObfuscator = require('javascript-obfuscator');

        for (const file of FILES_TO_OBFUSCATE) {
            const filePath = path.join(BUILD_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    console.log(`  Obfuscating: ${file}`);
                    const code = fs.readFileSync(filePath, 'utf8');
                    const obfuscated = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
                    fs.writeFileSync(filePath, obfuscated.getObfuscatedCode());
                } catch (error) {
                    console.error(`    Error obfuscating ${file}:`, error.message);
                }
            }
        }
    } else {
        console.log('\nStep 5: Skipping obfuscation (javascript-obfuscator not installed)');
    }

    // Step 6: Create a marker file to indicate protected build
    const markerPath = path.join(BUILD_DIR, '.protected-build');
    fs.writeFileSync(markerPath, JSON.stringify({
        buildDate: new Date().toISOString(),
        bytecodeMcompiled: bytenodeAvailable,
        obfuscated: obfuscatorAvailable,
        version: require(path.join(PROJECT_ROOT, 'package.json')).version
    }, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log(' Build Complete!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Protected build created in: build-temp/');
    console.log('');

    if (!bytenodeAvailable || !obfuscatorAvailable) {
        console.log('To enable full protection, install:');
        if (!bytenodeAvailable) console.log('  npm install --save-dev bytenode');
        if (!obfuscatorAvailable) console.log('  npm install --save-dev javascript-obfuscator');
        console.log('');
    }

    console.log('Next steps:');
    console.log('  1. cd build-temp');
    console.log('  2. npm run build:win');
    console.log('');
    console.log('Or run from project root:');
    console.log('  npm run package');
    console.log('');
}

// Run build
build().catch(error => {
    console.error('Build failed:', error);
    process.exit(1);
});
