// In-page feedback overlay for DB-backed pages (`/p/:id`).
//
// Served only when the request carries `?__swarm-feedback` (the dashboard's
// "Feedback" toggle sets it, see apps/ui/src/pages/pages/[id]/page.tsx). The
// viewer picks elements on the page, leaves a comment on each, and sends the
// batch to `POST /api/pages/:id/feedback`, which creates one task for the lead
// (src/http/pages.ts). Inside the dashboard the parent SPA sends it with its
// bearer (postMessage bridge), so the page never gets a viewer session for
// this. Opened directly, the overlay falls back to the `/@swarm/api` proxy,
// which needs an existing page session.
//
// Pure DOM, zero deps, rendered inside a shadow root so page CSS (and the
// Tailwind Play CDN) cannot restyle it. Draft comments persist in
// sessionStorage per page, so a reload does not lose them. User text is only
// ever written through `textContent`.
//
// The script body is a plain string: keep it free of backticks and `${`.

/** Query param that turns the overlay on. `0` / `false` keep it off. */
export const PAGE_FEEDBACK_PARAM = "__swarm-feedback";

export function isPageFeedbackRequested(queryParams: URLSearchParams): boolean {
  if (!queryParams.has(PAGE_FEEDBACK_PARAM)) return false;
  const value = (queryParams.get(PAGE_FEEDBACK_PARAM) ?? "").toLowerCase();
  return value !== "0" && value !== "false";
}

