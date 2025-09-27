import pool from './db.js';

try {
  const res = await pool.query('SELECT * FROM restaurante.usuarios');
  console.log(res.rows);
} catch (err) {
  console.error(err);
} finally {
  pool.end();
}
