// Fotos: copia las imágenes de la carpeta pública de Google Drive a Supabase Storage (bucket "fotos").
// Genera 2 tamaños WebP: m/ (900 px) y t/ (360 px). Solo baja lo nuevo o modificado.
// Optimizado: prioriza (y por defecto SOLO baja) las fotos de productos publicados, descarga en paralelo,
// miniatura derivada de la foto ya achicada, subida de ambos tamaños a la vez y filas guardadas por lotes.
// Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_API_KEY, DRIVE_FOLDER_ID
// Corre cada 10 min desde GitHub Actions, pero SOLO trabaja cuando le toca (frecuencia del panel) o si pediste "Forzar".
// Opcionales: MAX_NUEVAS (1500), PARALELO (4), TIEMPO_MAX_MIN (30), SOLO_PUBLICADOS ("1"; "0" = todas)
import { execSync } from "node:child_process";
// Opciones: --forzar (ignora la frecuencia del admin)
const FORZAR = process.argv.includes("--forzar");

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY;
const GK = process.env.GOOGLE_API_KEY, FOLDER = process.env.DRIVE_FOLDER_ID;
if (!URL_ || !KEY || !GK || !FOLDER) { console.error("Faltan SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_API_KEY o DRIVE_FOLDER_ID"); process.exit(1); }
const MAX = +(process.env.MAX_NUEVAS || 1500), PAR = +(process.env.PARALELO || 4);
const SOLO_PUB = (process.env.SOLO_PUBLICADOS ?? "1") !== "0";
const LIMITE = Date.now() + (+process.env.TIEMPO_MAX_MIN || 30) * 60000;

