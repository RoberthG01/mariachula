// index.js
import express from 'express';
import pool from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
// ==================================
// Importar nodemailer y dotenv para recuperación de contraseña
// ==================================
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const app = express();

// ==================================
// CONFIGURACIÓN CORS PARA DESARROLLO
// ==================================
app.use(cors({
  origin: function (origin, callback) {
      // En desarrollo, permitir todos los origenes
      if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
          callback(null, true);
          return;
      }
      
      // En producción, restringir a origenes específicos
      const allowedOrigins = [
          'https://tudominio.com', // Tu dominio de producción
      ];
      
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
          callback(null, true);
      } else {
          console.log('Bloqueado por CORS:', origin);
          callback(new Error('Not allowed by CORS'));
      }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Manejar preflight requests
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));

// ==================================
// CONFIGURACIÓN Y CONSTANTES (ACTUALIZADO)
// ==================================
const JWT_SECRET = process.env.JWT_SECRET || 'mariachula_secreto_super_seguro';
const PORT = process.env.PORT || 5000;

// ==================================
// CONFIGURACIÓN DE CORREO ELECTRÓNICO
// ==================================
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ==================================
// ALMACENAMIENTO TEMPORAL DE CÓDIGOS DE RECUPERACIÓN
// ==================================
const codigosRecuperacion = new Map();

// ==================================
// GENERAR CÓDIGO DE VERIFICACIÓN
// ==================================
function generarCodigoVerificacion() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================================
// MIDDLEWARES DE AUTENTICACIÓN
// ==================================

// Middleware para verificar el token JWT
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader;

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

// Middleware para verificar roles
function crearMiddlewareRol(rolRequerido) {
  return (req, res, next) => {
    if (!req.user || !req.user.rol) {
      return res.status(403).json({ error: 'Acceso denegado: usuario sin rol válido' });
    }

    const rolUsuario = req.user.rol.toLowerCase();
    const rolRequeridoLower = rolRequerido.toLowerCase();

    // ✅ Si el usuario es admin, puede acceder a cualquier ruta
    if (rolUsuario === 'admin') {
      return next();
    }

    // Solo permite si el rol coincide exactamente con el requerido
    if (rolUsuario !== rolRequeridoLower) {
      return res.status(403).json({ error: `Acceso denegado: solo ${rolRequeridoLower}s` });
    }

    next();
  };
}

const soloAdmin = crearMiddlewareRol('admin');
const soloMesero = crearMiddlewareRol('mesero');
const soloCocinero = crearMiddlewareRol('cocinero');

// ==================================
// UTILIDADES DE BASE DE DATOS
// ==================================

// Función helper para manejo de errores de consulta
async function ejecutarConsulta(consulta, parametros = []) {
  try {
    const result = await pool.query(consulta, parametros);
    return result;
  } catch (error) {
    console.error('Error en consulta:', error);
    throw error;
  }
}

// ==================================
// RUTAS DE CAJA REGISTRADORA
// ==================================

// Obtener estado actual de la caja
app.get('/api/cash-register/status', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT id_caja, fecha_apertura, fecha_cierre, monto_inicial, monto_final, estado
      FROM restaurante.caja 
      WHERE estado = 'abierta'
      ORDER BY fecha_apertura DESC 
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No hay caja abierta' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener estado de caja:', error);
    res.status(500).json({ error: 'Error al obtener estado de caja' });
  }
});

// Abrir caja
app.post('/api/cash-register/open', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { monto_inicial } = req.body;
    const id_usuario = req.user.id;

    if (!monto_inicial || monto_inicial <= 0) {
      return res.status(400).json({ error: 'Monto inicial debe ser mayor a 0' });
    }

    await client.query('BEGIN');

    // Verificar si ya hay una caja abierta
    const cajaAbierta = await client.query(
      'SELECT id_caja FROM restaurante.caja WHERE estado = $1',
      ['abierta']
    );

    if (cajaAbierta.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ya existe una caja abierta' });
    }

    // Abrir nueva caja
    const result = await client.query(
      `INSERT INTO restaurante.caja 
       (fecha_apertura, monto_inicial, estado) 
       VALUES (NOW(), $1, $2) 
       RETURNING id_caja, fecha_apertura, monto_inicial, estado`,
      [monto_inicial, 'abierta']
    );

    // Registrar movimiento de apertura
    await client.query(
      `INSERT INTO restaurante.movimientos_caja 
       (id_caja, tipo_movimiento, monto, descripcion, fecha) 
       VALUES ($1, $2, $3, $4, NOW())`,
      [result.rows[0].id_caja, 'apertura', monto_inicial, 'Apertura de caja']
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al abrir caja:', error);
    res.status(500).json({ error: 'Error al abrir caja' });
  } finally {
    client.release();
  }
});

