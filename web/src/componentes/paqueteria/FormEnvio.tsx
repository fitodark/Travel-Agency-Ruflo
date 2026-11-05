/**
 * Registrar un envío (REQ-1..REQ-7): destino, salida, remitente, destinatario,
 * descripción, bultos, importe y si se paga aquí o se cobra en destino.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { listarSucursales } from '../../api/catalogos';
import {
  registrarEnvio, salidasParaEnvio, type Modalidad, type ResultadoEnvio,
} from '../../api/paqueteria';
import { ErrorApi } from '../../api/cliente';
import { useSesion } from '../../auth/sesion';
import { hora, hoyLocal } from '../../lib/fechas';
import { Aviso, Boton, Tarjeta } from '../ui';
import { aPago, cobroInicial, CobroEnvio, cobroValido, ETIQUETA, mxn, type EstadoCobro } from './comun';

const vacio = {
  remitenteNombre: '', remitenteTelefono: '',
  destinatarioNombre: '', destinatarioTelefono: '',
  descripcion: '', bultos: '1', importe: '',
};

export function FormEnvio({ onRegistrado }: { onRegistrado: (folio: string) => void }) {
  const { sesion } = useSesion();
  const [fecha, setFecha] = useState(hoyLocal);
  const [destinoId, setDestinoId] = useState('');
  const [salidaId, setSalidaId] = useState('');
  const [d, setD] = useState(vacio);
  const [modalidad, setModalidad] = useState<Modalidad>('pagado');
  const [cobro, setCobro] = useState<EstadoCobro>(cobroInicial());
  const [resultado, setResultado] = useState<ResultadoEnvio | null>(null);

  const sucursales = useQuery({ queryKey: ['catalogos', 'sucursales'], queryFn: listarSucursales });
  const destinos = (sucursales.data ?? []).filter((s) => !s.sinSistema && s.id !== sesion?.sucursalId);
  const salidas = useQuery({
    queryKey: ['paqueteria', 'salidas', fecha, destinoId],
    queryFn: () => salidasParaEnvio(fecha, destinoId),
    enabled: !!destinoId,
  });
  // Solo las que aún reciben envíos: las que ya pasaron (o cerraron registro)
  // no se listan. Vienen ordenadas por hora de paso por esta terminal.
  const abiertas = useMemo(() => (salidas.data ?? []).filter((s) => s.abierta), [salidas.data]);

  // Por defecto, la más próxima; si la elegida deja de estar disponible, la siguiente.
  useEffect(() => {
    if (!abiertas.some((s) => s.salidaId === salidaId)) setSalidaId(abiertas[0]?.salidaId ?? '');
  }, [abiertas, salidaId]);

  const importe = Number(d.importe);
  const bultos = Number(d.bultos);
  const completo = useMemo(
    () => !!salidaId && Object.values(d).every((v) => v.trim() !== '')
      && Number.isInteger(bultos) && bultos >= 1 && bultos <= 99
      && Number.isFinite(importe) && importe > 0
      && (modalidad === 'por_cobrar' || cobroValido(cobro, importe)),
    [salidaId, d, bultos, importe, modalidad, cobro],
  );

  const registrar = useMutation({
    mutationFn: () => registrarEnvio({
      salidaId, sucursalDestinoId: destinoId,
      remitenteNombre: d.remitenteNombre.trim(), remitenteTelefono: d.remitenteTelefono.trim(),
      destinatarioNombre: d.destinatarioNombre.trim(), destinatarioTelefono: d.destinatarioTelefono.trim(),
      descripcion: d.descripcion.trim(), bultos, importe, modalidad,
      ...(modalidad === 'pagado' ? { pago: aPago(cobro) } : {}),
    }),
    onSuccess: (r) => {
      setResultado(r);
      onRegistrado(r.folio);
    },
  });

  const nuevo = () => {
    setD(vacio); setSalidaId(''); setModalidad('pagado'); setCobro(cobroInicial());
    setResultado(null); registrar.reset();
  };

  const campo = (
    k: keyof typeof vacio, etiqueta: string, extra: Record<string, unknown> = {}, mayusculas = false,
  ) => (
    <label className="block">
      <span className={ETIQUETA}>{etiqueta} *</span>
      <input
        value={d[k]}
        onChange={(e) => {
          if (!mayusculas) { setD({ ...d, [k]: e.target.value }); return; }
          // Máscara de mayúsculas (con acentos y Ñ). Se conserva el cursor para
          // poder corregir a media palabra sin que salte al final.
          const el = e.target;
          const { selectionStart: ini, selectionEnd: fin } = el;
          setD({ ...d, [k]: el.value.toLocaleUpperCase('es-MX') });
          requestAnimationFrame(() => { if (ini !== null && fin !== null) el.setSelectionRange(ini, fin); });
        }}
        className={`campo rounded-sm ${mayusculas ? 'uppercase' : ''}`} {...extra}
      />
    </label>
  );

  if (resultado) {
    return (
      <Tarjeta className="space-y-3 p-4 text-sm">
        <Aviso>
          Envío registrado · folio <span className="font-mono font-semibold">{resultado.folio}</span> ·{' '}
          {resultado.printJobs} ticket(s) a la impresora (recibo + uno por bulto).
          {resultado.estadoPago === 'por_confirmar' && ' La transferencia queda por confirmar en Caja.'}
        </Aviso>
        <p className="text-slate-600">Pega un ticket en cada bulto y entrega el recibo al cliente.</p>
        <Boton onClick={nuevo}>Registrar otro envío</Boton>
      </Tarjeta>
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
      <Tarjeta className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={ETIQUETA}>Fecha</span>
            <input type="date" value={fecha} min={hoyLocal()} required
                   onChange={(e) => { setFecha(e.target.value || hoyLocal()); setSalidaId(''); }}
                   className="campo rounded-sm" />
          </label>
          <label className="block sm:col-span-2">
            <span className={ETIQUETA}>Destino (terminal con sistema) *</span>
            <select value={destinoId} onChange={(e) => { setDestinoId(e.target.value); setSalidaId(''); }}
                    className="campo rounded-sm">
              <option value="">— elige —</option>
              {destinos.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </label>
        </div>

        {destinoId && (
          <label className="block">
            <span className={ETIQUETA}>Salida *</span>
            {salidas.isLoading ? (
              <p className="text-slate-400">Cargando salidas…</p>
            ) : abiertas.length === 0 ? (
              <p className="text-slate-500">
                No quedan salidas disponibles esta fecha que pasen por aquí y lleguen a ese destino.
              </p>
            ) : (
              <select value={salidaId} onChange={(e) => setSalidaId(e.target.value)} className="campo rounded-sm">
                {abiertas.map((s) => (
                  <option key={s.salidaId} value={s.salidaId}>
                    {hora(s.horaPaso)} · {s.ruta} · {s.unidad ?? 'sin unidad'}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {campo('remitenteNombre', 'Nombre de quien envía', { maxLength: 120 }, true)}
          {campo('remitenteTelefono', 'Celular de quien envía', { maxLength: 40, inputMode: 'tel' })}
          {campo('destinatarioNombre', 'Nombre completo de quien recibe', { maxLength: 120 }, true)}
          {campo('destinatarioTelefono', 'Celular de quien recibe', { maxLength: 40, inputMode: 'tel' })}
        </div>
        {campo('descripcion', 'Descripción breve del envío', { maxLength: 200, placeholder: 'p. ej. 5 cajas grandes de ropa' })}
        <div className="grid grid-cols-2 gap-3">
          {campo('bultos', 'Número de bultos', { type: 'number', min: 1, max: 99, step: 1 })}
          {campo('importe', 'Importe acordado ($)', { type: 'number', min: 1, step: 1, inputMode: 'decimal' })}
        </div>
      </Tarjeta>

      <Tarjeta className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-2 gap-2">
          {([['pagado', 'Paga aquí'], ['por_cobrar', 'Por cobrar en destino']] as const).map(([v, t]) => (
            <button
              key={v} type="button" onClick={() => setModalidad(v)}
              className={`rounded-sm border p-2 text-left ${
                modalidad === v ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700' : 'border-slate-300 bg-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {modalidad === 'pagado' ? (
          <CobroEnvio monto={importe || 0} valor={cobro} onCambio={setCobro} />
        ) : (
          <p className="text-slate-500">
            Lo paga completo quien recoge, en la sucursal destino. Los tickets lo marcan POR COBRAR.
          </p>
        )}
        <div className="flex justify-between border-t pt-3 font-semibold">
          <span>{modalidad === 'pagado' ? 'Total' : 'Por cobrar'}</span>
          <span>{Number.isFinite(importe) && importe > 0 ? mxn(importe) : '—'}</span>
        </div>
        {registrar.isError && (
          <Aviso tono="error">
            {registrar.error instanceof ErrorApi ? registrar.error.message : 'No se pudo registrar el envío.'}
          </Aviso>
        )}
        <Boton className="w-full" disabled={!completo || registrar.isPending} onClick={() => registrar.mutate()}>
          {registrar.isPending ? 'Registrando…' : 'Registrar envío e imprimir'}
        </Boton>
      </Tarjeta>
    </div>
  );
}
