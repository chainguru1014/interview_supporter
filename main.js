// Load environment variables from .env file (only works in dev mode)
const path = require('path');
const dotenvPath = path.join(__dirname, '.env');
const dotenvResult = require('dotenv').config({ path: dotenvPath });
if (dotenvResult.error) {
    console.log('[dotenv] No .env file found at:', dotenvPath);
    console.log('[dotenv] Error:', dotenvResult.error.code || dotenvResult.error.message);
    console.log('[dotenv] This is normal for packaged apps - use Settings to configure API key');
} else {
    console.log('[dotenv] Environment loaded from:', dotenvPath);
    console.log('[dotenv] OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
}

if (process.env.ELECTRON_RUN_AS_NODE) {
    delete process.env.ELECTRON_RUN_AS_NODE;
}
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const fsPromises = require('fs').promises;
const ffmpegStatic = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
// Note: path already required at top of file for dotenv
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const { spawn } = require('child_process');
const { calculateTokenCount, trimMessagesToTokenLimit } = require('./services/token-utils');
const { normalizeRagPayload, mergeRagState } = require('./services/rag-utils');
const openaiService = require('./services/openai');
const documentProcessor = require('./services/document-processor');
const licenseService = require('./services/license-service');
const { buildPrompt, getVisionPrompt, getMeetingTypeList } = require('./services/prompt-profiles');

// Helper function to get the correct icon path for both dev and packaged mode
function getIconPath() {
    if (app.isPackaged) {
        // In packaged mode, assets are in extraResources
        return path.join(process.resourcesPath, 'assets', 'icon.ico');
    }
    // In development mode
    return path.join(__dirname, 'assets', 'icon.ico');
}

// --- Configuration ---
// CONFIG_PATH will be set to userData directory after app is ready
let CONFIG_PATH = null;

// --- Load Configuration ---
let config = {
    audioDevice: 'CABLE Output (VB-Audio Virtual Cable)', // Default value
    exportFormat: 'json', // 'json' or 'txt'
    useDefaultExportPath: true,
    customExportPath: '',
    autoExportOnSessionEnd: false,
    openaiApiKey: null, // Will be set by user in Settings
};

// --- Enhanced Session Logging ---
let LOG_DIR; // Will be initialized when app is ready

// Session tracking
let currentSession = null;

function createNewSession() {
    // Ensure LOG_DIR is initialized before creating session
    if (!LOG_DIR) {
        console.warn('createNewSession called before LOG_DIR initialized, skipping session creation');
        return;
    }

    const sessionId = uuidv4();
    const timestamp = new Date().toISOString().replace(/:/g, '-');

    currentSession = {
        sessionId,
        startTime: new Date().toISOString(),
        endTime: null,
        mode: 'interview', // 'interview' or 'coding'
        profile: { ...profileData },
        messages: [],
        statistics: {
            totalMessages: 0,
            userMessages: 0,
            assistantMessages: 0,
            screenshotsAnalyzed: 0,
            tokensUsed: 0
        },
        textLogPath: path.join(LOG_DIR, `session_${timestamp}.txt`),
        jsonLogPath: path.join(LOG_DIR, `session_${timestamp}.json`)
    };

    // Write initial log header
    const header = `
╔════════════════════════════════════════════════════════════════════════════════╗
║                          INTERVIEW SESSION LOG                                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

Session ID: ${sessionId}
Start Time: ${new Date(currentSession.startTime).toLocaleString()}
Mode: Interview Practice & Transparent Assist

Profile Information:
- Job Title: ${profileData.jobTitle}
- Job Description: ${profileData.jobDescription}

═══════════════════════════════════════════════════════════════════════════════

`;

    fs.writeFileSync(currentSession.textLogPath, header);
    console.log(`New session started: ${sessionId}`);

    return currentSession;
}

function logSessionEvent(eventType, details = {}) {
    if (!currentSession) createNewSession();

    const timestamp = new Date().toISOString();
    const event = {
        type: eventType,
        timestamp,
        details
    };

    // Log to text file
    let textEntry = '';
    switch (eventType) {
        case 'mode_change':
            textEntry = `\n[${new Date(timestamp).toLocaleTimeString()}] Mode changed to: ${details.mode}\n\n`;
            break;
        case 'screenshot_capture':
            textEntry = `\n[${new Date(timestamp).toLocaleTimeString()}] 📸 Screenshot captured and analyzed\n\n`;
            currentSession.statistics.screenshotsAnalyzed++;
            break;
        case 'monitoring_started':
            textEntry = `\n[${new Date(timestamp).toLocaleTimeString()}] 🎤 Audio monitoring started\n\n`;
            break;
        case 'monitoring_stopped':
            textEntry = `\n[${new Date(timestamp).toLocaleTimeString()}] 🛑 Audio monitoring stopped\n\n`;
            break;
    }

    if (textEntry) {
        fs.appendFile(currentSession.textLogPath, textEntry, (err) => {
            if (err) console.error('Failed to log event:', err);
        });
    }
}

function logConversationMessage(role, content, metadata = {}) {
    if (!currentSession) createNewSession();

    const timestamp = new Date().toISOString();
    const message = {
        role,
        content,
        timestamp,
        ...metadata
    };

    currentSession.messages.push(message);
    currentSession.statistics.totalMessages++;

    if (role === 'user') {
        currentSession.statistics.userMessages++;
    } else if (role === 'assistant') {
        currentSession.statistics.assistantMessages++;
    }

    // Update token count
    currentSession.statistics.tokensUsed = calculateTokenCount(conversationHistory);

    // Format for text log
    const roleEmoji = role === 'user' ? '👤' : '🤖';
    const roleLabel = role === 'user' ? 'USER' : 'ASSISTANT';
    const timeStr = new Date(timestamp).toLocaleTimeString();

    const textEntry = `[${timeStr}] ${roleEmoji} ${roleLabel}${metadata.type ? ` (${metadata.type})` : ''}
${content}

${'─'.repeat(80)}

`;

    fs.appendFile(currentSession.textLogPath, textEntry, (err) => {
        if (err) console.error('Failed to write to conversation log:', err);
    });

    // Save JSON periodically (every 5 messages)
    if (currentSession.statistics.totalMessages % 5 === 0) {
        saveSessionJSON();
    }
}

function saveSessionJSON() {
    if (!currentSession) return;

    const sessionData = {
        ...currentSession,
        lastSaved: new Date().toISOString()
    };

    fs.writeFile(currentSession.jsonLogPath, JSON.stringify(sessionData, null, 2), (err) => {
        if (err) console.error('Failed to save session JSON:', err);
    });
}

async function endCurrentSession() {
    if (!currentSession) return;

    currentSession.endTime = new Date().toISOString();

    // Calculate session duration
    const duration = new Date(currentSession.endTime) - new Date(currentSession.startTime);
    const durationMinutes = Math.floor(duration / 60000);
    const durationSeconds = Math.floor((duration % 60000) / 1000);

    // Write session summary to text log
    const summary = `

╔════════════════════════════════════════════════════════════════════════════════╗
║                          SESSION SUMMARY                                        ║
╚════════════════════════════════════════════════════════════════════════════════╝

End Time: ${new Date(currentSession.endTime).toLocaleString()}
Duration: ${durationMinutes}m ${durationSeconds}s

Statistics:
- Total Messages: ${currentSession.statistics.totalMessages}
- User Messages: ${currentSession.statistics.userMessages}
- Assistant Messages: ${currentSession.statistics.assistantMessages}
- Screenshots Analyzed: ${currentSession.statistics.screenshotsAnalyzed}
- Tokens Used: ${currentSession.statistics.tokensUsed}

═══════════════════════════════════════════════════════════════════════════════

Session ended successfully.
`;

    fs.appendFileSync(currentSession.textLogPath, summary);

    // Save final JSON
    await saveSessionJSON();

    // Auto-export conversation if enabled
    if (config.autoExportOnSessionEnd && conversationHistory.length > 0) {
        try {
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            const exportDir = config.useDefaultExportPath ? LOG_DIR : (config.customExportPath || LOG_DIR);
            const exportFormat = config.exportFormat || 'json';
            const exportPath = path.join(exportDir, `auto_export_${timestamp}.${exportFormat}`);

            const exportData = {
                timestamp: new Date().toISOString(),
                conversationHistory,
                profileData,
                tokenCount: calculateTokenCount(conversationHistory),
                sessionInfo: {
                    sessionId: currentSession.sessionId,
                    startTime: currentSession.startTime,
                    endTime: currentSession.endTime,
                    statistics: currentSession.statistics
                }
            };

            if (exportFormat === 'json') {
                await fsPromises.writeFile(exportPath, JSON.stringify(exportData, null, 2));
            } else if (exportFormat === 'txt') {
                let textContent = `CONVERSATION AUTO-EXPORT\n`;
                textContent += `Export Time: ${new Date().toLocaleString()}\n`;
                textContent += `Session ID: ${currentSession.sessionId}\n`;
                textContent += `Token Count: ${exportData.tokenCount}\n`;
                textContent += `\n${'='.repeat(80)}\n\n`;

                conversationHistory.forEach((msg, idx) => {
                    const roleLabel = msg.role === 'user' ? 'USER' : 'ASSISTANT';
                    textContent += `[Message ${idx + 1}] ${roleLabel}\n`;
                    textContent += `${msg.content}\n`;
                    textContent += `\n${'-'.repeat(80)}\n\n`;
                });

                await fsPromises.writeFile(exportPath, textContent);
            }

            console.log(`Auto-exported conversation to: ${exportPath}`);
        } catch (err) {
            console.error('Failed to auto-export conversation:', err);
        }
    }

    console.log(`Session ended: ${currentSession.sessionId}`);
    console.log(`Logs saved to: ${currentSession.textLogPath}`);

    // Reset session
    currentSession = null;
}

// Legacy function for backward compatibility
function logInterview(role, content) {
    logConversationMessage(role, content);
}

// Config loading moved to app.whenReady() since it needs userData path
function loadConfig() {
    if (!CONFIG_PATH) {
        console.warn('loadConfig called before CONFIG_PATH initialized');
        return;
    }
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const savedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            config = { ...config, ...savedConfig };
            console.log('Config loaded from:', CONFIG_PATH);
        } catch (error) {
            console.error("Failed to load config.json, using defaults.", error);
        }
    } else {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log('Default config created at:', CONFIG_PATH);
    }
}

