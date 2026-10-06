const fs = require('fs');
const path = require('path');
const { getPostgresConfig } = require('../services/dbUrlParser');

const cfg = getPostgresConfig();
const configJson = {
  "@type": "PostgreSql",
  "host": cfg.host,
  "port": cfg.port,
  "database": cfg.database,
  "authUsername": cfg.user,
  "authSecret": {
    "@type": "Value",
    "value": cfg.password
  },
  "poolMaxConnections": 16
};

const targetPath = process.env.CONFIG_PATH || '/opt/iron-id/config.json';
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, JSON.stringify(configJson, null, 2));
console.log(`[CONFIG] Generated Stalwart PostgreSQL config.json -> ${targetPath} (${cfg.host}:${cfg.port}/${cfg.database})`);
