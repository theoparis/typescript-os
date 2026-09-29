// Kernel build configuration. Copy to config.ts (`cp config.example.ts config.ts`).
//
// page_size: MMU translation granule in bytes. One of:
//   4096  (4k)
//   16384 (16k, e.g. Apple Silicon)
//   65536 (64k)
export const page_size: bigint = 4096n;
