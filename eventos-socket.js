// ============================================
// SOCKET.IO - EVENTOS DE TIEMPO REAL
// ============================================

// Exportaremos funciones para emitir eventos
// y el método "configurarSocket" para inicializar el socket

let io = null;

export function configurarSocket(server) {
  import('socket.io').then(({ Server }) => {
    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    io.on("connection", (socket) => {
      console.log("🟢 Cliente conectado:", socket.id);

      socket.on("disconnect", () => {
        console.log("🔴 Cliente desconectado:", socket.id);
      });
    });

    console.log("✅ Socket.IO configurado correctamente");
  });
}

// Emitir cuando se crea un nuevo evento
export function emitirNuevoEvento(evento) {
  if (io) {
    io.emit("nuevo_evento", evento);
    console.log("📢 Evento emitido:", evento.id_evento || evento.nombre);
  }
}

// Emitir cuando se elimina un evento
export function emitirEventoEliminado(id_evento) {
  if (io) {
    io.emit("evento_eliminado", { id_evento });
    console.log("🗑️ Evento eliminado emitido:", id_evento);
  }
}
