ENTRY(_start)
SECTIONS {
    . = 0x40100000; /* RAM starts at 0x40000000 but if we ask to load the kernel there, QEMU will not load a DTB */
    .startup . : { boot.o(.text) }
    .text : { *(.text) }
    .data : { *(.data) }
    .bss : { *(.bss COMMON) }
    . = ALIGN(16); /* two times pointer size */
    . += 0x4000; /* 16kB of stack memory */
    stack_top = .;
    . = ALIGN(16384);
    _kernel_end = .;
}
