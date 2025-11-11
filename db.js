import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: 'postgres',          // mi usuario
  host: 'localhost',
  database: 'mariachula',   // mi base de datos
  password: 'rudy2001',   // mi contraseñaa
  port: 5432,
});

export default pool;