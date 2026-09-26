// AArch64 MMU Setup and Paging (supporting 4KB and 16KB granules)
import { shl64 } from "./uart.ts";
import * as config from "./build/config.ts";

function isb(): void {
	inline_asm("isb", "");
}

export function dsb_ish(): void {
	inline_asm("dsb ish", "");
}

function tlbi_all(): void {
	inline_asm("tlbi vmalle1is", "");
}

function tlbi_va(va_page: u64): void {
	inline_asm("tlbi vaae1is, $0", "r", va_page);
}

function write_mair_el1(val: u64): void {
	inline_asm("msr mair_el1, $0", "r", val);
}

function write_tcr_el1(val: u64): void {
	inline_asm("msr tcr_el1, $0", "r", val);
}

function write_ttbr0_el1(val: u64): void {
	inline_asm("msr ttbr0_el1, $0", "r", val);
}

function read_sctlr_el1(): u64 {
	return inline_asm<u64>("mrs $0, sctlr_el1", "=r");
}

function write_sctlr_el1(val: u64): void {
	inline_asm("msr sctlr_el1, $0", "r", val);
}

function get_kernel_end(): bigint {
	return inline_asm<u64>(
		"adrp $0, _kernel_end\nadd $0, $0, :lo12:_kernel_end",
		"=r",
	);
}

// --- Page Allocator ---

let next_free_page: bigint = 0n;

function init_allocator(): void {
	next_free_page = get_kernel_end();
	const align_mask = 16383n;
	if ((next_free_page & align_mask) !== 0n) {
		next_free_page = (next_free_page + 16384n) & ~align_mask;
	}
}

function alloc_page(): bigint {
	const page = next_free_page;
	if (config.use_16k) {
		next_free_page = next_free_page + 16384n;
		for (let i = 0n; i < 2048n; i = i + 1n) {
			poke64(page + i * 8n, 0n);
		}
	} else {
		next_free_page = next_free_page + 4096n;
		for (let i = 0n; i < 512n; i = i + 1n) {
			poke64(page + i * 8n, 0n);
		}
	}
	return page;
}

// --- Descriptor Constants ---

const ATTR_DEVICE: u64 = 0n;
const ATTR_NORMAL: u64 = 1n;

const FLAG_PAGE: u64 = 3n;
const FLAG_TABLE: u64 = 3n;
const FLAG_AF: u64 = 1n << 10n;
const FLAG_SH_INNER: u64 = 3n << 8n;
const FLAG_UXN: u64 = shl64(1n, 54n);
const FLAG_PXN: u64 = shl64(1n, 53n);

let root_table: bigint = 0n;

/**
 * Maps a single virtual page to a physical frame for kernel usage.
 */
export function map_page(va: bigint, pa: bigint, is_device: boolean): void {
	if (config.use_16k) {
		const l2_idx = lshr64(va, 25n) & 0x7ffn;
		const l3_idx = lshr64(va, 14n) & 0x7ffn;

		let l2_entry = peek64(root_table + l2_idx * 8n);
		let l3_table: bigint = 0n;
		if ((l2_entry & 1n) === 0n) {
			l3_table = alloc_page();
			poke64(root_table + l2_idx * 8n, l3_table | FLAG_TABLE);
		} else {
			l3_table = l2_entry & ~0x3fffn;
		}

		let attrs: u64 = FLAG_PAGE | FLAG_AF;
		if (is_device) {
			attrs = attrs | shl64(ATTR_DEVICE, 2n) | FLAG_UXN | FLAG_PXN;
		} else {
			attrs = attrs | shl64(ATTR_NORMAL, 2n) | FLAG_SH_INNER;
		}
		poke64(l3_table + l3_idx * 8n, (pa & ~0x3fffn) | attrs);

		dsb_ish();
		isb();
		tlbi_va(lshr64(va, 14n));
		dsb_ish();
		isb();
	} else {
		const l1_idx = lshr64(va, 30n) & 0x1ffn;
		const l2_idx = lshr64(va, 21n) & 0x1ffn;
		const l3_idx = lshr64(va, 12n) & 0x1ffn;

		const l1_entry = peek64(root_table + l1_idx * 8n);
		let l2_table: bigint = 0n;
		if ((l1_entry & 1n) === 0n) {
			l2_table = alloc_page();
			poke64(root_table + l1_idx * 8n, l2_table | FLAG_TABLE);
		} else {
			l2_table = l1_entry & ~0xfffn;
		}

		const l2_entry = peek64(l2_table + l2_idx * 8n);
		let l3_table: bigint = 0n;
		if ((l2_entry & 1n) === 0n) {
			l3_table = alloc_page();
			poke64(l2_table + l2_idx * 8n, l3_table | FLAG_TABLE);
		} else {
			l3_table = l2_entry & ~0xfffn;
		}

		let attrs: u64 = FLAG_PAGE | FLAG_AF;
		if (is_device) {
			attrs = attrs | shl64(ATTR_DEVICE, 2n) | FLAG_UXN | FLAG_PXN;
		} else {
			attrs = attrs | shl64(ATTR_NORMAL, 2n) | FLAG_SH_INNER;
		}
		poke64(l3_table + l3_idx * 8n, (pa & ~0xfffn) | attrs);

		dsb_ish();
		isb();
		tlbi_va(lshr64(va, 12n));
		dsb_ish();
		isb();
	}
}

