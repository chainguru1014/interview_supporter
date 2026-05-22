const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Audio Monitoring
    startMonitoring: () => ipcRenderer.invoke('start-monitoring'),
    stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
    onTranscriptionResult: (callback) => ipcRenderer.on('transcription-result', callback),
    onTranscriptionUpdate: (callback) => ipcRenderer.on('transcription-update', callback),
    onAudioLevel: (callback) => ipcRenderer.on('audio-level', callback),

    // AI Responses
    onAIResponseChunk: (callback) => ipcRenderer.on('ai-response-chunk', callback),
    onAIImageResponse: (callback) => ipcRenderer.on('ai-image-response', callback),

    // Profile Management
    loadProfile: () => ipcRenderer.invoke('load-profile'),
    saveProfile: (data) => ipcRenderer.invoke('save-profile', data),

    // Config Management
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (data) => ipcRenderer.invoke('save-config', data),
    getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
    browseExportDirectory: () => ipcRenderer.invoke('browse-export-directory'),
    getDefaultExportPath: () => ipcRenderer.invoke('get-default-export-path'),

    // Knowledge Base Management
    kbAddDocument: () => ipcRenderer.invoke('kb-add-document'),
    kbRemoveDocument: (docId) => ipcRenderer.invoke('kb-remove-document', docId),
    kbToggleDocument: (docId) => ipcRenderer.invoke('kb-toggle-document', docId),
    kbListDocuments: () => ipcRenderer.invoke('kb-list-documents'),
    kbGetDocumentPreview: (docId) => ipcRenderer.invoke('kb-get-document-preview', docId),
    kbUpdateSettings: (settings) => ipcRenderer.invoke('kb-update-settings', settings),

    // Screen Capture
    listCaptureSources: () => ipcRenderer.invoke('list-capture-sources'),
    captureSource: (sourceId) => ipcRenderer.invoke('capture-source', sourceId),
    onShortcutCapture: (callback) => ipcRenderer.on('shortcut-capture', callback),
    onToggleAssistance: (callback) => ipcRenderer.on('toggle-assistance-panel', callback),
    onRagCaptureScreen: (callback) => ipcRenderer.on('rag-capture-screen', callback),
    onRagCaptureWindow: (callback) => ipcRenderer.on('rag-capture-window', callback),
    onRagGenerateSolution: (callback) => ipcRenderer.on('rag-generate-solution', callback),

    // Window Management
    toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
    onAlwaysOnTopStatus: (callback) => ipcRenderer.on('always-on-top-status', callback),

    // Conversation History Management
    clearConversation: () => ipcRenderer.invoke('clear-conversation'),
    exportConversation: () => ipcRenderer.invoke('export-conversation'),
    getConversationStats: () => ipcRenderer.invoke('get-conversation-stats'),
    onConversationCleared: (callback) => ipcRenderer.on('conversation-cleared', callback),

    // Log Management
    cleanupOldLogs: () => ipcRenderer.invoke('cleanup-old-logs'),

    // Session Management
    getSessionInfo: () => ipcRenderer.invoke('get-session-info'),
    endSession: () => ipcRenderer.invoke('end-session'),
    startNewSession: () => ipcRenderer.invoke('start-new-session'),

    // RAG Workflow
    resetRagState: () => ipcRenderer.invoke('reset-rag-state'),
    getRagState: () => ipcRenderer.invoke('get-rag-state'),
    generateRagSolution: (state) => ipcRenderer.invoke('generate-rag-solution', state),

    // License Management
    checkLicense: () => ipcRenderer.invoke('check-license'),
    activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
    deactivateLicense: () => ipcRenderer.invoke('deactivate-license'),
    getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Meeting Type
    getMeetingTypes: () => ipcRenderer.invoke('get-meeting-types'),
    setMeetingType: (type) => ipcRenderer.invoke('set-meeting-type', type),

    // OpenAI Configuration
    checkOpenAIConfigured: () => ipcRenderer.invoke('check-openai-configured'),
});
