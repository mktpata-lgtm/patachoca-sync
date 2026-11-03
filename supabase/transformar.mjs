// Convierte las filas del sistema de gestión (productos_1.json) en filas para las tablas de Supabase.
// Una fila del origen = una variante (talla) en UNA sucursal. Aquí se agrupan en
// sucursales -> productos (codFabrica + color) -> variantes -> stock.
// Solo se importan precios minoristas (los mayoristas no se publican).

const norm = (s) => (s ?? "").toString().trim().replace(/\s+/g, " ").toUpperCase();
const slug = (s) =>
  norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fecha = (d) => (!d || String(d).startsWith("1899") || String(d).startsWith("0001") ? null : String(d).slice(0, 10));
const titulo = (s) => norm(s).toLowerCase().replace(/(^|[\s/.-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

export function transformar(filas, reglas) {
  const tiendas = reglas.tiendas || {}; // { "PATA 1": { id, nombre } }
  const sucursales = new Map();
  const productos = new Map();
  const variantes = new Map();
  const stock = new Map();
  let orden = 0;

  for (const r of filas) {
    const cod = (r.sucursal ?? "").toString().trim();
    if (!cod) continue;
    if (!sucursales.has(cod)) {
      const t = tiendas[cod];
      sucursales.set(cod, {
        id: t ? t.id : slug(cod),
        codigo_gestor: cod,
        nombre: t ? t.nombre : titulo(cod),
        es_tienda: !!t,
        activa: !!t, // solo las tiendas cuentan para publicar y mostrar stock
        orden: t ? orden++ : 100 + sucursales.size,
      });
    }
    const suc = sucursales.get(cod);
    const clave = `${norm(r.codFabrica)}|${norm(r.color)}`;
    if (!productos.has(clave)) {
      productos.set(clave, {
        clave,
        cod_fabrica: String(r.codFabrica ?? "").trim(),
        color: titulo(r.color),
        nombre: titulo(`${r.subgrupo ?? ""} ${r.marca ?? ""}`).trim() || titulo(r.nmProduto),
        marca: titulo(r.marca),
        grupo: norm(r.grupo),
        subgrupo: norm(r.subgrupo),
        coleccion: norm(r.colecao),
        imagen: r.imagen || null,
        ult_compra: fecha(r.dataUltCmp),
        ult_venta: fecha(r.dataUltVnd),
        mas_vendido: Math.round(r.qMasVendio || 0),
      });
    } else {
      const p = productos.get(clave);
      const c = fecha(r.dataUltCmp), v = fecha(r.dataUltVnd);
      if (c && (!p.ult_compra || c > p.ult_compra)) p.ult_compra = c;
      if (v && (!p.ult_venta || v > p.ult_venta)) p.ult_venta = v;
      p.mas_vendido = Math.max(p.mas_vendido, Math.round(r.qMasVendio || 0));
      if (!p.imagen && r.imagen) p.imagen = r.imagen;
    }
    if (!variantes.has(r.id)) {
      variantes.set(r.id, {
        id: r.id,
        producto_clave: clave,
        ean: r.ean || null,
        talla: String(r.grade ?? "").trim(),
        precio: Math.round(r.precioMinorista || 0),
        precio_promo: Math.round(r.precioMinoristaPromo || 0),
        promo_inicio: fecha(r.precioMinoristaPromoInicio),
        promo_fin: fecha(r.precioMinoristaPromoValidade),
      });
    }
    const k = `${r.id}|${suc.id}`;
    const q = Math.max(0, Math.round(r.cantidad || 0));
    stock.set(k, { variante_id: r.id, sucursal_id: suc.id, cantidad: (stock.get(k)?.cantidad || 0) + q });
  }
  return {
    sucursales: [...sucursales.values()],
    productos: [...productos.values()],
    variantes: [...variantes.values()],
    stock: [...stock.values()],
  };
}