/**
 * Maps a single virtual page with user (EL0) access permissions.
 * AP[2:1]: 0b01 = EL1 RW, EL0 RW (if write)
 *          0b11 = EL1 RO, EL0 RO (if read-only)
 * UXN: 0 if executable, 1 if non-executable (stack/data)
 * PXN: 1 (kernel cannot execute user pages)
 */
function map_user_page(
	va: bigint,
	pa: bigint,
	is_write: boolean,
	is_exec: boolean,
): void {
	let ap: u64 = shl64(1n, 6n); // 0b01: EL1 RW, EL0 RW
	if (!is_write) {
		ap = shl64(3n, 6n); // 0b11: EL1 RO, EL0 RO
	}

	let attrs: u64 =
		FLAG_PAGE |
		FLAG_AF |
		FLAG_SH_INNER |
		shl64(ATTR_NORMAL, 2n) |
		ap |
		FLAG_PXN;
	if (!is_exec) {
		attrs = attrs | FLAG_UXN;
	}

	if (config.use_16k) {
		const l2_idx = lshr64(va, 25n) & 0x7ffn;
		const l3_idx = lshr64(va, 14n) & 0x7ffn;

		let l2_entry = peek64(root_table + l2_idx * 8n);
		let l3_table: bigint = 0n;
		if ((l2_entry & 1n) === 0n) {
			l3_table = alloc_page();
			poke64(root_table + l2_idx * 8n, l3_table | FLAG_TABLE);
		} else {
			l3_table = l2_entry & ~0x3fffn;
		}

		poke64(l3_table + l3_idx * 8n, (pa & ~0x3fffn) | attrs);

		dsb_ish();
		isb();
		tlbi_va(lshr64(va, 14n));
		dsb_ish();
		isb();
	} else {
		const l1_idx = lshr64(va, 30n) & 0x1ffn;
		const l2_idx = lshr64(va, 21n) & 0x1ffn;
		const l3_idx = lshr64(va, 12n) & 0x1ffn;

		const l1_entry = peek64(root_table + l1_idx * 8n);
		let l2_table: bigint = 0n;
		if ((l1_entry & 1n) === 0n) {
			l2_table = alloc_page();
			poke64(root_table + l1_idx * 8n, l2_table | FLAG_TABLE);
		} else {
			l2_table = l1_entry & ~0xfffn;
		}

		const l2_entry = peek64(l2_table + l2_idx * 8n);
		let l3_table: bigint = 0n;
		if ((l2_entry & 1n) === 0n) {
			l3_table = alloc_page();
			poke64(l2_table + l2_idx * 8n, l3_table | FLAG_TABLE);
		} else {
			l3_table = l2_entry & ~0xfffn;
		}

		poke64(l3_table + l3_idx * 8n, (pa & ~0xfffn) | attrs);

		dsb_ish();
		isb();
		tlbi_va(lshr64(va, 12n));
		dsb_ish();
		isb();
	}
}

