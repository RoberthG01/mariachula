import dotenv from "dotenv";
dotenv.config();

const secret = process.env.JWT_SECRET;
console.log("Valor real:", JSON.stringify(secret));
console.log("Longitud:", secret.length);
for (let i = 0; i < secret.length; i++) {
  console.log(i, secret.charCodeAt(i));
}