// Set FFMPEG binary path - handle both dev and packaged app
let ffmpegPath = ffmpegStatic;

// In packaged app, ffmpeg is in extraResources
if (app.isPackaged) {
    // On Windows, the extraResources are in resources folder next to the exe
    ffmpegPath = path.join(process.resourcesPath, 'ffmpeg-static', 'ffmpeg.exe');
}

console.log('FFmpeg path:', ffmpegPath);
ffmpeg.setFfmpegPath(ffmpegPath);

// OpenAI client initialization
// Note: config.openaiApiKey will be loaded later in app.whenReady()
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
let openai = null;

function initializeOpenAI(apiKey, source = 'unknown') {
    if (!apiKey) {
        console.warn(`[OpenAI] initializeOpenAI called with empty key (source: ${source})`);
        return false;
    }

    console.log(`[OpenAI] Initializing with API key from ${source} (key length: ${apiKey.length})`);
    OPENAI_API_KEY = apiKey;
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Also set API key for the openaiService (used for transcription)
    const serviceResult = openaiService.setApiKey(apiKey);

    console.log(`[OpenAI] Client initialized successfully`);
    console.log(`[OpenAI] openaiService configured: ${openaiService.isConfigured()}`);
    return true;
}

// Try to initialize with env var (config will be loaded later in app.whenReady)
if (OPENAI_API_KEY) {
    console.log('[OpenAI] Found API key in environment variable');
    initializeOpenAI(OPENAI_API_KEY, 'environment');
} else {
    console.warn('[OpenAI] No API key in environment. Will try config file or Settings UI.');
}

const debugEnable = 0;

// --- Profile Management ---
let PROFILE_DIR; // Will be initialized when app is ready
let PROFILE_PATH;

let profileData = {
    jobTitle: 'No job title provided.',
    jobDescription: 'No job description provided.',
    candidateInfo: 'No candidate information provided.',
    projects: 'No projects listed.',
    // Meeting-type-specific fields (optional)
    meetingAgenda: '',
    teamContext: '',
    clientContext: '',
    courseNotes: '',
    contextNotes: '',
    previousNotes: '',
};

let currentMeetingType = 'interview';

