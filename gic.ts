// ARM Generic Interrupt Controller v3 (GICv3) and Generic Timer Driver

import { udiv64, peek32, poke32, poke8 } from "./uart.ts";

const GICD_BASE = 0x08000000n;
const GICR_RD_BASE = 0x080a0000n;
const GICR_SGI_BASE = 0x080b0000n;

/**
 * Initializes the GICv3 Distributor, CPU 0 Redistributor, and CPU Interface.
 */
function init_gicv3(): void {
	// 1. Enable FP/SIMD in CPACR_EL1
	inline_asm("msr cpacr_el1, $0", "r", 3n << 20n);
	inline_asm("isb", "");

	// 2. Enable Distributor Group 0 & Group 1 Non-Secure
	poke32(GICD_BASE + 0x0000n, 0x3);

	// 3. Wake up Redistributor (clear ProcessorSleep and wait for ChildrenAsleep == 0)
	let waker = peek32(GICR_RD_BASE + 0x0014n);
	waker = waker & ~2;
	poke32(GICR_RD_BASE + 0x0014n, waker);
	while ((peek32(GICR_RD_BASE + 0x0014n) & 4) !== 0) {}

	// 4. Mark all SGIs and PPIs as Group 1 Non-Secure
	poke32(GICR_SGI_BASE + 0x0080n, 0xffffffff);

	// 5. Configure Physical Timer interrupt (PPI INTID 30)
	// Set priority to 0x80
	poke8(GICR_SGI_BASE + 0x0400n + 30n, 0x80 as u8);
	// Enable INTID 30 in Redistributor
	poke32(GICR_SGI_BASE + 0x0100n, 1 << 30);

	// 6. CPU Interface system registers
	// ICC_SRE_EL1: Enable system registers
	inline_asm("msr icc_sre_el1, $0", "r", 7n);
	inline_asm("isb", "");

	// ICC_PMR_EL1: Unmask all priorities
	inline_asm("msr icc_pmr_el1, $0", "r", 0xffn);
	// ICC_BPR1_EL1: Set binary point to 0
	inline_asm("msr icc_bpr1_el1, $0", "r", 0n);
	// ICC_IGRPEN1_EL1: Enable Group 1 interrupts
	inline_asm("msr icc_igrpen1_el1, $0", "r", 1n);
	inline_asm("isb", "");
}

/**
 * Initializes the ARM Generic Physical Timer to tick at (freq / divisor) Hz.
 */
function init_timer(ticks_per_sec: u64): void {
	const freq = inline_asm<u64>("mrs $0, cntfrq_el0", "=r");
	const interval = udiv64(freq, ticks_per_sec);
	inline_asm("msr cntp_tval_el0, $0", "r", interval);
	inline_asm("msr cntp_ctl_el0, $0", "r", 1n); // Enable = 1, IMask = 0
}

/**
 * Acknowledges an interrupt by reading ICC_IAR1_EL1.
 */
function acknowledge_irq(): u64 {
	return inline_asm<u64>("mrs $0, icc_iar1_el1", "=r");
}

/**
 * Signals End of Interrupt by writing ICC_EOIR1_EL1.
 */
function end_of_interrupt(iar: u64): void {
	inline_asm("msr icc_eoir1_el1, $0", "r", iar);
}

/**
 * Unmasks IRQs in PSTATE (DAIF).
 */
function enable_irqs(): void {
	inline_asm("msr daifclr, #2", "");
}

/**
 * Masks IRQs in PSTATE (DAIF).
 */
function disable_irqs(): void {
	inline_asm("msr daifset, #2", "");
}
