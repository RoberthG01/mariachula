// middleware/auth.js — Middleware de autenticación para el backend
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "restmariachula";

export function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ error: "Acceso denegado. Token requerido." });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error("❌ Error verificando token:", err.message);
      return res.status(403).json({ error: "Token inválido o expirado." });
    }

    req.user = decoded;
    next();
  });
}
