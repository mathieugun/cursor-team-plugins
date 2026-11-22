'use strict';

// vscode.cursor.plugins has addPlugin/removePlugin (both take { path }) in Cursor 3.31; registerPath/unregisterPath are
// the names of Cursor's docs, kept as a fallback in case a future Cursor adds them.
function pluginApi(cursorApi) {
  const plugins = cursorApi && cursorApi.plugins;
  if (plugins && typeof plugins.addPlugin === 'function') {
    return {
      name: 'addPlugin',
      add: (p) => Promise.resolve().then(() => plugins.addPlugin({ path: p })),
      remove: (p) => Promise.resolve().then(() => plugins.removePlugin({ path: p })),
    };
  }
  if (plugins && typeof plugins.registerPath === 'function') {
    return {
      name: 'registerPath',
      add: (p) => Promise.resolve().then(() => plugins.registerPath(p)),
      remove: (p) => Promise.resolve().then(() => (plugins.unregisterPath ? plugins.unregisterPath(p) : undefined)),
    };
  }
  return null;
}

module.exports = { pluginApi };
