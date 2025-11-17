// ==============================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ==============================
const API_URL = "http://57.154.42.0:5000/api";
const TOKEN = localStorage.getItem("token");
let clienteTemp = null;
let facturaActual = null;

// ==============================
// INICIALIZACIÓN
// ==============================
document.addEventListener("DOMContentLoaded", function() {
    console.log("🚀 Inicializando módulo de facturación...");
    
    // Verificar autenticación
    if (!TOKEN) {
        mostrarToast("⚠️ Tu sesión ha caducado. Inicia sesión nuevamente.", "warning");
        setTimeout(() => {
            window.location.href = "login.html";
        }, 2000);
        return;
    }
    
    // Cargar datos iniciales
    cargarPedidos();
    cargarFacturasRecientes();
    
    // Configurar event listeners
    document.getElementById('pedidoSelect').addEventListener('change', actualizarInfoPedido);
});

// ==============================
// FUNCIONES PRINCIPALES
// ==============================

// 1. Cargar pedidos desde el backend
async function cargarPedidos() {
    const select = document.getElementById("pedidoSelect");
    const originalText = select.innerHTML;
    
    try {
        select.innerHTML = `<option value="">Cargando pedidos...</option>`;
        
        const res = await fetch(`${API_URL}/facturas/pedidos`, {
            headers: { 
                "Authorization": `Bearer ${TOKEN}`,
                "Content-Type": "application/json"
            },
        });

        if (!res.ok) {
            throw new Error(`Error ${res.status}: ${res.statusText}`);
        }

        const pedidos = await res.json();
        
        if (!Array.isArray(pedidos) || pedidos.length === 0) {
            select.innerHTML = `<option value="">No hay pedidos disponibles</option>`;
            mostrarToast("ℹ️ No hay pedidos pendientes de facturación", "info");
            return;
        }

        let opciones = '<option value="">Seleccione un pedido</option>';
        pedidos.forEach(p => {
            const cliente = p.cliente || "Cliente no especificado";
            const total = Number(p.total || 0).toFixed(2);
            const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString() : '';
            
            opciones += `<option value="${p.id_pedido}" 
                                 data-cliente="${cliente}"
                                 data-total="${p.total}"
                                 data-estado="${p.estado}"
                                 data-fecha="${p.fecha}">
                            Pedido #${p.id_pedido} — ${cliente} — Q${total}
                         </option>`;
        });
        
        select.innerHTML = opciones;
        mostrarToast("✅ Lista de pedidos actualizada", "success");
        
    } catch (err) {
        console.error("❌ Error al cargar pedidos:", err);
        select.innerHTML = `<option value="">Error al cargar pedidos</option>`;
        mostrarToast(err.message || "Error al conectar con el servidor", "error");
    }
}

// 2. Actualizar información del pedido seleccionado
function actualizarInfoPedido() {
    const select = document.getElementById("pedidoSelect");
    const selectedOption = select.options[select.selectedIndex];
    const infoDiv = document.getElementById("pedidoInfo");
    
    if (select.value) {
        document.getElementById("infoCliente").textContent = selectedOption.getAttribute('data-cliente');
        document.getElementById("infoTotal").textContent = `Q ${Number(selectedOption.getAttribute('data-total')).toFixed(2)}`;
        document.getElementById("infoEstado").textContent = selectedOption.getAttribute('data-estado');
        
        const fecha = selectedOption.getAttribute('data-fecha');
        document.getElementById("infoFecha").textContent = fecha ? new Date(fecha).toLocaleDateString() : 'No especificada';
        
        infoDiv.style.display = 'block';
    } else {
        infoDiv.style.display = 'none';
    }
}

// 3. Seleccionar pedido y abrir modal de cliente
function seleccionarPedido() {
    const idPedido = document.getElementById("pedidoSelect").value;
    
    if (!idPedido) {
        mostrarToast("⚠️ Por favor seleccione un pedido de la lista", "warning");
        return;
    }
    
    abrirModalCliente();
}

