import {pool} from "./connectionPostgreSQL";

const getLanguages=()=>{
    try{
        const result = await pool.query("SELECT id, name, phone, email, password FROM users;");
        console.table(result.rows);
        console.log("Language listed");
    }catch(error){
        console.error(error);
    }
};

getLanguages()