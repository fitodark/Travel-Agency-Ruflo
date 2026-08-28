# Donaji · SPA de la terminal

React 18 + Vite + TanStack Query + Tailwind + React Router. **Solo habla con la
API local** (`npm run api` en la raíz del repo) — nunca con Supabase ni con la
impresora (blueprint §4.1).

## Correr en local

```bash
# 1. En la raíz del repo: la API
npm run api                      # http://127.0.0.1:3000

# 2. Aquí: la SPA
cd web
npm install
npm run dev                      # http://localhost:5173
```

Vite proxya `/api/*` → `http://127.0.0.1:3000`. Para apuntar a otra API:
`VITE_API_URL=http://otra:3000 npm run dev`.

Usuario de desarrollo (sembrado con `npm run seed:admin` en la raíz):
`admin@donaji.local` / `donaji-admin`.

## Pantallas

| Ruta | Qué |
|---|---|
| `/login` → `/elegir-sucursal` | Login offline + elección de sucursal (paso 2 si el usuario tiene varias) |
| `/sincronizacion` | Estado del motor de sync en vivo (polling cada 3 s), botón "Forzar ciclo", excepciones abiertas |
| `/clientes` | Alta y búsqueda de clientes (CRUD de F2) |

## Estructura

```
src/
  api/         cliente HTTP (fetch + token) y wrappers por dominio
  auth/        ProveedorSesion + useSesion (token en memoria + sessionStorage)
  componentes/ Shell (layout con navegación)
  paginas/     una por ruta
```
