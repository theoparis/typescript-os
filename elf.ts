// Static Linux ELF64 Loader and Userspace Execution for tsos
import { peek8 } from "./uart.ts";
import { alloc_page } from "./mmu.ts";

function get_elf_base(): bigint {
	return inline_asm<u64>(
		"adrp $0, user_elf_start\nadd $0, $0, :lo12:user_elf_start",
		"=r",
	);
}

function drop_to_user(sp: bigint, pc: bigint): void {
	inline_asm(
		"msr sp_el0, $0\nmsr elr_el1, $1\nmsr spsr_el1, $2\nisb\neret",
		"r,r,r",
		sp,
		pc,
		0n, // SPSR_EL1 = 0 (EL0t mode, all interrupts unmasked)
	);
}

/**
 * Loads the embedded static Linux ELF executable into user space memory,
 * constructs the initial Linux ABI stack, and transitions to EL0.
 */
function load_and_run_elf(): void {
	const elf = get_elf_base();

	// Verify ELF Magic: 0x7f, 'E', 'L', 'F'
	if (
		peek8(elf + 0n) !== (127 as u8) ||
		peek8(elf + 1n) !== (69 as u8) ||
		peek8(elf + 2n) !== (76 as u8) ||
		peek8(elf + 3n) !== (70 as u8)
	) {
		print("[ELF] Error: Invalid ELF magic bytes!\n");
		return;
	}

	const e_entry = peek64(elf + 24n);
	const e_phoff = peek64(elf + 32n);
	const e_phentsize = peek16(elf + 54n);
	const e_phnum = peek16(elf + 56n);

	print("[ELF] Loading static Linux ELF... Entry point: 0x");
	printHex64(e_entry);
	print("\n");

	// Process all PT_LOAD segments
	for (let i = 0n; i < (e_phnum as u64); i = i + 1n) {
		const ph = elf + e_phoff + i * (e_phentsize as u64);
		const p_type = peek32(ph + 0n);
		const p_flags = peek32(ph + 4n);
		const p_offset = peek64(ph + 8n);
		const p_vaddr = peek64(ph + 16n);
		const p_filesz = peek64(ph + 32n);
		const p_memsz = peek64(ph + 40n);

		if (p_type === 1) {
			// PT_LOAD segment
			const is_exec = (p_flags & 1) !== 0;
			const is_write = (p_flags & 2) !== 0;

			const page_size = 4096n;
			const vaddr_start = p_vaddr & ~0xfffn;
			const vaddr_end = (p_vaddr + p_memsz + 4095n) & ~0xfffn;

			for (let v = vaddr_start; v < vaddr_end; v = v + page_size) {
				const phys = alloc_page();
				// Copy segment file contents into the page and zero BSS
				for (let off = 0n; off < page_size; off = off + 1n) {
					const curr_va = v + off;
					if (curr_va >= p_vaddr && curr_va < p_vaddr + p_filesz) {
						const file_off = p_offset + (curr_va - p_vaddr);
						poke8(phys + off, peek8(elf + file_off));
					} else {
						poke8(phys + off, 0 as u8);
					}
				}
				map_user_page(v, phys, is_write, is_exec);
			}
		}
	}

	// Allocate and map User Stack (4KB at 0x20000000)
	const USER_STACK_TOP = 0x0000000020000000n;
	const stack_phys = alloc_page();
	map_user_page(USER_STACK_TOP - 4096n, stack_phys, true, false);

	// Initial user stack frame (AArch64 Linux ABI)
	const user_sp = USER_STACK_TOP - 128n;
	poke64(user_sp + 0n, 1n); // argc = 1
	const str_addr = user_sp + 64n;
	poke64(user_sp + 8n, str_addr); // argv[0] pointer
	poke64(user_sp + 16n, 0n); // argv[1] = NULL
	poke64(user_sp + 24n, 0n); // envp[0] = NULL
	poke64(user_sp + 32n, 6n); // AT_PAGESZ
	poke64(user_sp + 40n, 4096n); // 4096 bytes
	poke64(user_sp + 48n, 0n); // AT_NULL
	poke64(user_sp + 56n, 0n);

	// "init\0" string on stack
	poke8(str_addr + 0n, 105 as u8); // 'i'
	poke8(str_addr + 1n, 110 as u8); // 'n'
	poke8(str_addr + 2n, 105 as u8); // 'i'
	poke8(str_addr + 3n, 116 as u8); // 't'
	poke8(str_addr + 4n, 0 as u8);

	// Invalidate instruction caches so newly mapped code is visible to CPU fetch
	inline_asm("ic iallu\ndsb ish\nisb", "");

	print("[ELF] Dropping to EL0 userspace to run binary!\n");
	print(
		"--------------------------------------------------------------------\n",
	);

	drop_to_user(user_sp, e_entry);
}
