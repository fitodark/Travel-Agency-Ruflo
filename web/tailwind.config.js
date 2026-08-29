/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Identidad Donaji — teal de viaje, cálido y distinto del slate genérico.
        brand: {
          50: '#eefaf8',
          100: '#d4f2ec',
          200: '#ace4da',
          300: '#78cec1',
          400: '#45b0a3',
          500: '#279488',
          600: '#1b766e',
          700: '#195e59',
          800: '#184b48',
          900: '#173f3d',
          950: '#082726',
        },
        // Acento cálido para lo temporal (contraseñas, códigos, "programado").
        arena: {
          50: '#fbf6ee',
          100: '#f4e8d3',
          200: '#e8cfa5',
          300: '#dcb176',
          400: '#d29653',
          500: '#c67f3e',
          600: '#b06633',
          700: '#924e2d',
          800: '#773f2b',
          900: '#633525',
        },
        // Superficies (off-white cálido, no el slate-100 plano).
        lienzo: '#f6f5f2',
        tinta: '#1c2523',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.875rem',
      },
      boxShadow: {
        tarjeta: '0 1px 2px rgba(23, 63, 61, 0.04), 0 4px 16px -6px rgba(23, 63, 61, 0.10)',
        panel: '0 1px 3px rgba(23, 63, 61, 0.06), 0 12px 32px -12px rgba(23, 63, 61, 0.16)',
      },
    },
  },
  plugins: [],
};