// 4. Generar factura
async function generarFactura(idPedido) {
    try {
        mostrarToast("⏳ Generando factura...", "info");
        
        const res = await fetch(`${API_URL}/facturas/generar/${idPedido}`, {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${TOKEN}`,
                "Content-Type": "application/json"
            },
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `Error HTTP ${res.status}`);
        }

        const data = await res.json();
        facturaActual = data;
        
        mostrarFactura(data);
        actualizarInterfazFactura(data);
        cargarFacturasRecientes();
        
    } catch (err) {
        console.error("❌ Error al generar factura:", err);
        mostrarToast(err.message || "No se pudo generar la factura", "error");
    }
}

// 5. Mostrar factura en la interfaz
function mostrarFactura(data) {
    const { factura, pedido, items, subtotal, iva, total } = data;
    
    // Actualizar información básica
    document.getElementById("pdfBillNumber").textContent = factura.id_factura;
    document.getElementById("pdfRefNumber").textContent = factura.id_factura;
    document.getElementById("pdfBillDate").textContent = formatDate(factura.fecha);
    document.getElementById("pdfDueDate").textContent = formatDate(addDays(factura.fecha, 14));
    document.getElementById("pdfDeliveryDate").textContent = formatDate(factura.fecha);
    document.getElementById("pdfSummaryTotalAmount").textContent = `Q ${Number(total).toFixed(2)}`;
    
    // Información del cliente
    document.getElementById("pdfClientName").textContent = clienteTemp ? clienteTemp.nombre : "Cliente no especificado";
    document.getElementById("pdfClientNIT").textContent = clienteTemp ? `NIT: ${clienteTemp.nit}` : "C/F";
    document.getElementById("pdfClientEmail").textContent = clienteTemp && clienteTemp.correo !== "N/A" ? clienteTemp.correo : "";
    
    // Items de la factura
    const tbody = document.getElementById("pdfItemsList");
    tbody.innerHTML = "";
    
    if (items && items.length > 0) {
        items.forEach(item => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${item.nombre || "Producto sin nombre"}</td>
                <td style="text-align: center;">${item.cantidad || 0}</td>
                <td style="text-align: right;">Q ${Number(item.precio_unitario || 0).toFixed(2)}</td>
                <td style="text-align: right;">Q ${Number(item.subtotal || 0).toFixed(2)}</td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center;">No hay items en este pedido</td></tr>`;
    }
    
    // Totales
    document.getElementById("pdfSubtotal").textContent = `Q ${Number(subtotal || 0).toFixed(2)}`;
    document.getElementById("pdfIVA").textContent = `Q ${Number(iva || 0).toFixed(2)}`;
    document.getElementById("pdfTotal").textContent = `Q ${Number(total || 0).toFixed(2)}`;
    
    // Mostrar vista previa
    document.getElementById("pdfContainer").style.display = "block";
}

// 6. Actualizar interfaz después de generar factura
function actualizarInterfazFactura(data) {
    document.getElementById("numeroFactura").textContent = data.factura.id_factura;
    document.getElementById("fechaFactura").textContent = formatDate(data.factura.fecha);
    document.getElementById("facturaInfo").style.display = 'block';
    
    mostrarToast(`✅ Factura #${data.factura.id_factura} generada correctamente`, "success");
}

// ==============================
// MODAL DE CLIENTE
// ==============================

function abrirModalCliente() {
    document.getElementById("clienteModal").style.display = "flex";
    document.getElementById("clienteNombre").focus();
}

function cerrarModalCliente() {
    document.getElementById("clienteModal").style.display = "none";
    limpiarCamposCliente();
}

function confirmarCliente() {
    const nombre = document.getElementById("clienteNombre").value.trim();
    const nit = document.getElementById("clienteNIT").value.trim();
    const correo = document.getElementById("clienteCorreo").value.trim();
    
    // Validaciones
    if (!nombre) {
        mostrarToast("⚠️ Por favor ingrese el nombre del cliente", "warning");
        document.getElementById("clienteNombre").focus();
        return;
    }
    
    // Validar NIT
    let nitValido = nit.toUpperCase();
    const regexNIT = /^[0-9]{6,10}$/;
    
    if (nitValido === "" || nitValido === "C/F" || nitValido === "CF") {
        nitValido = "C/F";
    } else if (!regexNIT.test(nitValido)) {
        mostrarToast("⚠️ El NIT debe ser un número de 6 a 10 dígitos o 'C/F'", "warning");
        document.getElementById("clienteNIT").focus();
        return;
    }
    
    // Validar correo
    let correoValido = correo || "N/A";
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        mostrarToast("⚠️ Ingrese un correo electrónico válido", "warning");
        document.getElementById("clienteCorreo").focus();
        return;
    }
    
    clienteTemp = { nombre, nit: nitValido, correo: correoValido };
    cerrarModalCliente();
    
    const idPedido = document.getElementById("pedidoSelect").value;
    if (idPedido) {
        generarFactura(idPedido);
    }
}

function limpiarCamposCliente() {
    document.getElementById("clienteNombre").value = "";
    document.getElementById("clienteNIT").value = "";
    document.getElementById("clienteCorreo").value = "";
}

// ==============================
// FUNCIONES PDF E IMPRESIÓN
// ==============================

async function downloadPDF() {
    if (!facturaActual) {
        mostrarToast("⚠️ Primero debe generar una factura", "warning");
        return;
    }
    
    try {
        mostrarToast("⏳ Generando PDF...", "info");
        
        const { jsPDF } = window.jspdf;
        const element = document.getElementById("invoiceForPDF");
        
        const pdf = new jsPDF("p", "mm", "a4");
        
        const canvas = await html2canvas(element, { 
            scale: 2, 
            useCORS: true,
            logging: false
        });
        
        const imgData = canvas.toDataURL("image/png");
        const imgWidth = 210;
        const pageHeight = 295;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        
        let heightLeft = imgHeight;
        let position = 0;
        
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
        
        while (heightLeft >= 0) {
            position = heightLeft - imgHeight;
            pdf.addPage();
            pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;
        }
        
        const fileName = `Factura_MariaChula_${facturaActual.factura.id_factura}_${Date.now()}.pdf`;
        pdf.save(fileName);
        
        mostrarToast("✅ PDF descargado correctamente", "success");
        
    } catch (error) {
        console.error("❌ Error generando PDF:", error);
        mostrarToast("❌ Error al generar el PDF", "error");
    }
}

function printPDF() {
    if (!facturaActual) {
        mostrarToast("⚠️ Primero debe generar una factura", "warning");
        return;
    }
    
    try {
        const content = document.getElementById("invoiceForPDF").outerHTML;
        const printWindow = window.open("", "_blank");
        
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Imprimir Factura - María Chula</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    .invoice-template { max-width: 800px; margin: 0 auto; }
                    @media print {
                        body { margin: 0; }
                        .no-print { display: none; }
                    }
                </style>
            </head>
            <body>
                ${content}
                <div class="no-print" style="text-align: center; margin-top: 20px;">
                    <button onclick="window.print()">🖨️ Imprimir</button>
                    <button onclick="window.close()">❌ Cerrar</button>
                </div>
            </body>
            </html>
        `);
        
        printWindow.document.close();
        printWindow.focus();
        
    } catch (error) {
        console.error("❌ Error al imprimir:", error);
        mostrarToast("❌ Error al preparar la impresión", "error");
    }
}

function toggleVistaPrevia() {
    const container = document.getElementById('pdfContainer');
    const isHidden = container.style.display === 'none';
    
    if (isHidden) {
        container.style.display = 'block';
        // Hacer scroll suave hacia la vista previa
        setTimeout(() => {
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        container.style.display = 'none';
    }
}

// ==============================
// FUNCIONES AUXILIARES
// ==============================

// Cargar facturas recientes
async function cargarFacturasRecientes() {
    try {
        const res = await fetch(`${API_URL}/facturas`, {
            headers: { 
                "Authorization": `Bearer ${TOKEN}`,
                "Content-Type": "application/json"
            },
        });

        if (res.ok) {
            const facturas = await res.json();
            actualizarTablaFacturas(facturas);
        }
    } catch (err) {
        console.error("❌ Error al cargar facturas recientes:", err);
    }
}

function actualizarTablaFacturas(facturas) {
    const tbody = document.getElementById("facturasTable");
    
    if (!Array.isArray(facturas) || facturas.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center;">No hay facturas registradas</td></tr>`;
        return;
    }
    
    let html = '';
    facturas.slice(0, 10).forEach(factura => {
        html += `
            <tr>
                <td>${factura.id_factura}</td>
                <td>${factura.id_pedido}</td>
                <td>${factura.cliente}</td>
                <td>${formatDate(factura.fecha)}</td>
                <td>Q ${Number(factura.total).toFixed(2)}</td>
                <td>
                    <button class="btn small" onclick="verFactura(${factura.id_factura})">
                        <i class="fas fa-eye"></i>
                    </button>
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

// ==============================
// FUNCIONES PARA VER FACTURAS EXISTENTES
// ==============================

async function verFactura(idFactura) {
    try {
        console.log("🔍 Cargando factura:", idFactura);
        mostrarToast("⏳ Cargando factura...", "info");
        
        const res = await fetch(`${API_URL}/facturas/${idFactura}`, {
            headers: { 
                "Authorization": `Bearer ${TOKEN}`,
                "Content-Type": "application/json"
            },
        });
        
        if (!res.ok) {
            throw new Error(`Error ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        console.log("✅ Factura cargada:", data);
        
        // Mostrar la factura en la vista previa
        mostrarFacturaExistente(data);
        toggleVistaPrevia();
        
        mostrarToast(`✅ Factura #${idFactura} cargada`, "success");
        
    } catch (err) {
        console.error("❌ Error al cargar factura:", err);
        mostrarToast("Error al cargar la factura: " + err.message, "error");
    }
}

// Función para mostrar facturas existentes
function mostrarFacturaExistente(data) {
    const { factura, items } = data;
    
    // Actualizar información básica
    document.getElementById("pdfBillNumber").textContent = factura.id_factura;
    document.getElementById("pdfRefNumber").textContent = factura.id_factura;
    document.getElementById("pdfBillDate").textContent = formatDate(factura.fecha_formateada || factura.fecha);
    document.getElementById("pdfDueDate").textContent = formatDate(addDays(factura.fecha_formateada || factura.fecha, 14));
    document.getElementById("pdfDeliveryDate").textContent = formatDate(factura.fecha_formateada || factura.fecha);
    document.getElementById("pdfSummaryTotalAmount").textContent = `Q ${Number(factura.total || 0).toFixed(2)}`;
    
    // Información del cliente (desde los datos de la factura)
    document.getElementById("pdfClientName").textContent = factura.cliente || "Cliente no especificado";
    document.getElementById("pdfClientNIT").textContent = "C/F";
    document.getElementById("pdfClientEmail").textContent = "";
    
    // Items de la factura
    const tbody = document.getElementById("pdfItemsList");
    tbody.innerHTML = "";
    
    if (items && items.length > 0) {
        items.forEach(item => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${item.nombre || "Producto sin nombre"}</td>
                <td style="text-align: center;">${item.cantidad || 0}</td>
                <td style="text-align: right;">Q ${Number(item.precio_unitario || 0).toFixed(2)}</td>
                <td style="text-align: right;">Q ${Number(item.subtotal || 0).toFixed(2)}</td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center;">No hay items en esta factura</td></tr>`;
    }
    
    // Calcular y mostrar totales
    const subtotal = items ? items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0) : 0;
    const iva = 0; // IVA en cero
    const total = subtotal;
    
    document.getElementById("pdfSubtotal").textContent = `Q ${Number(subtotal).toFixed(2)}`;
    document.getElementById("pdfIVA").textContent = `Q ${Number(iva).toFixed(2)}`;
    document.getElementById("pdfTotal").textContent = `Q ${Number(total).toFixed(2)}`;
    
    // Actualizar factura actual para permitir descargar/imprimir
    facturaActual = {
        factura: factura,
        items: items,
        subtotal: subtotal.toFixed(2),
        iva: iva.toFixed(2),
        total: total.toFixed(2)
    };
    
    // Habilitar botones de descarga/impresión
    document.getElementById("downloadBtn").disabled = false;
    document.getElementById("printBtn").disabled = false;
    
    // Mostrar información de la factura en la tarjeta de acciones
    document.getElementById("numeroFactura").textContent = factura.id_factura;
    document.getElementById("fechaFactura").textContent = formatDate(factura.fecha_formateada || factura.fecha);
    document.getElementById("facturaInfo").style.display = 'block';
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d;
}

function goToSAT() {
    window.open("https://portal.sat.gob.gt/portal/efactura/", "_blank");
}

function nuevaFactura() {
    facturaActual = null;
    clienteTemp = null;
    document.getElementById("pdfContainer").style.display = "none";
    document.getElementById("facturaInfo").style.display = "none";
    document.getElementById("pedidoSelect").value = "";
    document.getElementById("pedidoInfo").style.display = "none";
    
    mostrarToast("🔄 Listo para generar nueva factura", "info");
}

// ==============================
// SISTEMA DE NOTIFICACIONES
// ==============================

function mostrarToast(mensaje, tipo = "info") {
    let contenedor = document.getElementById("toastContainer");
    if (!contenedor) {
        contenedor = document.createElement("div");
        contenedor.id = "toastContainer";
        contenedor.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            max-width: 400px;
        `;
        document.body.appendChild(contenedor);
    }
    
    const toast = document.createElement("div");
    toast.style.cssText = `
        background: white;
        padding: 12px 16px;
        margin-bottom: 10px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-left: 4px solid #4a6fa5;
        display: flex;
        align-items: center;
        gap: 10px;
        transform: translateX(100%);
        opacity: 0;
        transition: all 0.3s ease;
    `;
    
    // Colores según el tipo
    const colors = {
        success: '#28a745',
        error: '#dc3545',
        warning: '#ffc107',
        info: '#4a6fa5'
    };
    
    toast.style.borderLeftColor = colors[tipo] || colors.info;
    
    const iconos = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    toast.innerHTML = `
        <i class="fas ${iconos[tipo] || iconos.info}" style="color: ${colors[tipo] || colors.info}"></i>
        <span>${mensaje}</span>
    `;
    
    contenedor.appendChild(toast);
    
    // Animación de entrada
    setTimeout(() => {
        toast.style.transform = 'translateX(0)';
        toast.style.opacity = '1';
    }, 10);
    
    // Auto-eliminar después de 5 segundos
    setTimeout(() => {
        toast.style.transform = 'translateX(100%)';
        toast.style.opacity = '0';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 5000);
}

// ==============================
// EVENT LISTENERS GLOBALES
// ==============================

// Teclas rápidas para el modal
document.addEventListener("keydown", function(e) {
    const modal = document.getElementById("clienteModal");
    if (modal && modal.style.display === "flex") {
        if (e.key === "Enter") {
            e.preventDefault();
            confirmarCliente();
        }
        if (e.key === "Escape") {
            cerrarModalCliente();
        }
    }
});

// Prevenir envío de formularios
document.addEventListener("submit", function(e) {
    e.preventDefault();
});

console.log("✅ Módulo de facturación cargado correctamente");