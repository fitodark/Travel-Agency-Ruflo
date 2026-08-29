import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import { guardarTicket, ticketVigente } from '../../api/admin';
import { useModo } from '../../componentes/admin/Modo';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo publicar el ticket.');
const fecha = (s?: string | null) => (s ? new Date(s).toLocaleString('es-MX') : null);

export function AdminTicket() {
  const qc = useQueryClient();
  const modo = useModo();
  const vigente = useQuery({ queryKey: ['admin', 'ticket'], queryFn: ticketVigente });
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ leyendaPie: '', telefonoAtencion: '', credencialesProveedor: '', logoUrl: '', hmacQrSecreto: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    const v = vigente.data;
    if (v) {
      setF({
        leyendaPie: v.leyenda_pie ?? '', telefonoAtencion: v.telefono_atencion ?? '',
        credencialesProveedor: v.credenciales_proveedor ?? '', logoUrl: v.logo_url ?? '', hmacQrSecreto: v.hmac_qr_secreto ?? '',
      });
    }
  }, [vigente.data]);

  const m = useMutation({
    mutationFn: () => guardarTicket({
      leyendaPie: f.leyendaPie, telefonoAtencion: f.telefonoAtencion, credencialesProveedor: f.credencialesProveedor,
      logoUrl: f.logoUrl || null, hmacQrSecreto: f.hmacQrSecreto || null, ...modo.valor(),
    }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['admin', 'ticket'] }); },
    onError: (e) => setError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-slate-500">Datos del pie del boleto. Cada guardado publica una versión nueva (versionado por fecha).</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <form onSubmit={enviar} className="rounded border bg-white p-4 grid gap-3 text-sm">
        <label>Leyenda de pie<input value={f.leyendaPie} onChange={set('leyendaPie')} className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label>Teléfono de atención<input value={f.telefonoAtencion} onChange={set('telefonoAtencion')} className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label>Créditos del proveedor<input value={f.credencialesProveedor} onChange={set('credencialesProveedor')} className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label>URL del logo<input value={f.logoUrl} onChange={set('logoUrl')} className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label>Secreto HMAC del QR<input value={f.hmacQrSecreto} onChange={set('hmacQrSecreto')} className="mt-1 w-full rounded border px-2 py-1" /></label>
        {modo.nodo}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={m.isPending} className="rounded bg-slate-900 text-white px-4 py-1.5 disabled:opacity-50">
            {m.isPending ? 'Publicando…' : 'Publicar versión'}
          </button>
          <span className="text-slate-400 text-xs">
            {fecha(vigente.data?.effective_from) ? `vigente desde ${fecha(vigente.data?.effective_from)}` : 'sin configuración previa'}
          </span>
        </div>
      </form>
    </div>
  );
}
