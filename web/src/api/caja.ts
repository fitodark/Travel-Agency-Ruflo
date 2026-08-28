import { api } from './cliente';

export interface CorteAbierto {
  corteId: string;
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
}

export interface Movimiento {
  id: string;
  corteCajaId: string;
  tipo: 'ingreso' | 'egreso';
  origenTipo: string;
  origenId: string | null;
  descripcion: string | null;
  monto: number;
  usuarioId: string;
  registradoEn: string;
  activo: boolean;
}

export interface CierreCorte {
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
  saldoDeclarado: number;
  diferencia: number;
}

export function corteAbierto(): Promise<CorteAbierto | null> {
  return api<CorteAbierto | null>('/caja/corte');
}

export function abrirCorte(saldoInicial: number): Promise<{ corteId: string }> {
  return api('/caja/corte', { method: 'POST', body: JSON.stringify({ saldoInicial }) });
}

export function cerrarCorte(corteId: string, saldoDeclarado: number): Promise<CierreCorte> {
  return api<CierreCorte>(`/caja/corte/${corteId}/cerrar`, {
    method: 'POST',
    body: JSON.stringify({ saldoDeclarado }),
  });
}

export function movimientos(corteId: string): Promise<Movimiento[]> {
  return api<Movimiento[]>(`/caja/corte/${corteId}/movimientos`);
}

export function registrarEgreso(
  corteId: string, datos: { monto: number; descripcion: string },
): Promise<{ movimientoId: string }> {
  return api(`/caja/corte/${corteId}/egresos`, {
    method: 'POST',
    body: JSON.stringify(datos),
  });
}

export function anularMovimiento(id: string, motivo: string): Promise<{ anulado: boolean }> {
  return api(`/caja/movimientos/${id}/anular`, {
    method: 'POST',
    body: JSON.stringify({ motivo }),
  });
}
