// Kernel Main Entry Point for tsos (AArch64)

declare const CONFIG_USE_16K: boolean;
declare function print(s: string): void;
declare function printHex64(v: u64): void;
declare function poke64(addr: bigint, val: u64): void;
declare function peek64(addr: bigint): u64;

declare function init_exceptions(): void;
declare function init_mmu(): void;
declare function map_page(va: bigint, pa: bigint, is_device: boolean): void;

/**
 * Main kernel entry point called from boot.s.
 */
function kmain(): void {
    if (CONFIG_USE_16K) {
        print("[tsos] Booting kernel with 16KB page granule (Apple Silicon compatible)...\n");
    } else {
        print("[tsos] Booting kernel with 4KB page granule...\n");
    }

    // 1. Install AArch64 exception vector table
    print("[tsos] Installing exception vectors into VBAR_EL1...\n");
    init_exceptions();
    print("[tsos] Exception vector table active!\n");

    // 2. Initialize MMU and Paging
    print("[tsos] Initializing MMU & page tables...\n");
    init_mmu();
    print("[tsos] MMU enabled: virtual memory and L1 caches active!\n");

    // 3. Dynamic virtual memory mapping test
    const test_va = 0x80000000n; // 2GB virtual address
    const test_pa = 0x40500000n; // Physical RAM frame
    map_page(test_va, test_pa, false);

    const test_val: u64 = 0x54534f5341534d31n; // 'TSOSASM1'
    poke64(test_va, test_val);
    const read_back = peek64(test_pa);

    print("[tsos] Dynamic paging test: VA 0x");
    printHex64(test_va);
    print(" -> PA 0x");
    printHex64(test_pa);
    print("\n");

    if (read_back == test_val) {
        print("[tsos] Dynamic paging test: PASSED!\n");
    } else {
        print("[tsos] Dynamic paging test: FAILED!\n");
    }

    // 4. Exception Handling Test: Trigger software interrupt (SVC #0)
    print("[tsos] Testing exception handler: issuing SVC #0 system call...\n");
    inline_asm("svc #0", "");
    print("[tsos] Resumed from SVC exception handler successfully!\n");

    print("[tsos] Kernel initialized successfully. Entering halt loop.\n");
    while (true) {
        inline_asm("wfi", "");
    }
}
