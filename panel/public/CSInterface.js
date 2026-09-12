// public/CSInterface.js
//
// Minimal CSInterface shim for Motion Toolbar. CEF in CEP exposes
// `window.__adobe_cep__` natively — this file just wraps the bits we use
// behind the conventional `window.CSInterface` / `window.SystemPath` API
// so the rest of the codebase can stay idiomatic.
//
// Adobe's full CSInterface.js is BSD-3-licensed; we vendor only the
// surface we actually call. If you need additional methods later, add them
// here as pass-throughs to __adobe_cep__.

(function (global) {
  'use strict';

  // SystemPath constants (string identifiers consumed by CEF's
  // __adobe_cep__.getSystemPath). These match Adobe's official enum values.
  global.SystemPath = {
    USER_DATA:        'userData',
    COMMON_FILES:     'commonFiles',
    MY_DOCUMENTS:     'myDocuments',
    APPLICATION:      'application',
    EXTENSION:        'extension',
    HOST_APPLICATION: 'hostApplication',
  };

  function CSInterface() {
    this.hostEnvironment = (typeof global.__adobe_cep__ !== 'undefined' && global.__adobe_cep__.getHostEnvironment)
      ? safeJson(global.__adobe_cep__.getHostEnvironment())
      : null;
  }

  CSInterface.prototype.getHostEnvironment = function () {
    return this.hostEnvironment;
  };

  CSInterface.prototype.getSystemPath = function (pathType) {
    if (typeof global.__adobe_cep__ === 'undefined') return '';
    return global.__adobe_cep__.getSystemPath(pathType);
  };

  CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof global.__adobe_cep__ === 'undefined') {
      if (typeof callback === 'function') callback('CEP Not Found. Simulated execution of: ' + script);
      return;
    }
    global.__adobe_cep__.evalScript(script, callback || function () {});
  };

  CSInterface.prototype.getApplicationID = function () {
    if (typeof global.__adobe_cep__ === 'undefined') return '';
    var env = safeJson(global.__adobe_cep__.getHostEnvironment());
    return env ? env.appId : '';
  };

  CSInterface.prototype.getExtensionID = function () {
    if (typeof global.__adobe_cep__ === 'undefined') return '';
    return global.__adobe_cep__.getExtensionId();
  };

  CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
    if (typeof global.__adobe_cep__ === 'undefined') return;
    global.__adobe_cep__.requestOpenExtension(extensionId, params || '');
  };

  CSInterface.prototype.closeExtension = function () {
    if (typeof global.__adobe_cep__ === 'undefined') return;
    global.__adobe_cep__.closeExtension();
  };

  function safeJson(s) {
    if (s == null) return null;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  global.CSInterface = CSInterface;
})(typeof window !== 'undefined' ? window : this);
