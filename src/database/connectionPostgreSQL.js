import pkg from 'pg';
const { Pool } = pkg;
import 'dotenv/config';

// Imprimir las variables de entorno para debug (quitar en producción)
console.log('Configuración DB:', {
  user: process.env.DB_USER,
  host: process.env.HOST,
  database: process.env.DATABASE,
  port: process.env.PORT_DB
  // No imprimir la contraseña por seguridad
});

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.PASSWORD,
  host: process.env.HOST,
  port: process.env.PORT_DB,
  database: process.env.DATABASE
});

// Verificar conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error detallado de conexión:', err);
    return;
  }
  console.log('Conexión exitosa a la base de datos PostgreSQL');
  release();
});

export default pool;