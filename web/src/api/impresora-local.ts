/**
 * Override LOCAL de emergencia para la impresora (0078).
 *
 * A diferencia de `api/admin.ts`, esto habla con `/impresora-local` (no con
 * `/admin`): funciona AUNQUE no haya conexión a la nube — es justo el
 * escenario que resuelve (ver `src/api/rutas/impresora-local.ts`).
 */

import { api } from './cliente';

export type Transporte = 'tcp' | 'usb';

export interface OverrideLocal {
  impresoraId: string;
  transporte: Transporte;
  ip: string | null;
  puerto: number | null;
  usbNombreCola: string | null;
  nota: string | null;
  actualizadoEn: string;
  actualizadoPor: string;
}

export interface ImpresoraLocal {
  id: string;
  sucursalId: string;
  nombre: string;
  transporte: Transporte;
  ip: string | null;
  puerto: number | null;
  usbNombreCola: string | null;
  esPredeterminada: boolean;
  override: OverrideLocal | null;
}

export function listarImpresorasLocales(): Promise<ImpresoraLocal[]> {
  return api<ImpresoraLocal[]>('/impresora-local');
}

export function fijarOverrideLocal(impresoraId: string, d: {
  transporte: Transporte; ip?: string; puerto?: number; usbNombreCola?: string; nota?: string;
}): Promise<void> {
  return api(`/impresora-local/${impresoraId}`, { method: 'POST', body: JSON.stringify(d) });
}

export function quitarOverrideLocal(impresoraId: string): Promise<void> {
  return api(`/impresora-local/${impresoraId}`, { method: 'DELETE' });
}
