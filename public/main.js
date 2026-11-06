import { mount } from './app.js';
import { getJson, subscribe } from './lib/api.js';

const app = mount(document.getElementById('app'), {
  getJson: (p) => getJson(p),
  subscribe: (cb) => subscribe('api/stream', cb),
});
app.load().catch((err) => {
  document.getElementById('app').textContent = `Failed to load: ${err.message}`;
});
