import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorApi } from '../api/cliente';
import { useSesion } from '../auth/sesion';

const MOTIVOS: Record<string, string> = {
  credenciales: 'Correo o contraseña incorrectos.',
  usuario_no_vigente: 'El usuario no está vigente.',
  credencial_no_vigente: 'La credencial no está vigente.',
  sin_sucursal_activa: 'El usuario no tiene ninguna sucursal activa.',
  bloqueo_degradado: 'La terminal lleva demasiado sin sincronizar; pide autorización del gerente.',
  demasiados_intentos: 'Demasiados intentos fallidos. Espera unos minutos.',
};

export function Login() {
  const { iniciar } = useSesion();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const { sesionCompleta, sucursales } = await iniciar(email.trim(), password);
      if (sesionCompleta) {
        navigate('/', { replace: true });
      } else {
        sessionStorage.setItem('donaji.sucursales', JSON.stringify(sucursales));
        navigate('/elegir-sucursal', { replace: true });
      }
    } catch (err) {
      if (err instanceof ErrorApi) {
        setError(MOTIVOS[err.codigo] ?? err.message);
      } else {
        setError('No se pudo contactar la API local. ¿Está corriendo `npm run api`?');
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center">
      <form
        onSubmit={(e) => void enviar(e)}
        className="w-80 bg-white rounded-lg shadow p-6 space-y-4"
      >
        <h1 className="text-xl font-semibold">Donaji · Terminal</h1>

        <label className="block text-sm">
          Correo
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={enviando}
          className="w-full rounded bg-slate-900 text-white py-2 text-sm disabled:opacity-50"
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
