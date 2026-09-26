TARGET_TRIPLE ?= aarch64-unknown-none-elf

TSLANG ?= tslang
ifeq ($(origin CC),default)
CC := clang
endif
QEMU ?= qemu-system-aarch64

PAGE_SIZE ?= 4k
PAGE_SIZE_LOWER := $(shell echo $(PAGE_SIZE) | tr '[:upper:]' '[:lower:]')

ifeq ($(PAGE_SIZE_LOWER),16k)
CONFIG_PAGE_SIZE_16K := true
QEMU_CPU ?= cortex-a76
else ifeq ($(PAGE_SIZE_LOWER),4k)
CONFIG_PAGE_SIZE_16K := false
QEMU_CPU ?= cortex-a53
else
$(error Invalid PAGE_SIZE '$(PAGE_SIZE)'. Supported values: 4k, 16k)
endif

BUILD_DIR ?= build
TARGET ?= $(BUILD_DIR)/boot/kernel.elf
LINKER_SCRIPT ?= linker.ld

TSFLAGS ?= --mtriple=$(TARGET_TRIPLE) --mm=rc --emit=obj
ASFLAGS ?= --target=$(TARGET_TRIPLE)
LDFLAGS ?= -fuse-ld=lld -nostdlib -T$(LINKER_SCRIPT) --target=$(TARGET_TRIPLE)
ROOTFS_IMG ?= $(BUILD_DIR)/rootfs.img
ROOTFS_DIR ?= $(BUILD_DIR)/rootfs
QEMUFLAGS ?= -M virt,gic-version=3 -cpu $(QEMU_CPU) -nographic \
	-drive file=$(ROOTFS_IMG),if=none,format=raw,id=hd0 \
	-device virtio-blk-device,drive=hd0

OBJS := \
	$(BUILD_DIR)/boot.o \
	$(BUILD_DIR)/vectors.o \
	$(BUILD_DIR)/embed.o \
	$(BUILD_DIR)/config.o \
	$(BUILD_DIR)/uart.o \
	$(BUILD_DIR)/gic.o \
	$(BUILD_DIR)/mmu.o \
	$(BUILD_DIR)/virtio.o \
	$(BUILD_DIR)/ext2.o \
	$(BUILD_DIR)/vfs.o \
	$(BUILD_DIR)/syscall.o \
	$(BUILD_DIR)/elf.o \
	$(BUILD_DIR)/exceptions.o \
	$(BUILD_DIR)/kmain.o
CONFIG_TS := $(BUILD_DIR)/config.ts
USER_ELF := $(BUILD_DIR)/init.elf

export PATH := $(HOME)/src/TypeScriptCompiler/build/bin:$(PATH)

.PHONY: all clean run

all: $(TARGET) $(ROOTFS_IMG)

$(TARGET): $(OBJS) $(LINKER_SCRIPT) | $(BUILD_DIR)/boot
	$(CC) $(LDFLAGS) $(OBJS) -o $@

# Build static Linux-compatible ELF binary for userspace execution
$(USER_ELF): user/init.s | $(BUILD_DIR)
	$(CC) --target=aarch64-linux-gnu -fuse-ld=lld -nostdlib -static $< -o $@

# Assembly embed object depending on the built user ELF
$(BUILD_DIR)/embed.o: embed.s $(USER_ELF) | $(BUILD_DIR)
	$(CC) $(ASFLAGS) -c $< -o $@

STAGE3_URL ?= https://distfiles.gentoo.org/releases/arm64/autobuilds/20260913T234554Z/stage3-arm64-musl-llvm-openrc-20260913T234554Z.tar.xz
STAGE3_TAR ?= $(BUILD_DIR)/stage3.tar.xz

$(STAGE3_TAR): | $(BUILD_DIR)
	@if [ -f /tmp/stage3-musl.tar.xz ]; then \
		cp /tmp/stage3-musl.tar.xz $@; \
	else \
		echo "Downloading Gentoo stage3 musl rootfs..."; \
		curl -L "$(STAGE3_URL)" -o $@; \
	fi

$(ROOTFS_IMG): $(STAGE3_TAR) | $(BUILD_DIR)
	rm -rf $(ROOTFS_DIR)
	mkdir -p $(ROOTFS_DIR)/usr/lib $(ROOTFS_DIR)/usr/bin $(ROOTFS_DIR)/etc
	tar -xf $(STAGE3_TAR) -C $(ROOTFS_DIR) \
		./usr/lib/libc.so \
		./usr/lib/libreadline.so.8.3 \
		./usr/lib/libtinfow.so.6.5 \
		./usr/lib/libncursesw.so.6.5 \
		./usr/bin/bash \
		./usr/bin/echo \
		./usr/bin/cat \
		./usr/bin/uname \
		./usr/bin/pwd 2>/dev/null || true
	ln -sf usr/lib $(ROOTFS_DIR)/lib
	ln -sf usr/bin $(ROOTFS_DIR)/bin
	ln -sf usr/bin $(ROOTFS_DIR)/sbin
	ln -sf libc.so $(ROOTFS_DIR)/usr/lib/ld-musl-aarch64.so.1
	ln -sf libreadline.so.8.3 $(ROOTFS_DIR)/usr/lib/libreadline.so.8
	ln -sf libreadline.so.8 $(ROOTFS_DIR)/usr/lib/libreadline.so
	ln -sf libtinfow.so.6.5 $(ROOTFS_DIR)/usr/lib/libtinfow.so.6
	ln -sf libtinfow.so.6 $(ROOTFS_DIR)/usr/lib/libtinfow.so
	ln -sf libncursesw.so.6.5 $(ROOTFS_DIR)/usr/lib/libncursesw.so.6
	ln -sf libncursesw.so.6 $(ROOTFS_DIR)/usr/lib/libncursesw.so
	ln -sf bash $(ROOTFS_DIR)/usr/bin/sh
	echo 'NAME="tsos"' > $(ROOTFS_DIR)/etc/os-release
	echo 'Hello from Gentoo musl rootfs in tsos!' > $(ROOTFS_DIR)/hello.txt
	mke2fs -q -F -t ext2 -d $(ROOTFS_DIR) $@ 32M
$(CONFIG_TS): FORCE | $(BUILD_DIR)
	@echo "// Auto-generated configuration" > $@.tmp; \
	echo "export const use_16k: boolean = $(CONFIG_PAGE_SIZE_16K);" >> $@.tmp; \
	if ! cmp -s $@.tmp $@ 2>/dev/null; then \
		mv $@.tmp $@; \
	else \
		rm -f $@.tmp; \
	fi

$(BUILD_DIR)/config.o: $(CONFIG_TS) | $(BUILD_DIR)
	$(TSLANG) $(TSFLAGS) -o $@ $<

$(BUILD_DIR)/%.o: %.ts | $(BUILD_DIR)
	$(TSLANG) $(TSFLAGS) -o $@ $<

$(BUILD_DIR)/%.o: %.s | $(BUILD_DIR)
	$(CC) $(ASFLAGS) -c $< -o $@

$(BUILD_DIR) $(BUILD_DIR)/boot:
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR)

run: $(TARGET)
	$(QEMU) $(QEMUFLAGS) -kernel $(TARGET)

FORCE:
.PHONY: FORCE
