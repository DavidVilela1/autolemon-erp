/**
 * @file Ambient type declarations for the web build (owning module: web).
 */
/// <reference types="vite/client" />
declare module 'jsbarcode' {
  /** Object-mode encoder used by components/Barcode.tsx. */
  const JsBarcode: (target: object, value: string, options?: Record<string, unknown>) => void;
  export default JsBarcode;
}
