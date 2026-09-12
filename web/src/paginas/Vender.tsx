import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import { listarPuntos, listarSucursales } from '../api/catalogos';
import { MapaAsientos } from '../componentes/MapaAsientos';
import { ResumenViaje } from '../componentes/venta/ResumenViaje';
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
import { fecha as soloFecha, hora } from '../lib/fechas';

type Paso = 1 | 2 | 3 | 4 | 5 | 6 | 'listo';

const hoy = new Date().toISOString().slice(0, 10);

/** Estilo compartido de las etiquetas de campo (arriba del input/select). */
const ETIQUETA = 'mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500';

function Pasos({ actual }: { actual: Paso }) {
  const nombres = ['Búsqueda', 'Horarios', 'Asientos', 'Pasajeros', 'Confirmación', 'Pago'];
  return (
    <ol className="mb-6 flex justify-between border-b border-slate-200">
      {nombres.map((n, i) => {
        const num = i + 1;
        const completado = actual === 'listo' || (typeof actual === 'number' && actual > num);
        const aqui = actual === num;
        return (
          <li
            key={n}
            className={`flex items-center gap-1.5 border-b-2 pb-2 text-xs uppercase tracking-wide ${
              aqui ? 'border-brand-600' : 'border-transparent'
            }`}
          >
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                aqui ? 'border-brand-600 text-brand-600' : 'border-slate-300 text-slate-400'
              }`}
            >
              {String(num).padStart(2, '0')}
            </span>
            <span
              className={
                aqui
                  ? 'font-semibold text-brand-700'
                  : completado
                    ? 'font-medium text-slate-700'
                    : 'text-slate-400'
              }
            >
              {n}
            </span>
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

  // Antes del paso 6 el método de pago todavía no se elige: con reservación
  // se muestra "Por cobrar" en automático. Ya en el paso 6, el label sigue al
  // método elegido (corresponsal y "pago en terminal" tampoco cobran ahora).
  const totalLabel = paso === 6
    ? (metodo === 'efectivo' || metodo === 'transferencia' ? 'Total' : 'Por cobrar')
    : (esReservacion ? 'Por cobrar' : 'Total');
  const avisoReservacion = esReservacion
    ? 'Venta tipo reservación: los asientos se conservan hasta 30 minutos antes de la salida.'
    : undefined;
  const textoBotonPago = metodo === 'efectivo'
    ? 'Registrar cobro'
    : metodo === 'transferencia'
      ? 'Registrar transferencia'
      : metodo === 'corresponsal'
        ? 'Registrar venta'
        : 'Apartar sin pago';

  // "Precio unitario" del panel lateral: solo tiene sentido mostrar una sola
  // tarifa cuando todos los asientos elegidos comparten categoría (lo normal).
  // Con categorías mixtas (general + INAPAM, p. ej.) se omite la fila — el
  // desglose real ya está en el paso de confirmación.
  const categoriaUnica = asientos.length > 0
    && asientos.every((a) => (categorias[a] ?? 'general') === (categorias[asientos[0]!] ?? 'general'))
    ? (categorias[asientos[0]!] ?? 'general')
    : 'general';
  const categoriasMixtas = asientos.length > 0
    && !asientos.every((a) => (categorias[a] ?? 'general') === (categorias[asientos[0]!] ?? 'general'));
  const precioUnitario = categoriasMixtas ? null : (salida?.tarifas?.[categoriaUnica] ?? salida?.importe ?? null);
  const precioUnitarioLabel = `Precio unitario × ${CATEGORIAS.find((c) => c.valor === categoriaUnica)?.etiqueta ?? 'General'}`;

  return (
    <div className="mx-auto w-full lg:w-[80%]">
      <Pasos actual={paso} />

      {esReservacion && typeof paso === 'number' && paso > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-brand-200 bg-brand-50 px-3 py-2 text-xs">
          <span className="font-semibold uppercase tracking-wide text-brand-700">Venta tipo reservación</span>
          <span className="text-slate-500">
            Pago opcional — el cliente puede liquidar en la terminal antes de la salida.
          </span>
        </div>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {paso === 1 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            busqueda.mutate();
          }}
          className="space-y-4 tarjeta p-4"
        >
          <div>
            <h2 className="text-xl font-semibold text-slate-900">¿A dónde vamos?</h2>
            <p className="mt-1 text-sm text-slate-500">
              Selecciona sucursal de origen y destino, el número de personas que viajan y
              consulta los horarios del día.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className={ETIQUETA}>Personas</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPersonas((p) => Math.max(1, p - 1))}
                  disabled={personas <= 1}
                  aria-label="Menos personas"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-300 bg-white text-base font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  −
                </button>
                <span className="w-8 text-center text-sm font-medium">{personas}</span>
                <button
                  type="button"
                  onClick={() => setPersonas((p) => Math.min(18, p + 1))}
                  disabled={personas >= 18}
                  aria-label="Más personas"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-300 bg-white text-base font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  +
                </button>
              </div>
            </label>
            <label className="block text-sm">
              <span className={ETIQUETA}>Fecha de viaje</span>
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="campo mt-1 rounded-sm"
              />
            </label>
            <div className="col-span-2 grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <label className="block text-sm">
                <span className={ETIQUETA}>Origen</span>
                <select
                  value={origen}
                  onChange={(e) => setOrigen(e.target.value)}
                  required
                  className="campo mt-1 rounded-sm"
                >
                  <option value="">—</option>
                  {puntos.data?.filter((p) => p.puedeOriginar).map((p) => (
                    <option key={p.id} value={p.id}>{p.nombre}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!origen || !destino || !puntos.data?.find((p) => p.id === destino)?.puedeOriginar}
                onClick={() => { setOrigen(destino); setDestino(origen); }}
                title="Intercambiar origen y destino"
                aria-label="Intercambiar origen y destino"
                className="flex h-9 w-9 items-center justify-center rounded-sm border border-slate-300 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ⇄
              </button>
              <label className="block text-sm">
                <span className={ETIQUETA}>Destino</span>
                <select
                  value={destino}
                  onChange={(e) => setDestino(e.target.value)}
                  required
                  className="campo mt-1 rounded-sm"
                >
                  <option value="">—</option>
                  {puntos.data?.filter((p) => p.id !== origen).map((p) => (
                    <option key={p.id} value={p.id}>{p.nombre}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="rounded-sm border border-slate-200 p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={esReservacion}
                onChange={(e) => setEsReservacion(e.target.checked)}
              />
              Es reservación (paga después)
            </label>
          </div>
          <div className="text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={conConexion}
                onChange={(e) => setConConexion(e.target.checked)}
              />
              Con conexión
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busqueda.isPending}
              className="btn-primario rounded-sm"
            >
              {busqueda.isPending ? 'Buscando…' : 'Buscar horarios'}
            </button>
          </div>
        </form>
      )}

      {paso === 2 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Horarios disponibles</h2>
            <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
              {puntos.data?.find((p) => p.id === origen)?.nombre} → {puntos.data?.find((p) => p.id === destino)?.nombre}
              {' · '}{fecha}{' · '}{personas} pasajero{personas > 1 ? 's' : ''}
            </p>
          </div>
          {busqueda.data?.length === 0 && (
            <p className="text-sm text-slate-500">No hay salidas para ese tramo y fecha.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {busqueda.data?.map((s) => (
              <button
                key={s.salidaId}
                disabled={!s.seleccionable}
                onClick={() => {
                  setSalida(s);
                  setAsientos([]);
                  setPaso(3);
                }}
                className={`rounded-sm border p-4 text-left tarjeta ${
                  s.seleccionable ? 'border-slate-200 hover:border-brand-400 hover:bg-brand-50/30' : 'border-slate-200 opacity-60'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <div>
                    <span className="text-lg font-semibold text-slate-900">{hora(s.horaSalidaOrigen)} h</span>
                    {s.horaLlegadaDestino && (
                      <span className="ml-1.5 text-xs text-slate-400">→ {hora(s.horaLlegadaDestino)} h</span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-slate-900">
                      {s.importe === null ? 'sin tarifa' : `$${s.importe}`}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">por persona</div>
                  </div>
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {s.origenNombre} → {s.destinoNombre}
                </div>
                <div className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
                  {s.unidadNombre}
                  {s.unidadNumeroEconomico ? ` · Unidad ${s.unidadNumeroEconomico}` : ''}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                  <span className="text-slate-500">
                    {s.seleccionable ? `Quedan ${s.disponibles} asientos libres` : 'No seleccionable'}
                  </span>
                  <span
                    className={`rounded-sm px-2 py-1 text-xs font-medium ${
                      s.seleccionable ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-400'
                    }`}
                  >
                    {s.seleccionable ? 'Seleccionar' : 'Sin lugar'}
                  </span>
                </div>
              </button>
            ))}
          </div>
          <button onClick={() => setPaso(1)} className="text-sm text-slate-500 underline">
            ← cambiar búsqueda
          </button>
        </div>
      )}

      {paso === 3 && salida && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4 tarjeta p-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Mapa de asientos</h2>
              <p className="mt-1 text-sm text-slate-500">
                Selecciona {personas} asiento{personas > 1 ? 's' : ''}. Los asientos en gris no
                están disponibles para esta venta.
              </p>
            </div>
            <MapaAsientos
              mapa={salida.mapa}
              ofrecibles={salida.asientosOfrecibles}
              seleccionados={asientos}
              onToggle={toggleAsiento}
              unidadNombre={salida.unidadNombre}
            />
          </div>
          <ResumenViaje
            salida={salida}
            personas={personas}
            asientos={asientos}
            total={total}
            totalLabel={totalLabel}
            precioUnitario={precioUnitario}
            precioUnitarioLabel={precioUnitarioLabel}
            aviso={avisoReservacion}
          >
            <button
              disabled={asientos.length !== personas}
              onClick={() => setPaso(4)}
              className="btn-primario w-full rounded-sm"
            >
              Continuar ({asientos.length}/{personas})
            </button>
            <button onClick={() => setPaso(2)} className="block text-sm text-slate-500 underline">
              ← volver a horarios
            </button>
          </ResumenViaje>
        </div>
      )}

      {paso === 4 && salida && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4 tarjeta p-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Registro de pasajeros</h2>
            <p className="mt-1 text-sm text-slate-500">
              Captura los nombres y confirma el asiento asignado a cada pasajero.
            </p>
          </div>
          <div className="space-y-4">
          {asientos.map((a, i) => (
            <div key={a} className="grid grid-cols-[96px_1fr] gap-4 border-b border-slate-100 pb-4 last:border-0 last:pb-0">
              <div>
                <p className="text-sm font-medium text-slate-900">Pasajero {String(i + 1).padStart(2, '0')}</p>
                <p className={ETIQUETA}>
                  {CATEGORIAS.find((c) => c.valor === (categorias[a] ?? 'general'))?.etiqueta ?? 'General'}
                  {' · asiento asignado'}
                </p>
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-sm border border-brand-600 text-sm font-semibold text-brand-700">
                  {String(a).padStart(2, '0')}
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="block min-w-[160px] flex-1 text-sm">
                  <span className={ETIQUETA}>Nombre completo</span>
                  <input
                    value={nombres[a] ?? ''}
                    onChange={(e) => setNombres((p) => ({ ...p, [a]: e.target.value.toUpperCase() }))}
                    className="campo mt-1 rounded-sm"
                  />
                </label>
                {catsDisponibles.length > 1 && (
                  <label className="block w-48 text-sm">
                    <span className={ETIQUETA}>Tarifa / descuento</span>
                    <select
                      value={categorias[a] ?? 'general'}
                      onChange={(e) =>
                        setCategorias((p) => ({ ...p, [a]: e.target.value as CategoriaPasajero }))
                      }
                      className="campo mt-1 rounded-sm"
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
            </div>
          ))}
          </div>
          {catsDisponibles.length > 1 && (
            <p className="text-xs text-slate-400">
              El descuento (INAPAM / menor) solo aplica de la terminal de origen a la de
              destino; para otros tramos solo hay tarifa general.
            </p>
          )}
          </div>
          <ResumenViaje
            salida={salida} personas={personas} asientos={asientos} total={total} totalLabel={totalLabel}
            precioUnitario={precioUnitario} precioUnitarioLabel={precioUnitarioLabel} aviso={avisoReservacion}
          >
            <button
              disabled={asientos.some((a) => !nombres[a]?.trim())}
              onClick={() => setPaso(5)}
              className="btn-primario w-full rounded-sm"
            >
              Continuar
            </button>
            <button onClick={() => setPaso(3)} className="block text-sm text-slate-500 underline">
              ← volver a asientos
            </button>
          </ResumenViaje>
        </div>
      )}

      {paso === 5 && salida && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4 tarjeta p-4 text-sm">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Confirmación de datos</h2>
              <p className="mt-1 text-sm text-slate-500">Revisa el viaje y los pasajeros antes de cobrar.</p>
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-sm bg-brand-50 p-3">
              <div>
                <p className={ETIQUETA}>Fecha de viaje</p>
                <p className="font-semibold text-slate-900">{soloFecha(salida.horaSalidaOrigen)}</p>
              </div>
              <div className="text-right">
                <p className={ETIQUETA}>Hora de salida</p>
                <p className="font-semibold text-slate-900">{hora(salida.horaSalidaOrigen)} h</p>
              </div>
            </div>
            <div>
              <p className={ETIQUETA}>Viaje</p>
              <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-slate-400">Origen</p>
                  <p className="font-medium text-slate-800">{salida.origenNombre}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Destino</p>
                  <p className="font-medium text-slate-800">{salida.destinoNombre}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Salida</p>
                  <p className="font-medium text-slate-800">
                    {soloFecha(salida.horaSalidaOrigen)} · {hora(salida.horaSalidaOrigen)} h
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Unidad</p>
                  <p className="font-medium text-slate-800">{salida.unidadNombre}</p>
                </div>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Pasajero</th>
                  <th className="py-2 pr-2">Tipo</th>
                  <th className="py-2 pr-2">Asiento</th>
                  <th className="py-2 text-right">Importe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {asientos.map((a, i) => (
                  <tr key={a}>
                    <td className="py-2 pr-2 text-slate-400">{String(i + 1).padStart(2, '0')}</td>
                    <td className="py-2 pr-2 font-medium text-slate-900">{nombres[a]}</td>
                    <td className="py-2 pr-2 text-slate-600">
                      {CATEGORIAS.find((c) => c.valor === (categorias[a] ?? 'general'))?.etiqueta ?? 'General'}
                    </td>
                    <td className="py-2 pr-2 text-slate-600">{a}</td>
                    <td className="py-2 text-right text-slate-900">${importeDe(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ResumenViaje
            salida={salida} personas={personas} asientos={asientos} total={total} totalLabel={totalLabel}
            precioUnitario={precioUnitario} precioUnitarioLabel={precioUnitarioLabel} aviso={avisoReservacion}
          >
            <button
              onClick={() => setPaso(6)}
              className="btn-primario w-full rounded-sm"
            >
              Ir al pago
            </button>
            <button onClick={() => setPaso(4)} className="block text-sm text-slate-500 underline">
              ← volver a pasajeros
            </button>
          </ResumenViaje>
        </div>
      )}

      {paso === 6 && salida && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4 tarjeta p-4 text-sm">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Pago</h2>
            <p className="mt-1 text-sm text-slate-500">
              {esReservacion
                ? 'Venta tipo reservación: el pago es opcional. Puedes apartar sin cobro para liquidar en terminal, o registrar transferencia de una vez.'
                : 'Registra el cobro en mostrador.'}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { valor: 'efectivo' as const, titulo: 'Efectivo', descripcion: 'Cobro en caja, calcula cambio' },
              { valor: 'transferencia' as const, titulo: 'Transferencia', descripcion: 'Monto exacto, con referencia' },
              ...(sinSistema.length > 0
                ? [{ valor: 'corresponsal' as const, titulo: 'Corresponsal', descripcion: 'Cobro en sucursal autorizada' }]
                : []),
              ...(esReservacion
                ? [{ valor: 'sin_pago' as const, titulo: 'Pago en terminal', descripcion: 'Sin cobro ahora, apartado' }]
                : []),
            ].map((m) => (
              <button
                key={m.valor}
                type="button"
                onClick={() => setMetodo(m.valor)}
                className={`rounded-sm border p-3 text-left ${
                  metodo === m.valor ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-white hover:bg-slate-50'
                }`}
              >
                <div className={`text-sm font-semibold uppercase tracking-wide ${
                  metodo === m.valor ? 'text-brand-700' : 'text-slate-700'
                }`}>
                  {m.titulo}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{m.descripcion}</div>
              </button>
            ))}
          </div>

          {metodo === 'efectivo' && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className={ETIQUETA}>Teléfono de contacto</span>
                  <input
                    value={contacto}
                    onChange={(e) => setContacto(e.target.value)}
                    className="campo mt-1 rounded-sm"
                  />
                </label>
                <label className="block">
                  <span className={ETIQUETA}>Recibe (efectivo)</span>
                  <input
                    type="number"
                    min={total}
                    step="1"
                    inputMode="decimal"
                    value={efectivoRecibido}
                    onChange={(e) => setEfectivoRecibido(e.target.value)}
                    className="campo mt-1 rounded-sm"
                  />
                </label>
                <div>
                  <span className={ETIQUETA}>Cambio a devolver</span>
                  <p className="campo mt-1 flex items-center rounded-sm bg-slate-50 text-slate-700">
                    {recibidoValido ? `$${cambio}` : '—'}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {[200, 500, 1000].map((monto) => (
                  <button
                    key={monto}
                    type="button"
                    onClick={() => setEfectivoRecibido(String(monto))}
                    className="rounded-sm border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50"
                  >
                    ${monto}
                  </button>
                ))}
              </div>
              {efectivoRecibido.trim() !== '' && !recibidoValido && (
                <p className="text-xs text-red-600">
                  El efectivo recibido debe cubrir el total (${total}).
                </p>
              )}
            </div>
          )}

          {metodo === 'transferencia' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={ETIQUETA}>Teléfono de contacto</span>
                <input
                  value={contacto}
                  onChange={(e) => setContacto(e.target.value)}
                  className="campo mt-1 rounded-sm"
                />
              </label>
              <label className="block">
                <span className={ETIQUETA}>Referencia / folio SPEI</span>
                <input
                  value={referencia}
                  onChange={(e) => setReferencia(e.target.value)}
                  className="campo mt-1 rounded-sm"
                />
              </label>
              <div>
                <span className={ETIQUETA}>Estatus</span>
                <div className="mt-1 rounded-sm border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Transferencia
                </div>
              </div>
            </div>
          )}

          {metodo === 'corresponsal' && (
            <div className="space-y-3">
              <label className="block">
                <span className={ETIQUETA}>Sucursales autorizadas de cobro</span>
                <select
                  value={sucursalCobroId}
                  onChange={(e) => setSucursalCobroId(e.target.value)}
                  className="campo mt-1 rounded-sm"
                >
                  <option value="">— elige —</option>
                  {sinSistema.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={ETIQUETA}>Teléfono de contacto</span>
                  <input
                    value={contacto}
                    onChange={(e) => setContacto(e.target.value)}
                    className="campo mt-1 rounded-sm"
                  />
                </label>
                <div>
                  <span className={ETIQUETA}>Estatus</span>
                  <div className="mt-1 rounded-sm border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Cobrado en sucursal sin sistema
                  </div>
                </div>
              </div>
            </div>
          )}

          {metodo === 'sin_pago' && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={ETIQUETA}>Teléfono de contacto</span>
                  <input
                    value={contacto}
                    onChange={(e) => setContacto(e.target.value)}
                    className="campo mt-1 rounded-sm"
                  />
                </label>
                <div>
                  <span className={ETIQUETA}>Estatus</span>
                  <div className="mt-1 rounded-sm border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Pendiente de pago
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Los asientos quedan apartados a nombre del cliente. El cobro se registra en
                caja al presentarse en la terminal, hasta 30 minutos antes de la salida.
              </p>
            </div>
          )}
          </div>
          <ResumenViaje
            salida={salida} personas={personas} asientos={asientos} total={total} totalLabel={totalLabel}
            precioUnitario={precioUnitario} precioUnitarioLabel={precioUnitarioLabel} aviso={avisoReservacion}
          >
            <button
              onClick={() => venta.mutate()}
              disabled={
                venta.isPending
                || !contacto.trim()
                || (metodo === 'corresponsal' && !sucursalCobroId)
                || efectivoIncompleto
              }
              className="btn-primario w-full rounded-sm"
            >
              {venta.isPending ? 'Registrando…' : textoBotonPago}
            </button>
            <button
              onClick={() => setPaso(5)}
              disabled={venta.isPending}
              className="block text-sm text-slate-500 underline"
            >
              ← volver al resumen
            </button>
          </ResumenViaje>
        </div>
      )}

      {typeof paso === 'number' && paso > 1 && (
        <div className="mt-4 border-t pt-4">
          <button type="button" onClick={cancelarVenta} className="btn-peligro rounded-sm">
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
          <button onClick={reiniciar} className="btn-primario rounded-sm">
            Nueva venta
          </button>
        </div>
      )}
    </div>
  );
}
