/**
 * La superficie mínima de acceso a PostgreSQL que necesita la lógica de dominio:
 * ejecutar una consulta parametrizada.
 *
 * Tanto un `Client` como un `PoolClient` como un `Pool` de `pg` la cumplen. Los
 * módulos que solo consultan piden esto en vez de un `Client` completo, y así se
 * prueban igual con una conexión en transacción (pruebas) que con un pool
 * (producción).
 */

import type { QueryResult, QueryResultRow } from 'pg';

export interface Consultable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
