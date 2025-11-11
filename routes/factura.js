import express from "express";
import pool from "../db.js";
import jwt from "jsonwebtoken";

const router = express.Router();

// ==============================
// 🔐 Middleware: Verificar Token JWT
// ==============================
const JWT_SECRET = process.env.JWT_SECRET || "restmariachula";

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ error: "Acceso denegado. Token requerido." });
  }

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error("❌ Token inválido:", err.message);
      return res.status(403).json({ error: "Token inválido o expirado." });
    }
    req.user = decoded;
    next();
  });
}

// ==============================
// 🛒 1. Obtener pedidos para facturación
// ==============================
router.get("/pedidos", verificarToken, async (req, res) => {
  try {
    console.log("📦 Solicitando pedidos para facturación...");
    
    const result = await pool.query(`
      SELECT 
        p.id_pedido,
        p.fecha,
        p.estado,
        p.total,
        COALESCE(c.nombre || ' ' || c.apellido, 'Cliente') AS cliente
      FROM restaurante.pedidos p
      LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
      WHERE p.estado IN ('completado', 'entregado', 'pendiente')
      ORDER BY p.fecha DESC;
    `);

    console.log(`✅ Enviando ${result.rows.length} pedidos`);
    res.json(result.rows);
    
  } catch (err) {
    console.error("❌ Error en backend al obtener pedidos:", err);
    res.status(500).json({ error: "Error al obtener pedidos: " + err.message });
  }
});

// ==============================
// 🧾 2. Obtener todas las facturas existentes
// ==============================
router.get("/", verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        f.id_factura,
        f.id_pedido,
        TO_CHAR(f.fecha, 'YYYY-MM-DD HH24:MI:SS') AS fecha,
        f.total,
        f.metodo_pago,
        f.estado,
        COALESCE(c.nombre || ' ' || c.apellido, 'Cliente sin registrar') AS cliente
      FROM restaurante.facturas f
      LEFT JOIN restaurante.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN restaurante.clientes c ON c.id_cliente = p.id_cliente
      ORDER BY f.id_factura DESC;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener facturas:", err);
    res.status(500).json({ error: "Error al obtener facturas" });
  }
});

// ==============================
// 🧾 3. Obtener una factura específica con detalles del pedido
// ==============================
router.get("/:id_factura", verificarToken, async (req, res) => {
  const { id_factura } = req.params;

  try {
    if (isNaN(id_factura)) {
      return res.status(400).json({ error: "ID de factura inválido" });
    }

    const facturaRes = await pool.query(
      `
      SELECT 
        f.*, 
        TO_CHAR(f.fecha, 'YYYY-MM-DD HH24:MI:SS') AS fecha_formateada,
        p.id_pedido,
        COALESCE(c.nombre || ' ' || c.apellido, 'Cliente sin registrar') AS cliente
      FROM restaurante.facturas f
      LEFT JOIN restaurante.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN restaurante.clientes c ON c.id_cliente = p.id_cliente
      WHERE f.id_factura = $1;
      `,
      [parseInt(id_factura)]
    );

    if (facturaRes.rows.length === 0) {
      return res.status(404).json({ error: "Factura no encontrada" });
    }

    const factura = facturaRes.rows[0];

    // Obtener detalles del pedido - SOLO menu_items
    const detalleRes = await pool.query(
      `
      SELECT 
        dp.id_detalle, 
        mi.nombre,
        dp.cantidad, 
        dp.precio_unitario, 
        dp.subtotal
      FROM restaurante.detalle_pedido dp
      LEFT JOIN restaurante.menu_items mi ON mi.id_item = dp.id_item
      WHERE dp.id_pedido = $1;
      `,
      [factura.id_pedido]
    );

    res.json({
      factura,
      items: detalleRes.rows,
    });
  } catch (err) {
    console.error("❌ Error al obtener detalles de factura:", err);
    res.status(500).json({ error: "Error al obtener factura: " + err.message });
  }
});

// ==============================
// 🧾 4. Generar nueva factura - SIN IVA
// ==============================
router.post("/generar/:id_pedido", verificarToken, async (req, res) => {
  const { id_pedido } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verificar pedido
    const pedidoRes = await client.query(
      `SELECT id_pedido, total, estado FROM restaurante.pedidos WHERE id_pedido = $1`,
      [id_pedido]
    );

    if (pedidoRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const pedido = pedidoRes.rows[0];

    // 2. Verificar si ya existe factura
    const facturaExistente = await client.query(
      `SELECT id_factura FROM restaurante.facturas WHERE id_pedido = $1`,
      [id_pedido]
    );

    if (facturaExistente.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Ya existe una factura para este pedido" });
    }

    // 3. SIN IVA - El total es directamente el subtotal
    const subtotal = parseFloat(pedido.total);
    const iva = 0; // IVA en cero

    // 4. Insertar factura
    const facturaRes = await client.query(
      `INSERT INTO restaurante.facturas 
       (id_pedido, fecha, total, metodo_pago, estado) 
       VALUES ($1, NOW(), $2, 'efectivo', 'pagada') 
       RETURNING *`,
      [id_pedido, pedido.total]
    );

    const factura = facturaRes.rows[0];

    // 5. Obtener detalles
    const detallesRes = await client.query(
      `SELECT 
        mi.nombre,
        dp.cantidad,
        dp.precio_unitario,
        dp.subtotal
       FROM restaurante.detalle_pedido dp
       LEFT JOIN restaurante.menu_items mi ON mi.id_item = dp.id_item
       WHERE dp.id_pedido = $1`,
      [id_pedido]
    );

    await client.query('COMMIT');

    // 6. Responder - SIN IVA
    res.json({
      factura: {
        id_factura: factura.id_factura,
        fecha: factura.fecha,
        total: factura.total
      },
      pedido: {
        id_pedido: pedido.id_pedido,
        total: pedido.total,
        estado: pedido.estado
      },
      items: detallesRes.rows,
      subtotal: subtotal.toFixed(2),
      iva: iva.toFixed(2), // IVA en cero
      total: pedido.total
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Error al generar factura:", err);
    res.status(500).json({ error: "Error al generar factura: " + err.message });
  } finally {
    client.release();
  }
});

// ==============================
// 📊 5. Obtener estadísticas de facturación
// ==============================
router.get("/estadisticas/resumen", verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_facturas,
        COALESCE(SUM(total), 0) as ingresos_totales,
        AVG(total) as ticket_promedio,
        COUNT(DISTINCT DATE(fecha)) as dias_facturados
      FROM restaurante.facturas
      WHERE fecha >= CURRENT_DATE - INTERVAL '30 days';
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error al obtener estadísticas:", err);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

export default router;