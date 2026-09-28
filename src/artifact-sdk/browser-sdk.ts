// Browser-side Swarm SDK injected into agent-served HTML pages.
//
// Exposes a domain-grouped API on `window.SwarmSDK` (class) and a ready-to-use
// singleton `window.swarmSdk`. All calls route through the `/@swarm/api/*`
// proxy, which strips the page-session cookie and forwards to `/api/*` with
// a server-side bearer and signed page session. Memory operations use the
// page owner's agent scope. Viewer identity and permissions remain separate.
// The browser never handles the server bearer.
//
// Domains exposed:
//   - tasks            create, list, get, storeProgress
//   - agents           list, get
//   - events           create, list, batch, counts
//   - memory           search, list, get, rate
//   - repos            list, get, create, update, delete
//   - schedules        list, get, create, update, delete, run
//   - approvalRequests list, get, create, respond
//   - assets           list, audit, registerMapping, move
//   - kv               get, set, del, incr, list  (namespace is forced server-
//                      side to the page's own `task:page:<id>` — no namespace
//                      argument is exposed)
//
// Full HTTP API reference: https://docs.agent-swarm.dev/docs/api-reference
export const BROWSER_SDK_JS = `
class SwarmSDK {
  constructor() {
    let realtime;
    const loadRealtime = () => realtime || (realtime = import('/@swarm/realtime.js'));
    this.room = async (name, options) => (await loadRealtime()).room(name, options);
    this.channel = async (name) => (await loadRealtime()).channel(name);

    const base = '/@swarm/api';
    const call = async (method, path, body) => {
      const init = { method };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(base + path, init);
      const text = await res.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (!res.ok) {
        const err = new Error('SwarmSDK ' + method + ' ' + path + ': ' + res.status);
        err.status = res.status;
        err.response = parsed;
        throw err;
      }
      return parsed;
    };
    const qs = (obj) => {
      if (!obj) return '';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        p.set(k, String(v));
      }
      const s = p.toString();
      return s ? '?' + s : '';
    };
    const enc = encodeURIComponent;

    this.tasks = {
      create: (body) => call('POST', '/tasks', body),
      list: (filters) => call('GET', '/tasks' + qs(filters)),
      get: (id) => call('GET', '/tasks/' + enc(id)),
      storeProgress: (id, data) => call('POST', '/tasks/' + enc(id) + '/progress', data),
    };

    this.agents = {
      list: () => call('GET', '/agents'),
      get: (id) => call('GET', '/agents/' + enc(id)),
    };

    this.events = {
      create: (body) => call('POST', '/events', body),
      list: (filters) => call('GET', '/events' + qs(filters)),
      batch: (body) => call('POST', '/events/batch', body),
      counts: (filters) => call('GET', '/events/counts' + qs(filters)),
    };

    this.memory = {
      search: (body) => call('POST', '/memory/search', body),
      list: (filters) => call('GET', '/memory/list' + qs(filters)),
      get: (id) => call('GET', '/memory/' + enc(id)),
      rate: (body) => call('POST', '/memory/rate', body),
    };

    this.repos = {
      list: () => call('GET', '/repos'),
      get: (id) => call('GET', '/repos/' + enc(id)),
      create: (body) => call('POST', '/repos', body),
      update: (id, body) => call('PUT', '/repos/' + enc(id), body),
      delete: (id) => call('DELETE', '/repos/' + enc(id)),
    };

    this.schedules = {
      list: () => call('GET', '/schedules'),
      get: (id) => call('GET', '/schedules/' + enc(id)),
      create: (body) => call('POST', '/schedules', body),
      update: (id, body) => call('PUT', '/schedules/' + enc(id), body),
      delete: (id) => call('DELETE', '/schedules/' + enc(id)),
      run: (id) => call('POST', '/schedules/' + enc(id) + '/run'),
    };

    this.approvalRequests = {
      list: (filters) => call('GET', '/approval-requests' + qs(filters)),
      get: (id) => call('GET', '/approval-requests/' + enc(id)),
      create: (body) => call('POST', '/approval-requests', body),
      respond: (id, body) => call('POST', '/approval-requests/' + enc(id) + '/respond', body),
    };

    this.assets = {
      list: (filters) => call('GET', '/assets' + qs(filters)),
      audit: () => call('GET', '/assets/key-audit'),
      registerMapping: (body) => call('POST', '/assets/mappings', body),
      move: (entityType, id, key) => call(
        'PATCH',
        '/assets/' + enc(entityType) + '/' + enc(id) + '/key',
        { key },
      ),
    };

    // KV store. The namespace is FORCED by the page-proxy to \`task:page:<id>\`
    // (it injects X-Page-Id which the kv handler treats as highest priority).
    // No namespace argument is exposed — pages cannot read/write any other
    // namespace via this SDK.
    this.kv = {
      get: (key) => call('GET', '/kv/' + enc(key)),
      set: (key, value, opts) => call('PUT', '/kv/' + enc(key), {
        value,
        valueType: opts && opts.valueType,
        expiresInSec: opts && opts.expiresInSec,
      }),
      del: (key) => call('DELETE', '/kv/' + enc(key)),
      incr: (key, by) => call('POST', '/kv/' + enc(key) + '/incr', { by: by == null ? 1 : by }),
      list: (opts) => call('GET', '/kv' + qs(opts)),
    };
  }
}

// Expose BOTH the class (for \`new SwarmSDK()\`) AND a ready-to-use singleton
// on \`window.swarmSdk\` so pages can call e.g. \`window.swarmSdk.agents.list()\`
// directly without instantiating.
window.SwarmSDK = SwarmSDK;
window.swarmSdk = new SwarmSDK();
`;

