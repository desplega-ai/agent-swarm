// Browser-side Swarm SDK injected into agent-served HTML pages.
//
// Exposes a domain-grouped API on `window.SwarmSDK` (class) and a ready-to-use
// singleton `window.swarmSdk`. All calls route through the `/@swarm/api/*`
// proxy, which strips the page-session cookie and forwards to `/api/*` with
// a server-side bearer + agent-id. From the page's perspective, the SDK is
// authenticated automatically — no token handling on the client.
//
// Domains exposed:
//   - tasks            create, list, get, storeProgress
//   - agents           list, get
//   - events           create, list, batch, counts
//   - memory           search, list, get, rate
//   - repos            list, get, create, update, delete
//   - schedules        list, get, create, update, delete, run
//   - approvalRequests list, get, create, respond
//   - kv               get, set, del, incr, list  (namespace is forced server-
//                      side to the page's own `task:page:<id>` — no namespace
//                      argument is exposed)
//
// Full HTTP API reference: https://docs.agent-swarm.dev/docs/api-reference
export const BROWSER_SDK_JS = `
class SwarmSDK {
  constructor() {
    this._configPromise = fetch('/@swarm/config').then(r => r.json()).catch(() => null);

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
})();
`;
