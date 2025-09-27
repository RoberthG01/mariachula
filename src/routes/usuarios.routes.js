import { Router } from "express";
import { UserControllers } from "../controllers/usuarios.controller.js";

const router = Router();

// La ruta completa será /api/usuarios
router.get('/usuarios', UserControllers.getAllUsuarios);

export default router;