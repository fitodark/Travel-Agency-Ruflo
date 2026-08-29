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
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-lienzo via-lienzo to-brand-50 p-6">
      <form
        onSubmit={(e) => void enviar(e)}
        className="tarjeta w-[22rem] space-y-5 p-7 shadow-panel"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">D</span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Donaji</h1>
            <p className="text-xs text-slate-500">Terminal de venta</p>
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Correo</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="campo"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Contraseña</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="campo"
          />
        </label>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <button type="submit" disabled={enviando} className="btn-primario w-full">
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
