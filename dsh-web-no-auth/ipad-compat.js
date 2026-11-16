(function () {
  // ---- ES2019-2023 language builtins missing from iPadOS 16.0-16.3 WebKit ----
  if (!Object.hasOwn) Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  if (!Object.groupBy) Object.groupBy = function (items, fn) {
    var out = Object.create(null), i = 0, list = Array.from(items);
    for (; i < list.length; i += 1) {
      var key = typeof fn === 'function' ? fn(list[i], i) : list[i][fn];
      (out[key] || (out[key] = [])).push(list[i]);
    }
    return out;
  };
  if (!Map.groupBy) Map.groupBy = function (items, fn) {
    var out = new Map(), i = 0, list = Array.from(items);
    for (; i < list.length; i += 1) {
      var key = typeof fn === 'function' ? fn(list[i], i) : list[i][fn];
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(list[i]);
    }
    return out;
  };
  if (!Array.fromAsync) Array.fromAsync = function (items, fn) {
    return Promise.resolve().then(function () {
      var list = Array.from(items);
      return fn === undefined ? list : Promise.all(list.map(fn));
    });
  };
  if (!Array.prototype.findLast) Array.prototype.findLast = function (predicate, thisArg) {
    for (var i = this.length - 1; i >= 0; i -= 1) if (predicate.call(thisArg, this[i], i, this)) return this[i];
  };
  if (!Array.prototype.findLastIndex) Array.prototype.findLastIndex = function (predicate, thisArg) {
    for (var i = this.length - 1; i >= 0; i -= 1) if (predicate.call(thisArg, this[i], i, this)) return i;
    return -1;
  };
  function defineArrayCopy(name, maker) {
    if (!Array.prototype[name]) Object.defineProperty(Array.prototype, name, {
      configurable: true, writable: true, value: maker
    });
  }
  defineArrayCopy('toSorted', function (compareFn) { return Array.prototype.slice.call(this).sort(compareFn); });
  defineArrayCopy('toReversed', function () { return Array.prototype.slice.call(this).reverse(); });
  defineArrayCopy('toSpliced', function () { var copy = Array.prototype.slice.call(this); Array.prototype.splice.apply(copy, arguments); return copy; });
  defineArrayCopy('with', function (index, value) {
    var copy = Array.prototype.slice.call(this);
    copy[index < 0 ? copy.length + index : index] = value;
    return copy;
  });
  if (!String.prototype.isWellFormed) String.prototype.isWellFormed = function () {
    try { encodeURIComponent(this); return true; } catch (error) { return false; }
  };
  if (!String.prototype.toWellFormed) String.prototype.toWellFormed = function () {
    return String(this).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, function (match, lead) {
      return lead === undefined ? '\uFFFD' : lead + '\uFFFD';
    });
  };
  if (typeof Set === 'function') {
    var setPrototype = Set.prototype;
    if (!setPrototype.union) setPrototype.union = function (other) {
      var out = new Set(this);
      other.forEach(function (value) { out.add(value); });
      return out;
    };
    if (!setPrototype.intersection) setPrototype.intersection = function (other) {
      var out = new Set(), self = this;
      other.forEach(function (value) { if (self.has(value)) out.add(value); });
      return out;
    };
    if (!setPrototype.difference) setPrototype.difference = function (other) {
      var out = new Set(), self = this;
      this.forEach(function (value) { if (!other.has(value)) out.add(value); });
      return out;
    };
    if (!setPrototype.symmetricDifference) setPrototype.symmetricDifference = function (other) {
      var out = new Set(), self = this;
      this.forEach(function (value) { if (!other.has(value)) out.add(value); });
      other.forEach(function (value) { if (!self.has(value)) out.add(value); });
      return out;
    };
    if (!setPrototype.isSubsetOf) setPrototype.isSubsetOf = function (other) {
      var ok = true;
      this.forEach(function (value) { if (!other.has(value)) ok = false; });
      return ok;
    };
    if (!setPrototype.isSupersetOf) setPrototype.isSupersetOf = function (other) {
      var self = this, ok = true;
      other.forEach(function (value) { if (!self.has(value)) ok = false; });
      return ok;
    };
    if (!setPrototype.isDisjointFrom) setPrototype.isDisjointFrom = function (other) {
      var self = this, ok = true;
      this.forEach(function (value) { if (other.has(value)) ok = false; });
      return ok;
    };
  }
  if (!Promise.withResolvers) Promise.withResolvers = function () {
    var resolve, reject, promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  };
  if (!Promise.try) Promise.try = function (fn) {
    return new Promise(function (resolve) { resolve(fn()); });
  };
  if (typeof URL === 'function' && !URL.canParse) URL.canParse = function (input, base) {
    try { new URL(input, base); return true; } catch (error) { return false; }
  };
  if (typeof Symbol === 'function') {
    if (!Symbol.dispose) Symbol.dispose = Symbol('Symbol.dispose');
    if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol('Symbol.asyncDispose');
  }
  if (!globalThis.structuredClone) globalThis.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
  if (!globalThis.requestIdleCallback) globalThis.requestIdleCallback = function (callback) {
    return setTimeout(function () {
      callback({ didTimeout: false, timeRemaining: function () { return 16; } });
    }, 1);
  };
  if (!globalThis.cancelIdleCallback) globalThis.cancelIdleCallback = function (handle) { clearTimeout(handle); };

  // ---- AbortSignal: any/timeout/throwIfAborted are 16.4+ or 17.4+ ----
  if (typeof AbortSignal === 'function') {
    function abortError() {
      return typeof DOMException === 'function'
        ? new DOMException('signal is aborted without reason', 'AbortError')
        : new Error('signal is aborted without reason');
    }
    if (!AbortSignal.timeout) AbortSignal.timeout = function (milliseconds) {
      var controller = new AbortController();
      setTimeout(function () { controller.abort(abortError()); }, milliseconds);
      return controller.signal;
    };
    if (!AbortSignal.any) AbortSignal.any = function (signals) {
      var controller = new AbortController();
      var list = Array.prototype.slice.call(signals);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].aborted) { controller.abort(list[i].reason); return controller.signal; }
      }
      for (var j = 0; j < list.length; j += 1) {
        (function (signal) {
          signal.addEventListener('abort', function () { controller.abort(signal.reason); }, { once: true });
        }(list[j]));
      }
      return controller.signal;
    };
    if (!AbortSignal.prototype.throwIfAborted) Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
      configurable: true,
      value: function () { if (this.aborted) throw this.reason === undefined ? abortError() : this.reason; }
    });
  }

  // ---- binary base64/hex helpers (Safari 18+) ----
  if (typeof Uint8Array === 'function' && typeof btoa === 'function') {
    var toBase64 = function () {
      var binary = '';
      for (var i = 0; i < this.length; i += 1) binary += String.fromCharCode(this[i]);
      return btoa(binary);
    };
    var fromBase64 = function (value) {
      var binary = atob(String(value)), out = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
      return out;
    };
    if (!Uint8Array.prototype.toBase64) Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: toBase64 });
    if (!Uint8Array.prototype.fromBase64) Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: fromBase64 });
  }

  // ---- clipboard on plain HTTP (non-secure origins) ----
  if (typeof navigator !== 'undefined' && navigator.clipboard === undefined) {
    var fallbackClipboard = {
      writeText: function (text) {
        return new Promise(function (resolve, reject) {
          var area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(area);
          area.select();
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
          document.body.removeChild(area);
          ok ? resolve() : reject(new Error('clipboard unavailable on this non-secure page'));
        });
      },
      readText: function () { return Promise.reject(new Error('clipboard read is unavailable on this non-secure page')); }
    };
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: function () { return fallbackClipboard; } }); } catch (error) { /* ignore */ }
  }

  // ---- crypto.randomUUID (15.4+, but absent on some 16.0 builds) ----
  if (globalThis.crypto && !crypto.randomUUID) {
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (character) {
          var value = Math.random() * 16 | 0;
          return (character === 'x' ? value : value & 3 | 8).toString(16);
        });
      }
    });
  }

  // ---- visible, dismissible failure surface instead of a silent blank page ----
  var lastBanner = '';
  function showBootError(error, where) {
    // A rejection with no reason, an abort, or a ResizeObserver notification is
    // routine noise; only surface real messages so the banner stays actionable.
    if (error === undefined || error === null) return '';
    var message = error && (error.message || error.reason || String(error));
    if (typeof message !== 'string' || message === '' || message === 'undefined' || message === 'null') return '';
    if (message === 'Script error.') return '';
    if (/^(AbortError|DOMException)$/.test(String(error && error.name || ''))) return '';
    if (/ResizeObserver loop/i.test(message)) return '';
    if (message === lastBanner) return message;
    lastBanner = message;
    if (document.getElementById('dsh-compat-banner')) return message;
    var node = document.createElement('div');
    node.id = 'dsh-compat-banner';
    node.textContent = 'DSH browser error: ' + message + (where ? ' (' + where + ')' : '') + ' - tap to dismiss';
    node.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 14px;background:#7f1d1d;color:#fff;font:12px -apple-system,BlinkMacSystemFont,sans-serif;white-space:pre-wrap;max-height:45vh;overflow:auto';
    node.onclick = function () { node.remove(); };
    (document.body || document.documentElement).appendChild(node);
    return message;
  }
  addEventListener('error', function (event) {
    if (!event) return;
    var where = event.filename ? event.filename.split('/').pop() + ':' + event.lineno : '';
    showBootError(event.error || event.message, where);
  }, true);
  addEventListener('unhandledrejection', function (event) {
    showBootError(event && event.reason, '');
  });
  // Server-side patching could not repair something (usually after a DSH
  // upgrade). Say so instead of showing a blank page.
  var unsupported = globalThis.__DSH_IPAD_COMPAT_WARNINGS__;
  if (unsupported && unsupported.length > 0) showBootError(new Error(unsupported.join(' | ')), 'auto-patch');
}());
