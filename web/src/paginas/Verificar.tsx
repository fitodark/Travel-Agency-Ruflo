import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import { registrarAbordaje, verificarBoletoQr, type VeredictoQr } from '../api/viajes';
import { fecha } from '../lib/fechas';

const VEREDICTO: Record<VeredictoQr['veredicto'], { rotulo: string; caja: string; punto: string }> = {
  ok: { rotulo: 'Boleto válido', caja: 'border-green-300 bg-green-50 text-green-900', punto: 'bg-green-500' },
  revisar: { rotulo: 'Revisar', caja: 'border-amber-300 bg-amber-50 text-amber-900', punto: 'bg-amber-500' },
  rechazar: { rotulo: 'Rechazar', caja: 'border-red-300 bg-red-50 text-red-900', punto: 'bg-red-500' },
};

const FIRMA: Record<VeredictoQr['firma'], string> = {
  valida: 'firma válida',
  invalida: 'firma inválida',
  sin_firma: 'sin firma',
  sin_secreto: 'sin secreto configurado',
};

const ABORDAJE: Record<string, string> = {
  abordo: 'ya abordó',
  no_presento: 'marcado como no se presentó',
  pendiente: 'sin capturar',
};

export function Verificar() {
  const [texto, setTexto] = useState('');
  const [resultado, setResultado] = useState<VeredictoQr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const campoRef = useRef<HTMLTextAreaElement>(null);

  const verificar = useMutation({
    mutationFn: (qr: string) => verificarBoletoQr(qr),
    onSuccess: (r) => { setResultado(r); setError(null); },
    onError: (e) => {
      setResultado(null);
      setError(e instanceof ErrorApi ? e.message : 'No se pudo verificar el boleto.');
    },
  });

  const abordaje = useMutation({
    mutationFn: (boletoId: string) => registrarAbordaje(boletoId, true),
    onSuccess: () => { if (texto.trim()) verificar.mutate(texto.trim()); },
    onError: (e) => setError(e instanceof ErrorApi ? e.message : 'No se pudo registrar el abordaje.'),
  });

  const lanzar = (): void => {
    const qr = texto.trim();
    if (qr) verificar.mutate(qr);
  };

  const enviar = (e: FormEvent): void => { e.preventDefault(); lanzar(); };

  const limpiar = (): void => {
    setTexto('');
    setResultado(null);
    setError(null);
    abordaje.reset();
    campoRef.current?.focus();
  };

  const r = resultado;
  const b = r?.boleto ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Verificar boleto</h1>
      <p className="text-sm text-slate-500">
        Escanea el QR del boleto (o pega su texto) para validar que lo emitió este sistema y que
        el boleto sigue vigente. Funciona sin internet.
      </p>

      <form onSubmit={enviar} className="tarjeta space-y-3 p-4">
        <textarea
          ref={campoRef}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); lanzar(); }
          }}
          placeholder="DONAJI|F:…|P:…|A:…|…|V:…"
          rows={3}
          autoFocus
          className="campo w-full resize-none font-mono text-xs tracking-tight"
        />
        <div className="flex gap-2">
          <button type="submit" disabled={verificar.isPending || !texto.trim()} className="btn-primario">
            {verificar.isPending ? 'Verificando…' : 'Verificar'}
          </button>
          {(resultado || texto) && (
            <button type="button" onClick={limpiar} className="rounded border px-3 py-1.5 text-sm">
              Limpiar
            </button>
          )}
        </div>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {r && (
        <div className={`rounded-lg border p-4 ${VEREDICTO[r.veredicto].caja}`}>
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${VEREDICTO[r.veredicto].punto}`} />
            <span className="text-lg font-semibold">{VEREDICTO[r.veredicto].rotulo}</span>
            <span className="ml-auto text-xs opacity-70">{FIRMA[r.firma]}</span>
          </div>
          <p className="mt-1 text-sm">{r.nota}</p>

          {b && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="opacity-70">Folio</dt>
              <dd className="font-mono font-semibold">{b.folio}</dd>
              <dt className="opacity-70">Pasajero</dt>
              <dd>{b.pasajeroNombre}</dd>
              <dt className="opacity-70">Asiento · tramo</dt>
              <dd>{b.asientoNum} · {b.tramos}</dd>
              <dt className="opacity-70">Ruta</dt>
              <dd>{b.origen} → {b.destino}</dd>
              <dt className="opacity-70">Salida</dt>
              <dd>
                {fecha(b.salida.fechaOperacion)} · {b.salida.estado}
                {!b.salida.esHoy && <span className="ml-1 font-medium">(no es hoy)</span>}
              </dd>
              <dt className="opacity-70">Boleto</dt>
              <dd>{b.estado} · abordaje: {ABORDAJE[b.estadoAbordaje] ?? b.estadoAbordaje}</dd>
              {!r.coincide && (
                <>
                  <dt className="opacity-70">Aviso</dt>
                  <dd className="font-medium">el QR no coincide con el boleto</dd>
                </>
              )}
            </dl>
          )}

          {!b && r.campos['F'] && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="opacity-70">Folio (del QR)</dt>
              <dd className="font-mono">{r.campos['F']}</dd>
              <dt className="opacity-70">Pasajero</dt>
              <dd>{r.campos['P'] ?? '—'}</dd>
              <dt className="opacity-70">Asiento</dt>
              <dd>{r.campos['A'] ?? '—'}</dd>
              <dt className="opacity-70">Viaje</dt>
              <dd>{r.campos['FH'] ?? '—'}</dd>
            </dl>
          )}

          {r.veredicto === 'ok' && b && b.estadoAbordaje === 'pendiente' && !abordaje.isSuccess && (
            <button
              type="button"
              onClick={() => abordaje.mutate(b.boletoId)}
              disabled={abordaje.isPending}
              className="btn-primario mt-3"
            >
              {abordaje.isPending ? 'Registrando…' : 'Registrar a bordo'}
            </button>
          )}
          {abordaje.isSuccess && <p className="mt-3 text-sm font-medium">Abordaje registrado.</p>}
        </div>
      )}
    </div>
  );
}
