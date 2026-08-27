/**
 * Carga de la configuración de impresión desde la base de datos.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2 y §3
 *
 * Hasta ahora la capa de impresión recibía su configuración a mano y la PoC la tomaba de
 * argumentos de línea de comandos. Eso sirve para probar, pero significa que poner en
 * marcha una sucursal exigiría editar código: la IP de la impresora, el ancho del papel,
 * la leyenda del pie y la clave del QR son DATOS de cada terminal, no constantes del
 * programa.
 *
 * Con esto, dar de alta una impresora es insertar una fila. Y como `config_impresora` es
 * clase A, esa fila baja desde la nube igual que cualquier otra configuración: el
 * administrador puede corregir la IP de una terminal a seis horas de distancia sin que
 * nadie toque el equipo.
 */

import type { Client } from 'pg';
import type { CodePageName } from './escpos/codepage.js';
import type { ConfigTicket } from './templates/boleto.js';
import { TcpTransport } from './transport/tcp.js';
import { UsbTransport } from './transport/usb.js';
import type { EscPosTransport } from './transport/types.js';

export interface ConfigImpresoraRow {
  id: string;
  sucursal_id: string;
  nombre: string;
  transporte: string;
  ip: string | null;
  puerto: number | null;
  usb_nombre_cola: string | null;
  ancho_mm: number;
  ancho_cols: number;
  code_page: string;
  soporta_qr_nativo: boolean;
}

export interface ConfigTicketRow {
  agencia_id: string;
  logo_url: string | null;
  telefono_atencion: string | null;
  leyenda_pie: string | null;
  credenciales_proveedor: string | null;
  hmac_qr_secreto: string | null;
}

/**
 * Impresora vigente de una sucursal.
 *
 * Devuelve `null` si no hay ninguna configurada, que NO es un error: una terminal recién
 * instalada opera sin impresora hasta que llega el equipo. La venta debe poder cerrarse y
 * el `print_job` quedar encolado; lo que no puede es reventar en el mostrador.
 */
export async function cargarConfigImpresora(
  client: Client,
  sucursalId: string,
): Promise<ConfigImpresoraRow | null> {
  const { rows } = await client.query<ConfigImpresoraRow>(
    `SELECT id, sucursal_id, nombre, transporte, host(ip) AS ip, puerto, usb_nombre_cola,
            ancho_mm, ancho_cols, code_page, soporta_qr_nativo
       FROM core.v_config_impresora_vigente
      WHERE sucursal_id = $1`,
    [sucursalId],
  );
  return rows[0] ?? null;
}

/** Leyendas y datos de pie en vigor ahora para la agencia. */
export async function cargarConfigTicket(
  client: Client,
  agenciaId: string,
): Promise<ConfigTicketRow | null> {
  const { rows } = await client.query<ConfigTicketRow>(
    `SELECT agencia_id, logo_url, telefono_atencion, leyenda_pie,
            credenciales_proveedor, hmac_qr_secreto
       FROM core.v_config_ticket_vigente
      WHERE agencia_id = $1`,
    [agenciaId],
  );
  return rows[0] ?? null;
}

const CODE_PAGES: readonly string[] = ['CP437', 'CP850', 'CP858'];

/**
 * Construye el transporte que declara la fila de configuración.
 *
 * Este es el punto donde el delta D-4 rinde: cambiar una terminal de red a USB es
 * `UPDATE core.config_impresora SET transporte = 'usb'`, sin desplegar nada. Con las
 * sucursales a 3-6 horas y solo TeamViewer en la madrugada (D-8), la diferencia entre un
 * cambio de dato y un cambio de código es la diferencia entre arreglarlo hoy y arreglarlo
 * la semana que viene.
 */
export function crearTransporte(cfg: ConfigImpresoraRow): EscPosTransport {
  switch (cfg.transporte) {
    case 'tcp': {
      if (!cfg.ip) {
        throw new Error(
          `La impresora "${cfg.nombre}" está configurada como tcp pero no tiene IP. ` +
            'Captura core.config_impresora.ip o cambia transporte a usb.',
        );
      }
      return new TcpTransport({ host: cfg.ip, port: cfg.puerto ?? 9100 });
    }

    case 'usb': {
      if (!cfg.usb_nombre_cola) {
        throw new Error(
          `La impresora "${cfg.nombre}" está configurada como usb pero no tiene nombre de cola. ` +
            'Captura core.config_impresora.usb_nombre_cola.',
        );
      }
      return new UsbTransport({ printerName: cfg.usb_nombre_cola });
    }

    // No hay caso 'captura': el CHECK de `core.config_impresora` solo admite 'tcp' y
    // 'usb', y además exige la IP o el nombre de cola correspondiente. La base ya
    // garantiza la invariante, así que las validaciones de arriba son solo para acotar
    // los tipos y dar un mensaje útil si alguien relaja la restricción.
    default:
      throw new Error(`Transporte desconocido en la configuración: "${cfg.transporte}"`);
  }
}

/**
 * Traduce las filas de configuración al objeto que consume la plantilla.
 *
 * `soporta_qr_nativo` NO se decide probando en caliente contra la impresora: se declara en
 * la configuración. Una detección automática que falle a media venta dejaría un ticket sin
 * QR sin que nadie se entere, y el dato es fijo por modelo de impresora.
 */
export function aConfigTicket(
  impresora: ConfigImpresoraRow,
  ticket: ConfigTicketRow | null,
): ConfigTicket {
  const codePage = CODE_PAGES.includes(impresora.code_page)
    ? (impresora.code_page as CodePageName)
    : 'CP858';

  const cfg: ConfigTicket = {
    leyendaPie: ticket?.leyenda_pie ?? '',
    telefonosAtencion: ticket?.telefono_atencion ?? '',
    proveedor: ticket?.credenciales_proveedor ?? '',
    cols: impresora.ancho_cols,
    codePage,
  };

  // Sin clave configurada se omite el campo `V:` en vez de firmar con un secreto
  // inventado: un HMAC que nadie puede verificar es peor que no tener HMAC, porque
  // aparenta una garantía que no existe.
  if (ticket?.hmac_qr_secreto) {
    cfg.hmacKey = ticket.hmac_qr_secreto;
    cfg.incluirHmac = true;
  } else {
    cfg.incluirHmac = false;
  }

  return cfg;
}

export interface ConfiguracionImpresion {
  impresora: ConfigImpresoraRow;
  transporte: EscPosTransport;
  ticket: ConfigTicket;
}

/** Carga todo lo necesario para imprimir en una sucursal, en una sola llamada. */
export async function cargarConfiguracionImpresion(
  client: Client,
  sucursalId: string,
  agenciaId: string,
): Promise<ConfiguracionImpresion> {
  const impresora = await cargarConfigImpresora(client, sucursalId);
  if (!impresora) {
    throw new Error(
      `La sucursal ${sucursalId} no tiene impresora configurada. ` +
        'Da de alta una fila en core.config_impresora.',
    );
  }
  const ticket = await cargarConfigTicket(client, agenciaId);

  return {
    impresora,
    transporte: crearTransporte(impresora),
    ticket: aConfigTicket(impresora, ticket),
  };
}
