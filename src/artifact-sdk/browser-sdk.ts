// This is a string template that gets served as JavaScript to the browser
export const BROWSER_SDK_JS = `
class SwarmSDK {
  constructor() {
    this._configPromise = fetch('/@swarm/config').then(r => r.json());
  }

  async createTask(opts) { return this._post('/@swarm/api/tasks', opts); }
  async getTasks(filters) { return this._get('/@swarm/api/tasks?' + new URLSearchParams(filters)); }
  async getTaskDetails(id) { return this._get('/@swarm/api/tasks/' + id); }
  async storeProgress(taskId, data) { return this._post('/@swarm/api/tasks/' + taskId + '/progress', data); }
  async postMessage(opts) { return this._post('/@swarm/api/messages', opts); }
  async readMessages(opts) { return this._get('/@swarm/api/messages?' + new URLSearchParams(opts)); }
  async getSwarm() { return this._get('/@swarm/api/agents'); }
  async listServices() { return this._get('/@swarm/api/services'); }
  async listEpics(opts) { return this._get('/@swarm/api/epics?' + new URLSearchParams(opts || {})); }
  async slackReply(opts) { return this._post('/@swarm/api/slack/reply', opts); }

  async _post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  async _get(url) {
    const res = await fetch(url);
    return res.json();
  }
}

window.SwarmSDK = SwarmSDK;
`;
