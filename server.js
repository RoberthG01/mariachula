const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');

// Config de PostgreSQL
const pool = new Pool({
    user: 'tu_usuario',
    host: 'localhost',
    database: 'nombre_base_datos',
    password: 'tu_contraseña',
    port: 5432,
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Ruta para obtener todos los usuarios
app.get('/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM restaurante.users');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Error al obtener los usuarios');
    }
});

// Ruta para crear un usuario
app.post('/users', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO restaurante.users (username, email, password) VALUES ($1, $2, $3) RETURNING *',
            [username, email, password]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Error al crear el usuario');
    }
});

// Ruta para actualizar un usuario
app.put('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { username, email, password } = req.body;
    try {
        const result = await pool.query(
            'UPDATE restaurante.users SET username = $1, email = $2, password = $3 WHERE id = $4 RETURNING *',
            [username, email, password, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Error al actualizar el usuario');
    }
});

// Ruta para eliminar un usuario
app.delete('/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM restaurante.users WHERE id = $1', [id]);
        res.sendStatus(204);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Error al eliminar el usuario');
    }
});

// Iniciar servidor
app.listen(3000, () => {
    console.log('Servidor corriendo en el puerto 3000');
});