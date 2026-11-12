import { hashPassword } from "../src/server/auth";

// Reads stdin; keep the password itself out of the shell command and its history.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (!password) throw new Error("Pipe the password on stdin.");
console.log(await hashPassword(password));
