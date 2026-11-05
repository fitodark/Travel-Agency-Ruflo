/**
 * Detalle de un envío (consulta por folio, REQ-10) con las acciones que le
 * tocan a MI sucursal:
 *   * origen: marcar en ruta (0089), reimprimir, mover de salida y cancelar
 *     (antes de despachar);
 *   * destino: recibir (en sucursal) y entregar (nombre verificado + cobro si
 *     es por cobrar);
 *   * cualquiera con permiso: confirmar una transferencia pendiente.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buscarEnvio, cancelarEnvio, confirmarTransferenciaEnvio, entregarEnvio, ESTADO_ENVIO,
  ESTADO_PAGO_ENVIO, marcarEnvioEnRuta, moverEnvio, recibirEnvio, reimprimirEnvio, salidasParaEnvio, type Envio,
} from '../../api/paqueteria';
import { ErrorApi } from '../../api/cliente';
import { useSesion } from '../../auth/sesion';
import { fecha, fechaHora, hora } from '../../lib/fechas';
import { Aviso, Boton, BotonSutil, Chip, Modal } from '../ui';
import { aPago, cobroInicial, CobroEnvio, cobroValido, ETIQUETA, mxn, type EstadoCobro } from './comun';

const tonoEstado = (e: Envio['estado']) =>
  e === 'cancelado' ? 'error' : e === 'entregado' ? 'baja' : e === 'en_sucursal' ? 'ok' : 'alerta';

const mensaje = (e: unknown, def: string) => (e instanceof ErrorApi ? e.message : def);

export function DetalleEnvio({ folio, onCerrar }: { folio: string; onCerrar: () => void }) {
  const { sesion } = useSesion();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['paqueteria', 'folio', folio], queryFn: () => buscarEnvio(folio) });
  const [aviso, setAviso] = useState<string | null>(null);
  const [accion, setAccion] = useState<'entregar' | 'mover' | 'cancelar' | 'reimprimir' | null>(null);

  const refrescar = (texto: string) => {
    setAviso(texto);
    setAccion(null);
    void qc.invalidateQueries({ queryKey: ['paqueteria'] });
  };

  const recibir = useMutation({
    mutationFn: (id: string) => recibirEnvio(id),
    onSuccess: () => refrescar('Paquete registrado en sucursal: ya puede recogerse.'),
  });
  const confirmar = useMutation({
    mutationFn: (pagoId: string) => confirmarTransferenciaEnvio(pagoId),
    onSuccess: () => refrescar('Transferencia confirmada: ya suma al corte.'),
  });

  const enRuta = useMutation({
    mutationFn: (id: string) => marcarEnvioEnRuta(id),
    onSuccess: () => refrescar('Paquete en ruta: ya va en la unidad.'),
  });

  const e = q.data;
  const soyOrigen = !!e && e.sucursalOrigenId === sesion?.sucursalId;
  const soyDestino = !!e && e.sucursalDestinoId === sesion?.sucursalId;
  const errorAccion = recibir.error ?? confirmar.error ?? enRuta.error;

  return (
    <Modal titulo={`Envío ${folio}`} onCerrar={onCerrar}>
      {q.isPending && <p className="text-sm text-slate-400">Cargando…</p>}
      {q.isError && <Aviso tono="error">{mensaje(q.error, 'No se encontró el envío.')}</Aviso>}
      {e && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Chip estado={tonoEstado(e.estado)}>{ESTADO_ENVIO[e.estado]}</Chip>
            <Chip estado={e.estadoPago === 'pagado' ? 'ok' : 'alerta'}>{ESTADO_PAGO_ENVIO[e.estadoPago]}</Chip>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-slate-500">Ruta</dt><dd>{e.origen} → {e.destino} · {fecha(e.fechaOperacion)}</dd>
            <dt className="text-slate-500">Envía</dt><dd>{e.remitenteNombre} · {e.remitenteTelefono}</dd>
            <dt className="text-slate-500">Recibe</dt><dd className="font-medium">{e.destinatarioNombre} · {e.destinatarioTelefono}</dd>
            <dt className="text-slate-500">Contenido</dt><dd>{e.descripcion} · {e.bultos} bulto(s)</dd>
            <dt className="text-slate-500">Importe</dt>
            <dd>{mxn(e.importe)}{e.porCobrar > 0 && <span className="font-semibold"> · por cobrar {mxn(e.porCobrar)}</span>}</dd>
            <dt className="text-slate-500">Registró</dt><dd>{e.registradoPor} · {fechaHora(e.registradoEn)}</dd>
          </dl>

          {aviso && <Aviso onCerrar={() => setAviso(null)}>{aviso}</Aviso>}
          {errorAccion && <Aviso tono="error">{mensaje(errorAccion, 'No se pudo completar la acción.')}</Aviso>}

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {soyDestino && (e.estado === 'registrado' || e.estado === 'en_ruta') && (
              <Boton onClick={() => recibir.mutate(e.envioId)} disabled={recibir.isPending}>Recibir en sucursal</Boton>
            )}
            {soyDestino && e.estado === 'en_sucursal' && (
              <Boton onClick={() => setAccion('entregar')}>Entregar</Boton>
            )}
            {e.pagoPorConfirmarId && (
              <BotonSutil onClick={() => confirmar.mutate(e.pagoPorConfirmarId!)} disabled={confirmar.isPending}>
                Confirmar transferencia
              </BotonSutil>
            )}
            {soyOrigen && e.estado !== 'cancelado' && (
              <BotonSutil onClick={() => setAccion('reimprimir')}>Reimprimir</BotonSutil>
            )}
            {soyOrigen && e.estado === 'registrado' && (
              <>
                <Boton onClick={() => enRuta.mutate(e.envioId)} disabled={enRuta.isPending}>
                  {enRuta.isPending ? 'Marcando…' : 'Marcar en ruta'}
                </Boton>
                <BotonSutil onClick={() => setAccion('mover')}>Mover de salida</BotonSutil>
                <BotonSutil className="text-red-600" onClick={() => setAccion('cancelar')}>Cancelar envío</BotonSutil>
              </>
            )}
          </div>

          {accion === 'entregar' && <Entregar envio={e} onListo={refrescar} />}
          {accion === 'mover' && <Mover envio={e} onListo={refrescar} />}
          {accion === 'cancelar' && <Cancelar envio={e} onListo={refrescar} />}
          {accion === 'reimprimir' && <Reimprimir envio={e} onListo={refrescar} />}
        </div>
      )}
    </Modal>
  );
}

function Entregar({ envio, onListo }: { envio: Envio; onListo: (t: string) => void }) {
  const [verificado, setVerificado] = useState(false);
  const [cobro, setCobro] = useState<EstadoCobro>(cobroInicial());
  const cobrar = envio.porCobrar > 0;
  const m = useMutation({
    mutationFn: () => entregarEnvio(envio.envioId, verificado, cobrar ? aPago(cobro) : undefined),
    onSuccess: () => onListo('Paquete entregado.'),
  });
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={verificado} onChange={(ev) => setVerificado(ev.target.checked)} className="mt-1" />
        <span>
          Verifiqué que el <b>nombre completo</b> de la credencial de elector es{' '}
          <b>{envio.destinatarioNombre}</b> y que trae el folio. <span className="text-slate-500">(No se captura el número de la credencial.)</span>
        </span>
      </label>
      {cobrar && (
        <>
          <p className="font-semibold">Cobrar {mxn(envio.porCobrar)}</p>
          <CobroEnvio monto={envio.porCobrar} valor={cobro} onCambio={setCobro} />
        </>
      )}
      {m.isError && <Aviso tono="error">{mensaje(m.error, 'No se pudo entregar.')}</Aviso>}
      <Boton
        disabled={!verificado || (cobrar && !cobroValido(cobro, envio.porCobrar)) || m.isPending}
        onClick={() => m.mutate()}
      >
        {cobrar ? `Cobrar ${mxn(envio.porCobrar)} y entregar` : 'Entregar'}
      </Boton>
    </div>
  );
}

function Mover({ envio, onListo }: { envio: Envio; onListo: (t: string) => void }) {
  const [dia, setDia] = useState(envio.fechaOperacion);
  const salidas = useQuery({
    queryKey: ['paqueteria', 'salidas', dia, envio.sucursalDestinoId],
    queryFn: () => salidasParaEnvio(dia, envio.sucursalDestinoId),
  });
  const m = useMutation({
    mutationFn: (salidaId: string) => moverEnvio(envio.envioId, salidaId),
    onSuccess: (r) => onListo(`Envío movido. Se reimprimieron ${r.printJobs} ticket(s): cambia los que ya estaban pegados.`),
  });
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <label className="block">
        <span className={ETIQUETA}>Fecha</span>
        <input type="date" value={dia} onChange={(ev) => setDia(ev.target.value)} className="campo rounded-sm" />
      </label>
      {salidas.data?.filter((s) => s.salidaId !== envio.salidaId).map((s) => (
        <button
          key={s.salidaId} type="button" disabled={!s.abierta || m.isPending}
          onClick={() => m.mutate(s.salidaId)}
          className="block w-full rounded-sm border border-slate-300 p-2 text-left disabled:opacity-50"
        >
          <span className="font-mono font-semibold">{hora(s.horaPaso)}</span> · {s.ruta} · {s.unidad ?? 'sin unidad'}
          {!s.abierta && ' · registro cerrado'}
        </button>
      ))}
      {salidas.data?.filter((s) => s.salidaId !== envio.salidaId).length === 0 && (
        <p className="text-slate-500">No hay otras salidas ese día hacia {envio.destino}.</p>
      )}
      {m.isError && <Aviso tono="error">{mensaje(m.error, 'No se pudo mover el envío.')}</Aviso>}
    </div>
  );
}

function Cancelar({ envio, onListo }: { envio: Envio; onListo: (t: string) => void }) {
  const [motivo, setMotivo] = useState('');
  const m = useMutation({
    mutationFn: () => cancelarEnvio(envio.envioId, motivo.trim()),
    onSuccess: (r) => onListo(r.reembolso > 0
      ? `Envío cancelado. Reembolso de ${mxn(r.reembolso)} registrado en el corte.`
      : 'Envío cancelado (no había cobro que reembolsar).'),
  });
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
      <p className="text-red-800">
        Solo se reembolsa lo cobrado en efectivo. Un envío pagado por transferencia no se cancela desde el sistema.
      </p>
      <input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo"
             maxLength={200} className="campo rounded-sm" />
      {m.isError && <Aviso tono="error">{mensaje(m.error, 'No se pudo cancelar.')}</Aviso>}
      <Boton variante="peligro" disabled={!motivo.trim() || m.isPending} onClick={() => m.mutate()}>
        Confirmar cancelación
      </Boton>
    </div>
  );
}

function Reimprimir({ envio, onListo }: { envio: Envio; onListo: (t: string) => void }) {
  const [que, setQue] = useState<'recibo' | 'etiquetas' | 'todo'>('etiquetas');
  const [bulto, setBulto] = useState('');
  const [motivo, setMotivo] = useState('');
  const m = useMutation({
    mutationFn: () => reimprimirEnvio(envio.envioId, que, motivo.trim(), bulto ? Number(bulto) : undefined),
    onSuccess: (r) => onListo(`${r.printJobs} ticket(s) enviados a la impresora.`),
  });
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <div className="grid grid-cols-2 gap-2">
        <select value={que} onChange={(ev) => setQue(ev.target.value as typeof que)} className="campo rounded-sm">
          <option value="etiquetas">Tickets de bultos</option>
          <option value="recibo">Recibo</option>
          <option value="todo">Todo</option>
        </select>
        {que === 'etiquetas' && (
          <select value={bulto} onChange={(ev) => setBulto(ev.target.value)} className="campo rounded-sm">
            <option value="">Todos los bultos</option>
            {Array.from({ length: envio.bultos }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>Bulto {n}/{envio.bultos}</option>
            ))}
          </select>
        )}
      </div>
      <input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo de la reimpresión"
             maxLength={200} className="campo rounded-sm" />
      {m.isError && <Aviso tono="error">{mensaje(m.error, 'No se pudo reimprimir.')}</Aviso>}
      <Boton disabled={!motivo.trim() || m.isPending} onClick={() => m.mutate()}>Reimprimir</Boton>
    </div>
  );
}
