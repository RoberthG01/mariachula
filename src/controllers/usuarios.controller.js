import {UserModel} from "../models/usuarios.model.js"

// Mostrar todos los Usuarios
const getAllUsuarios = async (req, res) => {
    try {
      const result = await UserModel.getAll();
      res.json({ ok: true, usuarios: result });
    } catch (error) {
      console.error('Error completo:', error);  // Agregamos más detalles al log
      res.status(500).json({
        ok: false,
        msg: 'Error del servidor al obtener los usuarios',
        error: error.message  // Agregamos el mensaje de error específico
      });
    }
};

export const UserControllers={ 
    getAllUsuarios
}