function loadProfile() {
    try {
        // **THE FIX**: Ensure the directory exists before reading/writing files.
        if (!fs.existsSync(PROFILE_DIR)) {
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
        }

        if (fs.existsSync(PROFILE_PATH)) {
            profileData = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
            console.log("Profile loaded successfully.");
        } else {
            // Create a default profile if it doesn't exist
            fs.writeFileSync(PROFILE_PATH, JSON.stringify(profileData, null, 2));
            console.log("Default profile created.");
        }
    } catch (error) {
        console.error("Error loading or creating profile.json:", error);
    }
}

// --- Knowledge Base Management ---
let KB_DIR; // Will be initialized when app is ready
let KB_PATH;

let knowledgeBaseState = {
    documents: [],
    settings: {
        maxTotalTokens: 4000,
        useSummariesForLarge: true,
        summaryThreshold: 2000
    }
};

function loadKnowledgeBase() {
    try {
        if (!fs.existsSync(KB_DIR)) {
            fs.mkdirSync(KB_DIR, { recursive: true });
        }

        if (fs.existsSync(KB_PATH)) {
            knowledgeBaseState = JSON.parse(fs.readFileSync(KB_PATH, 'utf-8'));
            console.log("Knowledge base loaded successfully.");
        } else {
            fs.writeFileSync(KB_PATH, JSON.stringify(knowledgeBaseState, null, 2));
            console.log("Default knowledge base created.");
        }
    } catch (error) {
        console.error("Error loading or creating knowledge base:", error);
    }
}

function saveKnowledgeBase() {
    try {
        fs.writeFileSync(KB_PATH, JSON.stringify(knowledgeBaseState, null, 2));
    } catch (error) {
        console.error("Failed to save knowledge base:", error);
    }
}

function calculateActiveKBTokens() {
    return knowledgeBaseState.documents
        .filter(d => d.isActive)
        .reduce((sum, d) => sum + d.tokenCount, 0);
}

function getKnowledgeBaseContext(maxTokensOverride) {
    const activeDocuments = knowledgeBaseState.documents.filter(d => d.isActive);
    if (activeDocuments.length === 0) return '';

    const contextParts = [];
    let remainingTokens = typeof maxTokensOverride === 'number'
        ? Math.min(maxTokensOverride, knowledgeBaseState.settings.maxTotalTokens)
        : knowledgeBaseState.settings.maxTotalTokens;

    for (const doc of activeDocuments) {
        if (remainingTokens <= 0) break;

        const filePath = doc.hasSummary && doc.summaryPath
            ? path.join(KB_DIR, doc.summaryPath)
            : path.join(KB_DIR, doc.storagePath);

        try {
            let content = fs.readFileSync(filePath, 'utf-8');

            // If content would exceed budget, truncate
            if (doc.tokenCount > remainingTokens) {
                content = content.substring(0, remainingTokens * 4) + '...';
            }

            contextParts.push(`[${doc.displayName}]:\n${content}`);
            remainingTokens -= doc.tokenCount;
        } catch (err) {
            console.error(`Failed to read KB document ${doc.id}:`, err);
        }
    }

    return contextParts.join('\n\n---\n\n');
}

// --- Token Management ---
let conversationHistory = [];
let ragState = {
    requirements: [],
    outline: [],
    tests: [],
    insights: [],
};
const maxTokens = 5000;

const pruneConversationHistory = () => {
    const { messages, tokenCount } = trimMessagesToTokenLimit(conversationHistory, maxTokens);
    conversationHistory = messages;
    if (mainWindow) {
        mainWindow.webContents.send('token-status', {
            used: tokenCount,
            max: maxTokens,
        });
    }
};

// --- Prompt Generation ---
const generateFinalPrompt = (lastQuestion) => {
    const kbBudget = currentMeetingType === 'interview' ? 1500 : undefined;
    const kbContext = getKnowledgeBaseContext(kbBudget);
    return buildPrompt(profileData, currentMeetingType, kbContext, lastQuestion);
};

const formatRagStateForPrompt = (state) => {
    const sections = [
        { title: 'Requirements', items: state.requirements },
        { title: 'Solution Outline', items: state.outline },
        { title: 'Test Ideas', items: state.tests },
        { title: 'Key Insights', items: state.insights },
    ];

    return sections
        .filter(section => Array.isArray(section.items) && section.items.length > 0)
        .map(section => {
            const bullets = section.items.map(item => `- ${item}`).join('\n');
            return `${section.title}:\n${bullets}`;
        })
        .join('\n\n');
};

// --- Main Application Setup ---
let mainWindow;
let licenseWindow;
let ffmpegSpawn;
const { registerHotkeys, unregisterAll } = require('./main/hotkeys');