// Cerrar caja
app.post('/api/cash-register/close', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener caja abierta
    const cajaResult = await client.query(
      `SELECT id_caja, monto_inicial 
       FROM restaurante.caja 
       WHERE estado = $1 
       ORDER BY fecha_apertura DESC 
       LIMIT 1`,
      ['abierta']
    );

    if (cajaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No hay caja abierta para cerrar' });
    }

    const caja = cajaResult.rows[0];

    // Calcular total de ventas del día
    const ventasResult = await client.query(
      `SELECT COALESCE(SUM(total), 0) as total_ventas
       FROM restaurante.facturas 
       WHERE fecha::date = CURRENT_DATE 
       AND estado = 'pagada'`
    );

    const totalVentas = parseFloat(ventasResult.rows[0].total_ventas);
    const montoFinal = parseFloat(caja.monto_inicial) + totalVentas;

    // Cerrar caja
    const updateResult = await client.query(
      `UPDATE restaurante.caja 
       SET fecha_cierre = NOW(), monto_final = $1, estado = $2 
       WHERE id_caja = $3 
       RETURNING *`,
      [montoFinal, 'cerrada', caja.id_caja]
    );

    // Registrar movimiento de cierre
    await client.query(
      `INSERT INTO restaurante.movimientos_caja 
       (id_caja, tipo_movimiento, monto, descripcion, fecha) 
       VALUES ($1, $2, $3, $4, NOW())`,
      [caja.id_caja, 'cierre', montoFinal, 'Cierre de caja']
    );

    await client.query('COMMIT');
    res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al cerrar caja:', error);
    res.status(500).json({ error: 'Error al cerrar caja' });
  } finally {
    client.release();
  }
});

// Registrar venta en caja
app.post('/api/cash-register/sales', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id_caja, total, recibido, cambio } = req.body;
    const id_usuario = req.user.id;

    if (!id_caja || !total || !recibido || cambio === undefined) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    if (recibido < total) {
      return res.status(400).json({ error: 'Monto recibido insuficiente' });
    }

    await client.query('BEGIN');

    // Verificar que la caja esté abierta
    const cajaResult = await client.query(
      'SELECT id_caja FROM restaurante.caja WHERE id_caja = $1 AND estado = $2',
      [id_caja, 'abierta']
    );

    if (cajaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Caja no está abierta' });
    }

    // Registrar movimiento de venta
    const movimientoResult = await client.query(
      `INSERT INTO restaurante.movimientos_caja 
       (id_caja, tipo_movimiento, monto, descripcion, fecha) 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING *`,
      [id_caja, 'venta', total, `Venta registrada - Recibido: Q${recibido}, Cambio: Q${cambio}`]
    );

    // Crear factura automáticamente
    const facturaResult = await client.query(
      `INSERT INTO restaurante.facturas 
       (id_pedido, fecha, total, metodo_pago, estado) 
       VALUES ($1, NOW(), $2, $3, $4) 
       RETURNING *`,
      [null, total, 'efectivo', 'pagada']
    );

    await client.query('COMMIT');

    res.status(201).json({
      movimiento: movimientoResult.rows[0],
      factura: facturaResult.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al registrar venta:', error);
    res.status(500).json({ error: 'Error al registrar venta' });
  } finally {
    client.release();
  }
});

// Obtener movimientos de caja
app.get('/api/cash-register/movements', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT mc.id_movimiento, mc.tipo_movimiento, mc.monto, mc.descripcion, mc.fecha,
             c.estado as estado_caja
      FROM restaurante.movimientos_caja mc
      INNER JOIN restaurante.caja c ON mc.id_caja = c.id_caja
      WHERE c.estado = 'abierta'
      ORDER BY mc.fecha DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener movimientos:', error);
    res.status(500).json({ error: 'Error al obtener movimientos de caja' });
  }
});

