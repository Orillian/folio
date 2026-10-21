/*
 * Folio artifact bridge (docs/spec-artifacts.md §3, "host bridge").
 * Served at /art/<token>/__folio/bridge.js and injected as the first element of
 * the entry page's <head>. Runs inside the sandboxed iframe (opaque origin: no
 * cookies, no real localStorage) and talks to the Folio page that hosts it over
 * postMessage (ArtifactBridgeRequest / ArtifactBridgeResponse in
 * shared/contracts.ts). Dependency-free ES2017.
 *
 *  - window.storage: the Claude artifacts API — get/set/delete/list, all async,
 *    values are strings, `shared` picks the state every reader sees.
 *  - localStorage / sessionStorage: synchronous in-memory polyfills. The local
 *    one is preloaded with the reader's state (keys `ls:<key>`) and writes every
 *    change back; the session one lives as long as the frame.
 *  - window.claude.complete: rejects — Folio runs artifacts without an AI backend.
 *
 * The server may prepend `window.__FOLIO_ARTIFACT_PRELOAD__ = {personal, shared}`
 * (a signed-in reader's state) so localStorage is filled before any page script runs.
 */
(function () {
  'use strict';
  if (window.__folioArtifactBridge) return;
  window.__folioArtifactBridge = true;

  var LS_PREFIX = 'ls:';
  var INIT_TIMEOUT_MS = 4000;
  var REQUEST_TIMEOUT_MS = 15000;
  var parentWin = window.parent && window.parent !== window ? window.parent : null;
  var nextId = 1;
  var pending = {};
  var state = { personal: {}, shared: {} };
  var preload = window.__FOLIO_ARTIFACT_PRELOAD__;
  if (preload && typeof preload === 'object') {
    state.personal = Object.assign({}, preload.personal || {});
    state.shared = Object.assign({}, preload.shared || {});
  }

  function send(msg) {
    return new Promise(function (resolve, reject) {
      if (!parentWin) {
        reject(new Error('no host'));
        return;
      }
      var id = nextId++;
      msg.folio = 'artifact';
      msg.id = id;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('Folio did not answer in time'));
      }, msg.op === 'init' ? INIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        parentWin.postMessage(msg, '*');
      } catch (err) {
        clearTimeout(timer);
        delete pending[id];
        reject(err);
      }
    });
  }

  window.addEventListener('message', function (event) {
    if (!parentWin || event.source !== parentWin) return;
    var data = event.data;
    if (!data || data.folio !== 'artifact' || typeof data.id !== 'number') return;
    var p = pending[data.id];
    if (!p) return;
    delete pending[data.id];
    clearTimeout(p.timer);
    if (data.ok) p.resolve(data);
    else p.reject(new Error(typeof data.error === 'string' ? data.error : 'storage error'));
  });

  // ---- local fallback (no host, or the host is gone): in-memory only ----
  function bucket(shared) {
    return shared ? state.shared : state.personal;
  }
  var hostAvailable = !!parentWin;

  var ready = (parentWin ? send({ op: 'init' }) : Promise.reject(new Error('no host')))
    .then(function (res) {
      if (res && res.state) {
        state.personal = Object.assign({}, res.state.personal || {});
        state.shared = Object.assign({}, res.state.shared || {});
      }
      fillLocalStorage(true);
    })
    .catch(function () {
      hostAvailable = false;
    });

  function asString(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('storage key must be a non-empty string');
    if (key.length > 200) throw new TypeError('storage key is longer than 200 characters');
  }

  var storage = {
    get: function (key, shared) {
      shared = !!shared;
      return ready.then(function () {
        checkKey(key);
        if (!hostAvailable) {
          var v = bucket(shared)[key];
          return v === undefined ? null : { key: key, value: v, shared: shared };
        }
        return send({ op: 'get', key: key, shared: shared }).then(function (res) {
          if (res.value === null || res.value === undefined) {
            delete bucket(shared)[key];
            return null;
          }
          bucket(shared)[key] = res.value;
          return { key: key, value: res.value, shared: shared };
        });
      });
    },
    set: function (key, value, shared) {
      shared = !!shared;
      var str = asString(value);
      return ready.then(function () {
        checkKey(key);
        if (!hostAvailable) {
          bucket(shared)[key] = str;
          return { key: key, value: str, shared: shared };
        }
        return send({ op: 'set', key: key, value: str, shared: shared }).then(function () {
          bucket(shared)[key] = str;
          return { key: key, value: str, shared: shared };
        });
      });
    },
    delete: function (key, shared) {
      shared = !!shared;
      return ready.then(function () {
        checkKey(key);
        if (!hostAvailable) {
          var had = Object.prototype.hasOwnProperty.call(bucket(shared), key);
          delete bucket(shared)[key];
          return { key: key, deleted: had, shared: shared };
        }
        return send({ op: 'delete', key: key, shared: shared }).then(function () {
          delete bucket(shared)[key];
          return { key: key, deleted: true, shared: shared };
        });
      });
    },
    list: function (prefix, shared) {
      shared = !!shared;
      prefix = typeof prefix === 'string' ? prefix : '';
      return ready.then(function () {
        if (!hostAvailable) {
          return { keys: Object.keys(bucket(shared)).filter(function (k) { return k.indexOf(prefix) === 0; }).sort(), prefix: prefix, shared: shared };
        }
        return send({ op: 'list', prefix: prefix, shared: shared }).then(function (res) {
          return { keys: Array.isArray(res.keys) ? res.keys : [], prefix: prefix, shared: shared };
        });
      });
    },
  };
  try {
    Object.defineProperty(window, 'storage', { value: storage, configurable: true, writable: true });
  } catch (err) {
    window.storage = storage;
  }

  // ---- Web Storage polyfills ----
  function makeStorage(persist) {
    var data = {};
    var api = {};
    function emit(key, oldValue, newValue) {
      try {
        window.dispatchEvent(new StorageEvent('storage', { key: key, oldValue: oldValue, newValue: newValue }));
      } catch (err) {
        /* old browsers: no event */
      }
    }
    Object.defineProperties(api, {
      length: { get: function () { return Object.keys(data).length; } },
      key: { value: function (i) { var keys = Object.keys(data); return i >= 0 && i < keys.length ? keys[i] : null; } },
      getItem: { value: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; } },
      setItem: {
        value: function (k, v) {
          k = String(k);
          v = String(v);
          data[k] = v;
          if (persist) {
            state.personal[LS_PREFIX + k] = v;
            if (hostAvailable) send({ op: 'set', key: LS_PREFIX + k, value: v, shared: false }).catch(function () {});
          }
        },
      },
      removeItem: {
        value: function (k) {
          k = String(k);
          if (!Object.prototype.hasOwnProperty.call(data, k)) return;
          delete data[k];
          if (persist) {
            delete state.personal[LS_PREFIX + k];
            if (hostAvailable) send({ op: 'delete', key: LS_PREFIX + k, shared: false }).catch(function () {});
          }
        },
      },
      clear: {
        value: function () {
          var keys = Object.keys(data);
          for (var i = 0; i < keys.length; i++) api.removeItem(keys[i]);
        },
      },
      __fill: {
        value: function (entries, notify) {
          for (var k in entries) {
            if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
            var old = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
            if (old === entries[k]) continue;
            data[k] = entries[k];
            if (notify) emit(k, old, entries[k]);
          }
        },
      },
    });
    return api;
  }

  var local = makeStorage(true);
  var session = makeStorage(false);

  function fillLocalStorage(notify) {
    var entries = {};
    for (var k in state.personal) {
      if (Object.prototype.hasOwnProperty.call(state.personal, k) && k.indexOf(LS_PREFIX) === 0) entries[k.slice(LS_PREFIX.length)] = state.personal[k];
    }
    local.__fill(entries, notify);
  }
  fillLocalStorage(false);

  function install(name, value) {
    try {
      Object.defineProperty(window, name, { value: value, configurable: true, writable: true });
    } catch (err) {
      /* the browser refused; the page keeps its own (throwing) storage */
    }
  }
  install('localStorage', local);
  install('sessionStorage', session);

  // ---- window.claude ----
  var claude = window.claude && typeof window.claude === 'object' ? window.claude : {};
  claude.complete = function () {
    return Promise.reject(new Error('Calls to Claude are not available in Folio: this artifact runs without an AI backend.'));
  };
  install('claude', claude);
})();
