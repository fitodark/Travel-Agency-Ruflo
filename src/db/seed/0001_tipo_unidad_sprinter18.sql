-- =============================================================================
-- SEED · Mercedes Benz Sprinter, 18 plazas.
--
-- Fuente: knowledge/esquema.JPG (delta D-6). Configuración 1+2.
-- Corrige el supuesto de v0.1, que asumía 19 plazas.
--
--                          FRENTE
--            ┌──────┬──────┐  ║  ┌──────┐
--            │  18  │      │  ║  │   1  │   ← acceso
--            ├──────┼──────┤  ║  ├──────┤
--            │   2  │   3  │  ║  │   4  │
--            ├──────┼──────┤  ║  ├──────┤
--            │   5  │   6  │  ║  │   7  │
--            ├──────┼──────┤  ║  ├──────┤
--            │   8  │   9  │  ║  │  10  │
--            ├──────┼──────┤  ║  ├──────┤
--            │  11  │  12  │  ║  │  13  │
--            ├──────┼──────┼──╨──┼──────┤
--            │  14  │  15  │  16 │  17  │   ← banca trasera de 4
--            └──────┴──────┴─────┴──────┘
--
--   Singles: 1, 4, 7, 10, 13     Pares: (2,3) (5,6) (8,9) (11,12)
--   Banca:   14, 15, 16, 17      Acceso: asiento 18 al frente
--
-- Los BLOQUES no son decorativos: son la unidad de reparto de cupos offline.
-- Se reparten bloques contiguos completos, nunca asientos sueltos de filas
-- distintas — de lo contrario una pareja que compra en una sucursal intermedia
-- quedaría separada aunque la unidad fuera casi vacía.
-- Ver docs/architecture/01b-consistencia-asientos.md §3
-- =============================================================================

INSERT INTO core.tipo_unidad (clave, nombre, marca, modelo, num_asientos, mapa)
VALUES (
  'SPRINTER-18',
  'Mercedes Benz Sprinter 18 plazas',
  'Mercedes Benz',
  'Sprinter',
  18,
  '{
    "version": 1,
    "filas": 6,
    "columnas": 4,
    "pasillo_despues_columna": 1,
    "frente": "arriba",
    "accesos": [ { "fila": 0, "lado": "derecho", "etiqueta": "ACCESO" } ],
    "asientos": [
      { "num": 18, "fila": 0, "col": 0, "tipo": "acceso",  "vendible": true },
      { "num": 1,  "fila": 0, "col": 3, "tipo": "acceso",  "vendible": true },

      { "num": 2,  "fila": 1, "col": 0, "tipo": "ventana", "vendible": true },
      { "num": 3,  "fila": 1, "col": 1, "tipo": "pasillo", "vendible": true },
      { "num": 4,  "fila": 1, "col": 3, "tipo": "single",  "vendible": true },

      { "num": 5,  "fila": 2, "col": 0, "tipo": "ventana", "vendible": true },
      { "num": 6,  "fila": 2, "col": 1, "tipo": "pasillo", "vendible": true },
      { "num": 7,  "fila": 2, "col": 3, "tipo": "single",  "vendible": true },

      { "num": 8,  "fila": 3, "col": 0, "tipo": "ventana", "vendible": true },
      { "num": 9,  "fila": 3, "col": 1, "tipo": "pasillo", "vendible": true },
      { "num": 10, "fila": 3, "col": 3, "tipo": "single",  "vendible": true },

      { "num": 11, "fila": 4, "col": 0, "tipo": "ventana", "vendible": true },
      { "num": 12, "fila": 4, "col": 1, "tipo": "pasillo", "vendible": true },
      { "num": 13, "fila": 4, "col": 3, "tipo": "single",  "vendible": true },

      { "num": 14, "fila": 5, "col": 0, "tipo": "banca",   "vendible": true },
      { "num": 15, "fila": 5, "col": 1, "tipo": "banca",   "vendible": true },
      { "num": 16, "fila": 5, "col": 2, "tipo": "banca",   "vendible": true },
      { "num": 17, "fila": 5, "col": 3, "tipo": "banca",   "vendible": true }
    ],
    "bloques": [
      { "clave": "B0", "etiqueta": "frente",        "asientos": [18, 1],
        "capacidad_grupo": 2, "juntos": false },
      { "clave": "B1", "etiqueta": "fila 1",        "asientos": [2, 3, 4],
        "capacidad_grupo": 3, "juntos": true },
      { "clave": "B2", "etiqueta": "fila 2",        "asientos": [5, 6, 7],
        "capacidad_grupo": 3, "juntos": true },
      { "clave": "B3", "etiqueta": "fila 3",        "asientos": [8, 9, 10],
        "capacidad_grupo": 3, "juntos": true },
      { "clave": "B4", "etiqueta": "fila 4",        "asientos": [11, 12, 13],
        "capacidad_grupo": 3, "juntos": true },
      { "clave": "B5", "etiqueta": "banca trasera", "asientos": [14, 15, 16, 17],
        "capacidad_grupo": 4, "juntos": true }
    ]
  }'::jsonb
)
ON CONFLICT (clave) DO UPDATE
  SET mapa = EXCLUDED.mapa,
      num_asientos = EXCLUDED.num_asientos,
      nombre = EXCLUDED.nombre;

-- -----------------------------------------------------------------------------
-- Reparto de referencia para una ruta de 4 paradas (S1 -> S2 -> S3 -> S4).
-- Lo aplica el job de materialización; se documenta aquí para que el reparto sea
-- auditable y no un número mágico dentro del código.
--
--   S1 (origen)      B0, B1, B2, B5 -> 18,1,2,3,4,5,6,7,14,15,16,17   12 asientos
--   S2 (intermedia)  B3             -> 8, 9, 10                        3 asientos
--   S3 (intermedia)  B4             -> 11, 12, 13                      3 asientos
--   S4 (destino)     --                                                no vende
--
-- Cada sucursal intermedia recibe una FILA COMPLETA: una pareja viaja junta más
-- un tercero al otro lado del pasillo, así que un grupo de hasta 3 nunca queda
-- separado dentro de su propio cupo. S1 conserva la banca de 4, que es el único
-- bloque capaz de sentar a una familia junta, y es donde se compra la mayoría.
--
-- Los conjuntos son DISJUNTOS (12 + 3 + 3 = 18): por eso, estando offline, la
-- sobreventa no es improbable sino imposible.
-- -----------------------------------------------------------------------------