// License activation window
function createLicenseWindow() {
    licenseWindow = new BrowserWindow({
        width: 500,
        height: 520,
        resizable: false,
        maximizable: false,
        minimizable: true,
        frame: true,
        center: true,
        title: 'License Activation',
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    licenseWindow.setMenu(null);
    licenseWindow.loadFile('license.html');

    licenseWindow.on('closed', () => {
        licenseWindow = null;
        // If license window is closed without activation, quit the app
        if (!licenseService.isActivated) {
            app.quit();
        }
    });
}

function createWindow() {
    const displays = screen.getAllDisplays();
    const externalDisplay = displays.length > 1 ? displays[1] : screen.getPrimaryDisplay();
    const { x, y, width: monitorWidth, height: monitorHeight } = externalDisplay.workArea;

    const windowWidth = Math.floor(monitorWidth / 2);
    const windowHeight = monitorHeight;

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: x,
        y: y,
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    // Register global hotkeys
    registerHotkeys(mainWindow);

    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    // Initialize paths after app is ready
    const userData = app.getPath('userData');

    // Initialize license service FIRST
    licenseService.initialize(userData);

    // Check for existing valid license
    const licenseCheck = licenseService.checkExistingLicense();
    console.log('License check result:', licenseCheck);

    if (!licenseCheck.valid) {
        // Show license activation window instead of main window
        console.log('No valid license found, showing activation window');
        createLicenseWindow();
        return; // Don't proceed with normal app initialization
    }

    // License is valid, proceed with normal initialization
    console.log('Valid license found, starting application');

    // Initialize config path and load config FIRST (needed for OpenAI key)
    CONFIG_PATH = path.join(userData, 'config.json');
    loadConfig();

    // Initialize OpenAI with config API key (if set and not already initialized from env)
    if (config.openaiApiKey) {
        console.log('[OpenAI] Found API key in config file');
        initializeOpenAI(config.openaiApiKey, 'config-file');
    } else if (!OPENAI_API_KEY) {
        console.warn('[OpenAI] No API key found in config. Please configure in Settings.');
    }

    LOG_DIR = path.join(userData, 'interview_logs');
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    PROFILE_DIR = userData;
    PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');

    // Initialize Knowledge Base paths
    KB_DIR = path.join(userData, 'knowledge_base');
    KB_PATH = path.join(userData, 'knowledgebase.json');

    loadProfile();
    loadKnowledgeBase();
    createWindow();
    createNewSession(); // Start session automatically

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('will-quit', () => {
    // Unregister the shortcut when the app is about to quit
    try { unregisterAll(); } catch {}
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
    // End session before quitting
    await endCurrentSession();

    if (ffmpegSpawn && !ffmpegSpawn.killed) {
        try {
            ffmpegSpawn.kill('SIGTERM');
            console.log('FFmpeg process terminated');
        } catch (err) {
            console.error('Failed to kill FFmpeg process:', err);
        }
    }
});

// --- IPC Handlers ---

// --- License Management IPC Handlers ---
ipcMain.handle('check-license', () => {
    return licenseService.checkExistingLicense();
});

ipcMain.handle('activate-license', async (event, key) => {
    const result = await licenseService.activateLicense(key);
    if (result.success) {
        // Close license window and restart app to load main window
        if (licenseWindow) {
            licenseWindow.close();
        }
        app.relaunch();
        app.exit(0);
    }
    return result;
});

ipcMain.handle('deactivate-license', () => {
    licenseService.deactivateLicense();
    app.relaunch();
    app.exit(0);
});

ipcMain.handle('get-license-status', () => {
    return licenseService.getStatus();
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

// Add this new IPC handler for the window lock
ipcMain.on('toggle-always-on-top', () => {
    const isAlwaysOnTop = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(isAlwaysOnTop);
    mainWindow.webContents.send('always-on-top-status', isAlwaysOnTop);
});

// Profile Management
ipcMain.handle('load-profile', () => {
    return profileData;
});

ipcMain.handle('save-profile', (event, newProfileData) => {
    try {
        fs.writeFileSync(PROFILE_PATH, JSON.stringify(newProfileData, null, 2));
        profileData = newProfileData; // Update in-memory profile
        return { success: true };
    } catch (error) {
        console.error("Failed to save profile:", error);
        return { success: false, error: error.message };
    }
});

// Config Management
ipcMain.handle('load-config', () => {
    return config;
});

ipcMain.handle('save-config', (event, newConfig) => {
    try {
        console.log('[Config] Saving config to:', CONFIG_PATH);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        config = { ...config, ...newConfig }; // Update in-memory config

        // Re-initialize OpenAI if API key changed
        if (newConfig.openaiApiKey) {
            console.log('[Config] API key found in new config, initializing OpenAI...');
            initializeOpenAI(newConfig.openaiApiKey, 'settings-ui');
        } else {
            console.log('[Config] No API key in new config');
        }

        return { success: true };
    } catch (error) {
        console.error("[Config] Failed to save config:", error);
        return { success: false, error: error.message };
    }
});

// Check if OpenAI is configured
ipcMain.handle('check-openai-configured', () => {
    return {
        configured: !!openai,
        hasKey: !!OPENAI_API_KEY
    };
});

// --- Meeting Type Management ---
ipcMain.handle('get-meeting-types', () => {
    return {
        current: currentMeetingType,
        types: getMeetingTypeList()
    };
});

ipcMain.handle('set-meeting-type', (event, type) => {
    const types = getMeetingTypeList();
    const valid = types.find(t => t.key === type);
    if (valid) {
        currentMeetingType = type;
        console.log(`[MeetingType] Switched to: ${valid.label}`);
        logSessionEvent('meeting_type_changed', { meetingType: type, label: valid.label });
        return { success: true, type, label: valid.label };
    }
    return { success: false, error: `Unknown meeting type: ${type}` };
});

// --- Knowledge Base Management ---
ipcMain.handle('kb-add-document', async () => {
    try {
        // Show file dialog
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Documents', extensions: ['pdf', 'docx', 'md', 'txt'] }
            ],
            title: 'Add Document to Knowledge Base'
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        const sourcePath = result.filePaths[0];
        const originalName = path.basename(sourcePath);
        const ext = documentProcessor.getFileType(originalName);

        // Validate file type
        if (!documentProcessor.isSupported(ext)) {
            return { success: false, error: 'Unsupported file type' };
        }

        // Process document - extract text
        console.log(`Processing document: ${originalName}`);
        const { text, tokenCount } = await documentProcessor.extractText(sourcePath, ext);
        const stats = await fsPromises.stat(sourcePath);

        // Determine if summary needed
        const needsSummary = knowledgeBaseState.settings.useSummariesForLarge &&
            tokenCount > knowledgeBaseState.settings.summaryThreshold;

        let summaryData = null;
        if (needsSummary) {
            console.log(`Document exceeds ${knowledgeBaseState.settings.summaryThreshold} tokens, generating summary...`);
            summaryData = await documentProcessor.generateSummary(text, originalName, openai);
            console.log(`Summary generated: ${summaryData.tokenCount} tokens`);
        }

        // Generate document ID
        const docId = uuidv4();

        // Save extracted text
        const textPath = `kb_${docId}.txt`;
        await fsPromises.writeFile(path.join(KB_DIR, textPath), text, 'utf-8');

        // Save summary if generated
        let summaryPath = null;
        if (summaryData) {
            summaryPath = `kb_${docId}_summary.txt`;
            await fsPromises.writeFile(path.join(KB_DIR, summaryPath), summaryData.summary, 'utf-8');
        }

        // Create metadata entry
        const docMeta = {
            id: docId,
            filename: originalName,
            displayName: path.parse(originalName).name,
            type: ext,
            addedAt: new Date().toISOString(),
            fileSize: stats.size,
            tokenCount: needsSummary ? summaryData.tokenCount : tokenCount,
            summaryTokenCount: summaryData?.tokenCount || 0,
            isActive: true,
            storagePath: textPath,
            summaryPath: summaryPath,
            hasSummary: needsSummary,
            originalTokenCount: tokenCount
        };

        knowledgeBaseState.documents.push(docMeta);
        saveKnowledgeBase();

        console.log(`Document added to knowledge base: ${originalName} (${docMeta.tokenCount} tokens)`);
        return { success: true, document: docMeta };
    } catch (error) {
        console.error('Failed to add document:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('kb-remove-document', async (event, docId) => {
    try {
        const docIndex = knowledgeBaseState.documents.findIndex(d => d.id === docId);
        if (docIndex === -1) {
            return { success: false, error: 'Document not found' };
        }

        const doc = knowledgeBaseState.documents[docIndex];

        // Delete stored files
        const textPath = path.join(KB_DIR, doc.storagePath);
        await fsPromises.unlink(textPath).catch(() => { });

        if (doc.summaryPath) {
            const summaryPath = path.join(KB_DIR, doc.summaryPath);
            await fsPromises.unlink(summaryPath).catch(() => { });
        }

        // Remove from state
        knowledgeBaseState.documents.splice(docIndex, 1);
        saveKnowledgeBase();

        console.log(`Document removed from knowledge base: ${doc.filename}`);
        return { success: true };
    } catch (error) {
        console.error('Failed to remove document:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('kb-toggle-document', async (event, docId) => {
    try {
        const doc = knowledgeBaseState.documents.find(d => d.id === docId);
        if (!doc) {
            return { success: false, error: 'Document not found' };
        }

        doc.isActive = !doc.isActive;
        saveKnowledgeBase();

        return { success: true, isActive: doc.isActive };
    } catch (error) {
        console.error('Failed to toggle document:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('kb-list-documents', async () => {
    return {
        success: true,
        documents: knowledgeBaseState.documents,
        settings: knowledgeBaseState.settings,
        totalActiveTokens: calculateActiveKBTokens()
    };
});

ipcMain.handle('kb-get-document-preview', async (event, docId) => {
    try {
        const doc = knowledgeBaseState.documents.find(d => d.id === docId);
        if (!doc) {
            return { success: false, error: 'Document not found' };
        }

        // Read the appropriate file (summary if available, else full text)
        const filePath = doc.hasSummary && doc.summaryPath
            ? path.join(KB_DIR, doc.summaryPath)
            : path.join(KB_DIR, doc.storagePath);

        const content = await fsPromises.readFile(filePath, 'utf-8');

        return {
            success: true,
            content: content.substring(0, 10000), // Limit preview
            isSummary: doc.hasSummary,
            fullTokenCount: doc.originalTokenCount,
            currentTokenCount: doc.tokenCount
        };
    } catch (error) {
        console.error('Failed to get document preview:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('kb-update-settings', async (event, newSettings) => {
    try {
        knowledgeBaseState.settings = { ...knowledgeBaseState.settings, ...newSettings };
        saveKnowledgeBase();
        return { success: true, settings: knowledgeBaseState.settings };
    } catch (error) {
        console.error('Failed to update KB settings:', error);
        return { success: false, error: error.message };
    }
});

// Audio Device Enumeration
ipcMain.handle('get-audio-devices', async () => {
    return new Promise((resolve) => {
        const devices = [];
        const ffmpegList = spawn(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);

        let stderrData = '';
        ffmpegList.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpegList.on('close', () => {
            // Parse FFmpeg output for audio devices
            const lines = stderrData.split('\n');
            let isAudioSection = false;

            for (const line of lines) {
                if (line.includes('DirectShow audio devices')) {
                    isAudioSection = true;
                    continue;
                }
                if (line.includes('DirectShow video devices')) {
                    isAudioSection = false;
                    break;
                }
                if (isAudioSection && line.includes('"')) {
                    const match = line.match(/"([^"]+)"/);
                    if (match && match[1]) {
                        devices.push(match[1]);
                    }
                }
            }

            resolve(devices);
        });

        ffmpegList.on('error', (err) => {
            console.error('Failed to list audio devices:', err);
            resolve([config.audioDevice]); // Fallback to current device
        });
    });
});

// Browse for export directory
ipcMain.handle('browse-export-directory', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select Export Directory',
            defaultPath: config.customExportPath || LOG_DIR
        });

        if (!result.canceled && result.filePaths.length > 0) {
            return { success: true, path: result.filePaths[0] };
        }
        return { success: false, canceled: true };
    } catch (error) {
        console.error('Failed to browse directory:', error);
        return { success: false, error: error.message };
    }
});

// Get default export path
ipcMain.handle('get-default-export-path', () => {
    return LOG_DIR;
});


// Audio Monitoring
ipcMain.handle('start-monitoring', async () => {
    try {
        logSessionEvent('monitoring_started');
        console.log('=== START MONITORING ===');
        console.log(`Audio device: ${config.audioDevice}`);
        console.log(`OpenAI configured: ${!!openai}`);
        console.log(`OpenAI API key set: ${!!OPENAI_API_KEY}`);
        console.log(`openaiService API key set: ${!!openaiService.getApiKey()}`);

        // Check if OpenAI is configured
        if (!openaiService.getApiKey()) {
            console.error('ERROR: No API key configured for transcription!');
            mainWindow.webContents.send('transcription-result', 'ERROR: OpenAI API key not configured. Please set it in Settings → Advanced.');
            return { success: false, error: 'OpenAI API key not configured' };
        }

        let isRecording = false;
        let silenceStart = null;
        let activelyTranscribing = "";
        const silenceThreshold = 2500; // ms of silence before finalizing (raised from 1500 to tolerate natural pauses)
        const amplitudeThreshold = 0.01;
        const audioChunks = [];
        const CHUNK_PROCESSING_SIZE = 4;
        const MIN_UTTERANCE_CHARS = 4;
        // Pure-filler utterances that Whisper produces from silence/breathing/sign-off
        // sounds. Skipping them avoids pointless GPT calls and stops them from
        // polluting conversation history with assistant turns like "[Listening...]".
        const FILLER_TOKENS = new Set([
            'mm', 'mmm', 'mhm', 'hmm', 'mmhmm', 'mmhm', 'mhmm',
            'uhhuh', 'uhuh', 'uh', 'um', 'er', 'erm', 'ah', 'oh',
            'bye', 'byebye', 'buhbye', 'peace', 'thanks', 'thankyou', 'boom',
            'you', 'the', 'a', 'i',
        ]);
        const isPureFiller = (text) => {
            const tokens = text.toLowerCase()
                .replace(/[^a-z\s]/g, ' ')   // drop punctuation
                .split(/\s+/)
                .filter(Boolean);
            if (tokens.length === 0) return true;
            return tokens.every(t => FILLER_TOKENS.has(t));
        };
        let chunkCount = 0;
        let pendingTailTranscriptions = 0; // tracks in-flight tail transcriptions so we finalize after they settle

        console.log(`Spawning FFmpeg from: ${ffmpegPath}`);
        ffmpegSpawn = spawn(ffmpegPath, [
            '-f', 'dshow',
            '-i', `audio=${config.audioDevice}`,
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '16000',
            '-f', 's16le',
            '-'
        ]);

        let lastLevelEmit = 0;
        ffmpegSpawn.stdout.on('data', (chunk) => {
            chunkCount++;
            const rms = calculateRMS(chunk);

            // Throttled audio level push to renderer (max ~15fps) so the VU meter stays smooth without flooding IPC.
            const now = Date.now();
            if (now - lastLevelEmit >= 66 && mainWindow && !mainWindow.isDestroyed()) {
                lastLevelEmit = now;
                // Normalize: RMS of speech typically 0.02–0.25; scale so normal voice lands ~0.5–0.9.
                const normalized = Math.min(1, rms * 6);
                mainWindow.webContents.send('audio-level', normalized);
            }

            // Log every 100th chunk to show audio is being received
            if (chunkCount % 100 === 0) {
                console.log(`[Audio] Chunk #${chunkCount}, RMS: ${rms.toFixed(4)}, Recording: ${isRecording}, Queued: ${audioChunks.length}`);
            }

            if (rms < amplitudeThreshold) {
                if (isRecording && !silenceStart) {
                    silenceStart = Date.now();
                } else if (silenceStart && (Date.now() - silenceStart) > silenceThreshold) {
                    isRecording = false;
                    silenceStart = null;

                    // Flush any tail chunks still in the buffer so they belong to THIS utterance,
                    // not the next one. This was the root cause of fragments appearing out of order.
                    const flushTail = () => {
                        if (audioChunks.length > 0) {
                            const buffer = Buffer.concat(audioChunks);
                            audioChunks.length = 0;
                            pendingTailTranscriptions++;
                            console.log(`[Audio] Flushing tail buffer (${buffer.length} bytes) before finalize`);
                            return transcribeChunk(buffer)
                                .then(tail => {
                                    if (tail) activelyTranscribing += ` ${tail}`;
                                })
                                .catch(err => console.error('[Transcription] Tail flush error:', err))
                                .finally(() => { pendingTailTranscriptions--; });
                        }
                        return Promise.resolve();
                    };

                    const doFinalize = () => {
                        const finalText = activelyTranscribing.trim();
                        if (finalText.length >= MIN_UTTERANCE_CHARS) {
                            if (isPureFiller(finalText)) {
                                console.log('[Audio] Skipping pure-filler utterance:', finalText);
                            } else {
                                console.log('[Audio] Processing final transcription:', finalText.substring(0, 60) + '...');
                                processFinalTranscription(finalText);
                            }
                        } else if (finalText.length > 0) {
                            console.log('[Audio] Skipping too-short utterance:', finalText);
                        }
                        activelyTranscribing = "";
                    };

                    // Wait for tail flush + any already-in-flight mid-utterance transcriptions to resolve
                    // before finalizing, so nothing leaks into the next utterance.
                    // Hard cap the wait so a single stuck chunk can't hold the GPT answer hostage —
                    // the question matters more than one missing fragment.
                    const FINALIZE_WAIT_BUDGET_MS = 6000;
                    flushTail().then(() => {
                        const startedWaiting = Date.now();
                        const waitForInFlight = () => {
                            if (pendingTailTranscriptions === 0) return Promise.resolve();
                            if (Date.now() - startedWaiting > FINALIZE_WAIT_BUDGET_MS) {
                                console.warn(`[Audio] Finalize wait budget exceeded (${pendingTailTranscriptions} chunks still in-flight) — proceeding without them`);
                                return Promise.resolve();
                            }
                            return new Promise(r => setTimeout(r, 50)).then(waitForInFlight);
                        };
                        return waitForInFlight();
                    }).then(doFinalize);
                }
            } else {
                isRecording = true;
                silenceStart = null;
                audioChunks.push(chunk);

                if (audioChunks.length >= CHUNK_PROCESSING_SIZE) {
                    const buffer = Buffer.concat(audioChunks);
                    audioChunks.length = 0;

                    pendingTailTranscriptions++;
                    console.log(`[Audio] Sending ${buffer.length} bytes for transcription...`);
                    transcribeChunk(buffer).then(transcription => {
                        console.log(`[Transcription] Result: "${transcription}"`);
                        if (transcription) {
                            activelyTranscribing += ` ${transcription}`;
                            mainWindow.webContents.send('transcription-update', `Transcribing...: ${activelyTranscribing.trim()}`);
                        }
                    }).catch(err => {
                        console.error('[Transcription] Error:', err);
                    }).finally(() => { pendingTailTranscriptions--; });
                }
            }
        });

        ffmpegSpawn.stderr.on('data', (chunk) => {
            const msg = chunk.toString();
            // Log FFmpeg errors/warnings
            if (msg.includes('error') || msg.includes('Error') || msg.includes('Cannot')) {
                console.error('[FFmpeg Error]', msg);
                // Surface device-open failures to the UI so the user knows
                if (msg.includes('Could not') || msg.includes('Cannot')) {
                    mainWindow.webContents.send('transcription-result',
                        `⚠️ Audio device error: ${msg.trim()}\nCheck Settings → Audio Device and ensure "${config.audioDevice}" is available.`);
                }
            }
        });
        ffmpegSpawn.on('close', (code) => {
            console.log(`[FFmpeg] Process exited with code ${code}`);
            if (code !== 0 && code !== null) {
                mainWindow.webContents.send('transcription-result',
                    `⚠️ Audio capture stopped unexpectedly (exit code ${code}). Check that your audio device "${config.audioDevice}" is connected and available.`);
            }
        });
        ffmpegSpawn.on('error', (err) => {
            console.error('[FFmpeg] Spawn error:', err);
            mainWindow.webContents.send('transcription-result',
                `⚠️ Failed to start audio capture: ${err.message}`);
        });

    } catch (error) {
        console.error('Error during audio monitoring:', error);
    }
});

ipcMain.handle('stop-monitoring', async () => {
    if (ffmpegSpawn && !ffmpegSpawn.killed) {
        try {
            logSessionEvent('monitoring_stopped');
            ffmpegSpawn.kill('SIGTERM');
            ffmpegSpawn = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('audio-level', 0);
            }
            console.log('Monitoring stopped.');
            return { success: true };
        } catch (err) {
            console.error('Failed to stop monitoring:', err);
            return { success: false, error: err.message };
        }
    }
    return { success: true };
});

// Conversation History Management
ipcMain.handle('clear-conversation', async () => {
    conversationHistory = [];
    ragState = {
        requirements: [],
        outline: [],
        tests: [],
        insights: [],
    };
    logSessionEvent('conversation_cleared');
    mainWindow.webContents.send('conversation-cleared', { rag: ragState });
    return { success: true, rag: ragState };
});

ipcMain.handle('export-conversation', async (event, customPath = null) => {
    try {
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const useCustomPath = customPath && config.customExportPath && !config.useDefaultExportPath;
        const exportDir = useCustomPath ? config.customExportPath : LOG_DIR;

        // Ensure export directory exists
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const exportFormat = config.exportFormat || 'json';
        const exportPath = path.join(exportDir, `conversation_export_${timestamp}.${exportFormat}`);

        const exportData = {
            timestamp: new Date().toISOString(),
            conversationHistory,
            profileData,
            tokenCount: calculateTokenCount(conversationHistory),
            ragState,
            sessionInfo: currentSession ? {
                sessionId: currentSession.sessionId,
                startTime: currentSession.startTime,
                statistics: currentSession.statistics
            } : null
        };

        if (exportFormat === 'json') {
            await fsPromises.writeFile(exportPath, JSON.stringify(exportData, null, 2));
        } else if (exportFormat === 'txt') {
            // Create human-readable text format
            let textContent = `CONVERSATION EXPORT\n`;
            textContent += `Export Time: ${new Date().toLocaleString()}\n`;
            textContent += `Token Count: ${exportData.tokenCount}\n`;
            textContent += `\n${'='.repeat(80)}\n\n`;

            conversationHistory.forEach((msg, idx) => {
                const roleLabel = msg.role === 'user' ? 'USER' : 'ASSISTANT';
                textContent += `[Message ${idx + 1}] ${roleLabel}\n`;
                textContent += `${msg.content}\n`;
                textContent += `\n${'-'.repeat(80)}\n\n`;
            });

            await fsPromises.writeFile(exportPath, textContent);
        }

        return { success: true, path: exportPath };
    } catch (error) {
        console.error('Failed to export conversation:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-conversation-stats', () => {
    return {
        messageCount: conversationHistory.length,
        tokenCount: calculateTokenCount(conversationHistory),
        maxTokens
    };
});

// Session Management
ipcMain.handle('get-session-info', () => {
    if (!currentSession) return null;
    return {
        sessionId: currentSession.sessionId,
        startTime: currentSession.startTime,
        mode: currentSession.mode,
        statistics: currentSession.statistics,
        textLogPath: currentSession.textLogPath,
        jsonLogPath: currentSession.jsonLogPath
    };
});

ipcMain.handle('end-session', async () => {
    try {
        await endCurrentSession();
        return { success: true };
    } catch (error) {
        console.error('Failed to end session:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-new-session', async () => {
    try {
        if (currentSession) {
            await endCurrentSession();
        }
        createNewSession();
        return { success: true, session: await ipcMain.handleOnce('get-session-info', () => {}) };
    } catch (error) {
        console.error('Failed to start new session:', error);
        return { success: false, error: error.message };
    }
});

// Log Management
ipcMain.handle('cleanup-old-logs', async () => {
    try {
        const files = await fsPromises.readdir(LOG_DIR);
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(LOG_DIR, file);
            const stats = await fsPromises.stat(filePath);
            if (now - stats.mtimeMs > maxAge) {
                await fsPromises.unlink(filePath);
                deletedCount++;
            }
        }

        console.log(`Cleaned up ${deletedCount} old log files`);
        return { success: true, deletedCount };
    } catch (error) {
        console.error('Failed to cleanup old logs:', error);
        return { success: false, error: error.message };
    }
});

// --- Capture Helpers ---
ipcMain.handle('list-capture-sources', async () => {
    const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: true,
        thumbnailSize: { width: 360, height: 220 },
    });

    return sources.map(source => ({
        id: source.id,
        name: source.name,
        type: source.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('capture-source', async (event, sourceId) => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 1920, height: 1080 },
        });
        const source = sources.find(s => s.id === sourceId);

        if (!source) {
            throw new Error('Screen source not found');
        }

        const screenshotPath = path.join(app.getPath('userData'), `capture-${uuidv4()}.png`);
        await fsPromises.writeFile(screenshotPath, source.thumbnail.toPNG());

        logSessionEvent('screenshot_capture');
        logConversationMessage('user', '[Screenshot Captured]', { type: 'screenshot' });
        mainWindow.webContents.send('transcription-result', 'User: [Screenshot Captured]');
        const analysis = await getAIResponseForImage(screenshotPath, source.name);

        return { success: true, ...analysis };
    } catch (error) {
        console.error('Failed to capture screen:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('reset-rag-state', () => {
    ragState = {
        requirements: [],
        outline: [],
        tests: [],
        insights: [],
    };
    return { success: true, rag: ragState };
});

ipcMain.handle('get-rag-state', () => ({
    success: true,
    rag: ragState,
}));

ipcMain.handle('generate-rag-solution', async (_event, partialState = {}) => {
    ragState = mergeRagState(ragState, partialState);

    const hasContent = [
        ragState.requirements.length,
        ragState.outline.length,
        ragState.tests.length,
        ragState.insights.length,
    ].some(count => count > 0);

    if (!hasContent) {
        return { success: false, error: 'Capture or add at least one requirement before generating a solution.' };
    }

    const ragPrompt = formatRagStateForPrompt(ragState);
    const synthesisPrompt = `Act as a senior React Native engineer preparing to code live. Using the captured buckets below, create a tight plan:

${ragPrompt}

Respond in polished Markdown with these sections:
1. Situation Snapshot (2 bullets max)
2. Implementation Plan (ordered list, actionable steps)
3. Code Blueprint (pseudo / snippets where useful)
4. Test Strategy (bullet list)
5. Talking Points (short reminders for interview discussion)
Keep it under 350 words.`;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0.4,
            max_tokens: 900,
            messages: [
                { role: 'system', content: 'You are an elite live coding copilot.' },
                { role: 'user', content: synthesisPrompt },
            ],
        });

        const solution = completion.choices[0].message.content.trim();

        logConversationMessage('user', synthesisPrompt, { type: 'rag_synthesis_request' });
        logConversationMessage('assistant', solution, { type: 'rag_solution' });
        pruneConversationHistory();

        return { success: true, content: solution };
    } catch (error) {
        console.error('RAG synthesis failed:', error);
        return { success: false, error: 'Failed to generate solution. Please try again.' };
    }
});

// --- Core Functions ---
function calculateRMS(buffer) {
    let sum = 0.0;
    for (let i = 0; i + 1 < buffer.length; i += 2) {
        const int16 = buffer.readInt16LE(i);
        const sample = int16 / 32768.0;
        sum += sample * sample;
    }
    return Math.sqrt(sum / (buffer.length / 2));
}

//"model": "gpt-5",
// New function to handle screenshot analysis with concise prompt
async function getAIResponseForImage(imagePath, sourceName = '') {
    try {
        const imageBuffer = await fsPromises.readFile(imagePath);
        const base64Image = imageBuffer.toString('base64');

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0.2,
            messages: [
                {
                    role: "system",
                    content: getVisionPrompt(currentMeetingType)
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Review this capture and populate the JSON buckets. Keep bullet text short (max 120 chars)."
                        },
                        {
                            type: "image_url",
                            image_url: { url: `data:image/png;base64,${base64Image}` }
                        }
                    ]
                }
            ],
            max_tokens: 800,
        });

        const rawContent = response.choices[0].message.content || '';
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        let parsed = {};
        if (jsonMatch) {
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch (jsonErr) {
                console.warn('Failed to parse AI image JSON, falling back to markdown:', jsonErr);
            }
        }

        const normalized = normalizeRagPayload(parsed);
        ragState = mergeRagState(ragState, normalized);

        const payload = {
            content: parsed.summary || rawContent.trim(),
            rag: normalized,
            sourceName,
        };

        mainWindow.webContents.send('ai-image-response', payload);
        logConversationMessage('assistant', payload.content, { type: 'image_analysis', rag: normalized, sourceName });

        return payload;
    } catch (err) {
        console.error('AI Image Response Error:', err);
        mainWindow.webContents.send('ai-image-response', {
            content: '### Error\nFailed to analyze the image.',
            isError: true
        });
        return { error: err.message };
    } finally {
        await fsPromises.unlink(imagePath).catch(err => console.error('Failed to delete screenshot:', err));
    }
}

// Hard ceiling for a single chunk's transcription. If exceeded, the audio
// is already stale relative to live conversation — drop it so the next
// chunk (and the GPT answer) can proceed.
const CHUNK_DEADLINE_MS = 10000;

async function transcribeChunk(audioData) {
    // Use system temp directory (writable) instead of __dirname (read-only in ASAR)
    const tempDir = app.getPath('temp');
    const tempFilePath = path.join(tempDir, `temp_chunk_${uuidv4()}.wav`);

    console.log(`[transcribeChunk] Audio data size: ${audioData.length} bytes`);
    console.log(`[transcribeChunk] API key available: ${!!openaiService.getApiKey()}`);
    console.log(`[transcribeChunk] Temp file: ${tempFilePath}`);

    const wavBuffer = addWavHeader(audioData);
    fs.writeFileSync(tempFilePath, wavBuffer);
    console.log(`[transcribeChunk] WAV file written: ${wavBuffer.length} bytes`);

    const deadline = new Promise((resolve) => {
        setTimeout(() => resolve({ __deadline: true }), CHUNK_DEADLINE_MS);
    });

    try {
        console.log('[transcribeChunk] Calling openaiService.transcribe...');
        const result = await Promise.race([
            openaiService.transcribe({
                fileStream: fs.createReadStream(tempFilePath),
                model: 'whisper-1',
                language: 'en',
            }),
            deadline,
        ]);
        if (result && result.__deadline) {
            console.warn(`[transcribeChunk] Deadline ${CHUNK_DEADLINE_MS}ms exceeded — dropping stale chunk`);
            return '';
        }
        console.log('[transcribeChunk] Response:', JSON.stringify(result));
        return result.text.trim();
    } catch (err) {
        console.error('[transcribeChunk] ERROR:', err.message);
        console.error('[transcribeChunk] Full error:', err.response?.data || err);
        return '';
    } finally {
        try {
            fs.unlinkSync(tempFilePath);
        } catch (e) {
            console.error('[transcribeChunk] Failed to delete temp file:', e.message);
        }
    }
}

function processFinalTranscription(transcription) {
    mainWindow.webContents.send('transcription-result', `User: ${transcription}`);
    // Tag the transcript with [Interviewer] in interview mode so the model knows
    // these turns come from the OTHER side of the table, not from the candidate.
    // This is a critical anti-identity-theft defense — without the tag, an
    // interviewer's self-introduction ("my name's Vaughn from Vector3") can
    // get echoed back as if it were the candidate's own background.
    const speakerTag = currentMeetingType === 'interview' ? '[Interviewer] ' : '';
    const taggedContent = `${speakerTag}${transcription}`;
    conversationHistory.push({ role: 'user', content: taggedContent });
    logConversationMessage('user', transcription, { type: 'audio_transcription' });
    pruneConversationHistory();
    getAIResponse(taggedContent);
}

// UPDATE this function to log the AI's final streamed response
async function getAIResponse(question) {
    const systemPrompt = generateFinalPrompt(question);
    const messages = [
        ...conversationHistory.slice(0, -1), // Include previous context
        { role: 'system', content: systemPrompt }
    ];

    try {
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
            temperature: 0.5,
            max_tokens: 1024,
            stream: true,
        });

        let fullResponse = "";
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            fullResponse += content;
            mainWindow.webContents.send('ai-response-chunk', { content });
        }
        conversationHistory.push({ role: 'assistant', content: fullResponse });
        logConversationMessage('assistant', fullResponse, { type: 'text_response' });

    } catch (err) {
        console.error('AI Response Error:', err);
        mainWindow.webContents.send('ai-response-chunk', {
            content: '### Error\nFailed to get AI response.',
            isError: true
        });
    }
}

function addWavHeader(audioBuffer) {
    const SAMPLE_RATE = 16000;
    const CHANNELS = 1;
    const BIT_DEPTH = 16;
    const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
    const blockAlign = CHANNELS * (BIT_DEPTH / 8);
    const wavHeader = Buffer.alloc(44);

    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + audioBuffer.length, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(CHANNELS, 22);
    wavHeader.writeUInt32LE(SAMPLE_RATE, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(BIT_DEPTH, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(audioBuffer.length, 40);

    return Buffer.concat([wavHeader, audioBuffer]);
}
