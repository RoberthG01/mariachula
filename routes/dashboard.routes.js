// dashboard.routes.js
const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Estadísticas generales
router.get('/stats', async (req, res) => {
    try {
        const { range = 'month' } = req.query;
        
        // Calcular fechas según el rango
        const dateFilter = getDateFilter(range);
        
        const statsQuery = `
            SELECT 
                -- Ingresos totales
                COALESCE(SUM(f.total), 0) as total_revenue,
                
                -- Total de pedidos
                COUNT(DISTINCT p.id_pedido) as total_orders,
                
                -- Eventos activos
                (SELECT COUNT(*) FROM restaurante.eventos 
                 WHERE estado = 'activo' AND fecha_evento >= CURRENT_DATE) as active_events,
                
                -- Ticket promedio
                CASE 
                    WHEN COUNT(DISTINCT p.id_pedido) > 0 
                    THEN COALESCE(SUM(f.total), 0) / COUNT(DISTINCT p.id_pedido)
                    ELSE 0 
                END as avg_order_value
                
            FROM restaurante.pedidos p
            LEFT JOIN restaurante.facturas f ON p.id_pedido = f.id_pedido
            WHERE p.fecha >= $1
        `;

        const statsResult = await db.query(statsQuery, [dateFilter]);
        res.json(statsResult.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Gráfica de ventas diarias
router.get('/sales-chart', async (req, res) => {
    try {
        const { range = 'month' } = req.query;
        const dateFilter = getDateFilter(range);
        
        let groupBy;
        switch(range) {
            case 'today':
                groupBy = `DATE_TRUNC('hour', p.fecha)`;
                break;
            case 'week':
                groupBy = `DATE(p.fecha)`;
                break;
            case 'month':
                groupBy = `DATE(p.fecha)`;
                break;
            case 'year':
                groupBy = `DATE_TRUNC('month', p.fecha)`;
                break;
            default:
                groupBy = `DATE(p.fecha)`;
        }

        const salesQuery = `
            SELECT 
                ${groupBy} as periodo,
                COALESCE(SUM(f.total), 0) as venta_total
            FROM restaurante.pedidos p
            LEFT JOIN restaurante.facturas f ON p.id_pedido = f.id_pedido
            WHERE p.fecha >= $1
            GROUP BY periodo
            ORDER BY periodo
        `;

        const salesResult = await db.query(salesQuery, [dateFilter]);
        
        const chartData = {
            labels: salesResult.rows.map(row => formatChartLabel(row.periodo, range)),
            data: salesResult.rows.map(row => parseFloat(row.venta_total))
        };

        res.json(chartData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Gráfica de estado de pedidos
router.get('/orders-chart', async (req, res) => {
    try {
        const ordersQuery = `
            SELECT 
                estado,
                COUNT(*) as cantidad
            FROM restaurante.pedidos
            WHERE fecha >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY estado
        `;

        const ordersResult = await db.query(ordersQuery);
        
        const chartData = {
            labels: ordersResult.rows.map(row => row.estado),
            data: ordersResult.rows.map(row => parseInt(row.cantidad))
        };

        res.json(chartData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Gráfica de productos más vendidos
router.get('/products-chart', async (req, res) => {
    try {
        const { range = 'month' } = req.query;
        const dateFilter = getDateFilter(range);

        const productsQuery = `
            SELECT 
                pr.nombre,
                SUM(dp.cantidad) as total_vendido
            FROM restaurante.detalle_pedido dp
            JOIN restaurante.productos pr ON dp.id_producto = pr.id_producto
            JOIN restaurante.pedidos p ON dp.id_pedido = p.id_pedido
            WHERE p.fecha >= $1
            GROUP BY pr.nombre
            ORDER BY total_vendido DESC
            LIMIT 10
        `;

        const productsResult = await db.query(productsQuery, [dateFilter]);
        
        const chartData = {
            labels: productsResult.rows.map(row => row.nombre),
            data: productsResult.rows.map(row => parseInt(row.total_vendido))
        };

        res.json(chartData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Gráfica de métodos de pago
router.get('/payments-chart', async (req, res) => {
    try {
        const { range = 'month' } = req.query;
        const dateFilter = getDateFilter(range);

        const paymentsQuery = `
            SELECT 
                metodo_pago,
                COUNT(*) as cantidad,
                COALESCE(SUM(total), 0) as monto_total
            FROM restaurante.facturas
            WHERE fecha >= $1
            GROUP BY metodo_pago
        `;

        const paymentsResult = await db.query(paymentsQuery, [dateFilter]);
        
        const chartData = {
            labels: paymentsResult.rows.map(row => row.metodo_pago || 'No especificado'),
            data: paymentsResult.rows.map(row => parseInt(row.cantidad))
        };

        res.json(chartData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Pedidos recientes
router.get('/recent-orders', async (req, res) => {
    try {
        const recentOrdersQuery = `
            SELECT 
                p.id_pedido,
                c.nombre as nombre_cliente,
                p.fecha,
                f.total,
                p.estado,
                f.metodo_pago
            FROM restaurante.pedidos p
            LEFT JOIN restaurante.clientes c ON p.id_cliente = c.id_cliente
            LEFT JOIN restaurante.facturas f ON p.id_pedido = f.id_pedido
            ORDER BY p.fecha DESC
            LIMIT 10
        `;

        const ordersResult = await db.query(recentOrdersQuery);
        res.json(ordersResult.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Funciones auxiliares
function getDateFilter(range) {
    const now = new Date();
    switch(range) {
        case 'today':
            return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        case 'week':
            return new Date(now.setDate(now.getDate() - 7));
        case 'month':
            return new Date(now.getFullYear(), now.getMonth(), 1);
        case 'year':
            return new Date(now.getFullYear(), 0, 1);
        default:
            return new Date(now.getFullYear(), now.getMonth(), 1);
    }
}

function formatChartLabel(date, range) {
    const d = new Date(date);
    switch(range) {
        case 'today':
            return d.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
        case 'week':
        case 'month':
            return d.toLocaleDateString('es-GT', { day: '2-digit', month: '2-digit' });
        case 'year':
            return d.toLocaleDateString('es-GT', { month: 'short', year: 'numeric' });
        default:
            return d.toLocaleDateString('es-GT');
    }
}

module.exports = router;