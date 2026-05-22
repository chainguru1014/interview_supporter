/**
 * License Key Generator
 * Generates 30 cryptographically secure license keys
 * Format: XXXX-XXXX-XXXX-XXXX (uppercase alphanumeric)
 *
 * Run with: node scripts/generate-keys.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Salt for hashing - CHANGE THIS TO YOUR UNIQUE VALUE
const SALT = 'INTERVIEW_ASSIST_2024_SECURE_SALT_v1';

/**
 * Generate a single license key
 * @returns {string} License key in format XXXX-XXXX-XXXX-XXXX
 */
function generateKey() {
    const segments = [];
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars: 0,O,1,I

    for (let i = 0; i < 4; i++) {
        let segment = '';
        for (let j = 0; j < 4; j++) {
            const randomIndex = crypto.randomInt(0, chars.length);
            segment += chars[randomIndex];
        }
        segments.push(segment);
    }
    return segments.join('-');
}

/**
 * Generate a set of unique license keys
 * @param {number} count Number of keys to generate
 * @returns {string[]} Array of unique license keys
 */
function generateKeySet(count = 30) {
    const keys = new Set();
    while (keys.size < count) {
        keys.add(generateKey());
    }
    return Array.from(keys);
}

/**
 * Hash a license key for secure storage
 * @param {string} key Plain text license key
 * @returns {string} SHA-256 hash of key + salt
 */
function hashKey(key) {
    const normalized = key.toUpperCase().trim();
    return crypto.createHash('sha256').update(normalized + SALT).digest('hex');
}

// Generate keys
console.log('🔐 Interview Assistant License Key Generator\n');
console.log('=' .repeat(60));

const keys = generateKeySet(30);
const hashedKeys = keys.map(key => hashKey(key));

// Display plain text keys (for distribution)
console.log('\n📋 PLAIN TEXT LICENSE KEYS (Distribute these to users):\n');
keys.forEach((key, i) => {
    console.log(`  ${String(i + 1).padStart(2, '0')}. ${key}`);
});

// Display hashed keys (for embedding in code)
console.log('\n\n🔒 HASHED KEYS (Copy to services/license-service.js):\n');
console.log('const VALID_KEY_HASHES = [');
hashedKeys.forEach((hash, i) => {
    const comma = i < hashedKeys.length - 1 ? ',' : '';
    console.log(`    '${hash}'${comma}`);
});
console.log('];');

// Create output directory
const outputDir = path.join(__dirname, '..', 'build-assets');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Save plain text keys to file
const plainKeysPath = path.join(outputDir, 'license-keys-plain.txt');
const plainKeysContent = [
    'Interview Assistant - License Keys',
    'Generated: ' + new Date().toISOString(),
    '=' .repeat(50),
    '',
    ...keys.map((key, i) => `${String(i + 1).padStart(2, '0')}. ${key}`),
    '',
    'IMPORTANT: Keep these keys secure!',
    'Each key can be used to activate one installation.'
].join('\n');

fs.writeFileSync(plainKeysPath, plainKeysContent);

// Save hashed keys to JSON file
const hashedKeysPath = path.join(outputDir, 'license-keys-hashed.json');
fs.writeFileSync(hashedKeysPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    salt: SALT,
    hashes: hashedKeys
}, null, 2));

// Generate the license-service.js snippet
const serviceSnippetPath = path.join(outputDir, 'license-service-snippet.js');
const snippetContent = `// Copy this array to services/license-service.js
// Generated: ${new Date().toISOString()}

const VALID_KEY_HASHES = [
${hashedKeys.map((hash, i) => `    '${hash}'${i < hashedKeys.length - 1 ? ',' : ''}`).join('\n')}
];

const SALT = '${SALT}';
`;
fs.writeFileSync(serviceSnippetPath, snippetContent);

console.log('\n\n✅ Files saved to build-assets/:');
console.log(`   - license-keys-plain.txt (distribute to users)`);
console.log(`   - license-keys-hashed.json (backup)`);
console.log(`   - license-service-snippet.js (copy to license-service.js)`);
console.log('\n' + '=' .repeat(60));
console.log('⚠️  IMPORTANT: Keep license-keys-plain.txt secure!');
console.log('=' .repeat(60) + '\n');
