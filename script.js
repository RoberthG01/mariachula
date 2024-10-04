// Variable para almacenar usuarios obtenidos del backend
let users = [];
let editIndex = null;

// Función para guardar el usuario
const saveUser = async (username, email, password) => {
    const userData = { username, email, password };
    
    if (editIndex === null) {
        // Crear nuevo usuario (POST request)
        await fetch('http://localhost:3000/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
    } else {
        // Editar usuario existente (PUT request)
        await fetch(`http://localhost:3000/users/${users[editIndex].id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
        editIndex = null;
    }
    renderUsers(); // Recargar lista de usuarios
};

// Función para renderizar los usuarios en la tabla
const renderUsers = async () => {
    const response = await fetch('http://localhost:3000/users');
    users = await response.json();
    
    const userTableBody = document.querySelector('#userTable tbody');
    userTableBody.innerHTML = ''; // Limpiar tabla
    
    users.forEach((user, index) => {
        const row = `
            <tr>
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td>${user.email}</td>
                <td>
                    <button onclick="editUser(${index})">Editar</button>
                    <button onclick="deleteUser(${index})">Eliminar</button>
                </td>
            </tr>
        `;
        userTableBody.innerHTML += row;
    });
};

// Función para editar usuario
const editUser = (index) => {
    const user = users[index];
    document.querySelector('#username').value = user.username;
    document.querySelector('#email').value = user.email;
    document.querySelector('#password').value = user.password;
    editIndex = index;
};

// Función para eliminar un usuario
const deleteUser = async (index) => {
    if (confirm("¿Estás seguro de eliminar este usuario?")) {
        await fetch(`http://localhost:3000/users/${users[index].id}`, {
            method: 'DELETE'
        });
        renderUsers(); // Recargar lista de usuarios
    }
};

// Manejar el evento de envío del formulario
document.querySelector('#userForm').addEventListener('submit', function (e) {
    e.preventDefault(); // Prevenir recarga de página
    const username = document.querySelector('#username').value;
    const email = document.querySelector('#email').value;
    const password = document.querySelector('#password').value;
    if (username && email && password) {
        saveUser(username, email, password);
        this.reset(); // Limpiar formulario
    }
});

// Cargar los usuarios al cargar la página
document.addEventListener('DOMContentLoaded', renderUsers);