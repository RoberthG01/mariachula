// index.js
import express from 'express';
import pool from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import facturasRoutes from "./routes/factura.js";
// < - - - - - - - - - Importar nodemailer y dotenv para recuperación de contraseña - - - - - - - - ->
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import http from 'http';
import { configurarSocket } from './eventos-socket.js';

// < - - - -  - - - - - - - - CARGAR VARIABLES DE ENTORNO - - - - - - - - - - - - - - - - >
dotenv.config();
console.log("JWT_SECRET desde .env:", process.env.JWT_SECRET);

// < - - - - - - - - - - - - CONFIGURACIÓN Y CONSTANTES - - - - - - - - - - - - - - - - - >
const JWT_SECRET = process.env.JWT_SECRET || 'restmariachula';
const PORT = process.env.PORT || 5000;

console.log("JWT_SECRET final usado:", JWT_SECRET);

const app = express();

// < - - - - - - - - - - - - - CONFIGURACIÓN CORS PARA DESARROLLO - - - - - - - - - - - - - - - >
app.use(cors({
  origin: function (origin, callback) {
    // En desarrollo, permitir todos los orígenes
    if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
      callback(null, true);
      return;
    }

    // En producción, restringir a dominios específicos
    const allowedOrigins = [
      'https://tudominio.com', // Mi dominio de producción
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

// < - - - - - - - - - - - CONFIGURACIÓN DE CORREO ELECTRÓNICO - - - - - - - - - - - >
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// < - - - - - - - - - - - - ALMACENAMIENTO TEMPORAL DE CÓDIGOS DE RECUPERACIÓN - - - - - - - - - - - - >
const codigosRecuperacion = new Map();

// < - - - - - - - - - - - - FUNCIONES UTILITARIAS UNIFICADAS - - - - - - - - - - - - - - >
// Función única para ejecutar consultas
async function ejecutarConsulta(consulta, parametros = []) {
  try {
    const result = await pool.query(consulta, parametros);
    return result;
  } catch (error) {
    console.error('Error en consulta:', error);
    throw error;
  }
}

// Función única para transacciones
async function ejecutarTransaccion(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Función única para consultas de pedidos
function construirConsultaPedidos(filtroWhere = '') {
  return `
    SELECT 
      p.id_pedido,
      p.fecha,
      p.estado,
      p.tipo_pedido,
      p.total,
      p.notas,
      COALESCE(c.nombre || ' ' || c.apellido, 'Cliente sin registrar') AS cliente,
      json_agg(
        json_build_object(
          'producto', mi.nombre,
          'cantidad', dp.cantidad,
          'subtotal', dp.subtotal
        ) ORDER BY dp.id_detalle
      ) AS detalles
    FROM restaurante.pedidos p
    LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
    LEFT JOIN restaurante.detalle_pedido dp ON p.id_pedido = dp.id_pedido
    LEFT JOIN restaurante.menu_items mi ON dp.id_item = mi.id_item  -- CORREGIDO: id_item en lugar de id_producto
    ${filtroWhere}
    GROUP BY p.id_pedido, c.nombre, c.apellido
    ORDER BY p.fecha DESC
  `;
}

// Función única para emisión WebSocket
function emitirEventoSocket(tipo, datos) {
  io.emit(tipo, datos);
  console.log(`🔔 ${tipo} emitido:`, datos.id_pedido || datos.id_evento || datos.id);
}

// Función única para obtener pedido completo
async function obtenerPedidoCompleto(idPedido) {
  const query = construirConsultaPedidos('WHERE p.id_pedido = $1');
  const result = await ejecutarConsulta(query, [idPedido]);
  return result.rows[0];
}

// < - - - - - - - - - - GENERAR CÓDIGO DE VERIFICACIÓN - - - - - - - - - - >
function generarCodigoVerificacion() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// < - - - - - - - - - - - MIDDLEWARES DE AUTENTICACIÓN - - - - - - - - - - - >
// Middleware para verificar el token JWT
function verificarToken(req, res, next) {
  // Obtener header en mayúscula o minúscula
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(403).json({ error: 'Acceso denegado. Token requerido.' });
  }

  const token = authHeader.split(' ')[1]; // Extraer token real

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error('❌ Error verificando token:', err.message);
      return res.status(403).json({ error: 'Token inválido o expirado.' });
    }

    req.user = decoded; // Guardar los datos del usuario del token
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

    // Si el usuario es admin, puede acceder a cualquier ruta
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

// < - - - - - - - - - - - - RUTAS DE CAJA REGISTRADORA - - - - - - - - - - - - - >
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
  try {
    const { monto_inicial } = req.body;

    if (!monto_inicial || monto_inicial <= 0) {
      return res.status(400).json({ error: 'Monto inicial debe ser mayor a 0' });
    }

    const resultado = await ejecutarTransaccion(async (client) => {
      // Verificar si ya hay una caja abierta
      const cajaAbierta = await client.query(
        'SELECT id_caja FROM restaurante.caja WHERE estado = $1',
        ['abierta']
      );

      if (cajaAbierta.rows.length > 0) {
        throw new Error('Ya existe una caja abierta');
      }

      // Abrir nueva caja
      const result = await client.query(
        `INSERT INTO restaurante.caja 
         (fecha_apertura, monto_inicial, estado) 
         VALUES (NOW(), $1, 'abierta') 
         RETURNING id_caja, fecha_apertura, monto_inicial, estado`,
        [monto_inicial]
      );

      const caja = result.rows[0];

      // Registrar movimiento de apertura
      await client.query(
        `INSERT INTO restaurante.movimientos_caja 
         (id_caja, tipo_movimiento, monto, descripcion, fecha) 
         VALUES ($1, 'apertura', $2, 'Apertura de caja', NOW())`,
        [caja.id_caja, monto_inicial]
      );

      return caja;
    });

    res.status(201).json(resultado);
  } catch (error) {
    console.error('Error al abrir caja:', error);
    res.status(500).json({ error: error.message || 'Error al abrir caja' });
  }
});

// 📌 Resetear caja (SOLO ADMINISTRADORES)
app.post('/api/cash-register/reset', verificarToken, async (req, res) => {
  try {
    // Verificar que el usuario sea administrador
    const user = req.user; // Asumiendo que verificarToken agrega el usuario a req
    if (user.rol !== 'admin' && user.rol !== 'administrador') {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta acción' });
    }

    const resultado = await ejecutarTransaccion(async (client) => {
      // Cerrar todas las cajas abiertas
      await client.query(
        `UPDATE restaurante.caja 
         SET estado = 'cerrada', fecha_cierre = NOW() 
         WHERE estado = 'abierta'`
      );

      // Opcional: Limpiar movimientos recientes (cuidado con esto)
      // await client.query('DELETE FROM restaurante.movimientos_caja WHERE fecha::date = CURRENT_DATE');

      return { mensaje: 'Caja reseteada correctamente' };
    });

    res.json(resultado);
  } catch (error) {
    console.error('Error al resetear caja:', error);
    res.status(500).json({ error: error.message || 'Error al resetear caja' });
  }
});

// Cerrar caja
app.post('/api/cash-register/close', verificarToken, async (req, res) => {
  try {
    const resultado = await ejecutarTransaccion(async (client) => {
      // Obtener caja abierta
      const cajaResult = await client.query(
        `SELECT id_caja, monto_inicial 
         FROM restaurante.caja 
         WHERE estado = 'abierta' 
         ORDER BY fecha_apertura DESC 
         LIMIT 1`
      );

      if (cajaResult.rows.length === 0) {
        throw new Error('No hay caja abierta para cerrar');
      }

      const caja = cajaResult.rows[0];

      // Calcular total de ventas (usando movimientos_caja)
      const ventasResult = await client.query(
        `SELECT COALESCE(SUM(monto), 0) as total_ventas
         FROM restaurante.movimientos_caja 
         WHERE id_caja = $1 
         AND tipo_movimiento = 'venta'
         AND DATE(fecha) = CURRENT_DATE`,
        [caja.id_caja]
      );

      const totalVentas = parseFloat(ventasResult.rows[0].total_ventas);
      const montoFinal = parseFloat(caja.monto_inicial) + totalVentas;

      // Cerrar caja
      const updateResult = await client.query(
        `UPDATE restaurante.caja 
         SET fecha_cierre = NOW(), monto_final = $1, estado = 'cerrada'
         WHERE id_caja = $2 
         RETURNING *`,
        [montoFinal, caja.id_caja]
      );

      // Registrar movimiento de cierre
      await client.query(
        `INSERT INTO restaurante.movimientos_caja 
         (id_caja, tipo_movimiento, monto, descripcion, fecha) 
         VALUES ($1, 'cierre', $2, 'Cierre de caja', NOW())`,
        [caja.id_caja, montoFinal]
      );

      return {
        caja: updateResult.rows[0],
        total_ventas: totalVentas,
        monto_final: montoFinal
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error('Error al cerrar caja:', error);
    res.status(500).json({ error: error.message || 'Error al cerrar caja' });
  }
});

// Registrar venta en caja
app.post('/api/cash-register/sales', verificarToken, async (req, res) => {
  try {
    const { id_caja, total, recibido, cambio } = req.body;

    if (!id_caja || !total || !recibido || cambio === undefined) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    if (recibido < total) {
      return res.status(400).json({ error: 'Monto recibido insuficiente' });
    }

    const resultado = await ejecutarTransaccion(async (client) => {
      // Verificar que la caja esté abierta
      const cajaResult = await client.query(
        'SELECT id_caja FROM restaurante.caja WHERE id_caja = $1 AND estado = $2',
        [id_caja, 'abierta']
      );

      if (cajaResult.rows.length === 0) {
        throw new Error('Caja no está abierta');
      }

      // Registrar movimiento de venta
      const movimientoResult = await client.query(
        `INSERT INTO restaurante.movimientos_caja 
         (id_caja, tipo_movimiento, monto, descripcion, fecha) 
         VALUES ($1, 'venta', $2, $3, NOW()) 
         RETURNING *`,
        [id_caja, total, `Venta - Recibido: Q${recibido}, Cambio: Q${cambio}`]
      );

      // Crear factura (sin pedido asociado para ventas directas)
      const facturaResult = await client.query(
        `INSERT INTO restaurante.facturas 
         (fecha, total, metodo_pago, estado) 
         VALUES (NOW(), $1, 'efectivo', 'pagada') 
         RETURNING *`,
        [total]
      );

      return {
        movimiento: movimientoResult.rows[0],
        factura: facturaResult.rows[0]
      };
    });

    res.status(201).json(resultado);
  } catch (error) {
    console.error('Error al registrar venta:', error);
    res.status(500).json({ error: error.message || 'Error al registrar venta' });
  }
});

// Obtener movimientos de caja actual
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

// < - - - - - - - - - RUTAS DE RECUPERACIÓN DE CONTRASEÑA - - - - - - - - - - - >
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

// < - - - - - - - - - - LIMPIAR CÓDIGOS EXPIRADOS PERIÓDICAMENTE - - - - - - - - - - - >
setInterval(() => {
    const ahora = Date.now();
    for (const [email, datos] of codigosRecuperacion.entries()) {
        if (ahora > datos.expiracion) {
            codigosRecuperacion.delete(email);
            console.log(`Código expirado eliminado para: ${email}`);
        }
    }
}, 5 * 60 * 1000); // Cada 5 minutos

// < - - - - - - - - - RUTA DE SALUD DEL SERVIDOR - - - - - - - - - - - >
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

// < - - - - - - - - - - - - - RUTAS DE AUTENTICACIÓN - - - - - - - - - - - - - >
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

// < - - - - - - - - - - - - -  RUTAS DE USUARIOS - - - - - - - - - - - - - - - >
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

// < - - - - - - - - - - - RUTAS DE INSUMOS E INVENTARIO - - - - - - - - - - - - - >
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

// < - - - - - - - - - - - - - RUTAS DE CLIENTES - - - - - - - - - - - - - - >
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

// < - - - - - - - - - - - - - - RUTA: OBTENER PEDIDOS - - - - - - - - - - - - - - - >
app.get('/pedidos', verificarToken, async (req, res) => {
  try {
    const query = construirConsultaPedidos();
    const result = await ejecutarConsulta(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener pedidos:', err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// < - - - - - - - - - - - - - - CREAR PEDIDO - - - - - - - - - - - - - - - >
app.post('/pedidos', verificarToken, async (req, res) => {
  try {
    const { tipo_pedido, id_cliente, total, detalles, notas } = req.body;

    // Validación básica
    if (!tipo_pedido || !id_cliente || !Array.isArray(detalles) || !detalles.length) {
      return res.status(400).json({ error: 'Faltan datos del pedido o detalles vacíos' });
    }

    const idPedido = await ejecutarTransaccion(async (client) => {
      // Insertar pedido principal
      const pedidoRes = await client.query(
        `INSERT INTO restaurante.pedidos 
          (id_cliente, id_usuario, fecha, estado, tipo_pedido, total, notas)
         VALUES ($1, $2, NOW(), 'pendiente', $3, $4, $5)
         RETURNING id_pedido`,
        [id_cliente, req.user.id, tipo_pedido, total, notas || null]
      );

      const idPedido = pedidoRes.rows[0].id_pedido;

      // Insertar los detalles del pedido
      for (const item of detalles) {
        await client.query(
          `INSERT INTO restaurante.detalle_pedido 
            (id_pedido, id_item, cantidad, precio_unitario, subtotal)
           VALUES ($1, $2, $3, $4, $5)`,
          [idPedido, item.id_item, item.cantidad, item.precio_unitario, item.subtotal]
        );
      }

      return idPedido;
    });

    // Obtener el pedido completo para emitirlo al WebSocket
    const nuevoPedido = await obtenerPedidoCompleto(idPedido);
    emitirEventoSocket('nuevo_pedido', nuevoPedido);

    // Respuesta HTTP
    res.status(201).json({
      mensaje: 'Pedido registrado con éxito',
      id_pedido: idPedido
    });

  } catch (err) {
    console.error('Error al crear pedido:', err);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

// DETALLE: compatible con id_item (menu) e id_producto
app.get('/detalle_pedido/:id_pedido', verificarToken, async (req, res) => {
  try {
    const { id_pedido } = req.params;
    const result = await ejecutarConsulta(
      `SELECT d.id_detalle,
              d.cantidad,
              d.precio_unitario,
              d.subtotal,
              COALESCE(mi.nombre, pr.nombre) AS producto,
              d.id_item,
              d.id_producto
       FROM restaurante.detalle_pedido d
       LEFT JOIN restaurante.menu_items mi ON d.id_item = mi.id_item
       LEFT JOIN restaurante.productos pr ON d.id_producto = pr.id_producto
       WHERE d.id_pedido=$1
       ORDER BY d.id_detalle`,
      [id_pedido]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener detalle de pedido' });
  }
});

// Crear detalle puntual (acepta id_item O id_producto)
app.post('/detalle_pedido', verificarToken, async (req, res) => {
  try {
    const { id_pedido, id_item = null, id_producto = null, cantidad, precio_unitario } = req.body;

    if (!id_pedido || !cantidad || !precio_unitario) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const usaItem = !!id_item;
    const usaProducto = !!id_producto;

    if (usaItem === usaProducto) {
      return res.status(400).json({ error: 'Proporciona exactamente uno: id_item o id_producto' });
    }

    const subtotal = cantidad * precio_unitario;

    const result = await ejecutarConsulta(
      `INSERT INTO restaurante.detalle_pedido (id_pedido, id_item, id_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id_pedido, id_item, id_producto, cantidad, precio_unitario, subtotal]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear detalle de pedido' });
  }
});

// < - - - - - - - - - - - - - COLA DEL CHEF - - - - - - - - - - - - - - - >
app.get('/cola_chef', verificarToken, soloCocinero, async (req, res) => {
  try {
    const query = construirConsultaPedidos("WHERE p.estado IN ('pendiente', 'en preparación')");
    const result = await ejecutarConsulta(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener la cola del chef:', err);
    res.status(500).json({ error: 'Error al obtener la cola del chef' });
  }
});

// < - - - - - - - - - - - COLA DEL MESERO - - - - - - - - - - - - - >
app.get('/cola_mesero', verificarToken, soloMesero, async (req, res) => {
  try {
    const query = construirConsultaPedidos("WHERE p.estado IN ('pendiente', 'en preparación', 'listo')");
    const result = await ejecutarConsulta(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener la cola del mesero:', err);
    res.status(500).json({ error: 'Error al obtener la cola del mesero' });
  }
});

// < - - - - - - - - - - RUTAS DEL MENÚ (CATEGORÍAS E ITEMS) - - - - - - - - - - >
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

// < - - - - - - - - - RUTA API para platillos del menú (frontend) - - - - - - - - - >
app.get('/api/menu_items', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT 
        id_item,
        nombre,
        precio
      FROM restaurante.menu_items
      WHERE estado = 'disponible'
      ORDER BY nombre ASC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener items del menú (API):', err);
    res.status(500).json({ error: 'Error al obtener items del menú' });
  }
});

// < - - - - - - - - - - - RUTAS DE PRODUCTOS (INVENTARIO) - - - - - - - - - - - >
app.get('/productos', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT 
        m.id_item AS id,
        m.nombre AS name,
        m.descripcion AS description,
        m.precio AS price,
        m.estado,
        COALESCE(m.img, 'fotos/no-image.png') AS img,
        c.nombre_categoria AS category
      FROM restaurante.menu_items m
      LEFT JOIN restaurante.categorias_menu c ON m.id_categoria = c.id_categoria
      WHERE m.estado = 'disponible'
      ORDER BY m.id_item;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener platillos del menú:', err);
    res.status(500).json({ error: 'Error al obtener platillos del menú' });
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

// < - - - - - - - - - - - ACTUALIZAR ESTADO DE UN PEDIDO (Chef o Mesero) - - - - - - - - - - - - - - >
app.put('/pedidos/:id/estado', verificarToken, async (req, res) => {
  try {
    const idPedido = parseInt(req.params.id);
    const { estado } = req.body;

    if (!idPedido || !estado) {
      return res.status(400).json({ error: 'Faltan datos: idPedido o estado' });
    }

    // Validar estados permitidos
    const estadosValidos = ['pendiente', 'en preparación', 'listo', 'entregado', 'cancelado'];
    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido: ${estado}` });
    }

    const pedido = await ejecutarTransaccion(async (client) => {
      // Actualizar el estado del pedido
      const updateRes = await client.query(
        `UPDATE restaurante.pedidos 
         SET estado = $1 
         WHERE id_pedido = $2 
         RETURNING *`,
        [estado, idPedido]
      );

      if (updateRes.rowCount === 0) {
        throw new Error('Pedido no encontrado');
      }

      // Obtener los datos completos del pedido actualizado
      const query = construirConsultaPedidos('WHERE p.id_pedido = $1');
      const pedidoCompleto = await client.query(query, [idPedido]);
      return pedidoCompleto.rows[0];
    });

    emitirEventoSocket('pedido_actualizado', pedido);
    console.log(`Pedido #${idPedido} → ${estado}`);

    res.json({ mensaje: 'Estado actualizado con éxito', pedido });

  } catch (err) {
    console.error('Error al actualizar estado del pedido:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar estado del pedido' });
  }
});

// < - - - - - - - - - - - - RUTAS DE EVENTOS - - - - - - - - - - - - - >
// Obtener todos los eventos (SIMPLE)
app.get('/eventos', verificarToken, async (req, res) => {
  try {
    const result = await ejecutarConsulta(`
      SELECT 
        id_evento,
        nombre_cliente,
        nombre_evento,
        fecha_evento,
        cantidad_personas,
        estado,
        observacion,
        id_vajilla,
        total
      FROM restaurante.eventos 
      ORDER BY fecha_evento DESC;
    `);
    
    res.json({ eventos: result.rows });
  } catch (err) {
    console.error('Error al obtener eventos:', err);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

// Obtener un evento específico por ID
app.get('/eventos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await ejecutarConsulta(`
      SELECT 
        id_evento,
        nombre_cliente,
        nombre_evento,
        fecha_evento,
        cantidad_personas,
        estado,
        observacion,
        id_vajilla,
        total
      FROM restaurante.eventos 
      WHERE id_evento = $1;
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    res.json({ evento: result.rows[0] });
  } catch (err) {
    console.error('Error al obtener evento:', err);
    res.status(500).json({ error: 'Error al obtener evento' });
  }
});

// Crear nuevo evento
app.post('/eventos', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      nombre_cliente,
      nombre_evento,
      fecha_evento,
      cantidad_personas,
      id_vajilla,
      observacion,
      total,
      estado = 'Confirmado',
      items = []
    } = req.body;

    // Validación básica
    if (!nombre_cliente || !nombre_evento || !fecha_evento || !cantidad_personas) {
      return res.status(400).json({ 
        error: 'Datos incompletos' 
      });
    }

    await client.query('BEGIN');

    // Crear el evento principal
    const resultEvento = await client.query(
      `INSERT INTO restaurante.eventos 
        (nombre_cliente, nombre_evento, fecha_evento, cantidad_personas, id_vajilla, observacion, total, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *;`,
      [nombre_cliente, nombre_evento, fecha_evento, cantidad_personas, id_vajilla, observacion, total, estado]
    );

    const nuevoEvento = resultEvento.rows[0];
    const idEvento = nuevoEvento.id_evento;

    // Insertar detalles si existen
    if (items && items.length > 0) {
      for (const item of items) {
        await client.query(
          `INSERT INTO restaurante.detalles_evento 
            (id_evento, id_item, cantidad, precio_unitario, subtotal)
           VALUES ($1, $2, $3, $4, $5);`,
          [idEvento, item.id_item, item.cantidad, item.precio_unitario, item.subtotal]  // ← CORREGIDO: item.id_item
        );
      }
    }

    await client.query('COMMIT');

    // Emitir por WebSocket
    emitirEventoSocket('nuevo_evento', nuevoEvento);

    res.status(201).json({ 
      mensaje: 'Evento registrado con éxito', 
      evento: nuevoEvento 
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear evento:', err);
    res.status(500).json({ error: 'Error al crear evento: ' + err.message });
  } finally {
    client.release();
  }
});

// Eliminar evento
app.delete('/eventos/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Eliminar detalles primero
    await client.query('DELETE FROM restaurante.detalles_evento WHERE id_evento = $1;', [id]);
    
    // Eliminar evento principal
    const result = await client.query('DELETE FROM restaurante.eventos WHERE id_evento = $1 RETURNING *;', [id]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    await client.query('COMMIT');

    // Emitir por WebSocket
    emitirEventoSocket('evento_eliminado', { id_evento: parseInt(id) });

    res.json({ 
      mensaje: 'Evento eliminado correctamente',
      evento: result.rows[0] 
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar evento:', err);
    res.status(500).json({ error: 'Error al eliminar evento: ' + err.message });
  } finally {
    client.release();
  }
});

// < - - - - - - - - - - - - - - ENDPOINTS PARA DASHBOARD - - - - - - - - - - - - - - - >

// Estadísticas generales
app.get('/api/dashboard/stats', verificarToken, async (req, res) => {
  try {
    const { range = 'month' } = req.query;
    
    let dateCondition;
    switch(range) {
      case 'today':
        dateCondition = "fecha::date = CURRENT_DATE";
        break;
      case 'week':
        dateCondition = "fecha >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'month':
        dateCondition = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'year':
        dateCondition = "fecha >= DATE_TRUNC('year', CURRENT_DATE)";
        break;
      default:
        dateCondition = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";
    }

    let pedidosDateCondition = dateCondition.replace('fecha', 'p.fecha');

    // Obtener ingresos totales
    const revenueResult = await ejecutarConsulta(`
      SELECT COALESCE(SUM(total), 0) as total_revenue
      FROM restaurante.facturas 
      WHERE estado = 'pagada'
      AND ${dateCondition}
    `);

    // Obtener total de pedidos
    const ordersResult = await ejecutarConsulta(`
      SELECT COUNT(*) as total_orders
      FROM restaurante.pedidos p
      WHERE ${pedidosDateCondition}
    `);

    // Obtener eventos activos
    const eventsResult = await ejecutarConsulta(`
      SELECT COUNT(*) as active_events
      FROM restaurante.eventos 
      WHERE estado = 'Confirmado'
      AND fecha_evento >= CURRENT_DATE
    `);

    // Calcular ticket promedio
    const avgResult = await ejecutarConsulta(`
      SELECT COALESCE(AVG(total), 0) as avg_order_value
      FROM restaurante.facturas 
      WHERE estado = 'pagada'
      AND ${dateCondition}
    `);

    res.json({
      total_revenue: parseFloat(revenueResult.rows[0].total_revenue),
      total_orders: parseInt(ordersResult.rows[0].total_orders),
      active_events: parseInt(eventsResult.rows[0].active_events),
      avg_order_value: parseFloat(avgResult.rows[0].avg_order_value)
    });

  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas: ' + error.message });
  }
});

// Gráfica de ventas
app.get('/api/dashboard/sales-chart', verificarToken, async (req, res) => {
  try {
    const { range = 'week' } = req.query;
    
    let groupBy, dateCondition;
    switch(range) {
      case 'today':
        groupBy = "DATE_TRUNC('hour', fecha)";
        dateCondition = "fecha::date = CURRENT_DATE";
        break;
      case 'week':
        groupBy = "DATE(fecha)";
        dateCondition = "fecha >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'month':
        groupBy = "DATE(fecha)";
        dateCondition = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'year':
        groupBy = "DATE_TRUNC('month', fecha)";
        dateCondition = "fecha >= DATE_TRUNC('year', CURRENT_DATE)";
        break;
      default:
        groupBy = "DATE(fecha)";
        dateCondition = "fecha >= CURRENT_DATE - INTERVAL '7 days'";
    }

    const result = await ejecutarConsulta(`
      SELECT 
        ${groupBy} as periodo,
        COALESCE(SUM(total), 0) as venta_total
      FROM restaurante.facturas 
      WHERE estado = 'pagada'
      AND ${dateCondition}
      GROUP BY periodo
      ORDER BY periodo
    `);

    const labels = result.rows.map(row => {
      const date = new Date(row.periodo);
      switch(range) {
        case 'today':
          return date.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
        case 'week':
        case 'month':
          return date.toLocaleDateString('es-GT', { day: '2-digit', month: '2-digit' });
        case 'year':
          return date.toLocaleDateString('es-GT', { month: 'short' });
        default:
          return date.toLocaleDateString('es-GT');
      }
    });
    
    const data = result.rows.map(row => parseFloat(row.venta_total));

    res.json({ labels, data });
  } catch (error) {
    console.error('Error en sales-chart:', error);
    res.status(500).json({ error: 'Error al obtener datos de ventas: ' + error.message });
  }
});

// Gráfica de estado de pedidos
app.get('/api/dashboard/orders-chart', verificarToken, async (req, res) => {
  try {
    const ordersQuery = `
      SELECT 
        estado,
        COUNT(*) as cantidad
      FROM restaurante.pedidos
      WHERE fecha >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY estado
    `;

    const ordersResult = await ejecutarConsulta(ordersQuery);
    
    const chartData = {
      labels: ordersResult.rows.map(row => row.estado),
      data: ordersResult.rows.map(row => parseInt(row.cantidad))
    };

    res.json(chartData);
  } catch (error) {
    console.error('Error en orders-chart:', error);
    res.status(500).json({ error: 'Error al obtener datos de pedidos: ' + error.message });
  }
});

// Gráfica de productos más vendidos
app.get('/api/dashboard/products-chart', verificarToken, async (req, res) => {
  try {
    const { range = 'month' } = req.query;
    
    let dateCondition;
    switch(range) {
      case 'today':
        dateCondition = "p.fecha::date = CURRENT_DATE";
        break;
      case 'week':
        dateCondition = "p.fecha >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'month':
        dateCondition = "p.fecha >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'year':
        dateCondition = "p.fecha >= DATE_TRUNC('year', CURRENT_DATE)";
        break;
      default:
        dateCondition = "p.fecha >= DATE_TRUNC('month', CURRENT_DATE)";
    }

    const productsQuery = `
      SELECT 
        mi.nombre,
        SUM(dp.cantidad) as total_vendido
      FROM restaurante.detalle_pedido dp
      JOIN restaurante.menu_items mi ON dp.id_item = mi.id_item
      JOIN restaurante.pedidos p ON dp.id_pedido = p.id_pedido
      WHERE ${dateCondition}
      GROUP BY mi.id_item, mi.nombre
      ORDER BY total_vendido DESC
      LIMIT 10
    `;

    const productsResult = await ejecutarConsulta(productsQuery);
    
    const chartData = {
      labels: productsResult.rows.map(row => row.nombre),
      data: productsResult.rows.map(row => parseInt(row.total_vendido))
    };

    res.json(chartData);
  } catch (error) {
    console.error('Error en products-chart:', error);
    res.status(500).json({ error: 'Error al obtener productos más vendidos: ' + error.message });
  }
});

// Gráfica de métodos de pago
app.get('/api/dashboard/payments-chart', verificarToken, async (req, res) => {
  try {
    const { range = 'month' } = req.query;
    
    let dateCondition;
    switch(range) {
      case 'today':
        dateCondition = "fecha::date = CURRENT_DATE";
        break;
      case 'week':
        dateCondition = "fecha >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'month':
        dateCondition = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'year':
        dateCondition = "fecha >= DATE_TRUNC('year', CURRENT_DATE)";
        break;
      default:
        dateCondition = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";
    }

    const paymentsQuery = `
      SELECT 
        COALESCE(metodo_pago, 'No especificado') as metodo_pago,
        COUNT(*) as cantidad,
        COALESCE(SUM(total), 0) as monto_total
      FROM restaurante.facturas
      WHERE ${dateCondition}
      GROUP BY metodo_pago
    `;

    const paymentsResult = await ejecutarConsulta(paymentsQuery);
    
    const chartData = {
      labels: paymentsResult.rows.map(row => row.metodo_pago),
      data: paymentsResult.rows.map(row => parseInt(row.cantidad))
    };

    res.json(chartData);
  } catch (error) {
    console.error('Error en payments-chart:', error);
    res.status(500).json({ error: 'Error al obtener métodos de pago: ' + error.message });
  }
});

// Pedidos recientes
app.get('/api/dashboard/recent-orders', verificarToken, async (req, res) => {
  try {
    const recentOrdersQuery = `
      SELECT 
        p.id_pedido,
        COALESCE(c.nombre, 'Cliente no registrado') as nombre_cliente,
        p.fecha,
        COALESCE(f.total, 0) as total,
        p.estado,
        COALESCE(f.metodo_pago, 'No especificado') as metodo_pago
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      LEFT JOIN restaurante.facturas f ON p.id_pedido = f.id_pedido
      ORDER BY p.fecha DESC
      LIMIT 10
    `;

    const ordersResult = await ejecutarConsulta(recentOrdersQuery);
    res.json(ordersResult.rows);
  } catch (error) {
    console.error('Error en recent-orders:', error);
    res.status(500).json({ error: 'Error al obtener pedidos recientes: ' + error.message });
  }
});

// < - - - - - - - - RUTAS DEL SISTEMA - - - - - - - - - >
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
      eventos: '/eventos',
      caja_registradora: '/api/cash-register/*',
      facturas: '/api/facturas'
    }
  });
});

// < - - - - - - - - - - - MANEJO DE ERRORES GLOBAL - - - - - - - - - - >
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Acceso no permitido por CORS' });
  }
  
  res.status(500).json({ error: 'Error interno del servidor' });
});

// < - - - - - - -  EXPRESS.STATIC Y API/FACTURAS - - - - - - - - - >
app.use(express.static("public"));

app.use("/api/facturas", facturasRoutes);

// < - - - - - - - INICIO DEL SERVIDOR CON SOCKET.IO - - - - - - - - >
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

// Crear servidor HTTP base con Express + SOCKET .IO
const httpServer = createServer(app);
configurarSocket(httpServer);

// Configurar Socket.IO con CORS
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*", // En producción, cámbialo a tu dominio real
    methods: ["GET", "POST"]
  }
});

// < - - - - - - - - - - EVENTOS SOCKET.IO - - - - - - - - - - >
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado:', socket.id);

  socket.on('disconnect', () => {
    console.log('🔴 Cliente desconectado:', socket.id);
  });
});

// < - - - - - - - - - ARRANQUE FINAL DEL SERVIDOR - - - - - - - - - - - >
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
  console.log(` Eventos: http://localhost:${PORT}/eventos`);
  console.log('='.repeat(60));
  console.log(' Servidor listo para recibir requests y WebSockets ');
});