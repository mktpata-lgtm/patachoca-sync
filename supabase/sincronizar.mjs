// Sincronización: copia los datos del origen a tu Supabase. Se ejecuta cada 5 min desde GitHub Actions
// y SOLO trabaja cuando le toca (según la frecuencia del admin) o si pediste "Forzar sincronización".
//
// Variables (secretos en GitHub, o en tu terminal):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   tu proyecto (la clave secreta NUNCA va en la página)
//   GESTOR_URL                           dirección del JSON del sistema de gestión (formato productos_1.json)
//   GESTOR_TOKEN                         opcional: se envía como "Authorization: Bearer ..."
//   MIN_FILAS                            opcional (1000): si el origen trae menos filas, se aborta sin tocar nada
// Es INCREMENTAL: guarda una huella por producto y solo envía los productos nuevos o modificados.
// Opciones:  --completo (reenvía todo, ignora las huellas)   --forzar (ignora la frecuencia)   --archivo ruta.json (usa un archivo en vez de GESTOR_URL)   --dry
import fs from "node:fs";
import { createHash } from "node:crypto";
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
    // El gestor arma el JSON al momento (3 a 5 min, a veces más): se espera hasta 8 min y se reintenta una vez.
    const pedir = async () => {
      const r = await fetch(process.env.GESTOR_URL, { headers: process.env.GESTOR_TOKEN ? { Authorization: `Bearer ${process.env.GESTOR_TOKEN}` } : {}, signal: AbortSignal.timeout(480000) });
      if (!r.ok) throw new Error(`El origen respondió ${r.status}`);
      return r.json();
    };
    try { filas = await pedir(); }
    catch (e) { console.log(`Primer intento falló (${e.message}); reintentando…`); filas = await pedir(); }
  }
  if (!Array.isArray(filas) || filas.length < MIN) throw new Error(`El origen trajo ${Array.isArray(filas) ? filas.length : "datos inválidos"} filas (mínimo ${MIN}): no se toca nada`);

  // 3) Transformar y subir (upsert por lotes)
  const reglas = JSON.parse(fs.readFileSync(new URL("../config/reglas.json", import.meta.url), "utf8"));
  const T = transformar(filas, reglas);
  console.log(Object.entries(T).map(([k, v]) => `${k}: ${v.length}`).join(" · "));
  if (flag("--dry")) process.exit(0);
  // Huella por producto = producto + sus variantes + su stock. Solo se envía lo que cambió.
  const claveDe = new Map(T.variantes.map((v) => [v.id, v.producto_clave]));
  const vPor = new Map(), sPor = new Map();
  for (const v of T.variantes) (vPor.get(v.producto_clave) || vPor.set(v.producto_clave, []).get(v.producto_clave)).push(v);
  for (const r of T.stock) { const c = claveDe.get(r.variante_id); (sPor.get(c) || sPor.set(c, []).get(c)).push(r); }
  const huella = new Map(T.productos.map((p) => [p.clave, createHash("sha1").update(JSON.stringify([p, vPor.get(p.clave) || [], sPor.get(p.clave) || []])).digest("hex")]));
  const previas = new Map();
  for (let off = 0; ; off += 1000) {
    const f = await api("GET", `productos?select=clave,hash_sync&order=clave&limit=1000&offset=${off}`);
    f.forEach((x) => previas.set(x.clave, x.hash_sync)); if (f.length < 1000) break;
  }
  const completo = flag("--completo");
  const cambiados = T.productos.filter((p) => completo || previas.get(p.clave) !== huella.get(p.clave));
  const ausentes = [...previas.entries()].filter(([c, h]) => h && !huella.has(c)).map(([c]) => c);
  if (previas.size > 1000 && ausentes.length > previas.size * 0.3) throw new Error(`Faltan ${ausentes.length} de ${previas.size} productos en el origen: se aborta sin tocar nada`);
  const setC = new Set(cambiados.map((p) => p.clave));
  const vars = T.variantes.filter((v) => setC.has(v.producto_clave));
  const stk = T.stock.filter((r) => setC.has(claveDe.get(r.variante_id))).map((r) => ({ ...r, visto: inicio }));
  console.log(`Cambiaron ${cambiados.length} de ${T.productos.length} productos (${vars.length} variantes, ${stk.length} stocks). Ausentes del origen: ${ausentes.length}.`);

  const subir = async (t, filas, conf) => { for (let i = 0; i < filas.length; i += 1000) await api("POST", `${t}?on_conflict=${conf}`, filas.slice(i, i + 1000), "resolution=merge-duplicates,return=minimal"); };
  await subir("sucursales", T.sucursales, "id");
  await subir("productos", cambiados, "clave");
  await subir("variantes", vars, "id");
  await subir("stock", stk, "variante_id,sucursal_id");

  // Lo que ya no viene del origen queda en stock 0 (nunca se borra: los pedidos dependen de estas filas)
  let enCero = 0;
  for (let i = 0; i < cambiados.length; i += 500) enCero += await rpc("sync_cerrar_productos", { p_claves: cambiados.slice(i, i + 500).map((p) => p.clave), p_visto: inicio });
  for (let i = 0; i < ausentes.length; i += 500) enCero += await rpc("sync_ausentes", { p_claves: ausentes.slice(i, i + 500) });
  // Recién ahora se guarda la huella: si algo falló antes, la próxima corrida reintenta esos productos
  for (let i = 0; i < cambiados.length; i += 500) await rpc("sync_marcar", { p: cambiados.slice(i, i + 500).map((p) => ({ clave: p.clave, hash: huella.get(p.clave) })) });
  const publicados = await rpc("refrescar_catalogo");
  await fin("ok", { productos: cambiados.length, variantes: vars.length, stock: stk.length, detalle: `${cambiados.length} productos cambiados de ${T.productos.length} · ${publicados} publicados · ${enCero} stocks puestos en 0` });
  console.log(`Listo: ${cambiados.length} productos actualizados, ${publicados} publicados, ${enCero} stocks puestos en 0.`);
} catch (e) {
  console.error("ERROR:", e.message);
  try { await fin("error", { detalle: String(e.message).slice(0, 500) }); } catch {}
  process.exit(1);
}
