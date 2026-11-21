import { appendFile } from "node:fs/promises";

export const ADMIN_EMAIL = "admin@orrery.test";
export const ADMIN_PASSWORD = "browser-checked-admin-password";

const secretsUsed = new URL("./.secrets-used", import.meta.url).pathname;

export const recordSecret = (value: string) => appendFile(secretsUsed, `${value}\n`, "utf8");