const FEEDBACK_OVERLAY_JS = `
(function () {
  var cfg = window.__swarmFeedback;
  if (!cfg || !cfg.pageId || window.__swarmFeedbackMounted) return;
  window.__swarmFeedbackMounted = true;

  var pageId = cfg.pageId;
  var storageKey = 'swarm-feedback:' + pageId;
  var state = { selecting: false, comments: load(), draft: null, sending: false, collapsed: false, status: null };

  function load() {
    try { return JSON.parse(sessionStorage.getItem(storageKey) || '[]') || []; } catch (e) { return []; }
  }
  function save() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state.comments)); } catch (e) {}
  }

  // ─── Element description ───────────────────────────────────────────────
  function esc(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }
  function uniqueId(el) {
    if (!el.id) return false;
    try { return document.querySelectorAll('#' + esc(el.id)).length === 1; } catch (e) { return false; }
  }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (uniqueId(el)) { parts.unshift('#' + esc(el.id)); break; }
      var part = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === el.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }
  function excerpt(el) {
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  }
  function htmlSnippet(el) {
    var html = el.outerHTML || '';
    return html.length > 400 ? html.slice(0, 400) + '…' : html;
  }
  function findEl(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  // ─── Shadow root + styles ──────────────────────────────────────────────
  var host = document.createElement('swarm-feedback-root');
  host.setAttribute('data-swarm-feedback', '');
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '@media print { :host { display: none !important; } }',
    '* { box-sizing: border-box; font-family: "Space Grotesk", system-ui, sans-serif; }',
    '.hl { position: fixed; pointer-events: none; z-index: 2147483645; border: 2px solid #f59e0b; background: rgba(245, 158, 11, 0.12); border-radius: 3px; display: none; }',
    '.hl-label { position: absolute; left: -2px; top: -22px; background: #f59e0b; color: #111827; font: 600 11px/1 "Space Mono", ui-monospace, monospace; padding: 4px 6px; border-radius: 3px; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }',
    '.marker { position: fixed; z-index: 2147483646; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 999px; background: #f59e0b; color: #111827; font: 700 11px/22px "Space Mono", ui-monospace, monospace; text-align: center; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.3); border: 2px solid #fff; }',
    '.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px; max-height: min(70vh, 560px); display: flex; flex-direction: column; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.18); font-size: 13px; line-height: 1.4; }',
    '.panel.collapsed { width: auto; }',
    '.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }',
    '.panel.collapsed .head { border-bottom: 0; }',
    '.title { font-weight: 600; flex: 1; }',
    '.count { font: 600 11px/1 "Space Mono", ui-monospace, monospace; background: #f3f4f6; border-radius: 999px; padding: 3px 7px; }',
    '.body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }',
    '.panel.collapsed .body { display: none; }',
    'button { font: inherit; font-size: 12px; border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 6px; padding: 6px 10px; cursor: pointer; }',
    'button:hover:not(:disabled) { background: #f9fafb; }',
    'button:disabled { opacity: 0.5; cursor: default; }',
    'button.primary { background: #111827; border-color: #111827; color: #fff; }',
    'button.primary:hover:not(:disabled) { background: #1f2937; }',
    'button.active { background: #f59e0b; border-color: #f59e0b; color: #111827; }',
    'button.icon { padding: 2px 7px; border: 0; color: #6b7280; }',
    '.hint { color: #6b7280; font-size: 12px; }',
    'ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }',
    'li { display: flex; gap: 8px; align-items: flex-start; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; }',
    'li:hover { border-color: #f59e0b; }',
    '.num { flex: none; width: 20px; height: 20px; border-radius: 999px; background: #f59e0b; color: #111827; font: 700 11px/20px "Space Mono", ui-monospace, monospace; text-align: center; }',
    '.li-main { flex: 1; min-width: 0; }',
    '.sel { font: 11px/1.3 "Space Mono", ui-monospace, monospace; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.missing { color: #b45309; }',
    '.text { white-space: pre-wrap; word-break: break-word; }',
    'textarea { font: inherit; font-size: 13px; width: 100%; min-height: 64px; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; color: #111827; background: #fff; }',
    'textarea:focus { outline: 2px solid #f59e0b; outline-offset: 0; border-color: #f59e0b; }',
    '.row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }',
    '.composer { position: fixed; z-index: 2147483647; width: 300px; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.18); padding: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }',
    '.status { font-size: 12px; border-radius: 6px; padding: 6px 8px; }',
    '.status.ok { background: #ecfdf5; color: #065f46; }',
    '.status.err { background: #fef2f2; color: #991b1b; }',
    '.status a { color: inherit; font-weight: 600; }',
  ].join('\\n');
  root.appendChild(style);

  var hl = document.createElement('div');
  hl.className = 'hl';
  var hlLabel = document.createElement('div');
  hlLabel.className = 'hl-label';
  hl.appendChild(hlLabel);
  var markers = document.createElement('div');
  var panel = document.createElement('div');
  panel.className = 'panel';
  var composer = null;
  root.appendChild(hl);
  root.appendChild(markers);
  root.appendChild(panel);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function describe(target) {
    var label = target.tagName.toLowerCase();
    if (target.id) label += '#' + target.id;
    else if (typeof target.className === 'string' && target.className.trim()) {
      label += '.' + target.className.trim().split(/\\s+/).slice(0, 2).join('.');
    }
    return label;
  }

  // ─── Highlight ─────────────────────────────────────────────────────────
  function showHighlight(target, label) {
    var r = target.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    hlLabel.textContent = label || describe(target);
    hlLabel.style.top = r.top < 24 ? '100%' : '-22px';
  }
  function hideHighlight() { hl.style.display = 'none'; }

  // ─── Select mode ───────────────────────────────────────────────────────
  var prevCursor = '';
  function isOwn(e) { return e.target === host; }
  function pickable(target) {
    return target && target.nodeType === 1 && target !== document.documentElement && target !== document.body;
  }
  function onMove(e) {
    if (state.draft) return;
    if (isOwn(e) || !pickable(e.target)) { hideHighlight(); return; }
    showHighlight(e.target);
  }
  function swallow(e) {
    if (isOwn(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (isOwn(e)) return;
    swallow(e);
    if (state.draft || !pickable(e.target)) return;
    openComposer(e.target);
  }
  function setSelecting(on) {
    state.selecting = on;
    var method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('mousemove', onMove, true);
    document[method]('click', onClick, true);
    document[method]('mousedown', swallow, true);
    document[method]('mouseup', swallow, true);
    document[method]('submit', swallow, true);
    if (on) {
      prevCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
    } else {
      document.documentElement.style.cursor = prevCursor;
      hideHighlight();
    }
    render();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.draft) { closeComposer(); return; }
    if (state.selecting) setSelecting(false);
  }, true);

  // ─── Composer ──────────────────────────────────────────────────────────
  function openComposer(target) {
    var selector = cssPath(target);
    state.draft = { target: target, selector: selector };
    showHighlight(target, describe(target));
    composer = el('div', 'composer');
    composer.appendChild(el('div', 'sel', selector));
    var input = el('textarea');
    input.placeholder = 'What should change here?';
    composer.appendChild(input);
    var row = el('div', 'row');
    var cancel = el('button', '', 'Cancel');
    var add = el('button', 'primary', 'Add comment');
    cancel.type = 'button';
    add.type = 'button';
    cancel.addEventListener('click', closeComposer);
    add.addEventListener('click', function () { commitDraft(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDraft(input.value); }
    });
    row.appendChild(cancel);
    row.appendChild(add);
    composer.appendChild(row);
    root.appendChild(composer);
    placeComposer(target);
    input.focus();
  }
  function placeComposer(target) {
    var r = target.getBoundingClientRect();
    var width = 300;
    var height = composer.offsetHeight || 150;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    var top = r.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 8);
    composer.style.left = left + 'px';
    composer.style.top = top + 'px';
  }
  function closeComposer() {
    if (composer) composer.remove();
    composer = null;
    state.draft = null;
    hideHighlight();
  }
  function commitDraft(value) {
    var text = (value || '').trim();
    if (!text || !state.draft) return;
    var target = state.draft.target;
    state.comments.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      selector: state.draft.selector,
      tagName: target.tagName.toLowerCase(),
      text: excerpt(target),
      html: htmlSnippet(target),
      comment: text,
    });
    state.status = null;
    save();
    closeComposer();
    render();
  }

  // ─── Markers ───────────────────────────────────────────────────────────
  function renderMarkers() {
    markers.textContent = '';
    state.comments.forEach(function (c, i) {
      var target = findEl(c.selector);
      if (!target) return;
      var r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      var m = el('div', 'marker', String(i + 1));
      m.style.left = Math.max(11, r.left) + 'px';
      m.style.top = Math.max(11, r.top) + 'px';
      m.title = c.comment;
      m.addEventListener('mouseenter', function () { showHighlight(target, '#' + (i + 1)); });
      m.addEventListener('mouseleave', hideHighlight);
      m.addEventListener('click', function () {
        state.collapsed = false;
        render();
      });
      markers.appendChild(m);
    });
  }
  var rafPending = false;
  function scheduleMarkers() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderMarkers();
      if (state.draft && composer) placeComposer(state.draft.target);
    });
  }
  window.addEventListener('scroll', scheduleMarkers, { capture: true, passive: true });
  window.addEventListener('resize', scheduleMarkers);

  // ─── Send ──────────────────────────────────────────────────────────────
  function pageUrl() {
    try {
      var url = new URL(location.href);
      url.searchParams.delete('__swarm-feedback');
      url.searchParams.delete('key');
      return url.toString();
    } catch (e) { return location.href; }
  }
  function errorMessage(status, body) {
    if (status === 401) return 'Your page session expired or is missing. Open this page from the swarm dashboard and try again.';
    if (status === 403) return 'This session cannot send feedback. Sign in to the swarm dashboard and open the page from there.';
    var detail = body && body.error ? ': ' + body.error : '';
    return 'Sending failed (' + status + detail + ').';
  }
  // Inside the dashboard, the parent SPA sends the comments with its own
  // bearer (apps/ui/src/pages/pages/[id]/feedback-bridge.ts), so the page
  // needs no viewer session. Elsewhere, fall back to the cookie-gated proxy.
  var bridge = null;
  var pending = {};
  var requestSeq = 0;
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || window.parent === window) return;
    var data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'swarm-feedback:host') {
      bridge = { target: e.source, origin: e.origin };
      return;
    }
    if (data.type === 'swarm-feedback:result' && pending[data.requestId]) {
      var done = pending[data.requestId];
      delete pending[data.requestId];
      done(data);
    }
  });
  function sendViaBridge(payload) {
    return new Promise(function (resolve, reject) {
      var requestId = 'fb' + (++requestSeq);
      var timer = setTimeout(function () {
        delete pending[requestId];
        reject({ message: 'The dashboard did not answer. Try again.' });
      }, 30000);
      pending[requestId] = function (data) {
        clearTimeout(timer);
        if (data.ok) resolve({ url: data.taskUrl });
        else reject({ message: 'Sending failed: ' + (data.error || 'unknown error') });
      };
      bridge.target.postMessage({ type: 'swarm-feedback:send', requestId: requestId, payload: payload }, bridge.origin);
    });
  }
  function sendViaProxy(payload) {
    return fetch('/@swarm/api/pages/' + encodeURIComponent(pageId) + '/feedback', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) throw { message: errorMessage(res.status, body) };
        return { url: body && body.task_url };
      });
    });
  }
  function send(note) {
    if (state.sending || state.comments.length === 0) return;
    state.sending = true;
    state.status = null;
    render();
    var payload = {
      pageUrl: pageUrl(),
      comments: state.comments.map(function (c) {
        return { selector: c.selector, tagName: c.tagName, text: c.text, html: c.html, comment: c.comment };
      }),
    };
    if (note && note.trim()) payload.note = note.trim();
    (bridge ? sendViaBridge(payload) : sendViaProxy(payload)).then(function (result) {
      state.comments = [];
      save();
      state.noteDraft = '';
      state.status = { ok: true, url: result && result.url };
    }).catch(function (err) {
      state.status = { ok: false, message: (err && err.message) || 'Sending failed.' };
    }).then(function () {
      state.sending = false;
      render();
    });
  }

  // ─── Panel ─────────────────────────────────────────────────────────────
  state.noteDraft = '';
  function render() {
    panel.textContent = '';
    panel.className = 'panel' + (state.collapsed ? ' collapsed' : '');

    var head = el('div', 'head');
    head.appendChild(el('span', 'title', 'Feedback'));
    head.appendChild(el('span', 'count', String(state.comments.length)));
    var toggle = el('button', 'icon', state.collapsed ? '▴' : '▾');
    toggle.type = 'button';
    toggle.title = state.collapsed ? 'Expand' : 'Collapse';
    toggle.addEventListener('click', function () { state.collapsed = !state.collapsed; render(); });
    head.appendChild(toggle);
    panel.appendChild(head);

    var body = el('div', 'body');
    var pick = el('button', state.selecting ? 'active' : '', state.selecting ? 'Selecting… (Esc to stop)' : 'Select an element');
    pick.type = 'button';
    pick.addEventListener('click', function () { setSelecting(!state.selecting); });
    body.appendChild(pick);

    if (state.comments.length === 0) {
      body.appendChild(el('div', 'hint', state.selecting
        ? 'Click any element on the page to comment on it.'
        : 'Pick elements on the page and leave a comment on each. Then send them to the swarm as one task.'));
    } else {
      var list = el('ol');
      state.comments.forEach(function (c, i) {
        var item = el('li');
        item.appendChild(el('span', 'num', String(i + 1)));
        var main = el('div', 'li-main');
        var target = findEl(c.selector);
        main.appendChild(el('div', 'sel' + (target ? '' : ' missing'), (target ? '' : '(not found) ') + c.selector));
        main.appendChild(el('div', 'text', c.comment));
        item.appendChild(main);
        var remove = el('button', 'icon', '×');
        remove.type = 'button';
        remove.title = 'Remove comment';
        remove.addEventListener('click', function () {
          state.comments.splice(i, 1);
          save();
          hideHighlight();
          render();
        });
        item.appendChild(remove);
        if (target) {
          item.addEventListener('mouseenter', function () { showHighlight(target, '#' + (i + 1)); });
          item.addEventListener('mouseleave', function () { if (!state.draft) hideHighlight(); });
          item.addEventListener('click', function (e) {
            if (e.target === remove) return;
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          });
        }
        list.appendChild(item);
      });
      body.appendChild(list);

      var note = el('textarea');
      note.placeholder = 'Overall note (optional)';
      note.value = state.noteDraft;
      note.addEventListener('input', function () { state.noteDraft = note.value; });
      body.appendChild(note);
    }

    if (state.status) {
      var status = el('div', 'status ' + (state.status.ok ? 'ok' : 'err'));
      if (state.status.ok) {
        status.appendChild(document.createTextNode('Sent to the swarm. '));
        if (state.status.url) {
          var link = el('a', '', 'Open task');
          link.href = state.status.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          status.appendChild(link);
        }
      } else {
        status.textContent = state.status.message;
      }
      body.appendChild(status);
    }

    var row = el('div', 'row');
    if (state.comments.length > 0) {
      var clear = el('button', '', 'Clear');
      clear.type = 'button';
      clear.disabled = state.sending;
      clear.addEventListener('click', function () {
        state.comments = [];
        save();
        render();
      });
      row.appendChild(clear);
    }
    var sendBtn = el('button', 'primary', state.sending ? 'Sending…' : 'Send to swarm');
    sendBtn.type = 'button';
    sendBtn.disabled = state.sending || state.comments.length === 0;
    sendBtn.addEventListener('click', function () { send(state.noteDraft); });
    row.appendChild(sendBtn);
    body.appendChild(row);

    panel.appendChild(body);
    renderMarkers();
  }

  function mount() {
    document.documentElement.appendChild(host);
    render();
    if (window.parent !== window) {
      try { window.parent.postMessage({ type: 'swarm-feedback:hello' }, '*'); } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
`;

/**
 * Script tags appended to a served HTML page when feedback mode is on. The
 * page id is a 32-char hex id, but it is JSON-encoded anyway so the bootstrap
 * stays safe if the id format ever changes.
 */
export function feedbackOverlayScripts(pageId: string): string {
  const config = JSON.stringify({ pageId }).replace(/</g, "\\u003c");
  return `<script>window.__swarmFeedback = ${config};</script><script>${FEEDBACK_OVERLAY_JS}</script>`;
}
