/**
 * IRON ID Sovereign Email — Root Entrypoint
 * Bridges Railway / Node runtimes directly to the Webmail & Admin Gateway
 */
const path = require('path');
process.chdir(path.join(__dirname, 'webmail'));
require('./webmail/server.js');
