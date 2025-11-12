// < - - - - - -  BACKUP TOTAL - Restaurante María Chula (Windows + Azure Ready) - - - - - >
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import dotenv from "dotenv";

dotenv.config(); // lee .env

const fecha = new Date().toISOString().split("T")[0];
const projectRoot = process.cwd();
const backupDir = path.join(projectRoot, "backups");
const dbDump = path.join(backupDir, `db_backup_${fecha}.backup`);
const zipFile = path.join(backupDir, `backup_total_${fecha}.zip`);

// Asegura carpeta
fs.mkdirSync(backupDir, { recursive: true });

// Datos BD desde .env o defaults
const DB_HOST = process.env.HOST || "localhost";
const DB_PORT = process.env.PORT_DB || "5432";
const DB_USER = process.env.DB_USER || "postgres";
const DB_NAME = process.env.DATABASE || "restaurante";
const PGPASSWORD = process.env.PGPASSWORD || process.env.PASSWORD || "";

// 1) Dump de BD con pg_dump (formato custom
const pgDumpCmd = `"C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe" -U "${DB_USER}" -h "${DB_HOST}" -p "${DB_PORT}" -F c -b -v -f "${dbDump}" "${DB_NAME}"`;
console.log("Ejecutando:", pgDumpCmd);

exec(pgDumpCmd, { env: { ...process.env, PGPASSWORD } }, (error, stdout, stderr) => {
  if (error) {
    console.error("❌ Error al generar backup de BD:", error.message);
    console.error(stderr);
    process.exit(1);
  }
  console.log("✅ Backup de base de datos creado:", dbDump);

  // 2) Crear ZIP del proyecto e incluir el .backup (excluyendo basura
  const output = fs.createWriteStream(zipFile);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    console.log(`✅ Backup completo generado (${archive.pointer()} bytes):`);
    console.log(zipFile);

    // 3) (Opcional) Borra el .backup suelto luego de estar dentro del ZIP
    try { fs.unlinkSync(dbDump); } catch {}
    // 4) (Opcional) Subir a Azure Blob: ver seccion más abajo (agregar exec con az CLI)
  });

  archive.on("error", (err) => { throw err; });
  archive.pipe(output);

  // EXCLUSIONES (muy importante para no inflar el ZIP)
  const ignorePatterns = [
    "node_modules/**",
    ".git/**",
    ".vscode/**",
    "backups/**"
  ];

  // Agregar todo el proyecto con exclusiones
  archive.glob("**/*", { ignore: ignorePatterns });

  // Incluir el dump de BD (por si las exclusiones afectan)
  archive.file(dbDump, { name: path.basename(dbDump) });

  archive.finalize();
});