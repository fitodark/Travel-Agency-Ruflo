import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import { listarPuntos, listarSucursales } from '../api/catalogos';
import { useSesion } from '../auth/sesion';
import {
  buscarSalidas, registrarVenta,
  type CategoriaPasajero, type ResultadoVenta, type SalidaDisponible,
} from '../api/ventas';

const CATEGORIAS: { valor: CategoriaPasajero; etiqueta: string }[] = [
  { valor: 'general', etiqueta: 'General' },
  { valor: 'inapam', etiqueta: 'INAPAM' },
  { valor: 'menor', etiqueta: 'Menor' },
];
import { fechaHora } from '../lib/fechas';

type Paso = 1 | 2 | 3 | 4 | 5 | 6 | 'listo';

const hoy = new Date().toISOString().slice(0, 10);

function Pasos({ actual }: { actual: Paso }) {
  const nombres = ['Búsqueda', 'Horario', 'Asientos', 'Pasajeros', 'Resumen', 'Pago'];
  return (
    <ol className="flex gap-2 text-xs mb-6">
      {nombres.map((n, i) => {
        const num = i + 1;
        const hecho = actual === 'listo' || (typeof actual === 'number' && actual > num);
        const aqui = actual === num;
        return (
          <li
            key={n}
            className={`rounded px-2 py-1 ${
              aqui ? 'bg-brand-600 text-white' : hecho ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'
            }`}
          >
            {i + 1}. {n}
          </li>
        );
      })}
    </ol>
  );
}

