document.addEventListener("DOMContentLoaded", function() {
    console.log("Cargando datos de usuarios...");
    fetchUsers();
});

function fetchUsers() {
    fetch('http://57.154.42.0:5000/api/usuarios')
        .then(response => {
            console.log("Respuesta recibida del servidor:", response);
            if (!response.ok) {
                throw new Error("Error al obtener los datos");
            }
            return response.json();
        })
        .then(data => {
            console.log("Datos de usuarios recibidos:", data);
            const tableBody = document.getElementById("userTableBody");
            tableBody.innerHTML = "";

            if (data.ok && Array.isArray(data.usuarios)) {
                data.usuarios.forEach(user => {
                    const row = document.createElement("tr");
                    row.innerHTML = `
                        <td>${user.id}</td>
                        <td>${user.nombre}</td>
                        <td>${user.email}</td>
                        <td>
                            <button class="crud-button view" onclick="viewUser(${user.id})">Ver</button>
                            <button class="crud-button edit" onclick="editUser(${user.id})">Editar</button>
                            <button class="crud-button delete" onclick="deleteUser(${user.id})">Eliminar</button>
                        </td>
                    `;
                    tableBody.appendChild(row);
                });
            } else {
                console.error("Estructura de datos inesperada:", data);
            }
        })
        .catch(error => {
            console.error("Error al obtener los usuarios:", error);
            alert("No se pudieron cargar los usuarios. Verifica la consola para más detalles.");
        });        
}

function addUser() {
    alert("Función para agregar un nuevo usuario.");
}

function viewUser(id) {
    alert("Función para ver los detalles del usuario con ID: " + id);
}

function editUser(id) {
    alert("Función para editar el usuario con ID: " + id);
}

function deleteUser(id) {
    if (confirm("¿Estás seguro de que deseas eliminar este usuario?")) {
        alert("Usuario con ID " + id + " eliminado.");
    }
}
