import pool from '../database/connectionPostgreSQL.js'

const getAll = async () => {
  try {
    // Verificamos primero si el esquema existe
    const schemaQuery = `
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name = 'restaurante'
    `;
    const schemaResult = await pool.query(schemaQuery);
    
    if (schemaResult.rows.length === 0) {
      throw new Error('El esquema restaurante no existe');
    }

    // Verificamos si la tabla existe
    const tableQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'restaurante' AND table_name = 'users'
    `;
    const tableResult = await pool.query(tableQuery);
    
    if (tableResult.rows.length === 0) {
      throw new Error('La tabla users no existe en el esquema restaurante');
    }

    // Si todo está bien, hacemos la consulta principal
    const query = `
      SELECT * FROM restaurante.users
    `;
    const { rows } = await pool.query(query);
    return rows;
  } catch (error) {
    console.error('Error detallado en getAll:', error);
    throw error;
  }
};

export const UserModel = {
  getAll
};
