// Static Linux ELF64 Loader and Userspace Execution for tsos
import { print, printHex64 } from "./uart.ts";
import { alloc_page, map_user_page } from "./mmu.ts";

export type Elf64_Ehdr = {
  e_magic: u32; // 0x464c457f (0x7f, 'E', 'L', 'F')
  e_ident1: u32;
  e_ident2: u32;
  e_ident3: u32;
  e_type: u16;
  e_machine: u16;
  e_version: u32;
  e_entry: u64;
  e_phoff: u64;
  e_shoff: u64;
  e_flags: u32;
  e_ehsize: u16;
  e_phentsize: u16;
  e_phnum: u16;
  e_shentsize: u16;
  e_shnum: u16;
  e_shstrndx: u16;
};

export type Elf64_Phdr = {
  p_type: u32;
  p_flags: u32;
  p_offset: u64;
  p_vaddr: u64;
  p_paddr: u64;
  p_filesz: u64;
  p_memsz: u64;
  p_align: u64;
};

export type LinuxUserStack = {
  argc: u64;
  argv0: u64;
  argv_null: u64;
  envp_null: u64;
  at_pagesz_key: u64;
  at_pagesz_val: u64;
  at_null_key: u64;
  at_null_val: u64;
};

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
  const ehdr = <Ref<Elf64_Ehdr>>(<Opaque>elf);

  // Verify ELF Magic: 0x7f, 'E', 'L', 'F' (0x464c457f in little-endian)
  if (ehdr.e_magic !== (0x464c457f as u32)) {
    print("[ELF] Error: Invalid ELF magic bytes!\n");
    return;
  }

  const e_entry = ehdr.e_entry;
  const e_phoff = ehdr.e_phoff;
  const e_phnum = ehdr.e_phnum as u64;

  print("[ELF] Loading static Linux ELF... Entry point: 0x");
  printHex64(e_entry);
  print("\n");

  // Process all PT_LOAD segments
  const ph_base = <Ref<Elf64_Phdr>>(<Opaque>(elf + e_phoff));
  for (let i = 0n; i < e_phnum; i = i + 1n) {
    const ph = ph_base[i];
    const p_type = ph.p_type;
    const p_flags = ph.p_flags;
    const p_offset = ph.p_offset;
    const p_vaddr = ph.p_vaddr;
    const p_filesz = ph.p_filesz;
    const p_memsz = ph.p_memsz;

    if (p_type === (1 as u32)) {
      // PT_LOAD segment
      const is_exec = (p_flags & (1 as u32)) !== (0 as u32);
      const is_write = (p_flags & (2 as u32)) !== (0 as u32);

      const page_size = 4096n;
      const vaddr_start = p_vaddr & ~0xfffn;
      const vaddr_end = (p_vaddr + p_memsz + 4095n) & ~0xfffn;

      const elf_bytes = <Ref<u8>>(<Opaque>elf);

      for (let v = vaddr_start; v < vaddr_end; v = v + page_size) {
        const phys = alloc_page();
        const phys_bytes = <Ref<u8>>(<Opaque>phys);

        // Copy segment file contents into the page and zero BSS
        for (let off = 0n; off < page_size; off = off + 1n) {
          const curr_va = v + off;
          if (curr_va >= p_vaddr && curr_va < p_vaddr + p_filesz) {
            const file_off = p_offset + (curr_va - p_vaddr);
            Deref(phys_bytes[off]) = Deref(elf_bytes[file_off]);
          } else {
            Deref(phys_bytes[off]) = 0 as u8;
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
  const stack_frame = <Ref<LinuxUserStack>>(<Opaque>user_sp);
  const str_addr = user_sp + 64n;

  stack_frame.argc = 1n;
  stack_frame.argv0 = str_addr;
  stack_frame.argv_null = 0n;
  stack_frame.envp_null = 0n;
  stack_frame.at_pagesz_key = 6n;
  stack_frame.at_pagesz_val = 4096n;
  stack_frame.at_null_key = 0n;
  stack_frame.at_null_val = 0n;

  // "init\0" string on stack
  const str_bytes = <Ref<u8>>(<Opaque>str_addr);
  const init_str = <Ref<u8>>(<Opaque>"init");
  let s_idx = 0n;
  while (true) {
    const ch = Deref(init_str[s_idx]);
    Deref(str_bytes[s_idx]) = ch;
    if (ch === (0 as u8)) break;
    s_idx = s_idx + 1n;
  }

  // Invalidate instruction caches so newly mapped code is visible to CPU fetch
  inline_asm("ic iallu\ndsb ish\nisb", "");

  print("[ELF] Dropping to EL0 userspace to run binary!\n");
  print(
    "--------------------------------------------------------------------\n",
  );

  drop_to_user(user_sp, e_entry);
}
