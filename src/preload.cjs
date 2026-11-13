// Minimal bridge: dropped files/folders → absolute paths (File.path no longer exists in Electron).
const { contextBridge, webUtils } = require('electron');
contextBridge.exposeInMainWorld('gr', { pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } } });
