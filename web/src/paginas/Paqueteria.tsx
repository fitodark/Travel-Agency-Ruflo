/**
 * Paquetería (Fase G): registrar envíos, la bandeja del destino (por recibir /
 * por entregar) y la consulta por folio con sus acciones.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { enviosDestino, ESTADO_ENVIO, type Envio } from '../api/paqueteria';
import { FormEnvio } from '../componentes/paqueteria/FormEnvio';
import { DetalleEnvio } from '../componentes/paqueteria/DetalleEnvio';
import { mxn } from '../componentes/paqueteria/comun';
import { EncabezadoPagina, Tabla } from '../componentes/ui';
import { fecha } from '../lib/fechas';

type Pestana = 'registrar' | 'por_recibir' | 'por_entregar';

const PESTANAS: Array<[Pestana, string]> = [
  ['registrar', 'Registrar envío'],
  ['por_recibir', 'Por recibir'],
  ['por_entregar', 'Por entregar'],
];

export function Paqueteria() {
  const [pestana, setPestana] = useState<Pestana>('registrar');
  const [folio, setFolio] = useState('');
  const [abierto, setAbierto] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <EncabezadoPagina
        titulo="Paquetería"
        descripcion="Envíos en los mismos horarios que los boletos: un folio por envío, un ticket por bulto."
        acciones={
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (folio.trim()) setAbierto(folio.trim().toUpperCase()); }}
          >
            <input value={folio} onChange={(e) => setFolio(e.target.value)} placeholder="Folio del envío"
                   maxLength={10} className="campo w-40 rounded-sm font-mono uppercase" />
            <button className="btn-primario rounded-sm" type="submit">Buscar</button>
          </form>
        }
      />

      <div className="flex gap-1 border-b">
        {PESTANAS.map(([p, t]) => (
          <button
            key={p} onClick={() => setPestana(p)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              pestana === p ? 'border-brand-600 font-semibold text-brand-700' : 'border-transparent text-slate-500'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {pestana === 'registrar' && <FormEnvio onRegistrado={() => { /* el formulario muestra el resultado */ }} />}
      {pestana !== 'registrar' && <Bandeja estado={pestana} onAbrir={setAbierto} />}

      {abierto && <DetalleEnvio folio={abierto} onCerrar={() => setAbierto(null)} />}
    </div>
  );
}

function Bandeja({ estado, onAbrir }: { estado: 'por_recibir' | 'por_entregar'; onAbrir: (folio: string) => void }) {
  const q = useQuery({ queryKey: ['paqueteria', 'destino', estado], queryFn: () => enviosDestino(estado) });
  return (
    <Tabla<Envio>
      filas={q.data}
      claveFila={(e) => e.envioId}
      vacio={estado === 'por_recibir' ? 'No hay paquetes en camino a esta sucursal.' : 'No hay paquetes esperando a que los recojan.'}
      cols={[
        { clave: 'folio', th: 'Folio', td: (e) => (
          <button className="font-mono font-semibold text-brand-700 underline" onClick={() => onAbrir(e.folio)}>{e.folio}</button>
        ) },
        { clave: 'origen', th: 'Origen', td: (e) => `${e.origen} · ${fecha(e.fechaOperacion)}` },
        { clave: 'recibe', th: 'Recibe', td: (e) => `${e.destinatarioNombre} · ${e.destinatarioTelefono}` },
        { clave: 'contenido', th: 'Contenido', td: (e) => `${e.descripcion} (${e.bultos})` },
        { clave: 'estado', th: 'Estado', td: (e) => ESTADO_ENVIO[e.estado] },
        { clave: 'cobro', th: 'Por cobrar', className: 'text-right', td: (e) => (e.porCobrar > 0 ? mxn(e.porCobrar) : '—') },
      ]}
    />
  );
}
