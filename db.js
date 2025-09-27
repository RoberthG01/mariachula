import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: 'postgres',          // tu usuario
  host: 'localhost',
  database: 'mariachula',   // tu base de datos
  password: 'rudy2001',   // tu contraseña
  port: 5432,
});

export default pool;