/**
 * Initializes the MMU with identity mappings and prepares user space translation.
 */
function init_mmu(): void {
	init_allocator();
	root_table = alloc_page();

	if (config.use_16k) {
		// 16KB Granule: Root table is Level 2 (2048 entries of 32MB blocks)
		// Block 0 [0..32MB): Left for L3 tables (user space ELFs at 0x200000 = 2MB)
		// Blocks 1..31 [32MB..1GB): Device MMIO
		for (let i = 1n; i < 32n; i = i + 1n) {
			const pa = i * 0x02000000n;
			const entry =
				pa | FLAG_AF | FLAG_UXN | FLAG_PXN | shl64(ATTR_DEVICE, 2n) | 0x1n;
			poke64(root_table + i * 8n, entry);
		}
		// Blocks 32..63 [1GB..2GB): Normal RAM (Kernel space)
		for (let i = 32n; i < 64n; i = i + 1n) {
			const pa = i * 0x02000000n;
			const entry =
				pa | FLAG_AF | FLAG_SH_INNER | shl64(ATTR_NORMAL, 2n) | 0x1n;
			poke64(root_table + i * 8n, entry);
		}

		const tcr = (2n << 32n) | (1n << 23n) | (2n << 14n) | (3n << 12n) | 28n;
		write_tcr_el1(tcr);
	} else {
		// 4KB Granule: Root table is Level 1 (512 entries of 1GB blocks)
		// Entry 0 (0..1GB): Point to an L2 table so we can separate MMIO and Userspace!
		const l2_table_0 = alloc_page();
		poke64(root_table + 0n * 8n, l2_table_0 | FLAG_TABLE);

		// In l2_table_0 (each entry maps 2MB):
		// Map GIC (0x08000000 >> 21 = 64) as 2MB Device block
		poke64(
			l2_table_0 + 64n * 8n,
			0x08000000n |
				FLAG_UXN |
				FLAG_PXN |
				FLAG_AF |
				shl64(ATTR_DEVICE, 2n) |
				0x1n,
		);
		// Map UART (0x09000000 >> 21 = 72) as 2MB Device block
		poke64(
			l2_table_0 + 72n * 8n,
			0x09000000n |
				FLAG_UXN |
				FLAG_PXN |
				FLAG_AF |
				shl64(ATTR_DEVICE, 2n) |
				0x1n,
		);
		// Map VirtIO MMIO (0x0a000000 >> 21 = 80) as 2MB Device block
		poke64(
			l2_table_0 + 80n * 8n,
			0x0a000000n |
				FLAG_UXN |
				FLAG_PXN |
				FLAG_AF |
				shl64(ATTR_DEVICE, 2n) |
				0x1n,
		);

		// Entry 1 (1GB..2GB): 1GB Normal RAM block (Kernel code, data, stack, heap)
		poke64(
			root_table + 1n * 8n,
			0x40000000n | FLAG_AF | FLAG_SH_INNER | shl64(ATTR_NORMAL, 2n) | 0x1n,
		);

		const tcr = (2n << 32n) | (1n << 23n) | (0n << 14n) | (3n << 12n) | 25n;
		write_tcr_el1(tcr);
	}

	// MAIR_EL1: Attr0 = Device-nGnRnE (0x00), Attr1 = Normal Cacheable (0xFF)
	write_mair_el1(0x000000000000ff00n);

	// TTBR0_EL1 -> root table
	write_ttbr0_el1(root_table);

	// Synchronize and flush TLB
	dsb_ish();
	isb();
	tlbi_all();
	dsb_ish();
	isb();

	// Enable MMU (M=1), D-Cache (C=1), and I-Cache (I=1) in SCTLR_EL1
	let sctlr = read_sctlr_el1();
	sctlr = sctlr | 0x1n | (1n << 2n) | (1n << 12n);
	write_sctlr_el1(sctlr);
	isb();
}
