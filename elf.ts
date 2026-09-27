// Linux ELF64 Loader (Static & Dynamic with PT_INTERP) for tsos
import {
    peek8,
    poke8,
    peek16,
    peek32,
    peek64,
    poke64,
    print,
    printHex64,
    lshr64,
    shl64,
} from "./uart.ts";
import {
    alloc_page,
    map_user_page,
    create_user_root_table,
    switch_user_root_table,
} from "./mmu.ts";
import { vfs_open, vfs_close, vfs_read, vfs_fstat } from "./vfs.ts";

const ELF_MAGIC = 0x464c457f as u32; // "\x7fELF"
const EM_AARCH64 = 183 as u16;
const ET_EXEC = 2 as u16;
const ET_DYN  = 3 as u16;

const PT_LOAD   = 1 as u32;
const PT_INTERP = 3 as u32;
const PT_PHDR   = 6 as u32;

const MAIN_EXEC_BASE = 0x0000000000400000n; // 4MB base for PIE
const INTERP_BASE    = 0x0000000010000000n; // 256MB base for dynamic linker
const USER_STACK_TOP = 0x0000000020000000n; // 512MB top of user stack

function drop_to_user(sp: bigint, pc: bigint): void {
    inline_asm(
        "msr sp_el0, $0\nmsr elr_el1, $1\nmsr spsr_el1, $2\nmov x0, #0\nmov x1, #0\nmov x2, #0\nmov x3, #0\nisb\neret",
        "r,r,r",
        sp,
        pc,
        0n, // SPSR_EL1 = 0 (EL0t mode, all interrupts unmasked)
    );
}

function copy_str_to_user(dest_addr: bigint, src_str: string): u64 {
    const src = <Ref<u8>>(<Opaque>src_str);
    let i: u64 = 0n;
    while (true) {
        const ch = Deref(src[i]);
        poke8(dest_addr + i, ch);
        if (ch === (0 as u8)) break;
        i = i + 1n;
    }
    return i;
}

/**
 * Loads and executes a Linux ELF executable (static or dynamically-linked).
 */
