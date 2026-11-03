// Sincronización: copia los datos del origen a tu Supabase. Se ejecuta cada 5 min desde GitHub Actions
// y SOLO trabaja cuando le toca (según la frecuencia del admin) o si pediste "Forzar sincronización".
//
// Variables (secretos en GitHub, o en tu terminal):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   tu proyecto (la clave secreta NUNCA va en la página)
//   GESTOR_URL                           dirección del JSON del sistema de gestión (formato productos_1.json)
//   GESTOR_TOKEN                         opcional: se envía como "Authorization: Bearer ..."
//   MIN_FILAS                            opcional (1000): si el origen trae menos filas, se aborta sin tocar nada
// Opciones:  --forzar (ignora la frecuencia)   --archivo ruta.json (usa un archivo en vez de GESTOR_URL)   --dry
import fs from "node:fs";
import { transformar } from "./transformar.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n), val = (n) => (flag(n) ? args[args.indexOf(n) + 1] : null);
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY"); process.exit(1); }
const MIN = +(process.env.MIN_FILAS || 1000);

const H = (extra = {}) => ({ apikey: KEY, ...(KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${KEY}` }), "Content-Type": "application/json", ...extra });
async function api(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: H(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} → ${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}
const rpc = (fn, body = {}) => api("POST", `rpc/${fn}`, body);

// 1) ¿Le toca correr?
const toca = flag("--forzar") ? true : await rpc("sync_debe_correr");
if (!toca) { console.log("Todavía no toca sincronizar."); process.exit(0); }

const inicio = new Date().toISOString();
let corrida = null;
const fin = async (estado, extra = {}) => { if (corrida) await api("PATCH", `sync_corridas?id=eq.${corrida}`, { fin: new Date().toISOString(), estado, ...extra }); };
try {
  if (!flag("--dry")) {
    corrida = (await api("POST", "sync_corridas", { inicio, estado: "corriendo" }, "return=representation"))[0].id;
    await api("PATCH", "sync_solicitudes?tomado=is.null", { tomado: inicio });   // toma los pedidos de "forzar"
  }

  // 2) Leer el origen
  let filas;
  if (val("--archivo")) filas = JSON.parse(fs.readFileSync(val("--archivo"), "utf8"));
  else {
    if (!process.env.GESTOR_URL) throw new Error("Falta GESTOR_URL (o usá --archivo)");
    const r = await fetch(process.env.GESTOR_URL, { headers: process.env.GESTOR_TOKEN ? { Authorization: `Bearer ${process.env.GESTOR_TOKEN}` } : {}, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`El origen respondió ${r.status}`);
    filas = await r.json();
  }
  if (!Array.isArray(filas) || filas.length < MIN) throw new Error(`El origen trajo ${Array.isArray(filas) ? filas.length : "datos inválidos"} filas (mínimo ${MIN}): no se toca nada`);

  // 3) Transformar y subir (upsert por lotes)
  const reglas = JSON.parse(fs.readFileSync(new URL("../config/reglas.json", import.meta.url), "utf8"));
  const T = transformar(filas, reglas);
  console.log(Object.entries(T).map(([k, v]) => `${k}: ${v.length}`).join(" · "));
  if (flag("--dry")) process.exit(0);
  T.stock = T.stock.map((r) => ({ ...r, visto: inicio }));
  const conflicto = { sucursales: "id", productos: "clave", variantes: "id", stock: "variante_id,sucursal_id" };
  for (const t of ["sucursales", "productos", "variantes", "stock"])
    for (let i = 0; i < T[t].length; i += 1000)
      await api("POST", `${t}?on_conflict=${conflicto[t]}`, T[t].slice(i, i + 1000), "resolution=merge-duplicates,return=minimal");

  // 4) Lo que ya no viene del origen queda en stock 0, y se rearma el catálogo que lee la tienda
  const enCero = await rpc("sync_cerrar", { p_visto: inicio });
  const publicados = await rpc("refrescar_catalogo");
  await fin("ok", { productos: T.productos.length, variantes: T.variantes.length, stock: T.stock.length, detalle: `${publicados} publicados · ${enCero} stocks puestos en 0` });
  console.log(`Listo: ${publicados} productos publicados, ${enCero} stocks puestos en 0.`);
} catch (e) {
  console.error("ERROR:", e.message);
  try { await fin("error", { detalle: String(e.message).slice(0, 500) }); } catch {}
  process.exit(1);
}
