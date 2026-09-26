// AArch64 Exception and Interrupt Dispatcher

declare function print(s: string): void;
declare function printHex64(v: u64): void;
declare function peek64(addr: bigint): u64;
declare function poke64(addr: bigint, val: u64): void;
declare function lshr64(v: u64, shift: u64): u64;

declare function handle_linux_syscall(frame_ptr: bigint): void;

/**
 * Installs the exception vector table by setting VBAR_EL1.
 */
function init_exceptions(): void {
    inline_asm("adrp x0, vector_table\nadd x0, x0, :lo12:vector_table\nmsr vbar_el1, x0\nisb", "~{x0}");
}

/**
 * Handles synchronous exceptions from Current EL with SPx (Kernel space).
 */
function handle_sync_exception(frame_ptr: bigint): void {
    const elr = peek64(frame_ptr + 248n);
    const esr = peek64(frame_ptr + 264n);
    const far = peek64(frame_ptr + 272n);
    const ec = lshr64(esr, 26n) & 0x3fn;

    print("\n[tsos] Kernel Synchronous Exception!\n");
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
        // SVC in kernel mode (e.g. self-test)
        print("       -> Handled kernel SVC, resuming.\n");
    } else {
        print("       -> Fatal kernel exception, halting.\n");
        while (true) {}
    }
}

/**
 * Handles synchronous exceptions from Lower EL using AArch64 (Userspace EL0).
 */
function handle_lower_sync_exception(frame_ptr: bigint): void {
    const elr = peek64(frame_ptr + 248n);
    const esr = peek64(frame_ptr + 264n);
    const ec = lshr64(esr, 26n) & 0x3fn;

    if (ec == 0x15n) {
        // AArch64 SVC (Linux System Call)
        handle_linux_syscall(frame_ptr);
    } else {
        const far = peek64(frame_ptr + 272n);
        print("\n[tsos] Userspace Exception (EC=0x");
        printHex64(ec);
        print(" at PC=0x");
        printHex64(elr);
        print(" FAR=0x");
        printHex64(far);
        print(")! Halting process.\n");
        while (true) {}
    }
}

/**
 * Handles IRQs from both Current EL and Lower EL.
 */
function handle_irq_exception(frame_ptr: bigint): bigint {
    // Acknowledge and EOI via system registers
    const iar = inline_asm<u64>("mrs $0, icc_iar1_el1", "=r");
    const intid = iar & 0x3ffn;

    if (intid == 30n) {
        // Physical timer PPI: reload timer for 50ms
        const freq = inline_asm<u64>("mrs $0, cntfrq_el0", "=r");
        inline_asm("msr cntp_tval_el0, $0", "r", freq / 20n);
    }

    inline_asm("msr icc_eoir1_el1, $0", "r", iar);
    return frame_ptr;
}