export function load_and_run_elf_file(
    path: string,
    argv0: string,
    argv1: string,
    argv2: string,
): boolean {
    print("[ELF] Loading executable: ");
    print(path);
    print("\n");

    const fd = vfs_open(path, 0 as u32, 0 as u32);
    if (fd < 0) {
        print("[ELF] Error: Failed to open executable!\n");
        return false;
    }

    const stat_page = alloc_page();
    vfs_fstat(fd, stat_page);
    const file_size = peek64(stat_page + 48n);

    // Allocate contiguous buffer to hold the executable
    const num_pages = (file_size + 4095n) >> 12n;
    const exec_buf = alloc_page();
    for (let i = 1n; i < num_pages; i = i + 1n) {
        alloc_page();
    }

    const bytes_read = vfs_read(fd, exec_buf, file_size);
    vfs_close(fd);

    if (bytes_read !== file_size) {
        print("[ELF] Error: Truncated read of executable!\n");
        return false;
    }

    // Validate ELF header
    const magic = peek32(exec_buf + 0n);
    if (magic !== ELF_MAGIC) {
        print("[ELF] Error: Invalid ELF magic bytes!\n");
        return false;
    }

    const e_type = peek16(exec_buf + 16n) as u16;
    const e_machine = peek16(exec_buf + 18n) as u16;

    if (e_machine !== EM_AARCH64) {
        print("[ELF] Error: Not an AArch64 ELF binary!\n");
        return false;
    }

    const e_entry = peek64(exec_buf + 24n);
    const e_phoff = peek64(exec_buf + 32n);
    const e_phentsize = peek16(exec_buf + 54n) as u64;
    const e_phnum = peek16(exec_buf + 56n) as u64;

    const main_base = (e_type === ET_DYN) ? MAIN_EXEC_BASE : 0n;
    const main_entry = main_base + e_entry;

    print("[ELF] Main binary type: ");
    printHex64(e_type as u64);
    print(", Entry point: 0x");
    printHex64(main_entry);
    print(", Program headers: ");
    printHex64(e_phnum);
    print("\n");

    // Scan program headers for PT_INTERP and PT_PHDR
    let interp_path_off: u64 = 0n;
    let interp_path_len: u64 = 0n;
    let at_phdr = main_base + e_phoff;

    for (let i = 0n; i < e_phnum; i = i + 1n) {
        const ph = exec_buf + e_phoff + i * e_phentsize;
        const p_type = peek32(ph + 0n);
        if (p_type === PT_INTERP) {
            interp_path_off = peek64(ph + 8n);
            interp_path_len = peek64(ph + 32n);
        } else if (p_type === PT_PHDR) {
            at_phdr = main_base + peek64(ph + 16n);
        }
    }

    // Load PT_LOAD segments for main executable
    for (let i = 0n; i < e_phnum; i = i + 1n) {
        const ph = exec_buf + e_phoff + i * e_phentsize;
        const p_type = peek32(ph + 0n);
        if (p_type === PT_LOAD) {
            const p_flags = peek32(ph + 4n);
            const p_offset = peek64(ph + 8n);
            const p_vaddr = peek64(ph + 16n);
            const p_filesz = peek64(ph + 32n);
            const p_memsz = peek64(ph + 40n);

            const is_write = (p_flags & (2 as u32)) !== (0 as u32);
            const is_exec = (p_flags & (1 as u32)) !== (0 as u32);

            const va_start = (main_base + p_vaddr) & ~0xfffn;
            const va_end = (main_base + p_vaddr + p_memsz + 4095n) & ~0xfffn;

            for (let v = va_start; v < va_end; v = v + 4096n) {
                const phys = alloc_page();
                for (let off = 0n; off < 4096n; off = off + 1n) {
                    const curr_va = v + off;
                    if (curr_va >= main_base + p_vaddr && curr_va < main_base + p_vaddr + p_filesz) {
                        const file_off = p_offset + (curr_va - (main_base + p_vaddr));
                        poke8(phys + off, peek8(exec_buf + file_off));
                    } else {
                        poke8(phys + off, 0 as u8);
                    }
                }
                // Map page (writable if requested, or if executable)
                map_user_page(v, phys, is_write, is_exec);
            }
        }
    }

    let has_interp = false;
    let interp_base = 0n;
    let interp_entry = 0n;

    // Load interpreter if requested by PT_INTERP
    if (interp_path_len > 0n) {
        has_interp = true;
        interp_base = INTERP_BASE;

        // Extract interpreter path string
        const interp_path_buf = alloc_page();
        for (let i = 0n; i < interp_path_len; i = i + 1n) {
            poke8(interp_path_buf + i, peek8(exec_buf + interp_path_off + i));
        }
        poke8(interp_path_buf + interp_path_len, 0 as u8);

        print("[ELF] Binary requires dynamic linker: \"");
        for (let i = 0n; i < interp_path_len; i = i + 1n) {
            const c = peek8(interp_path_buf + i);
            if (c === (0 as u8)) break;
            putchar(c);
        }
        print("\"\n");

        // Convert path bytes to string for vfs_open
        // In tsos, string is a pointer to null-terminated UTF-8 bytes!
        const interp_path_str = <string>(<Opaque>interp_path_buf);
        const ifd = vfs_open(interp_path_str, 0 as u32, 0 as u32);
        if (ifd < 0) {
            print("[ELF] Error: Failed to open dynamic linker from rootfs!\n");
            return false;
        }

        vfs_fstat(ifd, stat_page);
        const interp_size = peek64(stat_page + 48n);

        const interp_pages = (interp_size + 4095n) >> 12n;
        const interp_buf = alloc_page();
        for (let i = 1n; i < interp_pages; i = i + 1n) {
            alloc_page();
        }

        vfs_read(ifd, interp_buf, interp_size);
        vfs_close(ifd);

        // Validate interpreter ELF
        if (peek32(interp_buf + 0n) !== ELF_MAGIC) {
            print("[ELF] Error: Invalid dynamic linker ELF magic!\n");
            return false;
        }

        interp_entry = interp_base + peek64(interp_buf + 24n);
        const interp_phoff = peek64(interp_buf + 32n);
        const interp_phentsize = peek16(interp_buf + 54n) as u64;
        const interp_phnum = peek16(interp_buf + 56n) as u64;

        print("[ELF] Loaded dynamic linker, entry point: 0x");
        printHex64(interp_entry);
        print("\n");

        // Load interpreter PT_LOAD segments
        for (let i = 0n; i < interp_phnum; i = i + 1n) {
            const ph = interp_buf + interp_phoff + i * interp_phentsize;
            const p_type = peek32(ph + 0n);
            if (p_type === PT_LOAD) {
                const p_flags = peek32(ph + 4n);
                const p_offset = peek64(ph + 8n);
                const p_vaddr = peek64(ph + 16n);
                const p_filesz = peek64(ph + 32n);
                const p_memsz = peek64(ph + 40n);

                const is_write = (p_flags & (2 as u32)) !== (0 as u32);
                const is_exec = (p_flags & (1 as u32)) !== (0 as u32);

                const va_start = (interp_base + p_vaddr) & ~0xfffn;
                const va_end = (interp_base + p_vaddr + p_memsz + 4095n) & ~0xfffn;

                for (let v = va_start; v < va_end; v = v + 4096n) {
                    const phys = alloc_page();
                    for (let off = 0n; off < 4096n; off = off + 1n) {
                        const curr_va = v + off;
                        if (curr_va >= interp_base + p_vaddr && curr_va < interp_base + p_vaddr + p_filesz) {
                            const file_off = p_offset + (curr_va - (interp_base + p_vaddr));
                            poke8(phys + off, peek8(interp_buf + file_off));
                        } else {
                            poke8(phys + off, 0 as u8);
                        }
                    }
                    map_user_page(v, phys, is_write, is_exec);
                }
            }
        }
    }

    // Allocate and map User Stack (64KB at USER_STACK_TOP)
    for (let p = USER_STACK_TOP - 65536n; p < USER_STACK_TOP; p = p + 4096n) {
        map_user_page(p, alloc_page(), true, false);
    }

    // Set up strings in user stack top with ample spacing (256-512 bytes each)
    const str_env0  = USER_STACK_TOP - 3584n;
    const str_env1  = USER_STACK_TOP - 3328n;
    const str_argv0 = USER_STACK_TOP - 2560n;
    const str_argv1 = USER_STACK_TOP - 2048n;
    const str_argv2 = USER_STACK_TOP - 1536n;
    const str_execfn = USER_STACK_TOP - 1024n;
    const random_bytes = USER_STACK_TOP - 512n;

    copy_str_to_user(str_env0, "TERM=linux");
    copy_str_to_user(str_env1, "PATH=/bin:/usr/bin");
    copy_str_to_user(str_argv0, argv0);
    const p1 = <Ref<u8>>(<Opaque>argv1);
    const has_arg1 = Deref(p1[0n]) !== (0 as u8);
    if (has_arg1) {
        copy_str_to_user(str_argv1, argv1);
    }
    const p2 = <Ref<u8>>(<Opaque>argv2);
    const has_arg2 = Deref(p2[0n]) !== (0 as u8);
    if (has_arg2) {
        copy_str_to_user(str_argv2, argv2);
    }
    copy_str_to_user(str_execfn, path);

    // 16 bytes of random values
    poke64(random_bytes + 0n, 0x0123456789abcdefn);
    poke64(random_bytes + 8n, 0x7edcba9876543210n);

    // Stack pointer layout (16-byte aligned at USER_STACK_TOP - 4096n)
    const user_sp = USER_STACK_TOP - 4096n;
    let argc = 1n;
    if (has_arg1) argc = 2n;
    if (has_arg2) argc = 3n;

    poke64(user_sp + 0n, argc);
    poke64(user_sp + 8n, str_argv0);
    let cur_off = 16n;
    if (has_arg1) {
        poke64(user_sp + cur_off, str_argv1);
        cur_off = cur_off + 8n;
    }
    if (has_arg2) {
        poke64(user_sp + cur_off, str_argv2);
        cur_off = cur_off + 8n;
    }
    poke64(user_sp + cur_off, 0n); // argv[argc] = NULL
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, str_env0); // TERM=linux
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, str_env1); // PATH=/bin:/usr/bin
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, 0n); // envp NULL
    cur_off = cur_off + 8n;

    const auxv_base = user_sp + cur_off;

    poke64(auxv_base + 0n, 3n); poke64(auxv_base + 8n, at_phdr);
    poke64(auxv_base + 16n, 4n); poke64(auxv_base + 24n, e_phentsize);
    poke64(auxv_base + 32n, 5n); poke64(auxv_base + 40n, e_phnum);
    poke64(auxv_base + 48n, 6n); poke64(auxv_base + 56n, 4096n);
    poke64(auxv_base + 64n, 7n); poke64(auxv_base + 72n, has_interp ? interp_base : 0n);
    poke64(auxv_base + 80n, 8n); poke64(auxv_base + 88n, 0n);
    poke64(auxv_base + 96n, 9n); poke64(auxv_base + 104n, main_entry);
    poke64(auxv_base + 112n, 11n); poke64(auxv_base + 120n, 0n);
    poke64(auxv_base + 128n, 12n); poke64(auxv_base + 136n, 0n);
    poke64(auxv_base + 144n, 13n); poke64(auxv_base + 152n, 0n);
    poke64(auxv_base + 160n, 14n); poke64(auxv_base + 168n, 0n);
    poke64(auxv_base + 176n, 17n); poke64(auxv_base + 184n, 100n);
    poke64(auxv_base + 192n, 23n); poke64(auxv_base + 200n, 0n);
    poke64(auxv_base + 208n, 25n); poke64(auxv_base + 216n, random_bytes);
    poke64(auxv_base + 224n, 31n); poke64(auxv_base + 232n, str_execfn);
    poke64(auxv_base + 240n, 0n); poke64(auxv_base + 248n, 0n);
    // Invalidate instruction caches
    inline_asm("ic iallu\ndsb ish\nisb", "");

    const entry_pc = has_interp ? interp_entry : main_entry;

    print("[ELF] Dropping to EL0 userspace to run binary! Entry: 0x");
    printHex64(entry_pc);
    print("\n--------------------------------------------------------------------\n");

    drop_to_user(user_sp, entry_pc);
    return true;
}

