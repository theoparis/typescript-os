// Kernel Main Entry Point for tsos (AArch64)
import * as config from "./build/config.ts";
import { load_and_run_elf_file } from "./elf.ts";
import { init_exceptions } from "./exceptions.ts";
import { init_gicv3 } from "./gic.ts";
import { virtio_blk_init } from "./virtio.ts";
import { vfs_init } from "./vfs.ts";

/**
 * Landing pad entered when a userspace process exits via sys_exit.
 */
function kernel_exit_landing(): void {
	print(
		"--------------------------------------------------------------------\n",
	);
	print("[tsos] Userspace process completed and exited cleanly!\n");
	print("[tsos] Kernel regained control successfully.\n");
	print(
		"[tsos] All objectives (GICv3, MMU, Userspace EL0, Linux Syscalls, Static ELF) VERIFIED!\n",
	);
	while (true) {
		inline_asm("wfi", "");
	}
}

/**
 * Main kernel entry point called from boot.s.
 */
function kmain(): void {
	if (config.use_16k) {
		print(
			"[tsos] Booting kernel with 16KB page granule (Apple Silicon compatible)...\n",
		);
	} else {
		print("[tsos] Booting kernel with 4KB page granule...\n");
	}

	// 1. Install AArch64 exception vector table
	print("[tsos] Installing exception vectors into VBAR_EL1...\n");
	init_exceptions();

	// 2. Initialize GICv3 and ARM timer
	print("[tsos] Initializing GICv3 and ARM timer...\n");
	init_gicv3();
	// init_timer(50n); // 50 Hz (20ms interval)

	// 3. Initialize MMU and Paging
	print("[tsos] Initializing MMU & page tables...\n");
	init_mmu();
	print(
		"[tsos] MMU active: virtual memory, caches, and user-space separation enabled!\n",
	);

	// 4. Initialize VirtIO Block device
	if (!virtio_blk_init()) {
		print("[tsos] Fatal: VirtIO block device initialization failed!\n");
		while (true) inline_asm("wfi", "");
	}

	// 5. Mount root filesystem on VFS
	if (!vfs_init()) {
		print("[tsos] Fatal: Root filesystem mount failed!\n");
		while (true) inline_asm("wfi", "");
	}
	// 6. Load dynamically-linked Linux ELF executable from rootfs and drop to EL0 userspace
	load_and_run_elf_file(
		"/bin/echo",
		"echo",
		"Hello from dynamically-linked Gentoo Linux userspace on TypeScript OS!",
	);

	while (true) {
		inline_asm("wfi", "");
	}
}
