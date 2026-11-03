// Fotos: copia las imágenes de la carpeta pública de Google Drive a Supabase Storage (bucket "fotos").
// Solo baja lo nuevo o modificado. Genera 2 tamaños WebP: m/ (900 px) y t/ (360 px).
// Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_API_KEY, DRIVE_FOLDER_ID
// Opcionales: MAX_NUEVAS (400 por corrida), PARALELO (4)
import sharp from "sharp";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY;
const GK = process.env.GOOGLE_API_KEY, FOLDER = process.env.DRIVE_FOLDER_ID;
if (!URL_ || !KEY || !GK || !FOLDER) { console.error("Faltan SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_API_KEY o DRIVE_FOLDER_ID"); process.exit(1); }
const MAX = +(process.env.MAX_NUEVAS || 400), PAR = +(process.env.PARALELO || 2);
const H = (x = {}) => ({ apikey: KEY, ...(KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${KEY}` }), ...x });

// Misma regla que la página: minúscula, sin espacios, sin extensión, solo [a-z0-9._-]
const clave = (n) => String(n || "").toLowerCase().replace(/\s+/g, "").replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9._-]/g, "_");

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
async function rest(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: H({ "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} → ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function subir(ruta, buf) {
  const r = await fetch(`${URL_}/storage/v1/object/fotos/${ruta}`, { method: "POST", headers: H({ "Content-Type": "image/webp", "x-upsert": "true", "cache-control": "max-age=31536000" }), body: buf });
  if (!r.ok) throw new Error(`Storage ${ruta} → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const archivos = await listarDrive();
console.log(`Drive: ${archivos.length} imágenes`);
if (archivos.length < 1) { console.error("La carpeta devolvió 0 imágenes: aborto sin tocar nada."); process.exit(1); }
const ya = new Map();
for (let off = 0; ; off += 1000) {
  const f = await rest("GET", `fotos?select=drive_file_id,drive_modificado,ruta_storage&order=id&limit=1000&offset=${off}`);
  f.forEach((x) => ya.set(x.drive_file_id, x)); if (f.length < 1000) break;
}
const pendientes = archivos.filter((f) => { const x = ya.get(f.id); return !x || !x.ruta_storage || new Date(x.drive_modificado).getTime() !== new Date(f.modificado || f.modifiedTime).getTime(); });
console.log(`Pendientes: ${pendientes.length} (esta corrida: ${Math.min(MAX, pendientes.length)})`);

let ok = 0, mal = 0;
const lote = pendientes.slice(0, MAX);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function bajar(f) {
  let motivo = "";
  for (let intento = 0; intento < 4; intento++) {
    for (const u of [`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${GK}`, `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=t`]) {
      const r = await fetch(u);
      const tipo = r.headers.get("content-type") || "";
      if (r.ok && tipo.startsWith("image/")) return Buffer.from(await r.arrayBuffer());
      const t = r.ok ? "no devolvió imagen (" + tipo + ")" : (await r.text()).replace(/\s+/g, " ").slice(0, 160);
      motivo = `${r.status} ${t}`;
    }
    await dormir(1500 * (intento + 1));
  }
  throw new Error("descarga " + f.name + " → " + motivo);
}
async function uno(f) {
  const buf = await bajar(f);
  const src = buf;
  const base = sharp(src, { failOn: "none" }).rotate();
  const m = await base.clone().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const t = await base.clone().resize({ width: 360, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
  const k = clave(f.name);
  await subir(`m/${k}.webp`, m); await subir(`t/${k}.webp`, t);
  await rest("POST", "fotos?on_conflict=drive_file_id", [{ drive_file_id: f.id, nombre_archivo: f.name, ruta_storage: `m/${k}.webp`, drive_modificado: f.modifiedTime }], "resolution=merge-duplicates,return=minimal");
}
let i = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (i < lote.length) { if (mal >= 30 && ok === 0) { console.error('30 errores seguidos sin ninguna foto subida: corto para no gastar minutos.'); break; } const f = lote[i++]; try { await uno(f); ok++; } catch (e) { mal++; console.error("✗", f.name, e.message); } if ((ok + mal) % 50 === 0) console.log(`  ${ok + mal}/${lote.length}`); }
}));

// Quita de la base las fotos que ya no están en Drive (solo si la lista de Drive vino completa)
const vivos = new Set(archivos.map((f) => f.id));
const borrar = [...ya.keys()].filter((id) => !vivos.has(id));
for (const id of borrar) await rest("DELETE", `fotos?drive_file_id=eq.${encodeURIComponent(id)}`);
console.log(`Listo: ${ok} subidas, ${mal} con error, ${borrar.length} quitadas. Quedan ${Math.max(0, pendientes.length - lote.length)} por bajar.`);
if (mal > lote.length / 2) process.exit(1);
