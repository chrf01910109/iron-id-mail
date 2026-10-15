/**
 * Parses DATABASE_URL or PostgreSQL environment variables safely
 */
function getPostgresConfig() {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      return {
        host: u.hostname,
        port: parseInt(u.port, 10) || 5432,
        user: decodeURIComponent(u.username || 'postgres'),
        password: decodeURIComponent(u.password || ''),
        database: u.pathname.replace(/^\//, '') || 'railway'
      };
    } catch (err) {
      console.warn('[DB] Failed to parse DATABASE_URL:', err.message);
    }
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT, 10) || 5432,
    user: process.env.PGUSER || 'ironid',
    password: process.env.PGPASSWORD || 'IronIdSecretPass2026!',
    database: process.env.PGDATABASE || 'ironid_mail'
  };
}

if (require.main === module) {
  const cfg = getPostgresConfig();
  console.log(JSON.stringify(cfg));
}

module.exports = { getPostgresConfig };
