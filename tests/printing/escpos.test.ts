import { describe, expect, it } from 'vitest';
import { columnWidth, encodeText } from '../../src/printing/escpos/codepage.js';
import * as cmd from '../../src/printing/escpos/commands.js';
import { EscPosDocument, wrapText } from '../../src/printing/escpos/document.js';
import { CaptureTransport, stripCommands } from '../../src/printing/transport/capture.js';

describe('code page', () => {
  it('codifica acentos y enne a CP858, no a UTF-8', () => {
    // El fallo clásico: en UTF-8 son 2 bytes (0xC3 0xB1) y la térmica imprime basura.
    expect(encodeText('ñ', 'CP858')).toEqual(Buffer.from([0xa4]));
    expect(encodeText('Ñ', 'CP858')).toEqual(Buffer.from([0xa5]));
    expect(encodeText('áéíóú', 'CP858')).toEqual(Buffer.from([0xa0, 0x82, 0xa1, 0xa2, 0xa3]));
  });

  it('degrada a ASCII lo que la code page no tiene, en vez de imprimir basura', () => {
    // CP437 no tiene mayúsculas acentuadas.
    expect(encodeText('Á', 'CP437')).toEqual(Buffer.from([0x41]));
  });

  it('sustituye por signo de interrogacion lo que no se puede representar ni degradar', () => {
    expect(encodeText('日', 'CP858')).toEqual(Buffer.from([0x3f]));
  });

  it('cuenta columnas de impresion, no unidades UTF-16', () => {
    expect(columnWidth('MUÑOZ')).toBe(5);
  });
});

describe('QR nativo GS ( k', () => {
  it('calcula pL/pH incluyendo los 3 bytes de cabecera', () => {
    // Error de implementación más común: contar solo los datos.
    const store = cmd.qrStore(Buffer.from('ABC'));
    expect(store[3]).toBe(6); // 3 datos + 3 cabecera
    expect(store[4]).toBe(0);
  });

  it('maneja longitudes que cruzan el byte bajo', () => {
    const store = cmd.qrStore(Buffer.alloc(300));
    const len = (store[4]! << 8) | store[3]!;
    expect(len).toBe(303);
  });

  it('emite la secuencia completa modelo/tamano/EC/datos/imprimir', () => {
    const buf = cmd.qrNative('HOLA');
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41]))).toBe(true);
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43]))).toBe(true);
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45]))).toBe(true);
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]))).toBe(true);
  });
});

describe('raster GS v 0', () => {
  it('empaqueta 8 pixeles por byte y escala en ambos ejes', () => {
    const matrix = [[true, false], [false, true]];
    const buf = cmd.rasterBitmap(matrix, 4); // 8x8 px -> 1 byte por fila, 8 filas
    const bytesPerRow = (buf[5]! << 8) | buf[4]!;
    const height = (buf[7]! << 8) | buf[6]!;
    expect(bytesPerRow).toBe(1);
    expect(height).toBe(8);
    expect(buf.length).toBe(8 + 8);
    expect(buf[8]).toBe(0b11110000); // fila 0: módulo izquierdo negro, escalado x4
    expect(buf[12]).toBe(0b00001111); // fila 4: módulo derecho negro
  });
});

describe('maquetacion', () => {
  it('twoCol alinea el valor a la derecha en el ancho exacto', () => {
    const doc = new EscPosDocument({ cols: 24 });
    doc.twoCol('IMPORTE', '$450.00', '.');
    const line = stripCommands(doc.build()).trim();
    expect(columnWidth(line)).toBe(24);
    expect(line.endsWith('$450.00')).toBe(true);
  });

  it('trunca la etiqueta y nunca el valor', () => {
    const doc = new EscPosDocument({ cols: 12 });
    doc.twoCol('UNA ETIQUETA LARGUISIMA', '$1,234.00');
    expect(stripCommands(doc.build())).toContain('$1,234.00');
  });

  it('wrap respeta palabras y el ancho', () => {
    const lines = wrapText('Av. Miguel Hidalgo 214, Col. Centro, Huajuapan', 20);
    for (const l of lines) expect(columnWidth(l)).toBeLessThanOrEqual(20);
    expect(lines.join(' ')).toContain('Huajuapan');
  });

  it('abre con init y code page', () => {
    const buf = new EscPosDocument().build();
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(buf.subarray(2, 5)).toEqual(Buffer.from([0x1b, 0x74, 19]));
  });
});

describe('CaptureTransport', () => {
  it('exige open() antes de write()', async () => {
    const t = new CaptureTransport();
    await expect(t.write(Buffer.from('x'))).rejects.toThrow();
  });

  it('acumula lo escrito', async () => {
    const t = new CaptureTransport();
    await t.open();
    await t.write(Buffer.from('AB'));
    await t.write(Buffer.from('C'));
    await t.close();
    expect(t.buffer.toString()).toBe('ABC');
  });
});