/**
 * Replaces the current process image with a new ELF executable (execve).
 */
export function execve_load(
    path: string,
    argv_user_ptr: bigint,
    frame_ptr: bigint,
): boolean {
    const fd = vfs_open(path, 0 as u32, 0 as u32);
    if (fd < 0) {
        return false;
    }

    // 1. Read arguments from the OLD user address space before switching
    const arg_scratch = alloc_page();
    const arg_offsets = alloc_page();
    let argc: u64 = 0n;
    let cur_scratch_off: u64 = 0n;

    if (argv_user_ptr !== 0n) {
        while (argc < 16n) {
            const u_ptr = peek64(argv_user_ptr + argc * 8n);
            if (u_ptr === 0n) break;
            poke64(arg_offsets + argc * 8n, cur_scratch_off);
            let s: u64 = 0n;
            while (true) {
                const c = peek8(u_ptr + s);
                poke8(arg_scratch + cur_scratch_off + s, c);
                if (c === (0 as u8)) break;
                s = s + 1n;
            }
            cur_scratch_off = cur_scratch_off + s + 1n;
            argc = argc + 1n;
        }
    }

    if (argc === 0n) {
        poke64(arg_offsets + 0n, cur_scratch_off);
        let s = copy_str_to_user(arg_scratch + cur_scratch_off, path);
        cur_scratch_off = cur_scratch_off + s + 1n;
        argc = 1n;
    }

    // 2. Read executable into temporary buffer
    const stat_page = alloc_page();
    vfs_fstat(fd, stat_page);
    const file_size = peek64(stat_page + 48n);

    const num_pages = (file_size + 4095n) >> 12n;
    const exec_buf = alloc_page();
    for (let i = 1n; i < num_pages; i = i + 1n) {
        alloc_page();
    }

    vfs_read(fd, exec_buf, file_size);
    vfs_close(fd);

    if (peek32(exec_buf + 0n) !== ELF_MAGIC) {
        return false;
    }

    // 3. Create fresh address space and switch TTBR0
    const new_root = create_user_root_table();
    switch_user_root_table(new_root);

    const e_type = peek16(exec_buf + 16n) as u16;
    const e_entry = peek64(exec_buf + 24n);
    const e_phoff = peek64(exec_buf + 32n);
    const e_phentsize = peek16(exec_buf + 54n) as u64;
    const e_phnum = peek16(exec_buf + 56n) as u64;

    const main_base = (e_type === ET_DYN) ? MAIN_EXEC_BASE : 0n;
    const main_entry = main_base + e_entry;

    let interp_path_off: u64 = 0n;
    let interp_path_len: u64 = 0n;
    let at_phdr = main_base + e_phoff;

    for (let i = 0n; i < e_phnum; i = i + 1n) {
        const ph = exec_buf + e_phoff + i * e_phentsize;
        const p_type = peek32(ph + 0n);
        if (p_type === PT_INTERP) {
            interp_path_off = peek64(ph + 8n);
            interp_path_len = peek64(ph + 32n);
        } else if (p_type === PT_PHDR) {
            at_phdr = main_base + peek64(ph + 16n);
        }
    }

    // Map main executable segments
    for (let i = 0n; i < e_phnum; i = i + 1n) {
        const ph = exec_buf + e_phoff + i * e_phentsize;
        const p_type = peek32(ph + 0n);
        if (p_type === PT_LOAD) {
            const p_flags = peek32(ph + 4n);
            const p_offset = peek64(ph + 8n);
            const p_vaddr = peek64(ph + 16n);
            const p_filesz = peek64(ph + 32n);
            const p_memsz = peek64(ph + 40n);

            const is_write = (p_flags & (2 as u32)) !== (0 as u32);
            const is_exec = (p_flags & (1 as u32)) !== (0 as u32);

            const va_start = (main_base + p_vaddr) & ~0xfffn;
            const va_end = (main_base + p_vaddr + p_memsz + 4095n) & ~0xfffn;

            for (let v = va_start; v < va_end; v = v + 4096n) {
                const phys = alloc_page();
                for (let off = 0n; off < 4096n; off = off + 1n) {
                    const curr_va = v + off;
                    if (curr_va >= main_base + p_vaddr && curr_va < main_base + p_vaddr + p_filesz) {
                        const file_off = p_offset + (curr_va - (main_base + p_vaddr));
                        poke8(phys + off, peek8(exec_buf + file_off));
                    } else {
                        poke8(phys + off, 0 as u8);
                    }
                }
                map_user_page(v, phys, is_write, is_exec);
            }
        }
    }

    let has_interp = false;
    let interp_base = 0n;
    let interp_entry = 0n;

    if (interp_path_len > 0n) {
        has_interp = true;
        interp_base = INTERP_BASE;

        const interp_path_buf = alloc_page();
        for (let i = 0n; i < interp_path_len; i = i + 1n) {
            poke8(interp_path_buf + i, peek8(exec_buf + interp_path_off + i));
        }
        poke8(interp_path_buf + interp_path_len, 0 as u8);

        const interp_path_str = <string>(<Opaque>interp_path_buf);
        const ifd = vfs_open(interp_path_str, 0 as u32, 0 as u32);
        if (ifd >= 0) {
            vfs_fstat(ifd, stat_page);
            const interp_size = peek64(stat_page + 48n);
            const interp_pages = (interp_size + 4095n) >> 12n;
            const interp_buf = alloc_page();
            for (let i = 1n; i < interp_pages; i = i + 1n) alloc_page();

            vfs_read(ifd, interp_buf, interp_size);
            vfs_close(ifd);

            interp_entry = interp_base + peek64(interp_buf + 24n);
            const interp_phoff = peek64(interp_buf + 32n);
            const interp_phentsize = peek16(interp_buf + 54n) as u64;
            const interp_phnum = peek16(interp_buf + 56n) as u64;

            for (let i = 0n; i < interp_phnum; i = i + 1n) {
                const ph = interp_buf + interp_phoff + i * interp_phentsize;
                if (peek32(ph + 0n) === PT_LOAD) {
                    const p_flags = peek32(ph + 4n);
                    const p_offset = peek64(ph + 8n);
                    const p_vaddr = peek64(ph + 16n);
                    const p_filesz = peek64(ph + 32n);
                    const p_memsz = peek64(ph + 40n);

                    const is_write = (p_flags & (2 as u32)) !== (0 as u32);
                    const is_exec = (p_flags & (1 as u32)) !== (0 as u32);

                    const va_start = (interp_base + p_vaddr) & ~0xfffn;
                    const va_end = (interp_base + p_vaddr + p_memsz + 4095n) & ~0xfffn;

                    for (let v = va_start; v < va_end; v = v + 4096n) {
                        const phys = alloc_page();
                        for (let off = 0n; off < 4096n; off = off + 1n) {
                            const curr_va = v + off;
                            if (curr_va >= interp_base + p_vaddr && curr_va < interp_base + p_vaddr + p_filesz) {
                                const file_off = p_offset + (curr_va - (interp_base + p_vaddr));
                                poke8(phys + off, peek8(interp_buf + file_off));
                            } else {
                                poke8(phys + off, 0 as u8);
                            }
                        }
                        map_user_page(v, phys, is_write, is_exec);
                    }
                }
            }
        }
    }

    // 4. Map User Stack (64KB at USER_STACK_TOP)
    for (let p = USER_STACK_TOP - 65536n; p < USER_STACK_TOP; p = p + 4096n) {
        map_user_page(p, alloc_page(), true, false);
    }

    // Copy argument strings from arg_scratch to user stack
    let cur_user_str = USER_STACK_TOP - 2048n;
    const user_argv_ptrs = alloc_page();
    for (let i = 0n; i < argc; i = i + 1n) {
        const off = peek64(arg_offsets + i * 8n);
        poke64(user_argv_ptrs + i * 8n, cur_user_str);
        let s: u64 = 0n;
        while (true) {
            const c = peek8(arg_scratch + off + s);
            poke8(cur_user_str + s, c);
            if (c === (0 as u8)) break;
            s = s + 1n;
        }
        cur_user_str = cur_user_str - 256n;
    }
    copy_str_to_user(USER_STACK_TOP - 3584n, "TERM=linux");
    copy_str_to_user(USER_STACK_TOP - 3328n, "PATH=/bin:/usr/bin");
    copy_str_to_user(USER_STACK_TOP - 1024n, path);
    poke64(USER_STACK_TOP - 512n, 0x0123456789abcdefn);
    poke64(USER_STACK_TOP - 504n, 0x7edcba9876543210n);

    const user_sp = USER_STACK_TOP - 4096n;
    poke64(user_sp + 0n, argc);
    for (let i = 0n; i < argc; i = i + 1n) {
        poke64(user_sp + 8n + i * 8n, peek64(user_argv_ptrs + i * 8n));
    }
    let cur_off = 8n + argc * 8n;
    poke64(user_sp + cur_off, 0n); // argv NULL
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, USER_STACK_TOP - 3584n); // TERM=linux
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, USER_STACK_TOP - 3328n); // PATH=/bin:/usr/bin
    cur_off = cur_off + 8n;
    poke64(user_sp + cur_off, 0n); // envp NULL
    cur_off = cur_off + 8n;

    const auxv_base = user_sp + cur_off;
    poke64(auxv_base + 0n, 3n); poke64(auxv_base + 8n, at_phdr);
    poke64(auxv_base + 16n, 4n); poke64(auxv_base + 24n, e_phentsize);
    poke64(auxv_base + 32n, 5n); poke64(auxv_base + 40n, e_phnum);
    poke64(auxv_base + 48n, 6n); poke64(auxv_base + 56n, 4096n);
    poke64(auxv_base + 64n, 7n); poke64(auxv_base + 72n, has_interp ? interp_base : 0n);
    poke64(auxv_base + 80n, 8n); poke64(auxv_base + 88n, 0n);
    poke64(auxv_base + 96n, 9n); poke64(auxv_base + 104n, main_entry);
    poke64(auxv_base + 112n, 11n); poke64(auxv_base + 120n, 0n);
    poke64(auxv_base + 128n, 12n); poke64(auxv_base + 136n, 0n);
    poke64(auxv_base + 144n, 13n); poke64(auxv_base + 152n, 0n);
    poke64(auxv_base + 160n, 14n); poke64(auxv_base + 168n, 0n);
    poke64(auxv_base + 176n, 17n); poke64(auxv_base + 184n, 100n);
    poke64(auxv_base + 192n, 23n); poke64(auxv_base + 200n, 0n);
    poke64(auxv_base + 208n, 25n); poke64(auxv_base + 216n, USER_STACK_TOP - 512n);
    poke64(auxv_base + 224n, 31n); poke64(auxv_base + 232n, USER_STACK_TOP - 1024n);
    poke64(auxv_base + 240n, 0n); poke64(auxv_base + 248n, 0n);

    inline_asm("ic iallu\ndsb ish\nisb", "");

    const entry_pc = has_interp ? interp_entry : main_entry;
    poke64(frame_ptr + 248n, entry_pc); // frame.elr = entry_pc
    poke64(frame_ptr + 256n, 0n);       // frame.spsr = 0n (EL0t mode)
    inline_asm("msr sp_el0, $0", "r", user_sp);
    for (let i = 0n; i <= 30n; i = i + 1n) {
        poke64(frame_ptr + i * 8n, 0n);
    }

    return true;
}
