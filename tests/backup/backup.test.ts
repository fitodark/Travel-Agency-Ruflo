import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeOld, sameVolumeWarning } from '../../src/backup/backup.js';
import { withDatabase } from '../../src/backup/verify.js';

describe('aviso de mismo volumen', () => {
  // El error que anula el propósito entero del respaldo: copiar el disco al mismo disco.
  it('avisa cuando el respaldo va al mismo volumen que la base', () => {
    const w = sameVolumeWarning('C:/respaldos', 'C:/Program Files/PostgreSQL/18/data');
    expect(w).toContain('MISMO volumen');
  });

  it('no avisa cuando van a volúmenes distintos', () => {
    expect(sameVolumeWarning('E:/respaldos', 'C:/PostgreSQL/data')).toBeNull();
  });

  it('no avisa si no se pudo leer el directorio de datos', () => {
    expect(sameVolumeWarning('E:/respaldos', null)).toBeNull();
  });
});

describe('retención', () => {
  let dir: string;

  const crear = async (nombre: string, diasAtras: number): Promise<string> => {
    const full = path.join(dir, nombre);
    await writeFile(full, 'dump');
    await writeFile(`${full}.json`, '{}');
    const when = new Date(Date.now() - diasAtras * 24 * 60 * 60 * 1000);
    await utimes(full, when, when);
    return full;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'donaji-retencion-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('elimina los respaldos fuera de la ventana de retención', async () => {
    await crear('donaji-A-2026-01-01T00-00-00.dump', 30);
    await crear('donaji-A-2026-01-02T00-00-00.dump', 20);
    await crear('donaji-A-2026-08-26T00-00-00.dump', 1);

    expect(await purgeOld(dir, 7)).toBe(2);
    const quedan = (await readdir(dir)).filter((n) => n.endsWith('.dump'));
    expect(quedan).toEqual(['donaji-A-2026-08-26T00-00-00.dump']);
  });

  it('arrastra el manifiesto junto con el dump que elimina', async () => {
    await crear('donaji-A-2026-01-01T00-00-00.dump', 30);
    await crear('donaji-A-2026-08-26T00-00-00.dump', 1);

    await purgeOld(dir, 7);
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toEqual([
      'donaji-A-2026-08-26T00-00-00.dump.json',
    ]);
  });

  it('NUNCA borra el más reciente, aunque esté fuera de retención', async () => {
    // Una terminal apagada dos semanas no debe quedarse sin ningún respaldo al encender.
    await crear('donaji-A-2026-01-01T00-00-00.dump', 60);
    await crear('donaji-A-2026-01-02T00-00-00.dump', 59);

    expect(await purgeOld(dir, 7)).toBe(1);
    const quedan = (await readdir(dir)).filter((n) => n.endsWith('.dump'));
    expect(quedan).toEqual(['donaji-A-2026-01-02T00-00-00.dump']);
  });

  it('no toca nada si todo está dentro de la retención', async () => {
    await crear('donaji-A-2026-08-25T00-00-00.dump', 2);
    await crear('donaji-A-2026-08-26T00-00-00.dump', 1);
    expect(await purgeOld(dir, 7)).toBe(0);
  });

  it('tolera un directorio vacío', async () => {
    expect(await purgeOld(dir, 7)).toBe(0);
  });

  it('ignora archivos que no son respaldos', async () => {
    await writeFile(path.join(dir, 'notas.txt'), 'hola');
    await crear('donaji-A-2026-01-01T00-00-00.dump', 30);
    await crear('donaji-A-2026-08-26T00-00-00.dump', 1);

    await purgeOld(dir, 7);
    await expect(stat(path.join(dir, 'notas.txt'))).resolves.toBeDefined();
  });
});

describe('URL de base desechable', () => {
  it('cambia la base conservando credenciales y puerto', () => {
    const url = withDatabase('postgresql://user:pass@localhost:5433/produccion', 'scratch');
    expect(url).toBe('postgresql://user:pass@localhost:5433/scratch');
  });

  it('conserva los parámetros de conexión', () => {
    const url = withDatabase('postgresql://u:p@h:5432/db?sslmode=require', 'otra');
    expect(url).toContain('sslmode=require');
    expect(url).toContain('/otra');
  });
});
