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
  }
}

// Expose BOTH the class (for \`new SwarmSDK()\`) AND a ready-to-use singleton
// on \`window.swarmSdk\` so pages can call e.g. \`window.swarmSdk.agents.list()\`
// directly without instantiating.
window.SwarmSDK = SwarmSDK;
window.swarmSdk = new SwarmSDK();
`;
