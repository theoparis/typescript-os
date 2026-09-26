.global user_elf_start
.global user_elf_end
.section .rodata
.balign 16
user_elf_start:
    .incbin "build/init.elf"
user_elf_end:
