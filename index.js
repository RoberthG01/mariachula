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

    // Obtener id_rol según el nombre (case-insensitive)
    const resultRol = await pool.query(
      `SELECT id_rol FROM restaurante.roles WHERE LOWER(nombre_rol) = LOWER($1)`,
      [rol]
    );
    if (resultRol.rows.length === 0) {
      return res.status(400).json({ error: 'Rol no válido' });
    }
    const idRol = resultRol.rows[0].id_rol;

    // Insertar relación usuario ↔ rol
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

    // Actualizar datos del usuario
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

    let rolAsignado = null;
    if (rol) {
      const resultRol = await pool.query(
        `SELECT id_rol FROM restaurante.roles WHERE LOWER(nombre_rol) = LOWER($1)`,
        [rol]
      );
      if (resultRol.rows.length === 0) {
        return res.status(400).json({ error: 'Rol no válido' });
      }
      const idRol = resultRol.rows[0].id_rol;

      // UPSERT en usuario_rol
      await pool.query(
        `INSERT INTO restaurante.usuario_rol (id_usuario, id_rol)
         VALUES ($1, $2)
         ON CONFLICT (id_usuario)
         DO UPDATE SET id_rol = EXCLUDED.id_rol`,
        [id, idRol]
      );

      rolAsignado = rol;
    }

    res.json({ ...resultUsuario.rows[0], rol: rolAsignado });
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

    // Traer usuario + rol desde la BD
    const result = await pool.query(
      `SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.password, u.estado, 
              COALESCE(r.nombre_rol, 'Sin rol') AS rol
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

    // Validar contraseña
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Generar token con rol incluido
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

// ----------------------
// INSUMOS (CRUD) - para administrar materias primas
// ----------------------

// Listar insumos (datos base; stock real se calculará en /inventario)
app.get('/insumos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id_insumo, nombre, descripcion, stock, unidad_medida, estado FROM restaurante.insumos ORDER BY id_insumo');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

// Crear insumo
app.post('/insumos', verificarToken, async (req, res) => {
  try {
    const { nombre, descripcion = null, stock = 0, unidad_medida = 'u', estado = 'activo' } = req.body;
    if (!nombre || unidad_medida == null) return res.status(400).json({ error: 'Faltan campos obligatorios' });

    const result = await pool.query(
      `INSERT INTO restaurante.insumos (nombre, descripcion, stock, unidad_medida, estado)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nombre, descripcion, stock, unidad_medida, estado]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear insumo' });
  }
});

// Actualizar insumo
app.put('/insumos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, stock, unidad_medida, estado } = req.body;

    const result = await pool.query(
      `UPDATE restaurante.insumos
       SET nombre=$1, descripcion=$2, stock=COALESCE($3, stock), unidad_medida=$4, estado=$5
       WHERE id_insumo=$6 RETURNING *`,
      [nombre, descripcion, stock, unidad_medida, estado, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar insumo' });
  }
});

// Eliminar insumo (borra también movimientos relacionados)
app.delete('/insumos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM restaurante.inventario_movimientos WHERE id_insumo=$1', [id]);
    const result = await pool.query('DELETE FROM restaurante.insumos WHERE id_insumo=$1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json({ mensaje: 'Insumo eliminado', insumo: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar insumo' });
  }
});

// ----------------------
// INVENTARIO: stock calculado y movimientos
// ----------------------

// Obtener inventario (insumos con stock calculado usando movimientos + stock inicial)
app.get('/inventario', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id_insumo, i.nombre, i.descripcion, i.unidad_medida, i.estado, i.stock AS stock_inicial,
             COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'entrada' THEN m.cantidad
                               WHEN m.tipo_movimiento = 'salida' THEN -m.cantidad
                               ELSE 0 END), 0) AS movimientos_total,
             (COALESCE(i.stock,0) + COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'entrada' THEN m.cantidad
                               WHEN m.tipo_movimiento = 'salida' THEN -m.cantidad
                               ELSE 0 END), 0)) AS stock_actual
      FROM restaurante.insumos i
      LEFT JOIN restaurante.inventario_movimientos m ON i.id_insumo = m.id_insumo
      GROUP BY i.id_insumo, i.nombre, i.descripcion, i.unidad_medida, i.estado, i.stock
      ORDER BY i.id_insumo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener inventario' });
  }
});

// Registrar movimiento (entrada / salida)
app.post('/inventario/movimiento', verificarToken, async (req, res) => {
  try {
    const { id_insumo, tipo_movimiento, cantidad, observacion = null } = req.body;
    if (!id_insumo || !tipo_movimiento || cantidad == null) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    const tipo = tipo_movimiento.toString().toLowerCase();
    if (tipo !== 'entrada' && tipo !== 'salida') {
      return res.status(400).json({ error: 'tipo_movimiento debe ser "entrada" o "salida"' });
    }

    // Insertar movimiento
    const result = await pool.query(
      `INSERT INTO restaurante.inventario_movimientos (id_insumo, tipo_movimiento, cantidad, fecha, observacion)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
      [id_insumo, tipo, cantidad, observacion]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  }
});

// =======================
// Servidor
// =======================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});