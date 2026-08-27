/**
 * Abstracción de transporte de impresión (delta D-4).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1
 *
 * La capa de formato de ticket NO sabe por dónde sale el papel. Cambiar de red a USB
 * es cambiar `config_impresora.transporte`, no tocar código.
 */

export type TransportKind = 'tcp' | 'usb' | 'capture';

export interface ProbeResult {
  /** ¿El transporte pudo abrirse y aceptar bytes? */
  ok: boolean;
  /** Milisegundos que tardó el intento; útil para detectar impresoras lentas o lejanas. */
  latencyMs: number;
  /** Detalle legible cuando `ok` es false. Nunca una excepción cruda. */
  detail?: string;
}

export interface EscPosTransport {
  readonly kind: TransportKind;
  /** Etiqueta legible para logs y para la cola de excepciones. */
  readonly label: string;

  open(): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;

  /**
   * Verifica que la impresora esté alcanzable SIN imprimir nada.
   *
   * Se usa antes de marcar un `print_job` como `imprimiendo`: preferimos detectar la
   * impresora apagada antes de mover el job de estado, no después.
   */
  probe(): Promise<ProbeResult>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: TransportKind,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