// Obtener ventas del día actual
app.get('/api/cash-register/today-sales', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT COALESCE(SUM(mc.monto), 0) as total
      FROM restaurante.movimientos_caja mc
      INNER JOIN restaurante.caja c ON mc.id_caja = c.id_caja
      WHERE c.estado = 'abierta' 
      AND mc.tipo_movimiento = 'venta'
      AND mc.fecha::date = CURRENT_DATE
    `);

    res.json({ total: parseFloat(result.rows[0].total) });
  } catch (error) {
    console.error('Error al obtener ventas del día:', error);
    res.status(500).json({ error: 'Error al obtener ventas del día' });
  }
});

// ==================================
// RUTAS DE RECUPERACIÓN DE CONTRASEÑA
// ==================================

// Enviar código de recuperación por email
app.post('/api/send-recovery-code', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'El correo electrónico es requerido' });
        }

        // Verificar si el email existe en la base de datos
        const result = await ejecutarConsulta(
            'SELECT id_usuario, nombre, correo FROM restaurante.usuarios WHERE correo = $1 AND estado = $2',
            [email, 'activo']
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No se encontró una cuenta activa con este correo electrónico' });
        }

        const usuario = result.rows[0];
        
        // Generar código de verificación
        const codigo = generarCodigoVerificacion();
        
        // Guardar código temporalmente (expira en 5 minutos)
        codigosRecuperacion.set(email, {
            codigo: codigo,
            expiracion: Date.now() + 5 * 60 * 1000, // 5 minutos
            idUsuario: usuario.id_usuario
        });

        // Configurar email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Código de Recuperación - María Chula',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Recuperación de Contraseña</h2>
                    <p>Hola <strong>${usuario.nombre}</strong>,</p>
                    <p>Has solicitado restablecer tu contraseña en María Chula.</p>
                    <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                        <h3 style="color: #333; margin: 0;">Tu código de verificación es:</h3>
                        <div style="font-size: 32px; font-weight: bold; color: #007bff; letter-spacing: 5px; margin: 15px 0;">
                            ${codigo}
                        </div>
                        <p style="color: #666; font-size: 14px; margin: 0;">
                            Este código expirará en 5 minutos
                        </p>
                    </div>
                    <p>Si no solicitaste este cambio, por favor ignora este mensaje.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #666; font-size: 12px;">
                        María Chula - Sistema de Gestión de Restaurante
                    </p>
                </div>
            `
        };

        // Enviar email
        await emailTransporter.sendMail(mailOptions);
        
        console.log(`Código de recuperación enviado a ${email}: ${codigo}`);
        
        res.json({ 
            mensaje: 'Código de verificación enviado correctamente',
            codigo: codigo // En desarrollo, en producción no enviar
        });
        
    } catch (error) {
        console.error('Error al enviar código de recuperación:', error);
        res.status(500).json({ error: 'Error al enviar el código de verificación' });
    }
});

// Verificar código y cambiar contraseña
app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, codigo, nuevaPassword } = req.body;
        
        if (!email || !codigo || !nuevaPassword) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }

        // Verificar fortaleza de contraseña
        if (nuevaPassword.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        // Buscar código de recuperación
        const datosRecuperacion = codigosRecuperacion.get(email);
        
        if (!datosRecuperacion) {
            return res.status(400).json({ error: 'Código no encontrado o expirado' });
        }

        // Verificar expiración
        if (Date.now() > datosRecuperacion.expiracion) {
            codigosRecuperacion.delete(email);
            return res.status(400).json({ error: 'El código ha expirado' });
        }

        // Verificar código
        if (datosRecuperacion.codigo !== codigo) {
            return res.status(400).json({ error: 'Código de verificación incorrecto' });
        }

        // Hashear nueva contraseña
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(nuevaPassword, saltRounds);

        // Actualizar contraseña en la base de datos
        await ejecutarConsulta(
            'UPDATE restaurante.usuarios SET password = $1 WHERE id_usuario = $2',
            [hashedPassword, datosRecuperacion.idUsuario]
        );

        // Eliminar código usado
        codigosRecuperacion.delete(email);

        console.log(`Contraseña actualizada para usuario ID: ${datosRecuperacion.idUsuario}`);
        
        res.json({ mensaje: 'Contraseña actualizada correctamente' });
        
    } catch (error) {
        console.error('Error al resetear contraseña:', error);
        res.status(500).json({ error: 'Error al cambiar la contraseña' });
    }
});

// ==================================
// LIMPIAR CÓDIGOS EXPIRADOS PERIÓDICAMENTE
// ==================================
setInterval(() => {
    const ahora = Date.now();
    for (const [email, datos] of codigosRecuperacion.entries()) {
        if (ahora > datos.expiracion) {
            codigosRecuperacion.delete(email);
            console.log(`Código expirado eliminado para: ${email}`);
        }
    }
}, 5 * 60 * 1000); // Cada 5 minutos

// ==================================
// RUTA DE SALUD DEL SERVIDOR
// ==================================
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      message: 'Servidor María Chula funcionando correctamente',
      database: 'Conectado',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Problema con la base de datos',
      database: 'Desconectado',
      error: error.message 
    });
  }
});

// ==================================
// RUTAS DE AUTENTICACIÓN - MEJORADA CON MÁS LOGS
// ==================================

