// Linux AArch64 Syscall Dispatcher

import {
	peek8,
	peek64,
	poke8,
	poke64,
	print,
	printHex64,
	putchar,
} from "./uart.ts";

let user_process_exited: boolean = false;
let user_process_exit_code: u64 = 0n;

let current_brk: bigint = 0x0000000021000000n;

/**
 * Handles an AArch64 Linux system call from userspace (EL0).
 * Registers: x8 = syscall_nr, x0..x5 = args, return in x0.
 */
function handle_linux_syscall(frame_ptr: bigint): void {
	const syscall_nr = peek64(frame_ptr + 64n); // x8
	const arg0 = peek64(frame_ptr + 0n); // x0
	const arg1 = peek64(frame_ptr + 8n); // x1
	const arg2 = peek64(frame_ptr + 16n); // x2

	if (syscall_nr === 64n) {
		// sys_write(int fd, const char *buf, size_t count)
		const fd = arg0;
		const buf = arg1;
		const count = arg2;

		if (fd === 1n || fd === 2n) {
			for (let i = 0n; i < count; i = i + 1n) {
				const ch = peek8(buf + i);
				putchar(ch);
			}
		}
		// Return number of bytes written in x0
		poke64(frame_ptr + 0n, count);
	} else if (syscall_nr === 93n || syscall_nr === 94n) {
		// sys_exit(int error_code) / sys_exit_group(int error_code)
		user_process_exit_code = arg0;
		user_process_exited = true;

		print("[tsos] Linux process exited via syscall 0x");
		printHex64(syscall_nr);
		print(" with exit code: 0x");
		printHex64(user_process_exit_code);
		print("\n");

		// Divert return address to kernel_exit_landing pad
		const exit_land = inline_asm<u64>(
			"adrp $0, kernel_exit_landing\nadd $0, $0, :lo12:kernel_exit_landing",
			"=r",
		);
		poke64(frame_ptr + 248n, exit_land);
		// Set SPSR_EL1 to EL1h (0x05) to switch back to kernel mode on eret
		poke64(frame_ptr + 256n, 0x05n);
	} else if (syscall_nr === 214n) {
		// sys_brk(unsigned long brk)
		const req_brk = arg0;
		if (req_brk !== 0n && req_brk >= current_brk) {
			current_brk = req_brk;
		}
		poke64(frame_ptr + 0n, current_brk as u64);
	} else if (syscall_nr === 160n) {
		// sys_uname(struct utsname *buf)
		const buf = arg0;
		// utsname format: char sysname[65], nodename[65], release[65], version[65], machine[65]
		// "Linux"
		poke8(buf + 0n, 76 as u8);
		poke8(buf + 1n, 105 as u8);
		poke8(buf + 2n, 110 as u8);
		poke8(buf + 3n, 117 as u8);
		poke8(buf + 4n, 120 as u8);
		poke8(buf + 5n, 0 as u8);
		// "tsos"
		poke8(buf + 65n + 0n, 116 as u8);
		poke8(buf + 65n + 1n, 115 as u8);
		poke8(buf + 65n + 2n, 111 as u8);
		poke8(buf + 65n + 3n, 115 as u8);
		poke8(buf + 65n + 4n, 0 as u8);
		// "6.6.0"
		poke8(buf + 130n + 0n, 54 as u8);
		poke8(buf + 130n + 1n, 46 as u8);
		poke8(buf + 130n + 2n, 54 as u8);
		poke8(buf + 130n + 3n, 46 as u8);
		poke8(buf + 130n + 4n, 48 as u8);
		poke8(buf + 130n + 5n, 0 as u8);
		// "tsos-aarch64"
		poke8(buf + 195n + 0n, 116 as u8);
		poke8(buf + 195n + 1n, 115 as u8);
		poke8(buf + 195n + 2n, 111 as u8);
		poke8(buf + 195n + 3n, 115 as u8);
		poke8(buf + 195n + 4n, 0 as u8);
		// "aarch64"
		poke8(buf + 260n + 0n, 97 as u8);
		poke8(buf + 260n + 1n, 97 as u8);
		poke8(buf + 260n + 2n, 114 as u8);
		poke8(buf + 260n + 3n, 99 as u8);
		poke8(buf + 260n + 4n, 104 as u8);
		poke8(buf + 260n + 5n, 54 as u8);
		poke8(buf + 260n + 6n, 52 as u8);
		poke8(buf + 260n + 7n, 0 as u8);

		poke64(frame_ptr + 0n, 0n); // success = 0
	} else {
		print("[tsos] Unimplemented Linux syscall nr: 0x");
		printHex64(syscall_nr);
		print("\n");
		poke64(frame_ptr + 0n, -38n); // -ENOSYS (-38)
	}
}
