/**
 * Export semanal para el cliente (F8, mitigación R11).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8), R11
 *
 * Genera un bundle con todos los reportes de una semana. Determinista y sin
 * entrada del operador: lo dispara una tarea programada en la nube (F9 cablea la
 * entrega). `generarBundleSemanal` arma los datos; `escribirBundle` los vuelca a
 * disco — separados para poder probar el contenido sin tocar el filesystem.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Consultable } from '../db/consulta.js';
import {
  auditoriaInactivos, excepcionesAbiertas, excepcionesResumen, gastos, saludSucursales,
} from './auditoria.js';
import { reporteCortes, reporteIngresosCaja, reporteVentas, ventasVsCaja } from './operacion.js';

export interface RangoSemana {
  /** `YYYY-MM-DD`, inclusivo. */
  desde: string;
  hasta: string;
}

/** La última semana COMPLETA (lunes a domingo) anterior a `hoy` (UTC). */
export function rangoSemanaAnterior(hoy: Date = new Date()): RangoSemana {
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
  // getUTCDay: 0 = domingo. Días desde el lunes de ESTA semana:
  const desdeLunesEsta = (d.getUTCDay() + 6) % 7;
  const domingoPasado = new Date(d);
  domingoPasado.setUTCDate(d.getUTCDate() - desdeLunesEsta - 1);
  const lunesPasado = new Date(domingoPasado);
  lunesPasado.setUTCDate(domingoPasado.getUTCDate() - 6);
  return {
    desde: lunesPasado.toISOString().slice(0, 10),
    hasta: domingoPasado.toISOString().slice(0, 10),
  };
}

/** Etiqueta `YYYY-Www` de una fecha ISO (para nombrar la carpeta). */
export function etiquetaSemana(fechaIso: string): string {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  const jueves = new Date(d);
  jueves.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const primerJueves = new Date(Date.UTC(jueves.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round(
    ((jueves.getTime() - primerJueves.getTime()) / 86_400_000
      - 3 + ((primerJueves.getUTCDay() + 6) % 7)) / 7,
  );
  return `${jueves.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}

export interface BundleSemanal {
  rango: RangoSemana & { generadoEn: string; etiqueta: string };
  ventas: Awaited<ReturnType<typeof reporteVentas>>;
  ingresosCaja: Awaited<ReturnType<typeof reporteIngresosCaja>>;
  ventasVsCaja: Awaited<ReturnType<typeof ventasVsCaja>>;
  cortes: Awaited<ReturnType<typeof reporteCortes>>;
  gastos: Awaited<ReturnType<typeof gastos>>;
  salud: Awaited<ReturnType<typeof saludSucursales>>;
  excepciones: Awaited<ReturnType<typeof excepcionesAbiertas>>;
  excepcionesResumen: Awaited<ReturnType<typeof excepcionesResumen>>;
  inactivos: Awaited<ReturnType<typeof auditoriaInactivos>>;
}

export async function generarBundleSemanal(
  db: Consultable,
  rango: RangoSemana,
  ahora: Date = new Date(),
): Promise<BundleSemanal> {
  const r = { desde: rango.desde, hasta: rango.hasta };
  // Secuencial a propósito: un pg.Client no ejecuta consultas en paralelo, y esto
  // es un job semanal — la latencia no importa.
  const ventas = await reporteVentas(db, r);
  const ingresosCaja = await reporteIngresosCaja(db, r);
  const vsCaja = await ventasVsCaja(db, r.desde, r.hasta);
  const cortes = await reporteCortes(db, r);
  const gastosF = await gastos(db, r.desde, r.hasta);
  const salud = await saludSucursales(db);
  const excepciones = await excepcionesAbiertas(db);
  const resumen = await excepcionesResumen(db);
  const inactivos = await auditoriaInactivos(db);

  return {
    rango: {
      ...r,
      generadoEn: ahora.toISOString(),
      etiqueta: etiquetaSemana(r.desde),
    },
    ventas,
    ingresosCaja,
    ventasVsCaja: vsCaja,
    cortes,
    gastos: gastosF,
    salud,
    excepciones,
    excepcionesResumen: resumen,
    inactivos,
  };
}

/** Vuelca el bundle a `<outDir>/<etiqueta>/*.json`. Devuelve las rutas escritas. */
export async function escribirBundle(
  bundle: BundleSemanal, outDir: string,
): Promise<string[]> {
  const dir = path.join(outDir, bundle.rango.etiqueta);
  await mkdir(dir, { recursive: true });

  const archivos: Array<[string, unknown]> = [
    ['rango.json', bundle.rango],
    ['ventas.json', bundle.ventas],
    ['ingresos-caja.json', bundle.ingresosCaja],
    ['ventas-vs-caja.json', bundle.ventasVsCaja],
    ['cortes.json', bundle.cortes],
    ['gastos.json', bundle.gastos],
    ['salud.json', bundle.salud],
    ['excepciones.json', bundle.excepciones],
    ['excepciones-resumen.json', bundle.excepcionesResumen],
    ['inactivos.json', bundle.inactivos],
  ];

  const rutas: string[] = [];
  for (const [nombre, datos] of archivos) {
    const ruta = path.join(dir, nombre);
    await writeFile(ruta, JSON.stringify(datos, null, 2) + '\n', 'utf8');
    rutas.push(ruta);
  }
  return rutas;
}
