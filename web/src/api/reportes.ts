import { api } from './cliente';

export interface Rango {
  desde: string;
  hasta: string;
}

export interface FilaVentas {
  sucursalId: string;
  sucursal: string;
  dia: string;
  operaciones: number;
  boletos: number;
  reservaciones: number;
  importeVendido: number;
  importeLiquidado: number;
}

export interface FilaIngresosCaja {
  sucursalId: string;
  sucursal: string;
  dia: string;
  pagos: number;
  efectivo: number;
  transferencia: number;
  transferenciaPendiente: number;
  totalConfirmado: number;
}

export interface FilaVentasVsCaja {
  sucursal: string;
  importeVendido: number;
  ingresoACaja: number;
  diferencia: number;
  nota: string;
}

export interface FilaCorte {
  corteId: string;
  sucursal: string;
  abiertoEn: string;
  cerradoEn: string | null;
  estado: 'abierto' | 'cerrado';
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
  saldoDeclarado: number | null;
  diferencia: number | null;
}

export interface FilaGasto {
  concepto: string;
  sucursal: string | null;
  movimientos: number;
  monto: number;
}

export interface SaludSucursal {
  sucursalId: string;
  sucursal: string;
  ultimaSyncExitosa: string | null;
  atrasoHoras: number | null;
  outboxPendiente: number | null;
  derivaRelojSeg: number | null;
  excepcionesCriticas: number | null;
  versionEsquema: string | null;
  degradado: boolean | null;
}

export type Severidad = 'critica' | 'alta' | 'media' | 'baja';

export interface ExcepcionAbierta {
  excepcionId: string;
  sucursal: string | null;
  tipo: string;
  severidad: Severidad;
  entidad: string | null;
  creadoEn: string;
  antiguedadHoras: number;
}

export interface Excepciones {
  resumen: Record<Severidad, number>;
  abiertas: ExcepcionAbierta[];
}

const qs = (r: Rango): string =>
  `?desde=${encodeURIComponent(r.desde)}&hasta=${encodeURIComponent(r.hasta)}`;

export const reporteVentas = (r: Rango): Promise<FilaVentas[]> =>
  api<FilaVentas[]>(`/reportes/ventas${qs(r)}`);

export const reporteIngresosCaja = (r: Rango): Promise<FilaIngresosCaja[]> =>
  api<FilaIngresosCaja[]>(`/reportes/ingresos-caja${qs(r)}`);

export const ventasVsCaja = (r: Rango): Promise<FilaVentasVsCaja[]> =>
  api<FilaVentasVsCaja[]>(`/reportes/ventas-vs-caja${qs(r)}`);

export const reporteCortes = (r: Rango): Promise<FilaCorte[]> =>
  api<FilaCorte[]>(`/reportes/cortes${qs(r)}`);

export const gastos = (r: Rango): Promise<FilaGasto[]> =>
  api<FilaGasto[]>(`/reportes/gastos${qs(r)}`);

export const saludSucursales = (): Promise<SaludSucursal[]> =>
  api<SaludSucursal[]>('/reportes/salud');

export const excepciones = (): Promise<Excepciones> =>
  api<Excepciones>('/reportes/excepciones');
