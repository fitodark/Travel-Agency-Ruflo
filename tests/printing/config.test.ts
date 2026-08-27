/**
 * Carga de configuración de impresión desde la base.
 *
 * Corre contra PostgreSQL local real: las vistas `v_*_vigente` filtran por
 * `effective_from`, y esa es justamente la lógica que no se puede probar con un mock
 * porque vive en SQL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  aConfigTicket,
  cargarConfigImpresora,
  cargarConfigTicket,
  crearTransporte,
  type ConfigImpresoraRow,
} from '../../src/printing/config.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const IMPRESORA_TCP: ConfigImpresoraRow = {
  id: 'x', sucursal_id: 's', nombre: 'Caja 1', transporte: 'tcp',
  ip: '192.168.1.50', puerto: 9100, usb_nombre_cola: null,
  ancho_mm: 80, ancho_cols: 48, code_page: 'CP858', soporta_qr_nativo: true,
};

describe('construcción de transporte desde configuración', () => {
  it('crea transporte TCP con la IP y puerto configurados', () => {
    const t = crearTransporte(IMPRESORA_TCP);
    expect(t.kind).toBe('tcp');
    expect(t.label).toBe('tcp://192.168.1.50:9100');
  });

  it('crea transporte USB con el nombre de cola', () => {
    const t = crearTransporte({
      ...IMPRESORA_TCP, transporte: 'usb', ip: null, usb_nombre_cola: 'XP-80',
    });
    expect(t.kind).toBe('usb');
    expect(t.label).toContain('XP-80');
  });

  it('explica qué falta cuando la fila está incompleta, en vez de fallar oscuro', () => {
    expect(() => crearTransporte({ ...IMPRESORA_TCP, ip: null }))
      .toThrow(/no tiene IP/);
    expect(() => crearTransporte({ ...IMPRESORA_TCP, transporte: 'usb', usb_nombre_cola: null }))
      .toThrow(/nombre de cola/);
  });
});

describe('traducción a configuración de plantilla', () => {
  it('toma ancho y code page de la impresora', () => {
    const cfg = aConfigTicket({ ...IMPRESORA_TCP, ancho_cols: 32, code_page: 'CP850' }, null);
    expect(cfg.cols).toBe(32);
    expect(cfg.codePage).toBe('CP850');
  });

  it('cae a CP858 si la code page configurada no se reconoce', () => {
    const cfg = aConfigTicket({ ...IMPRESORA_TCP, code_page: 'INVENTADA' }, null);
    expect(cfg.codePage).toBe('CP858');
  });

  it('OMITE el HMAC cuando no hay secreto configurado', () => {
    // Firmar con un secreto inventado aparentaría una garantía inexistente.
    const cfg = aConfigTicket(IMPRESORA_TCP, null);
    expect(cfg.incluirHmac).toBe(false);
    expect(cfg.hmacKey).toBeUndefined();
  });

  it('usa el secreto de la agencia cuando existe', () => {
    const cfg = aConfigTicket(IMPRESORA_TCP, {
      agencia_id: 'a', logo_url: null, telefono_atencion: '953',
      leyenda_pie: 'Buen viaje', credenciales_proveedor: 'Fi.Tech',
      hmac_qr_secreto: 'secreto-real',
    });
    expect(cfg.incluirHmac).toBe(true);
    expect(cfg.hmacKey).toBe('secreto-real');
    expect(cfg.leyendaPie).toBe('Buen viaje');
  });
});

run('vistas de vigencia (PostgreSQL real)', () => {
  let client: Client;
  let agenciaId: string;
  let sucursalId: string;

  beforeAll(async () => {
    client = new Client(resolveConnection('local').config);
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const a = await client.query<{ id: string }>(
      `INSERT INTO core.agencia (id, nombre) VALUES (core.uuid_v7(), 'Cfg Test') RETURNING id`,
    );
    agenciaId = a.rows[0]!.id;
    const s = await client.query<{ id: string }>(
      `INSERT INTO core.sucursal (id, agencia_id, nombre, direccion_completa, telefono_principal, codigo)
       VALUES (core.uuid_v7(), $1, 'Sucursal Cfg', 'Calle 1', '953', 'Z') RETURNING id`,
      [agenciaId],
    );
    sucursalId = s.rows[0]!.id;
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('devuelve null cuando la sucursal no tiene impresora', async () => {
    // Una terminal recién instalada opera sin impresora: no es un error.
    expect(await cargarConfigImpresora(client, sucursalId)).toBeNull();
  });

  it('devuelve la impresora configurada con su IP legible', async () => {
    await client.query(
      `INSERT INTO core.config_impresora (id, sucursal_id, nombre, transporte, ip, es_predeterminada)
       VALUES (core.uuid_v7(), $1, 'Caja 1', 'tcp', '192.168.1.50'::inet, true)`,
      [sucursalId],
    );
    const cfg = await cargarConfigImpresora(client, sucursalId);
    expect(cfg?.ip).toBe('192.168.1.50');
    expect(cfg?.ancho_cols).toBe(48);
  });

  it('elige la predeterminada cuando hay varias', async () => {
    await client.query(
      `INSERT INTO core.config_impresora (id, sucursal_id, nombre, transporte, usb_nombre_cola, es_predeterminada)
       VALUES (core.uuid_v7(), $1, 'Secundaria', 'usb', 'OTRA', false)`,
      [sucursalId],
    );
    await client.query(
      `INSERT INTO core.config_impresora (id, sucursal_id, nombre, transporte, ip, es_predeterminada)
       VALUES (core.uuid_v7(), $1, 'Principal', 'tcp', '10.0.0.5'::inet, true)`,
      [sucursalId],
    );
    expect((await cargarConfigImpresora(client, sucursalId))?.nombre).toBe('Principal');
  });

  it('NO devuelve configuración de ticket cuya vigencia aún no llega', async () => {
    // El caso de la ventana de madrugada: el cambio ya viajó desde la nube y espera.
    await client.query(
      `INSERT INTO core.config_ticket (id, agencia_id, leyenda_pie, effective_from)
       VALUES (core.uuid_v7(), $1, 'Leyenda futura', now() + interval '2 days')`,
      [agenciaId],
    );
    expect(await cargarConfigTicket(client, agenciaId)).toBeNull();
  });

  it('devuelve la vigente y no la futura cuando conviven', async () => {
    await client.query(
      `INSERT INTO core.config_ticket (id, agencia_id, leyenda_pie, effective_from)
       VALUES (core.uuid_v7(), $1, 'Leyenda actual', now() - interval '1 day')`,
      [agenciaId],
    );
    await client.query(
      `INSERT INTO core.config_ticket (id, agencia_id, leyenda_pie, effective_from)
       VALUES (core.uuid_v7(), $1, 'Leyenda futura', now() + interval '2 days')`,
      [agenciaId],
    );
    expect((await cargarConfigTicket(client, agenciaId))?.leyenda_pie).toBe('Leyenda actual');
  });

  it('activa la más reciente ya vencida cuando hay varias pasadas', async () => {
    await client.query(
      `INSERT INTO core.config_ticket (id, agencia_id, leyenda_pie, effective_from)
       VALUES (core.uuid_v7(), $1, 'Vieja', now() - interval '10 days')`,
      [agenciaId],
    );
    await client.query(
      `INSERT INTO core.config_ticket (id, agencia_id, leyenda_pie, effective_from)
       VALUES (core.uuid_v7(), $1, 'Reciente', now() - interval '1 hour')`,
      [agenciaId],
    );
    expect((await cargarConfigTicket(client, agenciaId))?.leyenda_pie).toBe('Reciente');
  });
});
