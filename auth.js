// ===============================
// auth.js — Verificación global de sesión
// ===============================

// ✅ Crea el modal visual igual que los demás de tu app
function createSessionModal() {
    // Evita duplicados si ya existe
    if (document.getElementById("sessionModal")) return;
  
    const modal = document.createElement("div");
    modal.id = "sessionModal";
    modal.className = "modal fade-in"; // usa animación suave
  
    modal.innerHTML = `
      <div class="modal-content message-modal" style="max-width:400px;">
        <div class="modal-body" id="messageBody" style="text-align:center;">
          <div id="messageIcon" class="message-icon" style="color:#e74c3c;">
            <i class="fas fa-exclamation-triangle fa-3x"></i>
          </div>
          <h3 id="messageTitle" style="margin-top:10px;">Sesión expirada</h3>
          <p id="messageText">Tu sesión ha caducado o el token es inválido. Por favor, inicia sesión nuevamente.</p>
          <button id="sessionButton" class="btn primary" style="margin-top:15px;">Ir al login</button>
        </div>
      </div>
    `;
  
    document.body.appendChild(modal);
  
    // Mostrar modal suavemente
    setTimeout(() => modal.classList.add("show"), 50);
  
    // Acción del botón → limpiar token y redirigir
    document.getElementById("sessionButton").addEventListener("click", () => {
      localStorage.removeItem("token");
      modal.classList.remove("show");
      setTimeout(() => window.location.href = "login.html", 300);
    });
  }
  
  // ✅ Verifica la sesión actual con el backend
  async function verificarSesion() {
    const token = localStorage.getItem("token");
  
    // Si no hay token, mostrar modal y detener flujo
    if (!token) {
      createSessionModal();
      return;
    }
  
    try {
      const response = await fetch("http://57.154.42.0:5000/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
  
      if (response.status === 403) {
        // Token inválido o expirado → mostrar modal
        createSessionModal();
      }
    } catch (error) {
      console.error("❌ Error al verificar sesión:", error);
      createSessionModal();
    }
  }
  
  // Ejecuta verificación al cargar la página
  document.addEventListener("DOMContentLoaded", verificarSesion);
  