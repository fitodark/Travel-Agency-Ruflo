import { api } from './cliente';

export interface EstadoSync {
  sucursalId: string | null;
  versionEsquema: string | null;
  versionBinario: string | null;
  ultimaSyncExitosa: string | null;
  derivaRelojSeg: number | null;
  outboxPendiente: number;
  outboxAtascado: number;
  outboxMasAntiguoEn: string | null;
  excepcionesAbiertas: { critica: number; alta: number; media: number; baja: number };
  ultimaPasadaAplicador: string | null;
  degradado: boolean;
}

export interface Excepcion {
  id: string;
  tipo: string;
  severidad: 'critica' | 'alta' | 'media' | 'baja';
  entidad: string | null;
  detalle: Record<string, unknown>;
  estado: string;
  creadoEn: string;
  sucursal: string | null;
}

export type ResultadoCiclo =
  | { ok: true; push: unknown; pull: unknown }
  | { ok: false; error: string };

export function estadoSync(): Promise<EstadoSync> {
  return api<EstadoSync>('/sync/estado');
}

export function excepcionesSync(): Promise<Excepcion[]> {
  return api<Excepcion[]>('/sync/excepciones');
}

export function forzarCiclo(): Promise<ResultadoCiclo> {
  return api<ResultadoCiclo>('/sync/ciclo', { method: 'POST' });
}