// ─── UI primitives ──────────────────────────────────────────────────────────
//
// Auto-injected alongside the SDK. Exposes a tiny set of declarative web
// components agents can drop into HTML pages without bundling anything. v1:
// only \`<swarm-diff>\` (unified-diff renderer) + \`<swarm-diff-jumps>\` (a
// sibling-anchor jump list). All zero-dep, pure DOM — Tailwind utility
// classes are used freely since the Play CDN is already loaded by
// PAGE_HEAD_DEFAULTS, but every visual aspect has inline-style fallbacks so
// the component is still legible if Tailwind fails to load.

/**
 * Renders a unified diff as a two-column-gutter HTML table inside a
 * `<swarm-diff>` custom element. Reads `file`, `base-sha`, `head-sha`
 * attributes and parses the element's text content as JSON of shape
 * `{ hunks: [{ old_start, old_lines, new_start, new_lines, lines:
 * [{ type: 'context' | 'add' | 'del', text }], annotations?: [{ line,
 * severity, text }] }] }`. Severity ∈ `error|warn|info`. Each hunk gets a
 * deterministic anchor id so deep-linking + the sibling `<swarm-diff-jumps>`
 * component works.
 *
 * Pure JS, no deps. Tailwind utility classes are sprinkled in but every
 * critical visual property has an inline-style fallback.
 */
