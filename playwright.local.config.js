// Local-only browser suite: production smoke projects are excluded.
// Every spec uses fixtures.js to intercept student API requests.
const config = require('./playwright.config');
module.exports = {
  ...config,
  projects: config.projects.filter(p => p.name !== 'v2smoke'),
  use: {...config.use, serviceWorkers: 'block'},
  webServer: {...config.webServer, stdout: 'ignore', stderr: 'ignore'},
  testIgnore: [/v2-smoke\.spec\.js/, /offline_exam\.spec\.js/],
};