const H = (x = {}) => ({ apikey: KEY, ...(KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${KEY}` }), ...x });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
// Misma regla que la página: minúscula, sin espacios, sin extensión, solo [a-z0-9._-]
const clave = (n) => String(n || "").toLowerCase().replace(/\s+/g, "").replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9._-]/g, "_");
const quitarExt = (n) => String(n || "").toLowerCase().replace(/\s+/g, "").replace(/\.(jpe?g|png|webp|gif)$/, "");
const norm = quitarExt;
// Productos sin nombre de imagen en el sistema: el nombre habitual es CODIGO_CCOLOR (sin espacios, "|" ni "/")
const derivado = (cod, color) => quitarExt(String(cod || "").replace(/[|\/\s]/g, "") + "_C" + String(color || "").replace(/\s/g, ""));

async function rest(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: H({ "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} → ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function paginar(path) {
  const out = [];
  for (let off = 0; ; off += 1000) { const f = await rest("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`); out.push(...f); if (f.length < 1000) break; }
  return out;
}
async function listarDrive() {
  const out = []; let tok = "";
  do {
    const q = encodeURIComponent(`'${FOLDER}' in parents and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&key=${GK}${tok ? "&pageToken=" + tok : ""}`);
    if (!r.ok) throw new Error(`Drive lista → ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json(); out.push(...j.files); tok = j.nextPageToken || "";
  } while (tok);
  return out.filter((f) => /^image\//.test(f.mimeType));
}
async function subir(ruta, buf) {
  const r = await fetch(`${URL_}/storage/v1/object/fotos/${ruta}`, { method: "POST", headers: H({ "Content-Type": "image/webp", "x-upsert": "true", "cache-control": "max-age=31536000" }), body: buf });
  if (!r.ok) throw new Error(`Storage ${ruta} → ${r.status} ${(await r.text()).slice(0, 160)}`);
}

// Pausa global cuando Google frena (403/429): todos los trabajadores esperan y se vuelve a intentar
let pausaHasta = 0, pausaN = 0;
async function bajar(f) {
  let motivo = "";
  for (let intento = 0; intento < 4; intento++) {
    const espera = pausaHasta - Date.now(); if (espera > 0) await dormir(espera);
    for (const u of [`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${GK}`, `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=t`]) {
      const r = await fetch(u);
      const tipo = r.headers.get("content-type") || "";
      if (r.ok && tipo.startsWith("image/")) { pausaN = Math.max(0, pausaN - 1); return Buffer.from(await r.arrayBuffer()); }
      const t = r.ok ? "no devolvió imagen (" + tipo + ")" : (await r.text()).replace(/\s+/g, " ").slice(0, 140);
      motivo = `${r.status} ${t}`;
      if (r.status === 403 || r.status === 429) { pausaN = Math.min(pausaN + 1, 6); pausaHasta = Date.now() + 2000 * pausaN; }
    }
  }
  throw new Error("descarga " + f.name + " → " + motivo);
}

// ---- 0) ¿Le toca correr? (frecuencia y "forzar" del panel de administración)
let corrida = null, enDrive = null;
const cerrar = async (estado, extra = {}) => { if (corrida) { try { await rest("PATCH", `fotos_corridas?id=eq.${corrida}`, { fin: new Date().toISOString(), estado, ...extra }); } catch (e) { console.error("No se pudo anotar la corrida:", e.message); } } };
let conPanel = true;
try {
  const toca = FORZAR ? true : await rest("POST", "rpc/fotos_debe_correr", {});
  if (!toca) { console.log("Todavía no toca sincronizar fotos."); process.exit(0); }
  const inicio = new Date().toISOString();
  corrida = (await rest("POST", "fotos_corridas", { inicio, estado: "corriendo" }, "return=representation"))[0].id;
  await rest("PATCH", "fotos_solicitudes?tomado=is.null", { tomado: inicio });
} catch (e) {
  if (/→ (404|400)/.test(e.message)) { conPanel = false; console.log("Aviso: falta ejecutar 09_fotos_panel.sql; corro igual, sin bitácora."); } else throw e;
}
process.on("uncaughtException", async (e) => { console.error(e); await cerrar("error", { detalle: String(e.message || e).slice(0, 300) }); process.exit(1); });
let sharp;
try { sharp = (await import("sharp")).default; } catch { console.log("Instalando sharp…"); execSync("npm install --no-save sharp", { stdio: "inherit" }); sharp = (await import("sharp")).default; }
sharp.cache(false); sharp.concurrency(2);

// ---- 1) Qué hay en Drive, qué ya está en Supabase y qué productos están publicados
const archivos = await listarDrive();
console.log(`Drive: ${archivos.length} imágenes`);
enDrive = archivos.length;
if (archivos.length < 1) { console.error("La carpeta devolvió 0 imágenes: aborto sin tocar nada."); await cerrar("error", { detalle: "La carpeta de Drive devolvió 0 imágenes" }); process.exit(1); }
const ya = new Map((await paginar("fotos?select=drive_file_id,drive_modificado,ruta_storage&order=id")).map((x) => [x.drive_file_id, x]));
const publicadas = new Set((await paginar("catalogo_publicado?select=imagen,cod_fabrica,color&order=clave")).map((x) => (x.imagen ? norm(x.imagen) : derivado(x.cod_fabrica, x.color))).filter(Boolean));
console.log(`Productos publicados con foto indicada: ${publicadas.size}`);

const cambiado = (f) => { const x = ya.get(f.id); return !x || !x.ruta_storage || new Date(x.drive_modificado).getTime() !== new Date(f.modifiedTime).getTime(); };
const prio = (f) => publicadas.has(norm(f.name));
let pend = archivos.filter(cambiado);
const pendPrio = pend.filter(prio), pendResto = pend.filter((f) => !prio(f));
const cola = SOLO_PUB ? pendPrio : [...pendPrio, ...pendResto];
console.log(`Pendientes: ${pend.length} (de productos publicados: ${pendPrio.length}; otras: ${pendResto.length}${SOLO_PUB ? " — se omiten, usá SOLO_PUBLICADOS=0 para bajarlas" : ""})`);
const lote = cola.slice(0, MAX);
console.log(`Esta corrida: ${lote.length}`);

// ---- 2) Procesar en paralelo
let ok = 0, mal = 0, i = 0; const filas = [];
async function volcar() {
  if (!filas.length) return;
  const x = filas.splice(0, filas.length);
  await rest("POST", "fotos?on_conflict=drive_file_id", x, "resolution=merge-duplicates,return=minimal");
}
async function uno(f) {
  const src = await bajar(f);
  const m = await sharp(src, { failOn: "none", limitInputPixels: 80e6 }).rotate().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 80, effort: 3 }).toBuffer();
  const t = await sharp(m).resize({ width: 360, withoutEnlargement: true }).webp({ quality: 74, effort: 3 }).toBuffer();
  const k = clave(f.name);
  await Promise.all([subir(`m/${k}.webp`, m), subir(`t/${k}.webp`, t)]);
  filas.push({ drive_file_id: f.id, nombre_archivo: f.name, ruta_storage: `m/${k}.webp`, drive_modificado: f.modifiedTime });
  if (filas.length >= 25) await volcar();
}
const t0 = Date.now(), ventana = []; let frenado = false;
// Si Google/Supabase frena (menos de 60 fotos/min en las últimas 100, tras 3 min), se corta: la próxima corrida arranca a máxima velocidad
const lento = () => { if (ventana.length < 100 || Date.now() - t0 < 180000) return false; return Date.now() - ventana[ventana.length - 100] > 100000; };
await Promise.all(Array.from({ length: PAR }, async () => {
  while (i < lote.length) {
    if (frenado || lento()) { if (!frenado) console.log("La velocidad bajó de 60 fotos por minuto (límite de Google): corto y sigo en la próxima corrida."); frenado = true; break; }
    if (Date.now() > LIMITE) { console.log("Tiempo máximo alcanzado: corto ordenadamente; sigo en la próxima corrida."); break; }
    if (mal >= 30 && ok === 0) { console.error("30 errores seguidos sin ninguna foto subida: corto para no gastar minutos."); break; }
    const f = lote[i++];
    try { await uno(f); ok++; ventana.push(Date.now()); } catch (e) { mal++; console.error("✗", f.name, e.message); }
    if ((ok + mal) % 50 === 0) console.log(`  ${ok + mal}/${lote.length} · ${Math.round((ok + mal) / ((Date.now() - t0) / 60000))} por minuto`);
  }
}));
await volcar();

// ---- 3) Quitar de la base las fotos que ya no están en Drive (la lista vino completa)
const vivos = new Set(archivos.map((f) => f.id));
const borrar = [...ya.keys()].filter((id) => !vivos.has(id));
for (const id of borrar) await rest("DELETE", `fotos?drive_file_id=eq.${encodeURIComponent(id)}`);
const faltan = Math.max(0, cola.length - ok);
console.log(`Listo: ${ok} subidas, ${mal} con error, ${borrar.length} quitadas. Faltan ${faltan} de productos publicados${SOLO_PUB ? "" : " y otras"}.`);
const fallo = mal > Math.max(10, lote.length / 2);
await cerrar(fallo ? "error" : "ok", { subidas: ok, errores: mal, pendientes: faltan, en_drive: enDrive, detalle: fallo ? "Muchas fotos con error (" + mal + " de " + lote.length + ")" : null });
if (fallo) process.exit(1);