export const SWARM_UI_JS = `
(function() {
  if (typeof window === 'undefined' || !window.customElements) return;
  if (window.customElements.get('swarm-diff')) return;

  // Keep page-owned presence fields alongside the cursor. Room.presence.set
  // replaces its payload, so retain each room's latest page data and merge
  // the reserved __cursor field into it when the cursor moves.
  var roomPresenceTrackers = new WeakMap();

  function clonePresenceRecord(data) {
    return data && typeof data === 'object' && !Array.isArray(data)
      ? structuredClone(data)
      : {};
  }

  function mergeCursorPresence(data, cursor) {
    var merged = clonePresenceRecord(data);
    if (cursor) merged.__cursor = { x: cursor.x, y: cursor.y };
    else delete merged.__cursor;
    return merged;
  }

  function trackRoomPresence(room) {
    if (!room || !room.presence || typeof room.presence.set !== 'function') return null;
    var existing = roomPresenceTrackers.get(room);
    if (existing) return existing;

    var presence = room.presence;
    var originalSet = presence.set;
    var pageData = {};
    var cursor = null;
    var tracker = {
      setCursor: function(nextCursor) {
        cursor = nextCursor;
        return originalSet.call(presence, mergeCursorPresence(pageData, cursor));
      },
      clearCursor: function() {
        if (!cursor) return;
        return tracker.setCursor(null);
      },
    };

    presence.set = function(data) {
      pageData = clonePresenceRecord(data);
      return originalSet.call(presence, cursor ? mergeCursorPresence(pageData, cursor) : data);
    };
    roomPresenceTrackers.set(room, tracker);
    return tracker;
  }

  // Wrap room creation before page scripts run so presence.set calls made by
  // page code are tracked even when they happen before <swarm-cursors> connects.
  var cursorRoomRecords = new Map();
  var sdkRoomMethods = new WeakMap();
  var observedRoomClosers = new WeakSet();
  var originalRoom = null;
  function roomRecordKey(name) {
    return name === undefined ? 'default' : name;
  }

  function observeRoom(record, room) {
    record.hasResolvedRoom = true;
    if (!cursorRoomRecords.has(record.name)) cursorRoomRecords.set(record.name, record);
    trackRoomPresence(room);
    if (room && typeof room.close === 'function' && !observedRoomClosers.has(room)) {
      var originalClose = room.close;
      room.close = function() {
        if (cursorRoomRecords.get(record.name) === record) cursorRoomRecords.delete(record.name);
        return originalClose.apply(room, arguments);
      };
      observedRoomClosers.add(room);
    }
    return room;
  }

  function observeRoomPromise(record, result) {
    var observed = Promise.resolve(result).then(function(room) {
      var resolvedRoom = observeRoom(record, room);
      record.pageRequests--;
      record.hasPageUse = true;
      record.pageUsed = true;
      record.promise = Promise.resolve(resolvedRoom);
      return resolvedRoom;
    }).catch(function(error) {
      record.pageRequests--;
      record.pageUsed = record.hasPageUse || record.pageRequests > 0;
      if (!record.hasResolvedRoom
        && record.pageRequests === 0
        && cursorRoomRecords.get(record.name) === record)
        cursorRoomRecords.delete(record.name);
      if (record.cursorRefs === 0 && record.openedByCursor && !record.pageUsed)
        closeCursorRoomIfUnused(record);
      throw error;
    });
    record.pageRequests++;
    record.pageUsed = true;
    if (!record.promise) record.promise = observed;
    return observed;
  }

  function closeCursorRoomIfUnused(record) {
    if (record.closing || record.cursorRefs || !record.openedByCursor || record.pageUsed) return;
    record.closing = true;
    record.promise.then(function(room) {
      if (record.cursorRefs || record.pageUsed) {
        record.closing = false;
        return;
      }
      if (cursorRoomRecords.get(record.name) === record) cursorRoomRecords.delete(record.name);
      if (room && typeof room.close === 'function') return room.close();
    }).catch(function() {
      record.closing = false;
    });
  }

  function instrumentSdk(sdk) {
    if (!sdk || typeof sdk.room !== 'function') return null;
    var existing = sdkRoomMethods.get(sdk);
    if (existing) return existing;

    var sdkOriginalRoom = sdk.room;
    var wrappedRoom = function(name, options) {
      var key = roomRecordKey(name);
      var record = cursorRoomRecords.get(key);
      var result = sdkOriginalRoom.call(sdk, name, options);
      if (!record) {
        record = {
          name: key,
          cursorRefs: 0,
          openedByCursor: false,
          pageUsed: false,
          hasPageUse: false,
          pageRequests: 0,
          hasResolvedRoom: false,
          promise: null,
        };
        cursorRoomRecords.set(key, record);
      }
      return observeRoomPromise(record, result);
    };
    sdk.room = wrappedRoom;
    var methods = { original: sdkOriginalRoom, wrapped: wrappedRoom };
    sdkRoomMethods.set(sdk, methods);
    return methods;
  }

  if (window.swarmSdk) {
    var singletonRoomMethods = instrumentSdk(window.swarmSdk);
    originalRoom = singletonRoomMethods && singletonRoomMethods.original;
  }
  if (typeof window.SwarmSDK === 'function') {
    var OriginalSwarmSDK = window.SwarmSDK;
    window.SwarmSDK = new Proxy(OriginalSwarmSDK, {
      construct: function(target, args, newTarget) {
        var sdk = Reflect.construct(target, args, newTarget);
        instrumentSdk(sdk);
        return sdk;
      },
    });
  }

  function acquireCursorRoom(name, options) {
    var key = roomRecordKey(name);
    var record = cursorRoomRecords.get(key);
    if (record) {
      record.cursorRefs++;
      return { record: record, promise: record.promise };
    }

    record = {
      name: key,
      cursorRefs: 1,
      openedByCursor: true,
      pageUsed: false,
      hasPageUse: false,
      pageRequests: 0,
      hasResolvedRoom: false,
      closing: false,
      promise: null,
    };
    cursorRoomRecords.set(key, record);
    record.promise = Promise.resolve().then(function() {
      return originalRoom(name, options);
    }).then(function(room) {
      return observeRoom(record, room);
    }).catch(function(error) {
      if (cursorRoomRecords.get(key) === record) cursorRoomRecords.delete(key);
      throw error;
    });
    return { record: record, promise: record.promise };
  }

  function releaseCursorRoom(record, presence) {
    if (!record || record.cursorRefs < 1) return;
    if (record.cursorRefs === 1 && presence) presence.clearCursor();
    record.cursorRefs--;
    closeCursorRoomIfUnused(record);
  }

  var SEV_COLOR = {
    error: '#ef4444',
    warn:  '#f59e0b',
    info:  '#3b82f6',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function slugifyAttr(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function parseHunks(jsonText) {
    var trimmed = (jsonText || '').trim();
    if (!trimmed) return [];
    try {
      var parsed = JSON.parse(trimmed);
      if (parsed && Array.isArray(parsed.hunks)) return parsed.hunks;
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (e) {
      console.warn('[swarm-diff] failed to parse JSON body:', e);
      return [];
    }
  }

  function renderAnnotation(ann) {
    var color = SEV_COLOR[ann && ann.severity] || SEV_COLOR.info;
    return (
      '<span class="swarm-diff-annot no-print" '
      + 'style="display:inline-block;margin-left:8px;padding:1px 6px;'
      + 'border-radius:4px;font-size:11px;font-weight:600;'
      + 'background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;">'
      + esc((ann && ann.severity ? ann.severity.toUpperCase() : 'INFO')) + ' · ' + esc(ann && ann.text || '')
      + '</span>'
    );
  }

  function renderHunk(hunk, hunkIdx, file) {
    var oldLines = hunk.old_lines || 0;
    var newLines = hunk.new_lines || 0;
    var oldStart = hunk.old_start || 0;
    var newStart = hunk.new_start || 0;
    var lines = Array.isArray(hunk.lines) ? hunk.lines : [];
    var annotations = Array.isArray(hunk.annotations) ? hunk.annotations : [];
    // Index annotations by new-side line number for fast lookup per row.
    var annByLine = {};
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a && typeof a.line === 'number') {
        if (!annByLine[a.line]) annByLine[a.line] = [];
        annByLine[a.line].push(a);
      }
    }

    var rowsHtml = '';
    var oldN = oldStart;
    var newN = newStart;
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j] || {};
      var type = line.type || 'context';
      var text = line.text == null ? '' : line.text;
      var bg, oldCell, newCell, sign;
      if (type === 'add') {
        bg = 'rgba(34,197,94,0.10)';
        oldCell = '';
        newCell = String(newN++);
        sign = '+';
      } else if (type === 'del') {
        bg = 'rgba(239,68,68,0.10)';
        oldCell = String(oldN++);
        newCell = '';
        sign = '-';
      } else {
        bg = 'transparent';
        oldCell = String(oldN++);
        newCell = String(newN++);
        sign = ' ';
      }

      var annHtml = '';
      var anns = annByLine[Number(newCell)] || annByLine[Number(oldCell)] || [];
      for (var k = 0; k < anns.length; k++) annHtml += renderAnnotation(anns[k]);

      rowsHtml += (
        '<tr style="background:' + bg + ';">'
        + '<td class="swarm-diff-gutter" style="user-select:none;text-align:right;padding:0 8px;color:#7c8aa6;font-size:12px;width:48px;">' + esc(oldCell) + '</td>'
        + '<td class="swarm-diff-gutter" style="user-select:none;text-align:right;padding:0 8px;color:#7c8aa6;font-size:12px;width:48px;">' + esc(newCell) + '</td>'
        + '<td class="swarm-diff-sign" style="user-select:none;text-align:center;padding:0 4px;color:#7c8aa6;font-size:12px;width:18px;">' + esc(sign) + '</td>'
        + '<td class="swarm-diff-code" style="padding:0 8px;white-space:pre-wrap;word-break:break-word;font-family:\\'Space Mono\\',ui-monospace,monospace;font-size:12px;">' + esc(text) + annHtml + '</td>'
        + '</tr>'
      );
    }

    var anchorSlug = slugifyAttr((file || 'hunk') + '-' + (oldStart || hunkIdx + 1));
    var anchorId = 'swarm-diff-' + anchorSlug;
    var header = (
      '@@ -' + oldStart + ',' + oldLines + ' +' + newStart + ',' + newLines + ' @@'
    );

    return (
      '<a id="' + esc(anchorId) + '" class="swarm-diff-anchor" data-hunk="' + esc(anchorSlug) + '"></a>'
      + '<div class="swarm-diff-hunk-header" style="padding:6px 12px;background:rgba(124,138,166,0.10);color:#7c8aa6;font-family:\\'Space Mono\\',ui-monospace,monospace;font-size:11px;border-top:1px solid var(--swarm-border,#22304a);">'
      + esc(header)
      + '</div>'
      + '<table class="swarm-diff-table" style="width:100%;border-collapse:collapse;table-layout:fixed;">'
      + '<tbody>' + rowsHtml + '</tbody>'
      + '</table>'
    );
  }

  function renderDiff(rootEl, diffData) {
    var hunks = (diffData && Array.isArray(diffData.hunks)) ? diffData.hunks : (Array.isArray(diffData) ? diffData : []);
    var file = rootEl.getAttribute('file') || '';
    var baseSha = rootEl.getAttribute('base-sha') || '';
    var headSha = rootEl.getAttribute('head-sha') || '';

    var shaLine = '';
    if (baseSha || headSha) {
      shaLine = '<span class="swarm-diff-sha" style="font-family:\\'Space Mono\\',ui-monospace,monospace;font-size:11px;color:#7c8aa6;">'
        + esc(baseSha) + ' → ' + esc(headSha)
        + '</span>';
    }

    var hunksHtml = '';
    for (var i = 0; i < hunks.length; i++) {
      hunksHtml += renderHunk(hunks[i] || {}, i, file);
    }

    rootEl.innerHTML = (
      '<div class="swarm-diff-root" style="border:1px solid var(--swarm-border,#22304a);border-radius:8px;background:var(--swarm-card,#121826);overflow:hidden;margin:12px 0;break-inside:avoid;">'
      + '<div class="swarm-diff-header" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:rgba(59,130,246,0.10);border-bottom:1px solid var(--swarm-border,#22304a);">'
      + '<span class="swarm-diff-file" style="font-family:\\'Space Mono\\',ui-monospace,monospace;font-size:13px;font-weight:700;color:var(--swarm-text,#e6eaf2);">' + esc(file || '(untitled)') + '</span>'
      + shaLine
      + '</div>'
      + hunksHtml
      + '</div>'
    );
  }

  // Public function form lives on window.swarmUi so callers can render an
  // arbitrary root element programmatically. The custom element below is just
  // a declarative wrapper around the same render function.
  window.swarmUi = window.swarmUi || {};
  window.swarmUi.renderDiff = renderDiff;

  // Defer the parse-and-render so the HTML parser has time to finish
  // appending JSON text children. \`connectedCallback\` fires on the opening
  // tag — \`this.textContent\` is empty until children parse. Without a
  // defer, every declarative <swarm-diff> renders an empty header and the
  // JSON text remains visible as orphan children.
  //
  // queueMicrotask alone is NOT enough — Chrome's streaming parser drains
  // microtasks between chunks, so the microtask can run BEFORE the JSON
  // child is appended. We need to wait for the parser to finish the current
  // document load, then read textContent.
  //
  //  * \`document.readyState === 'loading'\` ⇒ parser still streaming →
  //    wait for DOMContentLoaded (fires after all children are parsed).
  //  * otherwise (element was created/inserted dynamically post-load) ⇒
  //    queueMicrotask is fine — DOM is stable, just give the caller a tick.
  //
  // Re-entrancy (element moved/reconnected) re-fires connectedCallback so
  // we re-render against current textContent.
  class SwarmDiffElement extends HTMLElement {
    connectedCallback() {
      var self = this;
      var doRender = function() {
        if (!self.isConnected) return;
        var raw = self.textContent || '';
        renderDiff(self, { hunks: parseHunks(raw) });
        // Notify <swarm-diff-jumps> instances so they can pick up new anchors.
        self.dispatchEvent(new CustomEvent('swarm-diff:rendered', { bubbles: true }));
      };
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', doRender, { once: true });
      } else {
        queueMicrotask(doRender);
      }
    }
  }
  window.customElements.define('swarm-diff', SwarmDiffElement);

  // Sibling-anchor jump list. Walks subsequent siblings, finds every
  // <swarm-diff data-hunk=...> anchor, and renders a small list of links.
  //
  // Same parse-order hazard as <swarm-diff>: <swarm-diff-jumps> usually
  // appears in the document BEFORE the <swarm-diff> elements it indexes, so
  // we also defer to a microtask AND re-render whenever a <swarm-diff> in the
  // document finishes rendering its anchors.
  class SwarmDiffJumpsElement extends HTMLElement {
    connectedCallback() {
      var self = this;
      var renderJumps = function() {
        var anchors = document.querySelectorAll('.swarm-diff-anchor[data-hunk]');
        if (!anchors.length) {
          self.innerHTML = '<span class="no-print" style="color:#7c8aa6;font-size:12px;">No hunks yet.</span>';
          return;
        }
        var items = '';
        for (var i = 0; i < anchors.length; i++) {
          var a = anchors[i];
          var slug = a.getAttribute('data-hunk') || ('hunk-' + i);
          // Hunk title = nearest preceding diff's file attribute if available.
          var diff = a.closest && a.closest('swarm-diff');
          var file = (diff && diff.getAttribute('file')) || slug;
          items += '<li style="margin:0;padding:2px 0;"><a href="#' + esc(a.id) + '" style="color:#3b82f6;text-decoration:none;font-family:\\'Space Mono\\',ui-monospace,monospace;font-size:12px;">' + esc(file) + '</a></li>';
        }
        self.innerHTML = (
          '<nav class="swarm-diff-jumps no-print" style="padding:8px 12px;border:1px dashed var(--swarm-border,#22304a);border-radius:8px;background:rgba(124,138,166,0.05);">'
          + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#7c8aa6;margin-bottom:4px;">Jump to</div>'
          + '<ul style="list-style:none;padding:0;margin:0;">' + items + '</ul>'
          + '</nav>'
        );
      };
      // Wait for the parser to finish initial load before first query —
      // <swarm-diff> elements also defer to DOMContentLoaded so we must
      // run AFTER they finish rendering their anchors. The event listener
      // below handles the live-update case.
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { queueMicrotask(renderJumps); }, { once: true });
      } else {
        queueMicrotask(renderJumps);
      }
      // Re-render whenever a sibling <swarm-diff> finishes its async render.
      self._onDiffRendered = function() { renderJumps(); };
      document.addEventListener('swarm-diff:rendered', self._onDiffRendered);
    }
    disconnectedCallback() {
      if (this._onDiffRendered) {
        document.removeEventListener('swarm-diff:rendered', this._onDiffRendered);
      }
    }
  }
  window.customElements.define('swarm-diff-jumps', SwarmDiffJumpsElement);

  var CURSOR_IDLE_MS = 3000;
  var CURSOR_SMOOTHING = 0.28;

  function cursorColor(userId) {
    var hash = 2166136261;
    var value = String(userId || '');
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'hsl(' + ((hash >>> 0) % 360) + ', 72%, 42%)';
  }

  function documentSize() {
    var root = document.documentElement || {};
    return {
      width: Math.max(1, root.scrollWidth || root.clientWidth || window.innerWidth || 1),
      height: Math.max(1, root.scrollHeight || root.clientHeight || window.innerHeight || 1),
    };
  }

  function cursorMarkup(name, color) {
    // CursorPointer + CursorBody label structure adapted from Kibo UI (MIT):
    // https://github.com/shadcnblocks/kibo/blob/main/packages/cursor/index.tsx
    return '<svg aria-hidden="true" focusable="false" height="20" width="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;flex:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.2));">'
      + '<path d="M19.438 6.716 1.115.05A.832.832 0 0 0 .05 1.116L6.712 19.45a.834.834 0 0 0 1.557.025l3.198-8 7.995-3.2a.833.833 0 0 0 0-1.559h-.024Z" fill="currentColor"></path>'
      + '</svg>'
      + '<span style="position:relative;margin-left:14px;display:flex;flex-direction:column;white-space:nowrap;border-radius:12px;padding:4px 12px 4px 10px;font-family:system-ui,sans-serif;font-size:12px;font-weight:500;line-height:1.4;background:' + color + ';color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.18);">'
      + esc(name || 'Guest')
      + '</span>';
  }

  class SwarmCursorsElement extends HTMLElement {
    connectedCallback() {
      if (this._startPromise) return;
      var roomName = this.getAttribute('room');
      if (!roomName || !originalRoom) return;

      var self = this;
      var lifecycle = (this._lifecycle || 0) + 1;
      this._lifecycle = lifecycle;
      var begin = function() {
        self._onDomReady = null;
      if (!self.isConnected || self._lifecycle !== lifecycle) return;
        var schemaVersion = self.getAttribute('schema-version');
        var options = schemaVersion == null ? {} : { schemaVersion: Number(schemaVersion) };
        var acquired = acquireCursorRoom(roomName, options);
        self._roomRecord = acquired.record;
        self._startPromise = acquired.promise.then(function(room) {
        if (!self.isConnected || self._lifecycle !== lifecycle) return;
        self._startPromise = null;
        self._room = room;
        self._presence = trackRoomPresence(room);
        if (!self._presence) return;
        self._pointers = new Map();
        self._cursorStates = new Map();

        self._overlay = document.createElement('div');
        self._overlay.setAttribute('aria-hidden', 'true');
        self._overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;';
        var parent = document.body || document.documentElement;
        if (parent) parent.appendChild(self._overlay);

        self._onPresence = function(peers) { self._renderPeers(peers || []); };
        self._onPointerMove = function(event) {
          var size = documentSize();
          var scrollX = window.scrollX || window.pageXOffset || 0;
          var scrollY = window.scrollY || window.pageYOffset || 0;
          var pageX = typeof event.pageX === 'number' ? event.pageX : event.clientX + scrollX;
          var pageY = typeof event.pageY === 'number' ? event.pageY : event.clientY + scrollY;
          var x = Math.max(0, Math.min(1, pageX / size.width));
          var y = Math.max(0, Math.min(1, pageY / size.height));
          self._presence.setCursor({ x: x, y: y });
        };
        self._onPointerLeave = function() {
          self._presence.clearCursor();
        };

        self._unsubscribe = room.on('presence', self._onPresence);
        document.addEventListener('pointermove', self._onPointerMove, { passive: true });
        document.addEventListener('pointerleave', self._onPointerLeave);
        self._renderPeers(room.presence.peers || []);
      }).catch(function(error) {
        self._startPromise = null;
        console.warn('[swarm-cursors] failed to join room:', error);
      });
      };
      if (document.readyState === 'loading') {
        this._onDomReady = function() { queueMicrotask(begin); };
        this._startPromise = Promise.resolve();
        document.addEventListener('DOMContentLoaded', this._onDomReady, { once: true });
      } else {
        begin();
      }
    }

    _renderPeers(peers) {
      if (!this._pointers) return;
      var seen = new Set();
      var activePeerIds = new Set();
      var includeAgents = this.hasAttribute('include-agents');
      var ownId = this._room && this._room.me && this._room.me.userId;
      var now = Date.now();

      for (var i = 0; i < peers.length; i++) {
        var peer = peers[i];
        if (!peer || !peer.userId || peer.userId === ownId) continue;
        if (peer.kind === 'agent' && !includeAgents) continue;
        var data = peer.data && typeof peer.data === 'object' ? peer.data : null;
        var cursor = data && data.__cursor;
        if (!cursor || typeof cursor.x !== 'number' || typeof cursor.y !== 'number'
          || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) continue;

        var id = String(peer.userId);
        activePeerIds.add(id);
        var state = this._cursorStates.get(id);
        if (!state || state.x !== cursor.x || state.y !== cursor.y) {
          state = { x: cursor.x, y: cursor.y, lastSeen: now };
          this._cursorStates.set(id, state);
        }
        if (now - state.lastSeen > CURSOR_IDLE_MS) continue;

        var entry = this._pointers.get(id);
        if (!entry) {
          entry = this._createPointer(peer);
          this._pointers.set(id, entry);
        }
        entry.cursor = { x: state.x, y: state.y };
        entry.lastSeen = state.lastSeen;
        if (entry.name !== peer.name) {
          entry.name = peer.name || 'Guest';
          entry.node.innerHTML = cursorMarkup(entry.name, entry.color);
        }
        seen.add(id);
      }

      var ids = Array.from(this._pointers.keys());
      for (var j = 0; j < ids.length; j++) {
        if (!seen.has(ids[j])) this._removePointer(ids[j]);
      }
      var stateIds = Array.from(this._cursorStates.keys());
      for (var k = 0; k < stateIds.length; k++) {
        if (!activePeerIds.has(stateIds[k])) this._cursorStates.delete(stateIds[k]);
      }
      this._scheduleFrame();
    }

    _createPointer(peer) {
      var color = cursorColor(peer.userId);
      var node = document.createElement('div');
      node.style.cssText = 'position:absolute;left:0;top:0;display:flex;align-items:flex-start;pointer-events:none;user-select:none;will-change:transform;color:' + color + ';';
      node.innerHTML = cursorMarkup(peer.name || 'Guest', color);
      this._overlay.appendChild(node);
      return {
        node: node,
        color: color,
        name: peer.name || 'Guest',
        cursor: null,
        x: null,
        y: null,
        lastSeen: Date.now(),
      };
    }

    _removePointer(id) {
      var entry = this._pointers.get(id);
      if (entry && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
      this._pointers.delete(id);
    }

    _scheduleFrame() {
      if (this._frameId != null || !this._pointers || !this._pointers.size
        || typeof window.requestAnimationFrame !== 'function') return;
      var self = this;
      this._frameId = window.requestAnimationFrame(function() { self._animate(); });
    }

    _animate() {
      this._frameId = null;
      if (!this._pointers || !this._overlay) return;
      var now = Date.now();
      var size = documentSize();
      var scrollX = window.scrollX || window.pageXOffset || 0;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      var ids = Array.from(this._pointers.keys());

      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var entry = this._pointers.get(id);
        if (now - entry.lastSeen > CURSOR_IDLE_MS) {
          this._removePointer(id);
          continue;
        }
        var targetX = entry.cursor.x * size.width - scrollX;
        var targetY = entry.cursor.y * size.height - scrollY;
        if (entry.x == null || entry.y == null) {
          entry.x = targetX;
          entry.y = targetY;
        } else {
          // Exponential interpolation keeps 50 ms presence updates from jumping.
          entry.x += (targetX - entry.x) * CURSOR_SMOOTHING;
          entry.y += (targetY - entry.y) * CURSOR_SMOOTHING;
        }
        entry.node.style.transform = 'translate3d(' + Math.round(entry.x) + 'px,' + Math.round(entry.y) + 'px,0)';
      }
      this._scheduleFrame();
    }

    disconnectedCallback() {
      this._lifecycle = (this._lifecycle || 0) + 1;
      this._startPromise = null;
      if (this._onDomReady) {
        document.removeEventListener('DOMContentLoaded', this._onDomReady);
        this._onDomReady = null;
      }
      if (this._unsubscribe) this._unsubscribe();
      if (this._onPointerMove) document.removeEventListener('pointermove', this._onPointerMove);
      if (this._onPointerLeave) document.removeEventListener('pointerleave', this._onPointerLeave);
      if (this._roomRecord) releaseCursorRoom(this._roomRecord, this._presence);
      if (this._frameId != null && typeof window.cancelAnimationFrame === 'function')
        window.cancelAnimationFrame(this._frameId);
      if (this._pointers) {
        var ids = Array.from(this._pointers.keys());
        for (var i = 0; i < ids.length; i++) this._removePointer(ids[i]);
      }
      if (this._overlay && this._overlay.parentNode)
        this._overlay.parentNode.removeChild(this._overlay);
      this._room = null;
      this._roomRecord = null;
      this._presence = null;
      this._overlay = null;
      this._pointers = null;
      this._cursorStates = null;
      this._frameId = null;
    }
  }
  window.customElements.define('swarm-cursors', SwarmCursorsElement);
})();
`;
