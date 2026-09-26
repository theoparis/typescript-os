// AArch64 Exception and Interrupt Handling

declare function print(s: string): void;
declare function printHex64(v: u64): void;
declare function peek64(addr: bigint): u64;
declare function poke64(addr: bigint, val: u64): void;
declare function lshr64(v: u64, shift: u64): u64;

/**
 * Installs the exception vector table by setting VBAR_EL1.
 */
function init_exceptions(): void {
    inline_asm("adrp x0, vector_table\nadd x0, x0, :lo12:vector_table\nmsr vbar_el1, x0\nisb", "~{x0}");
}

/**
 * Dispatches synchronous exceptions from current or lower EL.
 * TrapFrame layout at frame_ptr:
 *   [0..239]: x0..x29, x30
 *   [248]: ELR_EL1 (return address)
 *   [256]: SPSR_EL1 (saved processor state)
 *   [264]: ESR_EL1 (exception syndrome)
 *   [272]: FAR_EL1 (fault address)
 */
function handle_sync_exception(frame_ptr: bigint): void {
    const elr = peek64(frame_ptr + 248n);
    const spsr = peek64(frame_ptr + 256n);
    const esr = peek64(frame_ptr + 264n);
    const far = peek64(frame_ptr + 272n);

    // Extract Exception Class (EC) from ESR_EL1 bits [31:26]
    const ec = lshr64(esr, 26n) & 0x3fn;

    print("\n[tsos] Synchronous Exception Occurred!\n");
    print("       ESR_EL1: 0x");
    printHex64(esr);
    print(" (EC=0x");
    printHex64(ec);
    print(")\n       ELR_EL1: 0x");
    printHex64(elr);
    print("\n       FAR_EL1: 0x");
    printHex64(far);
    print("\n");

    if (ec == 0x15n) {
        // SVC in AArch64 state (System Call)
        // For SVC, ELR_EL1 already points to the instruction following SVC.
        const imm = esr & 0xffffn;
        print("       [SVC] System Call trapped! Immediate: 0x");
        printHex64(imm);
        print(" -> Handled successfully, resuming execution.\n");
    } else if (ec == 0x24n || ec == 0x25n) {
        // Data Abort (Page fault / memory access fault)
        print("       [DATA ABORT] Faulting access to address 0x");
        printHex64(far);
        print("! Skipping faulting instruction to recover.\n");
        // Advance ELR by 4 bytes to skip the faulting instruction
        poke64(frame_ptr + 248n, elr + 4n);
    } else if (ec == 0x20n || ec == 0x21n) {
        // Instruction Abort
        print("       [INSTRUCTION ABORT] Fault at instruction address 0x");
        printHex64(far);
        print("! Halting.\n");
        while (true) {}
    } else if (ec == 0x3cn) {
        // Software Breakpoint (BRK)
        print("       [BREAKPOINT] Breakpoint instruction hit. Resuming.\n");
        poke64(frame_ptr + 248n, elr + 4n);
    } else {
        print("       [FATAL] Unhandled exception class! System halted.\n");
        while (true) {}
    }
}

/**
 * Dispatches IRQ interrupts from current or lower EL.
 */
function handle_irq_exception(frame_ptr: bigint): void {
    print("[tsos] IRQ Interrupt received!\n");
}
