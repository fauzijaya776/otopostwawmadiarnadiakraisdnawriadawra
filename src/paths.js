'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  session: process.env.SESSION_DIR || path.join(ROOT, 'session'),
  media: path.join(ROOT, 'media'),
  data: path.join(ROOT, 'data'),
  state: path.join(ROOT, 'data', 'state.json'),
  pairingState: path.join(ROOT, 'data', 'pairing.json'),
  groupsJson: path.join(ROOT, 'groups.json'),
};

for (const dir of [PATHS.session, PATHS.media, PATHS.data]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { PATHS, ROOT };
