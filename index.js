// index.js
import express from 'express';
import pool from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Aumentar límite para imágenes base64

// Clave secreta (en producción mover a variables de entorno)
const JWT_SECRET = 'mariachula_secreto_super_seguro';

// ===============================
// Middleware para verificar token
// ===============================
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader;

  // Si el token incluye "Bearer ", extraer solo el token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

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
// Middleware solo admin (acepta variaciones de texto)
function soloAdmin(req, res, next) {
  if (!req.user || !req.user.rol || req.user.rol.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado: solo administradores' });
  }
  next();
}

// --- Middleware: solo meseros ---
function soloMesero(req, res, next) {
  if (!req.user || !req.user.rol || req.user.rol.toLowerCase() !== 'mesero') {
    return res.status(403).json({ error: 'Acceso denegado: solo meseros' });
  }
  next();
}

// --- Middleware: solo cocineros ---
function soloCocinero(req, res, next) {
  if (!req.user || !req.user.rol || req.user.rol.toLowerCase() !== 'cocinero') {
    return res.status(403).json({ error: 'Acceso denegado: solo cocineros' });
  }
  next();
}

// =======================
// USUARIOS
// =======================

// Listar usuarios (con rol si existe)
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

// Obtener usuario por id
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

// Crear usuario (y asignar rol por nombre)
app.post('/usuarios', async (req, res) => {
  try {
    const { nombre, apellido, correo, password, telefono = null, estado = 'activo', rol } = req.body;

    if (!nombre || !apellido || !correo || !password || !rol) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (incluyendo rol)' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const resultUsuario = await pool.query(
      `INSERT INTO restaurante.usuarios 
       (nombre, apellido, correo, password, telefono, estado)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_usuario, nombre, apellido, correo, estado`,
      [nombre, apellido, correo, hashedPassword, telefono, estado]
    );
    const nuevoUsuario = resultUsuario.rows[0];

    // Buscar id_rol (case-insensitive)
    const resultRol = await pool.query(
      `SELECT id_rol FROM restaurante.roles WHERE LOWER(nombre_rol) = LOWER($1)`,
      [rol]
    );
    if (resultRol.rows.length === 0) {
      // Si no existe el rol, eliminar el usuario creado para mantener consistencia
      await pool.query('DELETE FROM restaurante.usuarios WHERE id_usuario=$1', [nuevoUsuario.id_usuario]);
      return res.status(400).json({ error: 'Rol no válido' });
    }
    const idRol = resultRol.rows[0].id_rol;

    // Insertar en usuario_rol
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

// Actualizar usuario (y rol)
app.put('/usuarios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, correo, password, telefono = null, estado = 'activo', rol } = req.body;

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

      // Upsert en usuario_rol: si ya existe relación, update; si no, insert
      try {
        await pool.query(
          `INSERT INTO restaurante.usuario_rol (id_usuario, id_rol)
           VALUES ($1, $2)
           ON CONFLICT (id_usuario)
           DO UPDATE SET id_rol = EXCLUDED.id_rol`,
          [id, idRol]
        );
      } catch (upsertErr) {
        // Si falla por ausencia de constraint ON CONFLICT, hacemos UPDATE y si no existe hacemos INSERT
        if (upsertErr && upsertErr.code === '42P10') {
          // no existe índice para ON CONFLICT -> fallback
          const upd = await pool.query(`UPDATE restaurante.usuario_rol SET id_rol=$1 WHERE id_usuario=$2 RETURNING *`, [idRol, id]);
          if (upd.rows.length === 0) {
            await pool.query(`INSERT INTO restaurante.usuario_rol (id_usuario, id_rol) VALUES ($1, $2)`, [id, idRol]);
          }
        } else {
          throw upsertErr;
        }
      }

      rolAsignado = rol;
    }

    res.json({ ...resultUsuario.rows[0], rol: rolAsignado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// Eliminar usuario (solo admin)
app.delete('/usuarios/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(`DELETE FROM restaurante.usuario_rol WHERE id_usuario=$1`, [id]);
    const result = await pool.query(`DELETE FROM restaurante.usuarios WHERE id_usuario=$1 RETURNING *`, [id]);

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

    // Traer usuario + rol
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

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      {
        id: user.id_usuario,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol ? user.rol.toLowerCase() : 'usuario'
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
// INSUMOS (CRUD)
// ----------------------
app.get('/insumos', verificarToken, async (req, res) => {
  try {
    // Retornamos la información base del insumo. El stock "real" se calcula en /inventario.
    const result = await pool.query(`
      SELECT id_insumo, nombre, descripcion, stock, unidad_medida, estado
      FROM restaurante.insumos
      ORDER BY id_insumo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

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

app.delete('/insumos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    // borrar movimientos asociados
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
// INVENTARIO: stock calculado y último movimiento (solo en la consulta)
// ----------------------
app.get('/inventario', verificarToken, async (req, res) => {
  try {
    // Calcula stock_actual = stock inicial + sum(movimientos)
    // además trae la fecha y tipo del último movimiento (si existe)
    const result = await pool.query(`
      SELECT i.id_insumo,
             i.nombre,
             i.descripcion,
             i.unidad_medida,
             i.estado,
             i.stock AS stock_inicial,
             COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'entrada' THEN m.cantidad
                               WHEN m.tipo_movimiento = 'salida' THEN -m.cantidad
                               ELSE 0 END), 0) AS movimientos_total,
             (COALESCE(i.stock,0) + COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'entrada' THEN m.cantidad
                               WHEN m.tipo_movimiento = 'salida' THEN -m.cantidad
                               ELSE 0 END), 0)) AS stock_actual,
             -- fecha del último movimiento
             (SELECT m2.fecha FROM restaurante.inventario_movimientos m2 WHERE m2.id_insumo = i.id_insumo ORDER BY m2.fecha DESC LIMIT 1) AS last_movement,
             (SELECT m3.tipo_movimiento FROM restaurante.inventario_movimientos m3 WHERE m3.id_insumo = i.id_insumo ORDER BY m3.fecha DESC LIMIT 1) AS last_tipo
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

// ----------------------
// CLIENTES (ejemplos)
// ----------------------
app.get('/clientes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id_cliente, nombre, apellido, telefono, direccion, correo FROM restaurante.clientes ORDER BY id_cliente`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

app.post('/clientes', verificarToken, async (req, res) => {
  try {
    const { nombre, apellido, telefono = null, direccion = null, correo = null } = req.body;
    if (!nombre || !apellido) return res.status(400).json({ error: 'Faltan campos obligatorios' });
    const result = await pool.query(
      `INSERT INTO restaurante.clientes (nombre, apellido, telefono, direccion, correo, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [nombre, apellido, telefono, direccion, correo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ----------------------
// PEDIDOS Y DETALLES (resumido, ya lo tenías)
// ----------------------
app.get('/pedidos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id_pedido, p.fecha, p.estado, p.total,
             c.nombre || ' ' || c.apellido AS cliente
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      ORDER BY p.id_pedido DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

app.post('/pedidos', verificarToken, soloMesero, async (req, res) => {
  try {
    const { id_cliente, id_usuario, tipo_pedido = null, estado = 'pendiente', total = 0 } = req.body;
    if (!id_cliente || !id_usuario) return res.status(400).json({ error: 'Faltan cliente o usuario' });

    const result = await pool.query(
      `INSERT INTO restaurante.pedidos (id_cliente, id_usuario, tipo_pedido, estado, total, fecha)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [id_cliente, id_usuario, tipo_pedido, estado, total]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

app.get('/detalle_pedido/:id_pedido', verificarToken, async (req, res) => {
  try {
    const { id_pedido } = req.params;
    const result = await pool.query(
      `SELECT d.id_detalle, d.cantidad, d.precio_unitario, d.subtotal,
              pr.nombre AS producto
       FROM restaurante.detalle_pedido d
       LEFT JOIN restaurante.productos pr ON d.id_producto = pr.id_producto
       WHERE d.id_pedido=$1`,
      [id_pedido]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener detalle de pedido' });
  }
});

app.post('/detalle_pedido', verificarToken, async (req, res) => {
  try {
    const { id_pedido, id_producto, cantidad, precio_unitario } = req.body;
    if (!id_pedido || !id_producto || !cantidad || !precio_unitario) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    const subtotal = cantidad * precio_unitario;
    const result = await pool.query(
      `INSERT INTO restaurante.detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id_pedido, id_producto, cantidad, precio_unitario, subtotal]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear detalle de pedido' });
  }
});

// ====================================================
// MENÚ (categorías, items y sus ingredientes) - CORREGIDO
// ====================================================

// ----------------------
// CATEGORÍAS DEL MENÚ - CORREGIDO
// ----------------------
app.get('/categorias_menu', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_categoria, nombre_categoria, descripcion
      FROM restaurante.categorias_menu
      ORDER BY id_categoria
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener categorías del menú' });
  }
});

app.post('/categorias_menu', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { nombre_categoria, descripcion = null } = req.body;
    if (!nombre_categoria) return res.status(400).json({ error: 'El nombre de la categoría es obligatorio' });

    const result = await pool.query(`
      INSERT INTO restaurante.categorias_menu (nombre_categoria, descripcion)
      VALUES ($1, $2) RETURNING *
    `, [nombre_categoria, descripcion]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear categoría de menú' });
  }
});

app.put('/categorias_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_categoria, descripcion } = req.body;
    const result = await pool.query(`
      UPDATE restaurante.categorias_menu
      SET nombre_categoria=$1, descripcion=$2
      WHERE id_categoria=$3 RETURNING *
    `, [nombre_categoria, descripcion, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar categoría de menú' });
  }
});

app.delete('/categorias_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // eliminar también items dependientes si lo deseas
    await pool.query('DELETE FROM restaurante.menu_items WHERE id_categoria=$1', [id]);
    const result = await pool.query('DELETE FROM restaurante.categorias_menu WHERE id_categoria=$1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ mensaje: 'Categoría eliminada', categoria: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar categoría de menú' });
  }
});

// ----------------------
// ITEMS DEL MENÚ - CORREGIDO (AGREGADO id_categoria)
// ----------------------
app.get('/menu_items', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id_item, m.nombre, m.descripcion, m.precio, m.estado, m.img,
             c.nombre_categoria, m.id_categoria
      FROM restaurante.menu_items m
      LEFT JOIN restaurante.categorias_menu c ON m.id_categoria = c.id_categoria
      ORDER BY m.id_item
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener items del menú' });
  }
});

app.post('/menu_items', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id_categoria, nombre, descripcion = null, precio, estado = 'disponible', img = null } = req.body;
    if (!id_categoria || !nombre || precio == null) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const result = await pool.query(`
      INSERT INTO restaurante.menu_items (id_categoria, nombre, descripcion, precio, estado, img)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id_categoria, nombre, descripcion, precio, estado, img]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear item de menú' });
  }
});

app.put('/menu_items/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { id_categoria, nombre, descripcion, precio, estado, img } = req.body;
    const result = await pool.query(`
      UPDATE restaurante.menu_items
      SET id_categoria=$1, nombre=$2, descripcion=$3, precio=$4, estado=$5, img=$6
      WHERE id_item=$7 RETURNING *
    `, [id_categoria, nombre, descripcion, precio, estado, img, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar item del menú' });
  }
});

app.delete('/menu_items/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM restaurante.ingredientes_menu WHERE id_item=$1', [id]);
    const result = await pool.query('DELETE FROM restaurante.menu_items WHERE id_item=$1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    res.json({ mensaje: 'Item eliminado', item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar item del menú' });
  }
});

// ----------------------
// INGREDIENTES DE UN ITEM
// ----------------------
app.get('/ingredientes_menu/:id_item', verificarToken, async (req, res) => {
  try {
    const { id_item } = req.params;
    const result = await pool.query(`
      SELECT i.id_ingrediente, i.cantidad_requerida,
             ins.nombre AS insumo, ins.unidad_medida
      FROM restaurante.ingredientes_menu i
      LEFT JOIN restaurante.insumos ins ON i.id_insumo = ins.id_insumo
      WHERE i.id_item = $1
    `, [id_item]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener ingredientes del item' });
  }
});

app.post('/ingredientes_menu', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id_item, id_insumo, cantidad_requerida } = req.body;
    if (!id_item || !id_insumo || !cantidad_requerida) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    const result = await pool.query(`
      INSERT INTO restaurante.ingredientes_menu (id_item, id_insumo, cantidad_requerida)
      VALUES ($1, $2, $3) RETURNING *
    `, [id_item, id_insumo, cantidad_requerida]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al agregar ingrediente' });
  }
});

app.delete('/ingredientes_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM restaurante.ingredientes_menu WHERE id_ingrediente=$1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ingrediente no encontrado' });
    res.json({ mensaje: 'Ingrediente eliminado', ingrediente: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar ingrediente' });
  }
});

// =======================
// RUTA DE PRUEBA PARA VERIFICAR SERVIDOR
// =======================
app.get('/', (req, res) => {
  res.json({ 
    mensaje: 'Servidor María Chula funcionando',
    rutas: {
      categorias: '/categorias_menu',
      menu_items: '/menu_items',
      login: '/login (POST)',
      usuarios: '/usuarios'
    }
  });
});

// =======================
// MANEJO DE ERRORES GLOBAL
// =======================
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ----------------------
// COLA DEL CHEF
// ----------------------
app.get('/cola_chef', verificarToken, soloCocinero, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id_pedido, p.fecha, p.estado, 
             c.nombre || ' ' || c.apellido AS cliente
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c 
             ON p.id_cliente = c.id_cliente
      WHERE p.estado IN ('pendiente', 'en preparación')
      ORDER BY p.fecha ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la cola del chef' });
  }
});

// =======================
// INICIAR SERVIDOR
// =======================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Ruta de prueba: http://localhost:${PORT}/`);
  console.log(`Ruta de categorías: http://localhost:${PORT}/categorias_menu`);
  console.log(`Ruta de menú items: http://localhost:${PORT}/menu_items`);
});