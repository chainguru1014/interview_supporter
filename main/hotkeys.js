/**
 * Centralized globalShortcut registration.
 * Exposes: registerHotkeys, unregisterAll
 */
const { globalShortcut } = require('electron');

function registerHotkeys(win) {
  const safeSend = (channel) => {
    try {
      win.webContents.send(channel);
    } catch (error) {
      console.error(`Hotkey dispatch failed for ${channel}:`, error);
    }
  };

  globalShortcut.register('Control+Alt+S', () => safeSend('rag-capture-screen'));
  globalShortcut.register('Control+Alt+W', () => safeSend('rag-capture-window'));
  globalShortcut.register('Control+Alt+L', () => safeSend('rag-generate-solution'));
  globalShortcut.register('Control+Alt+A', () => safeSend('toggle-assistance-panel'));
  // Backwards-compat hotkey
  globalShortcut.register('Alt+Shift+C', () => safeSend('shortcut-capture'));
}

function unregisterAll() {
  globalShortcut.unregisterAll();
}

module.exports = { registerHotkeys, unregisterAll };