export function Vender() {
  const { sesion } = useSesion();
  const puntos = useQuery({ queryKey: ['puntos'], queryFn: listarPuntos });

  // La sucursal de la sesión (esta terminal) es el origen por defecto: un
  // vendedor de una sola sucursal la trae ya elegida; un multi-sucursal eligió
  // al entrar. Si esa terminal no origina ninguna ruta activa, queda vacío y el
  // usuario decide.
  const origenPorDefecto = useMemo(
    () =>
      (puntos.data ?? []).find(
        (p) => p.sucursalId === sesion?.sucursalId && p.puedeOriginar,
      )?.id ?? '',
    [puntos.data, sesion?.sucursalId],
  );

  const [paso, setPaso] = useState<Paso>(1);
  const [fecha, setFecha] = useState(hoy);
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [personas, setPersonas] = useState(1);
  const [esReservacion, setEsReservacion] = useState(false);
  const [conConexion, setConConexion] = useState(true);
  const [contacto, setContacto] = useState('');

  const [salida, setSalida] = useState<SalidaDisponible | null>(null);
  const [asientos, setAsientos] = useState<number[]>([]);
  const [nombres, setNombres] = useState<Record<number, string>>({});
  const [categorias, setCategorias] = useState<Record<number, CategoriaPasajero>>({});
  const [metodo, setMetodo] = useState<'efectivo' | 'transferencia' | 'corresponsal' | 'sin_pago'>('efectivo');
  const [referencia, setReferencia] = useState('');
  const [sucursalCobroId, setSucursalCobroId] = useState('');
  // Paso 6, pago en efectivo: con cuánto paga el cliente. String para admitir el
  // campo vacío mientras teclea.
  const [efectivoRecibido, setEfectivoRecibido] = useState('');

  // D8: las sucursales sin sistema (Tamazulapan) son las únicas donde puede
  // cobrarse un pago `corresponsal`.
  const sucursales = useQuery({ queryKey: ['catalogos', 'sucursales'], queryFn: listarSucursales });
  const sinSistema = (sucursales.data ?? []).filter((s) => s.sinSistema);
  const [resultado, setResultado] = useState<ResultadoVenta | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Categorías con tarifa capturada para este tramo: `general` siempre; `inapam` /
  // `menor` solo si la ruta las tiene. El descuento solo aplica terminal↔terminal
  // (D4) — el backend lo valida; aquí solo se ofrece lo que hay.
  const catsDisponibles = CATEGORIAS.filter(
    (c) => c.valor === 'general' || salida?.tarifas?.[c.valor] != null,
  );
  const importeDe = (a: number): number =>
    salida?.tarifas?.[categorias[a] ?? 'general'] ?? salida?.importe ?? 0;
  const total = useMemo(
    () => asientos.reduce((s, a) => s + importeDe(a), 0),
    [asientos, categorias, salida],
  );

  // Preselecciona el origen con la sucursal de la sesión en cuanto cargan los
  // puntos (o al cambiar de sucursal). Solo si el campo está vacío: no pisa una
  // elección del usuario.
  useEffect(() => {
    if (origenPorDefecto) setOrigen((o) => o || origenPorDefecto);
  }, [origenPorDefecto]);

  // Efectivo (paso 6): monto recibido y cambio. `recibido` es null si el campo
  // está vacío o no es un número; el cobro se bloquea hasta que cubra el total.
  const recibido = efectivoRecibido.trim() === '' ? null : Number(efectivoRecibido);
  const recibidoValido = recibido != null && Number.isFinite(recibido) && recibido >= total;
  const cambio = recibidoValido ? recibido - total : 0;
  const efectivoIncompleto = metodo === 'efectivo' && !recibidoValido;

  const busqueda = useMutation({
    mutationFn: () =>
      buscarSalidas({ fecha, origen, destino, personas, conConexion }),
    onSuccess: () => {
      setError(null);
      setPaso(2);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'No se pudo buscar.'),
  });

  const venta = useMutation({
    mutationFn: () => {
      if (!salida) throw new Error('sin salida');
      return registrarVenta({
        salidaId: salida.salidaId,
        origenOrden: salida.origenOrden,
        destinoOrden: salida.destinoOrden,
        contactoTelefono: contacto,
        esReservacion,
        conConexion,
        pasajeros: asientos.map((a) => ({
          asientoNum: a,
          nombre: nombres[a] ?? '',
          importe: importeDe(a),
          categoria: categorias[a] ?? 'general',
        })),
        ...(metodo === 'sin_pago'
          ? {}
          : {
              pago: {
                metodo, monto: total,
                ...(metodo === 'efectivo' && recibidoValido ? { efectivoRecibido: recibido } : {}),
                ...(metodo === 'transferencia' && referencia ? { referencia } : {}),
                ...(metodo === 'corresponsal' ? { sucursalCobroId } : {}),
              },
            }),
      });
    },
    onSuccess: (r) => {
      setResultado(r);
      setError(null);
      setPaso('listo');
    },
    onError: (e) => {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo registrar la venta.');
    },
  });

  const reiniciar = () => {
    setPaso(1);
    setSalida(null);
    setAsientos([]);
    setNombres({});
    setCategorias({});
    setResultado(null);
    setError(null);
    setMetodo('efectivo');
    setSucursalCobroId('');
    setReferencia('');
    setEfectivoRecibido('');
  };

  // Cancelar la venta en curso desde cualquier paso del wizard: el pasajero
  // puede arrepentirse hasta en el pago. Suelta los asientos elegidos —hoy la
  // selección del paso 3 es solo estado local, no hay lease en servidor que
  // liberar, así que limpiarla los devuelve al cupo— y vuelve al paso 1. Como la
  // venta nunca se registró, nada entra al corte de caja.
  const cancelarVenta = () => {
    reiniciar();
    setFecha(hoy);
    setOrigen(origenPorDefecto);
    setDestino('');
    setPersonas(1);
    setEsReservacion(false);
    setConConexion(true);
    setContacto('');
    busqueda.reset();
    venta.reset();
  };

  const toggleAsiento = (n: number) => {
    setAsientos((prev) =>
      prev.includes(n)
        ? prev.filter((x) => x !== n)
        : prev.length < personas
          ? [...prev, n]
          : prev,
    );
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-2">Vender</h1>
      <Pasos actual={paso} />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {paso === 1 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            busqueda.mutate();
          }}
          className="space-y-4 tarjeta p-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              Fecha de viaje
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="campo mt-1"
              />
            </label>
            <label className="text-sm">
              Personas
              <input
                type="number"
                min={1}
                max={18}
                value={personas}
                onChange={(e) => setPersonas(Math.max(1, Number(e.target.value)))}
                className="campo mt-1"
              />
            </label>
            <label className="text-sm">
              Origen
              <select
                value={origen}
                onChange={(e) => setOrigen(e.target.value)}
                required
                className="campo mt-1"
              >
                <option value="">—</option>
                {puntos.data?.filter((p) => p.puedeOriginar).map((p) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Destino
              <select
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                required
                className="campo mt-1"
              >
                <option value="">—</option>
                {puntos.data?.filter((p) => p.id !== origen).map((p) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex gap-6 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={esReservacion}
                onChange={(e) => setEsReservacion(e.target.checked)}
              />
              Es reservación (paga después)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={conConexion}
                onChange={(e) => setConConexion(e.target.checked)}
              />
              Con conexión
            </label>
          </div>
          <button
            type="submit"
            disabled={busqueda.isPending}
            className="btn-primario"
          >
            {busqueda.isPending ? 'Buscando…' : 'Buscar horarios'}
          </button>
        </form>
      )}

      {paso === 2 && (
        <div className="space-y-3">
          {busqueda.data?.length === 0 && (
            <p className="text-sm text-slate-500">No hay salidas para ese tramo y fecha.</p>
          )}
          {busqueda.data?.map((s) => (
            <button
              key={s.salidaId}
              disabled={!s.seleccionable}
              onClick={() => {
                setSalida(s);
                setAsientos([]);
                setPaso(3);
              }}
              className={`w-full text-left rounded border p-3 text-sm ${
                s.seleccionable ? 'bg-white hover:bg-slate-50' : 'bg-slate-100 text-slate-400'
              }`}
            >
              <div className="flex justify-between">
                <span className="font-medium">{fechaHora(s.horaSalidaOrigen)}</span>
                <span>{s.importe === null ? 'sin tarifa' : `$${s.importe}`}</span>
              </div>
              <div className="text-xs text-slate-600">
                {[s.origenNombre, ...s.escalas, s.destinoNombre].join(' → ')}
              </div>
              <div className="text-xs text-slate-400">
                {s.rutaNombre} · {s.disponibles} disponibles
                {!s.seleccionable && ' · no seleccionable'}
              </div>
            </button>
          ))}
          <button onClick={() => setPaso(1)} className="text-sm text-slate-500 underline">
            ← cambiar búsqueda
          </button>
        </div>
      )}

      {paso === 3 && salida && (
        <div className="space-y-4 tarjeta p-4">
          <p className="text-sm text-slate-500">
            Elige {personas} asiento{personas > 1 ? 's' : ''} (mapa pendiente del prototipo; por
            ahora, lista de disponibles).
          </p>
          <div className="flex flex-wrap gap-2">
            {salida.asientosOfrecibles.map((n) => (
              <button
                key={n}
                onClick={() => toggleAsiento(n)}
                className={`h-10 w-10 rounded border text-sm ${
                  asientos.includes(n) ? 'bg-brand-600 text-white border-brand-600' : 'bg-white hover:bg-brand-50'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              disabled={asientos.length !== personas}
              onClick={() => setPaso(4)}
              className="btn-primario"
            >
              Continuar ({asientos.length}/{personas})
            </button>
            <button onClick={() => setPaso(2)} className="text-sm text-slate-500 underline">
              ← volver a horarios
            </button>
          </div>
        </div>
      )}

      {paso === 4 && (
        <div className="space-y-3 tarjeta p-4">
          {asientos.map((a) => (
            <div key={a} className="space-y-1">
              <label className="block text-sm">
                Asiento {a} — nombre del pasajero
                <input
                  value={nombres[a] ?? ''}
                  onChange={(e) => setNombres((p) => ({ ...p, [a]: e.target.value }))}
                  className="campo mt-1"
                />
              </label>
              {catsDisponibles.length > 1 && (
                <label className="block text-sm">
                  Categoría (descuento)
                  <select
                    value={categorias[a] ?? 'general'}
                    onChange={(e) =>
                      setCategorias((p) => ({ ...p, [a]: e.target.value as CategoriaPasajero }))
                    }
                    className="campo mt-1"
                  >
                    {catsDisponibles.map((c) => (
                      <option key={c.valor} value={c.valor}>
                        {c.etiqueta} — ${salida?.tarifas?.[c.valor] ?? salida?.importe ?? 0}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ))}
          {catsDisponibles.length > 1 && (
            <p className="text-xs text-slate-400">
              El descuento (INAPAM / menor) solo aplica de la terminal de origen a la de
              destino; para otros tramos solo hay tarifa general.
            </p>
          )}
          <label className="block text-sm">
            Teléfono de contacto (obligatorio)
            <input
              value={contacto}
              onChange={(e) => setContacto(e.target.value)}
              className="campo mt-1"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              disabled={asientos.some((a) => !nombres[a]?.trim()) || !contacto.trim()}
              onClick={() => setPaso(5)}
              className="btn-primario"
            >
              Continuar
            </button>
            <button onClick={() => setPaso(3)} className="text-sm text-slate-500 underline">
              ← volver a asientos
            </button>
          </div>
        </div>
      )}

      {paso === 5 && salida && (
        <div className="space-y-3 tarjeta p-4 text-sm">
          <div>
            <div className="font-medium">{fechaHora(salida.horaSalidaOrigen)}</div>
            <div className="text-xs text-slate-500">
              {[salida.origenNombre, ...salida.escalas, salida.destinoNombre].join(' → ')} · {salida.rutaNombre}
            </div>
          </div>
          <ul className="divide-y">
            {asientos.map((a) => (
              <li key={a} className="flex justify-between py-1">
                <span>
                  Asiento {a} · {nombres[a]}
                  {(categorias[a] ?? 'general') !== 'general' && ` · ${categorias[a]}`}
                </span>
                <span>${importeDe(a)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total</span>
            <span>${total}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPaso(6)}
              className="btn-primario"
            >
              Confirmar y pagar
            </button>
            <button onClick={() => setPaso(4)} className="text-sm text-slate-500 underline">
              ← volver a pasajeros
            </button>
          </div>
        </div>
      )}

      {paso === 6 && (
        <div className="space-y-4 tarjeta p-4 text-sm">
          <div className="flex justify-between font-semibold border-b pb-2">
            <span>Total a cobrar</span>
            <span>${total}</span>
          </div>
          <div className="space-y-2">
            {(['efectivo', 'transferencia'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === m}
                  onChange={() => setMetodo(m)}
                />
                {m}
              </label>
            ))}
            {sinSistema.length > 0 && (
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === 'corresponsal'}
                  onChange={() => setMetodo('corresponsal')}
                />
                Corresponsal (cobrado en sucursal sin sistema)
              </label>
            )}
            {esReservacion && (
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === 'sin_pago'}
                  onChange={() => setMetodo('sin_pago')}
                />
                Reservar sin pago
              </label>
            )}
          </div>
          {metodo === 'transferencia' && (
            <label className="block">
              Referencia
              <input
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
                className="campo mt-1"
              />
            </label>
          )}
          {metodo === 'corresponsal' && (
            <label className="block">
              Sucursal donde se cobró
              <select
                value={sucursalCobroId}
                onChange={(e) => setSucursalCobroId(e.target.value)}
                className="campo mt-1"
              >
                <option value="">— elige —</option>
                {sinSistema.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
              </select>
            </label>
          )}
          {metodo === 'efectivo' && (
            <div className="space-y-1">
              <label className="block">
                Paga con (efectivo recibido)
                <input
                  type="number"
                  min={total}
                  step="1"
                  inputMode="decimal"
                  value={efectivoRecibido}
                  onChange={(e) => setEfectivoRecibido(e.target.value)}
                  className="campo mt-1"
                />
              </label>
              {efectivoRecibido.trim() !== '' && !recibidoValido && (
                <p className="text-xs text-red-600">
                  El efectivo recibido debe cubrir el total (${total}).
                </p>
              )}
              {recibidoValido && (
                <p className="text-xs text-slate-500">Cambio: ${cambio}</p>
              )}
            </div>
          )}
          <p className="text-slate-500">
            {metodo === 'sin_pago'
              ? 'Sin cobro ahora.'
              : metodo === 'corresponsal'
                ? `Se registra el cobro de $${total} hecho en la corresponsal (no entra al efectivo del corte).`
                : metodo === 'efectivo' && recibidoValido
                  ? `Se cobra $${total} en efectivo · paga con $${recibido} · cambio $${cambio}.`
                  : `Se cobra $${total} en ${metodo}.`}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => venta.mutate()}
              disabled={
                venta.isPending
                || (metodo === 'corresponsal' && !sucursalCobroId)
                || efectivoIncompleto
              }
              className="btn-primario"
            >
              {venta.isPending ? 'Registrando…' : 'Registrar venta'}
            </button>
            <button
              onClick={() => setPaso(5)}
              disabled={venta.isPending}
              className="text-sm text-slate-500 underline"
            >
              ← volver al resumen
            </button>
          </div>
        </div>
      )}

      {typeof paso === 'number' && paso > 1 && (
        <div className="mt-4 border-t pt-4">
          <button type="button" onClick={cancelarVenta} className="btn-peligro">
            Cancelar venta
          </button>
          <p className="mt-1 text-xs text-slate-400">
            Libera los asientos seleccionados y vuelve al paso 1. Al no concretarse
            la venta, no se registra nada en el corte de caja.
          </p>
        </div>
      )}

      {paso === 'listo' && resultado && (
        <div className="space-y-3 rounded border border-green-300 bg-green-50 p-4 text-sm">
          <div className="font-semibold">
            {resultado.estado === 'finalizada_transferencia'
              ? 'Venta finalizada · transferencia'
              : `Venta ${resultado.estado}`}
            {' · '}{resultado.printJobs} ticket(s) encolado(s)
          </div>
          {resultado.estado === 'finalizada_transferencia' && (
            <p className="text-slate-600">
              El pasajero debe enviar el comprobante al encargado para confirmar el pago.
              El monto entrará al corte al confirmarlo (Caja → «Transferencias por verificar»).
            </p>
          )}
          <ul className="divide-y">
            {resultado.boletos.map((b) => (
              <li key={b.boletoId} className="flex justify-between py-1">
                <span>
                  Folio {b.folio} · asiento {b.asientoNum} · {b.pasajero}
                  {b.categoria !== 'general' && ` · ${b.categoria}`}
                </span>
                <span>${b.importe}</span>
              </li>
            ))}
          </ul>
          <div className="text-slate-600">
            Total ${resultado.importeTotal} · pagado ${resultado.pagado} · saldo ${resultado.saldoPendiente}
          </div>
          {metodo === 'efectivo' && recibidoValido && (
            <div className="text-slate-600">
              Pagó con ${recibido} · cambio ${cambio}
            </div>
          )}
          <button onClick={reiniciar} className="btn-primario">
            Nueva venta
          </button>
        </div>
      )}
    </div>
  );
}
