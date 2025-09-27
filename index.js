// index.js
import express from 'express';
import pool from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const app = express();
app.use(cors()); 
app.use(express.json());

// Clave secreta (en producción mover a variables de entorno)
const JWT_SECRET = 'mariachula_secreto_super_seguro';

// =======================
// Middleware verificar token
// =======================
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(403).json({ error: 'Acceso denegado. Token requerido.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado.' });
    req.user = user;
    next();
  });
}

// Middleware solo admin
function soloAdmin(req, res, next) {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado: solo administradores' });
  }
  next();
}

// =======================
// LISTAR USUARIOS
// =======================
app.get('/usuarios', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.estado, r.nombre_rol AS rol
      FROM restaurante.usuarios u
      LEFT JOIN restaurante.usuario_rol ur ON u.id_usuario = ur.id_usuario
      LEFT JOIN restaurante.roles r ON ur.id_rol = r.id_rol
      ORDER BY u.id_usuario
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// =======================
// OBTENER USUARIO POR ID
// =======================
app.get('/usuarios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.estado, r.nombre_rol AS rol
      FROM restaurante.usuarios u
      LEFT JOIN restaurante.usuario_rol ur ON u.id_usuario = ur.id_usuario
      LEFT JOIN restaurante.roles r ON ur.id_rol = r.id_rol
      WHERE u.id_usuario = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// =======================
// CREAR USUARIO
// =======================
app.post('/usuarios', async (req, res) => {
  try {
    const { nombre, apellido, correo, password, telefono, estado, rol } = req.body;

    if (!nombre || !apellido || !correo || !password || !rol) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (incluyendo rol)' });
    }

    // Encriptar contraseña
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Crear usuario
    const resultUsuario = await pool.query(
      `INSERT INTO restaurante.usuarios 
       (nombre, apellido, correo, password, telefono, estado) 
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_usuario, nombre, apellido, correo, estado`,
      [nombre, apellido, correo, hashedPassword, telefono, estado]
    );
    const nuevoUsuario = resultUsuario.rows[0];

    // Obtener id_rol según el nombre
    const resultRol = await pool.query(
      `SELECT id_rol FROM restaurante.roles WHERE nombre_rol = $1`,
      [rol]
    );
    if (resultRol.rows.length === 0) {
      return res.status(400).json({ error: 'Rol no válido' });
    }
    const idRol = resultRol.rows[0].id_rol;

    // Insertar relación en usuario_rol
    await pool.query(
      `INSERT INTO restaurante.usuario_rol (id_usuario, id_rol) VALUES ($1, $2)`,
      [nuevoUsuario.id_usuario, idRol]
    );

    res.status(201).json({ ...nuevoUsuario, rol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// =======================
// ACTUALIZAR USUARIO
// =======================
app.put('/usuarios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, correo, password, telefono, estado, rol } = req.body;

    let hashedPassword = null;
    if (password) {
      const saltRounds = 10;
      hashedPassword = await bcrypt.hash(password, saltRounds);
    }

    const resultUsuario = await pool.query(
      `UPDATE restaurante.usuarios 
       SET nombre=$1, apellido=$2, correo=$3,
           password=COALESCE($4, password),
           telefono=$5, estado=$6
       WHERE id_usuario=$7
       RETURNING id_usuario, nombre, apellido, correo, estado`,
      [nombre, apellido, correo, hashedPassword, telefono, estado, id]
    );

    if (resultUsuario.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (rol) {
      const resultRol = await pool.query(
        `SELECT id_rol FROM restaurante.roles WHERE nombre_rol=$1`,
        [rol]
      );
      if (resultRol.rows.length === 0) {
        return res.status(400).json({ error: 'Rol no válido' });
      }
      const idRol = resultRol.rows[0].id_rol;

      await pool.query(
        `UPDATE restaurante.usuario_rol SET id_rol=$1 WHERE id_usuario=$2`,
        [idRol, id]
      );
    }

    res.json({ ...resultUsuario.rows[0], rol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// =======================
// ELIMINAR USUARIO
// =======================
app.delete('/usuarios/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(`DELETE FROM restaurante.usuario_rol WHERE id_usuario=$1`, [id]);
    const result = await pool.query(
      `DELETE FROM restaurante.usuarios WHERE id_usuario=$1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ mensaje: 'Usuario eliminado correctamente', usuario: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

// =======================
// LOGIN
// =======================
app.post('/login', async (req, res) => {
  try {
    const { correo, password } = req.body;

    if (!correo || !password) {
      return res.status(400).json({ error: 'Correo y contraseña requeridos' });
    }

    const result = await pool.query(
      `SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.password, u.estado, r.nombre_rol AS rol
       FROM restaurante.usuarios u
       LEFT JOIN restaurante.usuario_rol ur ON u.id_usuario = ur.id_usuario
       LEFT JOIN restaurante.roles r ON ur.id_rol = r.id_rol
       WHERE u.correo = $1`,
      [correo]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      {
        id: user.id_usuario,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      mensaje: 'Login exitoso',
      token,
      usuario: {
        id: user.id_usuario,
        nombre: user.nombre,
        apellido: user.apellido,
        correo: user.correo,
        estado: user.estado,
        rol: user.rol
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el login' });
  }
});

// =======================
// Servidor
// =======================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