// Login de usuarios
app.post('/login', async (req, res) => {
  try {
    console.log('Intento de login recibido para:', req.body.correo);
    
    const { correo, password } = req.body;
    if (!correo || !password) {
      console.log('Faltan credenciales');
      return res.status(400).json({ error: 'Correo y contraseña requeridos' });
    }

    const result = await ejecutarConsulta(
      `SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.password, u.estado,
              COALESCE(r.nombre_rol, 'Sin rol') AS rol
       FROM restaurante.usuarios u
       LEFT JOIN restaurante.usuario_rol ur ON u.id_usuario = ur.id_usuario
       LEFT JOIN restaurante.roles r ON ur.id_rol = r.id_rol
       WHERE u.correo = $1`,
      [correo]
    );

    console.log(`Usuarios encontrados: ${result.rows.length}`);

    if (result.rows.length === 0) {
      console.log('Usuario no encontrado:', correo);
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];
    console.log(`Usuario encontrado: ${user.nombre} (${user.estado})`);

    // Verificar si el usuario está activo
    if (user.estado !== 'activo') {
      console.log('Usuario inactivo:', correo);
      return res.status(401).json({ error: 'Usuario inactivo' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    console.log(`Contraseña válida: ${isValid}`);

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
      { expiresIn: '8h' }
    );

    console.log(`Login exitoso para: ${user.nombre}`);

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
    console.error('💥 Error completo en login:', err);
    res.status(500).json({ error: 'Error en el servidor durante el login' });
  }
});

// ==================================
// RUTAS DE USUARIOS
// ==================================

// Obtener todos los usuarios
app.get('/usuarios', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.correo, u.estado, r.nombre_rol AS rol
      FROM restaurante.usuarios u
      LEFT JOIN restaurante.usuario_rol ur ON u.id_usuario = ur.id_usuario
      LEFT JOIN restaurante.roles r ON ur.id_rol = r.id_rol
      ORDER BY u.id_usuario
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// Obtener usuario por ID
app.get('/usuarios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await ejecutarConsulta(`
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
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// Crear nuevo usuario
app.post('/usuarios', async (req, res) => {
  try {
    const { nombre, apellido, correo, password, telefono = null, estado = 'activo', rol } = req.body;

    if (!nombre || !apellido || !correo || !password || !rol) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (incluyendo rol)' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const resultUsuario = await ejecutarConsulta(
      `INSERT INTO restaurante.usuarios 
       (nombre, apellido, correo, password, telefono, estado)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_usuario, nombre, apellido, correo, estado`,
      [nombre, apellido, correo, hashedPassword, telefono, estado]
    );
    const nuevoUsuario = resultUsuario.rows[0];

    // Asignar rol al usuario
    const resultRol = await ejecutarConsulta(
      `SELECT id_rol FROM restaurante.roles WHERE LOWER(nombre_rol) = LOWER($1)`,
      [rol]
    );
    
    if (resultRol.rows.length === 0) {
      await ejecutarConsulta('DELETE FROM restaurante.usuarios WHERE id_usuario=$1', [nuevoUsuario.id_usuario]);
      return res.status(400).json({ error: 'Rol no válido' });
    }
    
    const idRol = resultRol.rows[0].id_rol;
    await ejecutarConsulta(
      `INSERT INTO restaurante.usuario_rol (id_usuario, id_rol) VALUES ($1, $2)`,
      [nuevoUsuario.id_usuario, idRol]
    );

    res.status(201).json({ ...nuevoUsuario, rol });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// Actualizar usuario existente
app.put('/usuarios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, correo, password, telefono = null, estado = 'activo', rol } = req.body;

    let hashedPassword = null;
    if (password) {
      const saltRounds = 10;
      hashedPassword = await bcrypt.hash(password, saltRounds);
    }

    const resultUsuario = await ejecutarConsulta(
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

    // Actualizar rol si se proporciona
    if (rol) {
      const resultRol = await ejecutarConsulta(
        `SELECT id_rol FROM restaurante.roles WHERE LOWER(nombre_rol) = LOWER($1)`,
        [rol]
      );
      
      if (resultRol.rows.length === 0) {
        return res.status(400).json({ error: 'Rol no válido' });
      }
      
      const idRol = resultRol.rows[0].id_rol;
      await ejecutarConsulta(
        `INSERT INTO restaurante.usuario_rol (id_usuario, id_rol)
         VALUES ($1, $2)
         ON CONFLICT (id_usuario)
         DO UPDATE SET id_rol = EXCLUDED.id_rol`,
        [id, idRol]
      );
    }

    res.json({ ...resultUsuario.rows[0], rol });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// Eliminar usuario (solo admin)
app.delete('/usuarios/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await ejecutarConsulta(`DELETE FROM restaurante.usuario_rol WHERE id_usuario=$1`, [id]);
    const result = await ejecutarConsulta(`DELETE FROM restaurante.usuarios WHERE id_usuario=$1 RETURNING *`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ mensaje: 'Usuario eliminado correctamente', usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

// ==================================
// RUTAS DE INSUMOS E INVENTARIO
// ==================================

// CRUD de insumos
app.get('/insumos', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT id_insumo, nombre, descripcion, stock, unidad_medida, estado
      FROM restaurante.insumos
      ORDER BY id_insumo
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

app.post('/insumos', verificarToken, async (req, res) => {
  try {
    const { nombre, descripcion = null, stock = 0, unidad_medida = 'u', estado = 'activo' } = req.body;
    if (!nombre || unidad_medida == null) return res.status(400).json({ error: 'Faltan campos obligatorios' });

    const result = await ejecutarConsulta(
      `INSERT INTO restaurante.insumos (nombre, descripcion, stock, unidad_medida, estado)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nombre, descripcion, stock, unidad_medida, estado]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear insumo' });
  }
});

app.put('/insumos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, stock, unidad_medida, estado } = req.body;

    const result = await ejecutarConsulta(
      `UPDATE restaurante.insumos
       SET nombre=$1, descripcion=$2, stock=COALESCE($3, stock), unidad_medida=$4, estado=$5
       WHERE id_insumo=$6 RETURNING *`,
      [nombre, descripcion, stock, unidad_medida, estado, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar insumo' });
  }
});

app.delete('/insumos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    await ejecutarConsulta('DELETE FROM restaurante.inventario_movimientos WHERE id_insumo=$1', [id]);
    const result = await ejecutarConsulta('DELETE FROM restaurante.insumos WHERE id_insumo=$1 RETURNING *', [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json({ mensaje: 'Insumo eliminado', insumo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar insumo' });
  }
});

// Gestión de inventario y movimientos
app.get('/inventario', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
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
             (SELECT m2.fecha FROM restaurante.inventario_movimientos m2 WHERE m2.id_insumo = i.id_insumo ORDER BY m2.fecha DESC LIMIT 1) AS last_movement,
             (SELECT m3.tipo_movimiento FROM restaurante.inventario_movimientos m3 WHERE m3.id_insumo = i.id_insumo ORDER BY m3.fecha DESC LIMIT 1) AS last_tipo
      FROM restaurante.insumos i
      LEFT JOIN restaurante.inventario_movimientos m ON i.id_insumo = m.id_insumo
      GROUP BY i.id_insumo, i.nombre, i.descripcion, i.unidad_medida, i.estado, i.stock
      ORDER BY i.id_insumo
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener inventario' });
  }
});

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

    const result = await ejecutarConsulta(
      `INSERT INTO restaurante.inventario_movimientos (id_insumo, tipo_movimiento, cantidad, fecha, observacion)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
      [id_insumo, tipo, cantidad, observacion]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al registrar movimiento' });
  }
});

// ==================================
// RUTAS DE CLIENTES
// ==================================

app.get('/clientes', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(
      `SELECT id_cliente, nombre, apellido, telefono, direccion, correo 
       FROM restaurante.clientes ORDER BY id_cliente`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

app.post('/clientes', verificarToken, async (req, res) => {
  try {
    const { nombre, apellido, telefono = null, direccion = null, correo = null } = req.body;
    if (!nombre || !apellido) return res.status(400).json({ error: 'Faltan campos obligatorios' });
    
    const result = await ejecutarConsulta(
      `INSERT INTO restaurante.clientes (nombre, apellido, telefono, direccion, correo, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [nombre, apellido, telefono, direccion, correo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ==================================
// RUTAS DE PEDIDOS Y DETALLES
// ==================================

app.get('/pedidos', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT p.id_pedido, p.fecha, p.estado, p.total,
             c.nombre || ' ' || c.apellido AS cliente
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      ORDER BY p.id_pedido DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// Crear pedido (mesa o domicilio) con sus detalles
app.post('/pedidos', verificarToken, soloMesero, async (req, res) => {
  const client = await pool.connect();
  try {
    const { tipo_pedido, id_cliente, id_mesa = null, direccion_entrega = null, telefono_contacto = null, items } = req.body;

    if (!tipo_pedido || !items || items.length === 0) {
      return res.status(400).json({ error: 'Faltan datos del pedido o no hay productos.' });
    }

    await client.query('BEGIN');

    // Calcular total
    const total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

    // Insertar pedido base
    const pedidoRes = await client.query(
      `INSERT INTO restaurante.pedidos (id_cliente, id_usuario, fecha, estado, tipo_pedido, total)
       VALUES ($1, $2, NOW(), 'pendiente', $3, $4)
       RETURNING id_pedido`,
      [id_cliente, req.user.id, tipo_pedido, total]
    );

    const idPedido = pedidoRes.rows[0].id_pedido;

    // Insertar los detalles del pedido
    for (const item of items) {
      await client.query(
        `INSERT INTO restaurante.detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [idPedido, item.id_producto, item.cantidad, item.precio, item.precio * item.cantidad]
      );

      // Actualizar stock del producto
      await client.query(
        `UPDATE restaurante.productos
         SET stock_actual = stock_actual - $1
         WHERE id_producto = $2`,
        [item.cantidad, item.id_producto]
      );
    }

    // Si es pedido de mesa
    if (tipo_pedido === 'mesa' && id_mesa) {
      await client.query(
        `INSERT INTO restaurante.pedidos_mesa (id_pedido, id_mesa)
         VALUES ($1, $2)`,
        [idPedido, id_mesa]
      );
    }

    // Si es pedido a domicilio
    if (tipo_pedido === 'domicilio' && direccion_entrega && telefono_contacto) {
      await client.query(
        `INSERT INTO restaurante.pedidos_domicilio (id_pedido, direccion_entrega, telefono_contacto, estado_envio)
         VALUES ($1, $2, $3, 'pendiente')`,
        [idPedido, direccion_entrega, telefono_contacto]
      );
    }

    await client.query('COMMIT');

// 🔹 Obtener el pedido recién creado con todos sus detalles
const nuevoPedido = await ejecutarConsulta(`
  SELECT p.id_pedido, p.fecha, p.estado, p.tipo_pedido, p.total,
         c.nombre || ' ' || c.apellido AS cliente,
         json_agg(json_build_object(
           'producto', pr.nombre,
           'cantidad', dp.cantidad,
           'subtotal', dp.subtotal
         )) AS detalles
  FROM restaurante.pedidos p
  LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
  LEFT JOIN restaurante.detalle_pedido dp ON p.id_pedido = dp.id_pedido
  LEFT JOIN restaurante.productos pr ON dp.id_producto = pr.id_producto
  WHERE p.id_pedido = $1
  GROUP BY p.id_pedido, c.nombre, c.apellido
`, [idPedido]);

// 🔹 Emitir el nuevo pedido por WebSocket (para todos los clientes conectados)
emitirNuevoPedido(nuevoPedido.rows[0]);

// 🔹 Responder al frontend
res.status(201).json({
  mensaje: 'Pedido registrado con éxito',
  id_pedido: idPedido
});
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear pedido:', err);
    res.status(500).json({ error: 'Error al crear el pedido' });
  } finally {
    client.release();
  }
});

app.get('/detalle_pedido/:id_pedido', verificarToken, async (req, res) => {
  try {
    const { id_pedido } = req.params;
    const result = await ejecutarConsulta(
      `SELECT d.id_detalle, d.cantidad, d.precio_unitario, d.subtotal,
              pr.nombre AS producto
       FROM restaurante.detalle_pedido d
       LEFT JOIN restaurante.productos pr ON d.id_producto = pr.id_producto
       WHERE d.id_pedido=$1`,
      [id_pedido]
    );
    res.json(result.rows);
  } catch (err) {
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
    const result = await ejecutarConsulta(
      `INSERT INTO restaurante.detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id_pedido, id_producto, cantidad, precio_unitario, subtotal]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear detalle de pedido' });
  }
});

// ----------------------
// COLA DEL CHEF
// ----------------------
app.get('/cola_chef', verificarToken, soloCocinero, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT p.id_pedido, p.fecha, p.estado, p.tipo_pedido, p.total,
             c.nombre || ' ' || c.apellido AS cliente,
             json_agg(json_build_object(
               'producto', pr.nombre,
               'cantidad', dp.cantidad,
               'subtotal', dp.subtotal
             )) AS detalles
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      LEFT JOIN restaurante.detalle_pedido dp ON p.id_pedido = dp.id_pedido
      LEFT JOIN restaurante.productos pr ON dp.id_producto = pr.id_producto
      WHERE p.estado IN ('pendiente', 'en preparación')
      GROUP BY p.id_pedido, c.nombre, c.apellido
      ORDER BY p.fecha ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener la cola del chef' });
  }
});

// ----------------------
// COLA DEL MESERO
// ----------------------
app.get('/cola_mesero', verificarToken, soloMesero, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT p.id_pedido, p.fecha, p.estado, p.tipo_pedido, p.total,
             c.nombre || ' ' || c.apellido AS cliente,
             json_agg(json_build_object(
               'producto', pr.nombre,
               'cantidad', dp.cantidad,
               'subtotal', dp.subtotal
             )) AS detalles
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      LEFT JOIN restaurante.detalle_pedido dp ON p.id_pedido = dp.id_pedido
      LEFT JOIN restaurante.productos pr ON dp.id_producto = pr.id_producto
      WHERE p.estado IN ('pendiente', 'en preparación', 'listo')
      GROUP BY p.id_pedido, c.nombre, c.apellido
      ORDER BY p.fecha ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener la cola del mesero:', err);
    res.status(500).json({ error: 'Error al obtener la cola del mesero' });
  }
});

// ==================================
// RUTAS DEL MENÚ (CATEGORÍAS E ITEMS)
// ==================================

// Categorías del menú
app.get('/categorias_menu', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT id_categoria, nombre_categoria, descripcion
      FROM restaurante.categorias_menu
      ORDER BY id_categoria
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener categorías del menú' });
  }
});

app.post('/categorias_menu', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { nombre_categoria, descripcion = null } = req.body;
    if (!nombre_categoria) return res.status(400).json({ error: 'El nombre de la categoría es obligatorio' });

    const result = await ejecutarConsulta(`
      INSERT INTO restaurante.categorias_menu (nombre_categoria, descripcion)
      VALUES ($1, $2) RETURNING *
    `, [nombre_categoria, descripcion]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear categoría de menú' });
  }
});

app.put('/categorias_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_categoria, descripcion } = req.body;
    const result = await ejecutarConsulta(`
      UPDATE restaurante.categorias_menu
      SET nombre_categoria=$1, descripcion=$2
      WHERE id_categoria=$3 RETURNING *
    `, [nombre_categoria, descripcion, id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar categoría de menú' });
  }
});

app.delete('/categorias_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await ejecutarConsulta('DELETE FROM restaurante.menu_items WHERE id_categoria=$1', [id]);
    const result = await ejecutarConsulta('DELETE FROM restaurante.categorias_menu WHERE id_categoria=$1 RETURNING *', [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ mensaje: 'Categoría eliminada', categoria: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar categoría de menú' });
  }
});

// Items del menú
app.get('/menu_items', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT m.id_item, m.nombre, m.descripcion, m.precio, m.estado, m.img,
             c.nombre_categoria, m.id_categoria
      FROM restaurante.menu_items m
      LEFT JOIN restaurante.categorias_menu c ON m.id_categoria = c.id_categoria
      ORDER BY m.id_item
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener items del menú' });
  }
});

app.post('/menu_items', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id_categoria, nombre, descripcion = null, precio, estado = 'disponible', img = null } = req.body;
    if (!id_categoria || !nombre || precio == null) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const result = await ejecutarConsulta(`
      INSERT INTO restaurante.menu_items (id_categoria, nombre, descripcion, precio, estado, img)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [id_categoria, nombre, descripcion, precio, estado, img]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear item de menú' });
  }
});

app.put('/menu_items/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { id_categoria, nombre, descripcion, precio, estado, img } = req.body;
    const result = await ejecutarConsulta(`
      UPDATE restaurante.menu_items
      SET id_categoria=$1, nombre=$2, descripcion=$3, precio=$4, estado=$5, img=$6
      WHERE id_item=$7 RETURNING *
    `, [id_categoria, nombre, descripcion, precio, estado, img, id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar item del menú' });
  }
});

app.delete('/menu_items/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await ejecutarConsulta('DELETE FROM restaurante.ingredientes_menu WHERE id_item=$1', [id]);
    const result = await ejecutarConsulta('DELETE FROM restaurante.menu_items WHERE id_item=$1 RETURNING *', [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    res.json({ mensaje: 'Item eliminado', item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar item del menú' });
  }
});

// Ingredientes de los items del menú
app.get('/ingredientes_menu/:id_item', verificarToken, async (req, res) => {
  try {
    const { id_item } = req.params;
    const result = await ejecutarConsulta(`
      SELECT i.id_ingrediente, i.cantidad_requerida,
             ins.nombre AS insumo, ins.unidad_medida
      FROM restaurante.ingredientes_menu i
      LEFT JOIN restaurante.insumos ins ON i.id_insumo = ins.id_insumo
      WHERE i.id_item = $1
    `, [id_item]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener ingredientes del item' });
  }
});

app.post('/ingredientes_menu', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id_item, id_insumo, cantidad_requerida } = req.body;
    if (!id_item || !id_insumo || !cantidad_requerida) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    
    const result = await ejecutarConsulta(`
      INSERT INTO restaurante.ingredientes_menu (id_item, id_insumo, cantidad_requerida)
      VALUES ($1, $2, $3) RETURNING *
    `, [id_item, id_insumo, cantidad_requerida]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al agregar ingrediente' });
  }
});

app.delete('/ingredientes_menu/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await ejecutarConsulta('DELETE FROM restaurante.ingredientes_menu WHERE id_ingrediente=$1 RETURNING *', [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ingrediente no encontrado' });
    res.json({ mensaje: 'Ingrediente eliminado', ingrediente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar ingrediente' });
  }
});

// ==================================
// RUTAS DE PRODUCTOS
// ==================================

app.get('/productos', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT id_producto, nombre, descripcion, precio, categoria,
             stock_actual, unidad_medida, estado
      FROM restaurante.productos
      ORDER BY id_producto
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

app.get('/productos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await ejecutarConsulta(`
      SELECT id_producto, nombre, descripcion, precio, categoria,
             stock_actual, unidad_medida, estado
      FROM restaurante.productos
      WHERE id_producto = $1
    `, [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

app.post('/productos', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion, precio, categoria, stock_actual = 0, unidad_medida, estado = 'disponible' } = req.body;
    if (!nombre || precio == null || !unidad_medida) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    
    const result = await ejecutarConsulta(`
      INSERT INTO restaurante.productos (nombre, descripcion, precio, categoria, stock_actual, unidad_medida, estado)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [nombre, descripcion, precio, categoria, stock_actual, unidad_medida, estado]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

app.put('/productos/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, precio, categoria, stock_actual, unidad_medida, estado } = req.body;
    const result = await ejecutarConsulta(`
      UPDATE restaurante.productos
      SET nombre=$1, descripcion=$2, precio=$3, categoria=$4, stock_actual=$5,
          unidad_medida=$6, estado=$7
      WHERE id_producto=$8 RETURNING *
    `, [nombre, descripcion, precio, categoria, stock_actual, unidad_medida, estado, id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

app.delete('/productos/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await ejecutarConsulta('DELETE FROM restaurante.detalle_pedido WHERE id_producto=$1', [id]);
    const result = await ejecutarConsulta('DELETE FROM restaurante.productos WHERE id_producto=$1 RETURNING *', [id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ mensaje: 'Producto eliminado', producto: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

// ==================================
// RUTAS ESPECIALIZADAS
// ==================================

// Actualizar estado del pedido (para cocineros)
app.put('/pedidos/:id/estado', verificarToken, soloCocinero, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;
    
    if (!estado || !['pendiente', 'en preparación', 'listo', 'entregado'].includes(estado)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }

    const result = await ejecutarConsulta(
      'UPDATE restaurante.pedidos SET estado = $1 WHERE id_pedido = $2 RETURNING *',
      [estado, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 🔹 Obtener el pedido actualizado
    const pedidoActualizado = result.rows[0];

    // 🔹 Emitir actualización por WebSocket (chef ↔ mesero)
    emitirCambioEstado(pedidoActualizado);

    // 🔹 Responder al frontend
    res.json({ mensaje: 'Estado actualizado', pedido: pedidoActualizado });
  } catch (err) {
    console.error('Error al actualizar estado:', err);
    res.status(500).json({ error: 'Error al actualizar estado del pedido' });
  }
});

// ==================================
// MARCAR PEDIDO COMO ENTREGADO (para Meseros)
// ==================================
app.put('/pedidos/:id/entregar', verificarToken, soloMesero, async (req, res) => {
  try {
    const { id } = req.params;

    // 🔹 Actualizamos el estado directamente a "entregado"
    const result = await ejecutarConsulta(
      'UPDATE restaurante.pedidos SET estado = $1 WHERE id_pedido = $2 RETURNING *',
      ['entregado', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedidoEntregado = result.rows[0];

    // 🔹 Emitimos el evento WebSocket para actualizar en tiempo real
    emitirCambioEstado(pedidoEntregado);

    // 🔹 Respuesta HTTP
    res.json({
      mensaje: 'Pedido marcado como entregado correctamente',
      pedido: pedidoEntregado
    });

  } catch (err) {
    console.error('Error al marcar pedido como entregado:', err);
    res.status(500).json({ error: 'Error al marcar pedido como entregado' });
  }
});

// ==================================
// RUTAS DEL SISTEMA
// ==================================

// Ruta de prueba para verificar servidor
app.get('/', (req, res) => {
  res.json({ 
    mensaje: 'Servidor María Chula funcionando',
    rutas: {
      salud: '/health',
      categorias: '/categorias_menu',
      menu_items: '/menu_items',
      login: '/login (POST)',
      usuarios: '/usuarios',
      recuperacion_codigo: '/api/send-recovery-code (POST)',
      reset_password: '/api/reset-password (POST)',
      cola_chef: '/cola_chef',
      pedidos: '/pedidos',
      caja_registradora: '/api/cash-register/*'
    }
  });
});

// ==================================
// MANEJO DE ERRORES GLOBAL
// ==================================
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Acceso no permitido por CORS' });
  }
  
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ==================================
// INICIO DEL SERVIDOR CON SOCKET.IO
// ==================================
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

// Crear servidor HTTP base con Express
const httpServer = createServer(app);

// Configurar Socket.IO con CORS
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*", // En producción, cámbialo a tu dominio real
    methods: ["GET", "POST"]
  }
});

// ==================================
// EVENTOS SOCKET.IO
// ==================================
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado:', socket.id);

  socket.on('disconnect', () => {
    console.log('🔴 Cliente desconectado:', socket.id);
  });
});

// ==================================
// FUNCIONES AUXILIARES PARA EMITIR EVENTOS
// ==================================
function emitirNuevoPedido(pedido) {
  io.emit('nuevo_pedido', pedido);
  console.log('📦 Pedido emitido a todos los clientes:', pedido.id_pedido);
}

function emitirCambioEstado(pedido) {
  io.emit('pedido_actualizado', pedido);
  console.log('🔁 Pedido actualizado emitido:', pedido.id_pedido, pedido.estado);
}

// ==================================
// EXPORTAR FUNCIONES PARA USARLAS EN RUTAS
// ==================================
export { emitirNuevoPedido, emitirCambioEstado };

// ==================================
// ARRANQUE FINAL DEL SERVIDOR
// ==================================
httpServer.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(' SERVIDOR MARÍA CHULA INICIADO');
  console.log('='.repeat(60));
  console.log(` Puerto: ${PORT}`);
  console.log(` Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Salud: http://localhost:${PORT}/health`);
  console.log(` Login: http://localhost:${PORT}/login`);
  console.log(` Recuperación: http://localhost:${PORT}/api/send-recovery-code`);
  console.log(` Caja Registradora: http://localhost:${PORT}/api/cash-register/status`);
  console.log('='.repeat(60));
  console.log(' Servidor listo para recibir requests y WebSockets ');
});